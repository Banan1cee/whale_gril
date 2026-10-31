'use strict';

// Experimental sticker library. No disk access while the master switch is off.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const features = require('../infra/features');
const EMOTIONS = Object.freeze({ cute: '傲娇', angry: '炸毛', other: '其他' });
const EMOTION_LABELS = EMOTIONS;
const GENERIC = '通用';
// Legacy keys remain accepted by the API, but are never exposed as extra cards.
const ALIASES = Object.freeze({ cute: 'cute', angry: 'angry', other: 'other',
  happy: 'other', meh: 'other', bored: 'other' });
const FOLDERS = Object.freeze({
  cute: ['傲娇', 'cute', '撒娇'],
  angry: ['炸毛', 'angry'],
  other: ['其他', 'other', '开心', 'happy', '嫌弃', 'meh', '敷衍', 'bored', '通用'],
});
const EXTRA_PREFIX = 'x:';

/** 自定义分类的标签是否合法：不能带路径分隔符/控制字符，长度 1~20 */
function cleanCategoryLabel(value) {
  const label = String(value == null ? '' : value).trim()
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .slice(0, 20);
  return label === '.' || label === '..' ? '' : label;
}

/** 自定义分类 key：内置三类之外的用户分类统一用 x:<标签> */
function extraKey(label) {
  const clean = cleanCategoryLabel(label);
  return clean ? EXTRA_PREFIX + clean : '';
}

function normalizeEmotion(value) {
  if (typeof value !== 'string') return '';
  if (value.startsWith(EXTRA_PREFIX)) return extraKey(value.slice(EXTRA_PREFIX.length));
  return Object.hasOwn(ALIASES, value) ? ALIASES[value] : '';
}
const EXTS = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
const MAX_FILE_BYTES = 64 * 1024 * 1024;   // 只防内存炸，不是业务限制
const MAX_UPLOAD_FILES = 50;
const MAX_FILES = 5000;
const RULES = [
  ['angry', /(傻逼|蠢货|废物|垃圾|滚|你妈|妈的|弱智|脑残|智障|去死|闭嘴|别烦|走开|胖|肥|笨|丑|菜鸡|菜鸟)/],
  ['cute', /(乖|宝贝|抱抱|摸摸|喜欢你|想你|对不起|抱歉|好啦|别气)/],
  ['happy', /(可爱|厉害|好棒|牛逼|牛啊|爱了|绝了|哈哈|笑死)/],
  ['meh', /(？{2,}|什么鬼|离谱|无语|服了|呵呵|行吧|就这)/],
];
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function hasEmotion(value) { return Boolean(normalizeEmotion(value)); }

/** 这个分类真的存在吗（内置三类恒存在；自定义分类要查配置） */
function hasCategory(config, emotion) {
  const key = normalizeEmotion(emotion);
  if (!key) return false;
  if (!key.startsWith(EXTRA_PREFIX)) return true;
  const label = key.slice(EXTRA_PREFIX.length);
  return readExtraCategories(config, config.root).some((c) => c.label === label);
}


function stickerDir(config, root) {
  return path.resolve(root || process.cwd(), String(config?.sticker?.dir || 'data/stickers'));
}
function isInside(root, file) {
  const rel = path.relative(root, file);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}
/**
 * 这个路径是否经由链接/目录联接（reparse point）指向别处。
 *
 * 只靠 `lstat().isSymbolicLink()` 不够：Windows 的 junction 在某些 Node 版本 /
 * 环境下会返回 false（reparse tag 0xa0000003 但不标记为 symlink）。用 realpath
 * 和字面路径比对，能同时覆盖符号链接与目录联接；解析失败按可疑处理。
 */
function linkedPath(file) {
  try {
    // Windows junction 在部分 Node 版本里 isSymbolicLink() 为 false、JS 版 realpath
    // 也原样返回；只有 native realpath 会真正解析到目标。
    const resolve = fs.realpathSync.native || fs.realpathSync;
    const literal = path.resolve(file);
    const expected = path.join(resolve(path.dirname(literal)), path.basename(literal));
    const real = resolve(literal);
    // 用「父目录解析结果 + 文件名」比，而不是比字面路径：
    // runner 的临时目录可能带 8.3 短名（RUNNER~1），字面路径与解析路径本来就不同，
    // 直接比会把所有正常目录都判成链接。
    return expected.toLowerCase() !== real.toLowerCase();
  } catch {
    return true;
  }
}
/**
 * 库根路径上是否有一级是链接/目录联接（例如 data 整体被 junction 到别处）。
 * 结果按根路径缓存：同一进程内目录结构不会频繁变；不存在的前缀直接放过，
 * 交给 safeDirectory 在创建时再判。
 */
const ancestorLinkCache = new Map();
function rootHasLinkedAncestor(root) {
  const abs = path.resolve(root);
  if (ancestorLinkCache.has(abs)) return ancestorLinkCache.get(abs);
  let bad = false;
  const parsed = path.parse(abs);
  let cur = parsed.root;
  for (const part of abs.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      if (!fs.existsSync(cur)) break;
      if (linkedPath(cur)) { bad = true; break; }
    } catch { bad = true; break; }
  }
  ancestorLinkCache.set(abs, bad);
  return bad;
}
function regularFile(file, root) {
  try {
    if (!isInside(root, file)) return false;
    if (rootHasLinkedAncestor(root)) return false;
    // lstat each component: do not follow junctions or symbolic links out of the library.
    const absolute = path.resolve(root);
    const anchor = path.parse(absolute).root;
    let cur = anchor;
    for (const part of absolute.slice(anchor.length).split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      const stat = fs.lstatSync(cur);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    cur = absolute;
    for (const part of path.relative(root, file).split(path.sep)) {
      cur = path.join(cur, part);
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
      if (linkedPath(cur)) return false;
    }
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES;
  } catch { return false; }
}
function listImages(dir, { recursive = true, root = dir, depth = 0, result = [] } = {}) {
  if (depth > 3 || result.length >= MAX_FILES) return result;
  if (rootHasLinkedAncestor(root)) return result;
  let entries;
  try {
    if (fs.lstatSync(dir).isSymbolicLink() || linkedPath(dir)) return result;
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
// Every public entry has a relative ID, not just a basename: legacy folders can
// contain different images with the same name. Preview/delete must identify one file.
function categoryImages(dir, emotion) {
  const key = normalizeEmotion(emotion);
  if (!key) return [];
  if (key.startsWith(EXTRA_PREFIX)) {
    // 自定义分类：目录名就是标签，不递归（用户自己往里复制/拖文件）
    return listImages(path.join(dir, key.slice(EXTRA_PREFIX.length)), { root: dir, recursive: false });
  }
  const files = FOLDERS[key].flatMap((name) => listImages(path.join(dir, name), { root: dir, recursive: false }));
  if (key === 'other') files.push(...listImages(dir, { root: dir, recursive: false }));
  return [...new Set(files)].sort((a, b) => a.localeCompare(b));
}
function imagesFor(dir, emotion) { return categoryImages(dir, emotion); }
function anyImages(dir) { return [...new Set(Object.keys(EMOTIONS).flatMap((key) => categoryImages(dir, key)))]; }
function resolveImage(dir, emotion, id) {
  if (typeof id !== 'string' || !id || /[\\:\x00-\x1f]/.test(id)) return '';
  if (id.split('/').some((part) => !part || part === '.' || part === '..')) return '';
  const files = categoryImages(dir, emotion);
  const matches = id.includes('/') ? files.filter((file) => path.relative(dir, file).split(path.sep).join('/') === id)
    : files.filter((file) => path.basename(file) === id);
  return matches.length === 1 ? matches[0] : '';
}
function safeDirectory(dir) {
  const absolute = path.resolve(dir);
  const parsed = path.parse(absolute);
  let cur = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    if (fs.existsSync(cur)) {
      const stat = fs.lstatSync(cur);
      if (stat.isSymbolicLink() || !stat.isDirectory() || linkedPath(cur)) {
        throw fail('表情包目录不能是链接、目录联接或普通文件');
      }
    } else fs.mkdirSync(cur);
  }
  return absolute;
}
function migrateLegacy(config, root) {
  // OFF is a hard boundary: do not even stat/create a directory.
  if (!isOn(config)) return { moved: 0, deduplicated: 0, errors: [] };
  const dir = stickerDir(config, root);
  const report = { moved: 0, deduplicated: 0, errors: [] };
  try { safeDirectory(dir); } catch (err) { report.errors.push(err.message); return report; }
  for (const [key, label] of Object.entries(EMOTIONS)) {
    const targetDir = path.join(dir, label);
    try { safeDirectory(targetDir); } catch (err) { report.errors.push(label + '：' + err.message); continue; }
    for (const source of categoryImages(dir, key)) {
      if (path.dirname(source) === targetDir) continue;
      try {
        if (!regularFile(source, dir)) continue;
        const bytes = fs.readFileSync(source);
        const ext = path.extname(source);
        const stem = path.basename(source, ext);
        let target = path.join(targetDir, path.basename(source));
        let suffix = 1;
        while (fs.existsSync(target)) {
          if (!regularFile(target, dir)) throw fail('迁移目标不是安全文件');
          if (fs.readFileSync(target).equals(bytes)) break;
          target = path.join(targetDir, stem + '-迁移' + suffix++ + ext);
        }
        const existed = fs.existsSync(target);
        if (!existed) fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
        // Verify both absolute paths and bytes BEFORE deleting the source. A failed
        // copy/permission error keeps the source readable via legacy inventory.
        if (!isInside(dir, source) || !isInside(dir, target) || source === target
            || !regularFile(source, dir) || !regularFile(target, dir)
            || !fs.readFileSync(source).equals(bytes) || !fs.readFileSync(target).equals(bytes)) {
          throw fail('迁移校验失败，保留原图');
        }
        fs.unlinkSync(source);
        if (existed) report.deduplicated++; else report.moved++;
      } catch (err) { report.errors.push(path.relative(dir, source) + '：' + err.message); }
    }
    // Remove only proven-empty, known legacy folders. Unknown files/subfolders
    // are never deleted just to make Explorer show three folders.
    for (const legacy of FOLDERS[key].filter((name) => name !== label)) {
      const oldDir = path.resolve(dir, legacy);
      if (!isInside(dir, oldDir) || !fs.existsSync(oldDir)) continue;
      try {
        const stat = fs.lstatSync(oldDir);
        if (stat.isDirectory() && !stat.isSymbolicLink() && fs.readdirSync(oldDir).length === 0) fs.rmdirSync(oldDir);
      } catch (err) { report.errors.push(legacy + '：' + err.message); }
    }
  }
  return report;
}

// 自定义分类存 data/sticker-categories.json（不进 config：那个文件是给表单用的，
// 数组里放对象会被 coerceValue 转成 "[object Object]"）。
const CATEGORY_FILE = 'sticker-categories.json';

function categoryFile(config, root) {
  const base = path.dirname(stickerDir(config, root));   // data/
  return path.join(base, CATEGORY_FILE);
}

function readExtraCategories(config, root) {
  try {
    const raw = JSON.parse(fs.readFileSync(categoryFile(config, root), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .map((c) => ({ label: cleanCategoryLabel(c && c.label), chance: Number(c && c.chance) }))
      .filter((c) => c.label)
      .map((c) => ({ label: c.label, chance: Number.isFinite(c.chance) ? Math.max(0, Math.min(1, c.chance)) : 0.25 }));
  } catch {
    return [];
  }
}

function writeExtraCategories(config, root, list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((c) => ({ label: cleanCategoryLabel(c && c.label), chance: Number(c && c.chance) }))
    .filter((c) => c.label)
    .map((c) => ({ label: c.label, chance: Number.isFinite(c.chance) ? Math.max(0, Math.min(1, c.chance)) : 0.25 }));
  const file = categoryFile(config, root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return clean;
}

function isOn(config) { return features.isOn(config, 'stickers'); }
function detectEmotion(text, hour = new Date().getHours()) {
  for (const [emotion, re] of RULES) if (re.test(String(text || ''))) return emotion;
  return hour >= 23 || hour < 6 ? 'bored' : 'happy';
}
function chanceFor(config, emotion) {
  const cfg = config?.sticker || {};
  const key = normalizeEmotion(emotion);
  if (key.startsWith(EXTRA_PREFIX)) {
    const label = key.slice(EXTRA_PREFIX.length);
    const found = readExtraCategories(config, config.root).find((c) => c.label === label);
    const n = Number(found && found.chance);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.25;
  }
  const raw = cfg.chances?.[key] ?? cfg.genericChance ?? 0.25;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
function choose(pool, rng = Math.random, recent = []) {
  const fresh = pool.filter((f) => !recent.includes(f));
  const options = fresh.length ? fresh : (pool.length > 1 ? pool.filter((f) => f !== recent.at(-1)) : pool);
  if (!options.length) return '';
  const random = Number(rng());
  const index = Math.min(options.length - 1, Math.max(0, Math.floor((Number.isFinite(random) ? random : 0) * options.length)));
  return options[index];
}
// 没有冷却、也不按会话类型限制：总开关开着就按概率（或对方明确要）发。
// 同一个会话同时只会存在一个待发任务，避免连发刷屏。
const WANT_RE = /(发|来|甩|扔|给|丢|整|弄|上)(一?个|一?张|一?只|点)?\s*(表情包?|动图|贴纸|梗图|meme)/i;
const WANT_BARE_RE = /^\s*(表情包|表情)(呗|吧|啊|呀|嘛|啦)?[！!？?~～。]*\s*$/;
function isStickerRequest(value) {
  const text = String(value ?? '').trim();
  if (/(不要|别|不用|不想|不会|不能|不许|不准|停止)[^，。！？!?]{0,12}(发|来|给|整|弄|甩|扔|上).{0,6}(表情|动图|贴纸|梗图|meme)/i.test(text)) return false;
  return WANT_RE.test(text) || WANT_BARE_RE.test(text);
}
const STRONG_ANGRY = /(气死|烦死|滚[！!]|闭嘴|傻逼|去死|你有病|别烦我|火大)/;
const STRONG_CUTE = /(抱抱|亲亲|想你|可爱|陪我|喜欢你|摸摸|亲一下|撒娇|傲娇)/;
function strongEmotion(value) {
  // Classify the bot's reply (not the user's mood). Avoid broad "骂/过分" and
  // negated requests such as "别骂人", which previously became false angry hits.
  const s = String(value ?? '').replace(/(别|不要|不会|不想|不许|不准)(再|老是|一直)?(骂人?|生气|滚|气死|烦死|闭嘴|去死)/g, '');
  if (STRONG_ANGRY.test(s) || /^\s*滚[！!。]*\s*$/.test(s)) return 'angry';
  if (STRONG_CUTE.test(s)) return 'cute';
  return '';
}
function randomPool(dir) { return categoryImages(dir, 'other'); }
function pick({ config, root, text = '', request = '', recent = [], rng = Math.random } = {}) {
  if (!isOn(config)) return null;
  const emotion = strongEmotion(text || request) || 'other';
  const want = isStickerRequest(request); // Never force-send from the bot's own reply.
  if (!want && !(rng() < chanceFor(config, emotion))) return null;
  const dir = stickerDir(config, root);
  // Empty other MUST stay empty. Never borrow angry/cute, even for an explicit
  // request; otherwise default chat still sends the two excluded categories.
  const file = choose(categoryImages(dir, emotion), rng, recent);
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
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) throw fail('一次上传数量不合法');
  const validated = files.map((item) => {
    const name = String(item?.name || '');
    if (!name || /[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..') throw fail('图片文件名无效');
    let ext = path.extname(name).toLowerCase();
    if (!EXTS.includes(ext)) throw fail('只支持 GIF、PNG、JPG、WebP 图片');
    const data = item?.data;
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw fail('单张图片太大（上限 64 MB）', 413);
    if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail('图片编码无效');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_FILE_BYTES) throw fail('单张图片太大（上限 64 MB）', 413);
    if (bytes.toString('base64') !== data) throw fail('图片编码无效');
    const type = imageType(bytes);
    if (!type || (ext === '.jpeg' ? '.jpg' : ext) !== type) throw fail('图片内容与格式不匹配或图片已损坏');
    let stem = path.basename(name, path.extname(name)).replace(/[<>"|?*\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || 'sticker';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem)) stem = '_' + stem;
    const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    return { name: `${stem}-${hash}${type}`, bytes };
  });
  const dir = stickerDir(config, root);
  const key = normalizeEmotion(emotion);
  const target = key.startsWith(EXTRA_PREFIX)
    ? path.join(dir, key.slice(EXTRA_PREFIX.length))
    : path.join(dir, EMOTIONS[key]);
  // Refuse redirects, including pre-existing category junctions. Never overwrite a user's file.
  for (const candidate of [dir, target]) {
    if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) throw fail('表情包目录不能是链接或目录联接');
  }
  safeDirectory(target);
  const uploaded = [];
  for (const entry of validated) {
    const file = path.join(target, entry.name);
    try { fs.writeFileSync(file, entry.bytes, { flag: 'wx' }); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (!regularFile(file, dir) || !fs.readFileSync(file).equals(entry.bytes)) throw fail('文件名冲突，请换一个名字');
    }
    uploaded.push({ name: entry.name, emotion: key });
  }
  return uploaded;
}
module.exports = { EMOTIONS, EMOTION_LABELS, EXTRA_PREFIX, cleanCategoryLabel, extraKey, hasCategory, readExtraCategories, writeExtraCategories, categoryFile, normalizeEmotion, GENERIC, EXTS, MAX_FILE_BYTES, MAX_UPLOAD_FILES,
  hasEmotion, resolveImage, safeDirectory, migrateLegacy, stickerDir, regularFile, listImages, categoryImages, imagesFor, anyImages, isOn,
  detectEmotion, chanceFor, choose, pick, isStickerRequest, strongEmotion, randomPool, imageType, upload };
