'use strict';

// Experimental sticker library. No disk access while the master switch is off.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const features = require('./features');
const EMOTIONS = Object.freeze({ happy: '开心', angry: '炸毛', cute: '撒娇', meh: '嫌弃', bored: '敷衍' });
const EMOTION_LABELS = EMOTIONS;
const GENERIC = '通用';
const EXTS = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_UPLOAD_FILES = 5;
const MAX_FILES = 500;
const RULES = [
  ['angry', /(傻逼|蠢货|废物|垃圾|滚|你妈|妈的|弱智|脑残|智障|去死|闭嘴|别烦|走开|胖|肥|笨|丑|菜鸡|菜鸟)/],
  ['cute', /(乖|宝贝|抱抱|摸摸|喜欢你|想你|对不起|抱歉|好啦|别气)/],
  ['happy', /(可爱|厉害|好棒|牛逼|牛啊|爱了|绝了|哈哈|笑死)/],
  ['meh', /(？{2,}|什么鬼|离谱|无语|服了|呵呵|行吧|就这)/],
];
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function hasEmotion(value) { return Object.prototype.hasOwnProperty.call(EMOTIONS, value); }
function stickerDir(config, root) {
  return path.resolve(root || process.cwd(), String(config?.sticker?.dir || 'data/stickers'));
}
function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
function regularFile(file, root) {
  try {
    if (!isInside(root, file)) return false;
    // lstat each component: do not follow junctions or symbolic links out of the library.
    let cur = root;
    if (fs.lstatSync(cur).isSymbolicLink()) return false;
    for (const part of path.relative(root, file).split(path.sep)) {
      cur = path.join(cur, part);
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    }
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES;
  } catch { return false; }
}
function listImages(dir, { recursive = true, root = dir, depth = 0, result = [] } = {}) {
  if (depth > 3 || result.length >= MAX_FILES) return result;
  let entries;
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return result;
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return result; }
  for (const ent of entries) {
    if (result.length >= MAX_FILES) break;
    if (ent.isSymbolicLink()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) listImages(full, { recursive, root, depth: depth + 1, result });
    } else if (EXTS.includes(path.extname(ent.name).toLowerCase()) && regularFile(full, root)) result.push(full);
  }
  return result;
}
// Inventory is exact, without fallback: an empty category must display zero in the console.
function categoryImages(dir, emotion) {
  if (!hasEmotion(emotion)) return [];
  return [...new Set([emotion, EMOTIONS[emotion]].flatMap((name) =>
    listImages(path.join(dir, name), { root: dir })))].sort();
}
function imagesFor(dir, emotion) {
  const category = categoryImages(dir, emotion);
  if (category.length) return category;
  const generic = listImages(path.join(dir, GENERIC), { root: dir });
  if (generic.length) return generic;
  // 这一类还没放图时，用库里其它图兜底：只要开关开着就能发出表情包，
  // 而不是「明明传了图却一张也发不出去」。分类计数仍然是精确的。
  return listImages(dir);
}
function isOn(config) { return features.isOn(config, 'stickers'); }
function detectEmotion(text, hour = new Date().getHours()) {
  for (const [emotion, re] of RULES) if (re.test(String(text || ''))) return emotion;
  return hour >= 23 || hour < 6 ? 'bored' : 'happy';
}
function chanceFor(config, emotion) {
  const cfg = config?.sticker || {};
  const n = Number(cfg.chances?.[emotion] ?? cfg.genericChance ?? 0.1);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
function choose(pool, rng = Math.random, recent = []) {
  const fresh = pool.filter((f) => !recent.includes(f));
  const options = fresh.length ? fresh : pool;
  if (!options.length) return '';
  const random = Number(rng());
  const index = Math.min(options.length - 1, Math.max(0, Math.floor((Number.isFinite(random) ? random : 0) * options.length)));
  return options[index];
}
// 没有冷却、也不按会话类型限制：总开关开着就按概率（或对方明确要）发。
// 同一个会话同时只会存在一个待发任务，避免连发刷屏。
function pick({ config, root, key = '', text = '', request = '', recent = [], rng = Math.random } = {}) {
  if (!isOn(config)) return null;
  const emotion = detectEmotion(String(text || request));
  const want = /(发|来|甩|扔|给|丢)(个|一个|张)?\s*(表情包?|动图|贴纸)/.test(String(request || ''));
  if (!want && !(rng() < chanceFor(config, emotion))) return null;
  const file = choose(imagesFor(stickerDir(config, root), emotion), rng, recent);
  return file ? { emotion, path: file } : null;
}

// Validate magic + basic dimensions before writing. Bridge additionally decodes via Pillow before sending.
function imageType(bytes) {
  if (bytes.length >= 14 && /^(GIF87a|GIF89a)$/.test(bytes.toString('ascii', 0, 6))) {
    const w = bytes.readUInt16LE(6), h = bytes.readUInt16LE(8);
    if (w > 0 && h > 0 && w <= 8192 && h <= 8192 && bytes[bytes.length - 1] === 0x3b) return '.gif';
  }
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
    if (w > 0 && h > 0 && w <= 8192 && h <= 8192 && bytes.toString('ascii', bytes.length - 8, bytes.length - 4) === 'IEND') return '.png';
  }
  if (bytes.length >= 16 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return '.jpg';
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return '.webp';
  return '';
}
function upload(config, root, emotion, files) {
  if (!isOn(config)) throw fail('表情包功能未开启', 404);
  if (!hasEmotion(emotion)) throw fail('请选择有效的情绪');
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) throw fail('每次请上传 1～5 张图片');
  const validated = files.map((item) => {
    const name = String(item?.name || '');
    if (!name || /[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..') throw fail('图片文件名无效');
    let ext = path.extname(name).toLowerCase();
    if (!EXTS.includes(ext)) throw fail('只支持 GIF、PNG、JPG、WebP 图片');
    const data = item?.data;
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw fail('单张图片不能超过 4 MB', 413);
    if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail('图片编码无效');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw fail('单张图片不能超过 4 MB', 413);
    if (bytes.toString('base64') !== data) throw fail('图片编码无效');
    const type = imageType(bytes);
    if (!type || (ext === '.jpeg' ? '.jpg' : ext) !== type) throw fail('图片内容与格式不匹配或图片已损坏');
    let stem = path.basename(name, path.extname(name)).replace(/[<>"|?*\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || 'sticker';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return { name: `${stem}-${hash}${type}`, bytes };
  });
  const dir = stickerDir(config, root);
  const target = path.join(dir, EMOTIONS[emotion]);
  // Refuse redirects, including pre-existing category junctions. Never overwrite a user's file.
  for (const candidate of [dir, target]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw fail('表情包目录不能是链接或目录联接');
  }
  fs.mkdirSync(target, { recursive: true });
  const uploaded = [];
  for (const entry of validated) {
    const file = path.join(target, entry.name);
    try { fs.writeFileSync(file, entry.bytes, { flag: 'wx' }); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!regularFile(file, dir) || !fs.readFileSync(file).equals(entry.bytes)) throw fail('文件名冲突，请换一个名字');
    }
    uploaded.push({ name: entry.name, emotion });
  }
  return uploaded;
}
module.exports = { EMOTIONS, EMOTION_LABELS, GENERIC, EXTS, MAX_FILE_BYTES, MAX_UPLOAD_FILES,
  hasEmotion, stickerDir, regularFile, listImages, categoryImages, imagesFor, isOn,
  detectEmotion, chanceFor, choose, pick, imageType, upload };
