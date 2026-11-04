'use strict';

// Experimental sticker library. No disk access while the master switch is off.
const fs = require('node:fs');
const fsp = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const features = require('../infra/features');
const probe = require('../infra/probe');
const EMOTIONS = Object.freeze({ cute: '傲娇', angry: '炸毛', happy: '开心' });
// 探针用 logger：由 stickerService/app 注入；子进程（stickerLibraryLocal）不注入 → 完全静默，
// 免得往被当作 JSON 解析的 stdout 里掺东西。
let probeLogger = null;
function setProbeLogger(logger) { probeLogger = logger || null; }
const EMOTION_LABELS = EMOTIONS;
const GENERIC = '通用';
// Legacy keys remain accepted by the API, but are never exposed as extra cards.
// 旧的「其他」及其别名统一并到内置的「开心」：不再有单独的其他分类。
const ALIASES = Object.freeze({ cute: 'cute', angry: 'angry', happy: 'happy',
  other: 'happy', meh: 'happy', bored: 'happy' });
const FOLDERS = Object.freeze({
  cute: ['傲娇', 'cute', '撒娇'],
  angry: ['炸毛', 'angry'],
  // 「开心」是硬编码内置分类；旧版本的 其他/通用 等目录里的图也归到这一类，不丢图
  happy: ['开心', 'happy', '通用', '其他', 'other', '嫌弃', 'meh', '敷衍', 'bored'],
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
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;   // 单张上传上限，与启动器/README 对齐
const MAX_UPLOAD_FILES = 5;
const MAX_FILES = 5000;
// 中文展示名 → 内部 key（模型可能直接写「傲娇」而不是 cute）
const LABEL_TO_KEY = Object.freeze({ 傲娇: 'cute', 炸毛: 'angry', 开心: 'happy', 其他: 'happy' });
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
    const norm = (s) => s.replace(/^\\\\\?\\/, '').replace(/^\\\\\.\\/, '').toLowerCase();
    // 8.3 短名（RUNNER~1）解析后一定不同名，但它是同一个目录；链接不会长这样。
    if (/~\d+(\.[^.]*)?$/.test(path.basename(literal))) return false;
    // 用「父目录解析结果 + 文件名」比，而不是比字面路径：
    // runner 的临时目录可能带 8.3 短名（RUNNER~1）或 \\?\ 前缀，
    // 字面路径与解析路径本来就不同，直接比会把所有正常目录都判成链接。
    return norm(expected) !== norm(real);
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

/**
 * 扫描用的「目录级」安全判断。
 *
 * 以前每个文件都要走一遍 regularFile：逐层 lstat + 每层两次 realpath，实测 0.8ms/张 ——
 * 565 张就是 450ms 的同步阻塞。同一个目录里的文件，路径前缀的检查结果必然相同，
 * 所以改成「每个目录验一次、结果缓存」，单文件只剩一次 lstat。
 * 真正的发送前校验（claim）仍然走 regularFile，安全边界没有放松。
 */
const dirSafeCache = new Map();
function safeScanDir(dir, root) {
  const abs = path.resolve(dir);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !isInside(rootAbs, abs)) return false;
  if (rootHasLinkedAncestor(rootAbs)) return false;
  if (dirSafeCache.has(abs)) return dirSafeCache.get(abs);
  let ok = false;
  try {
    const stat = fs.lstatSync(abs);
    ok = stat.isDirectory() && !stat.isSymbolicLink() && !linkedPath(abs);
  } catch { ok = false; }
  dirSafeCache.set(abs, ok);
  return ok;
}

/** 单文件便宜校验：一次 lstat（链接会被 isFile=false 排除） */
function cheapImageFile(file, name) {
  if (!EXTS.includes(path.extname(name).toLowerCase())) return false;
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES;
  } catch { return false; }
}

function listImages(dir, { recursive = true, root = dir, depth = 0, result = [] } = {}) {
  if (depth > 3 || result.length >= MAX_FILES) return result;
  if (!safeScanDir(dir, root)) return result;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch { return result; }
  for (const ent of entries) {
    if (result.length >= MAX_FILES) break;
    if (ent.isSymbolicLink()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) listImages(full, { recursive, root, depth: depth + 1, result });
    } else if (cheapImageFile(full, ent.name)) result.push(full);
  }
  return result;
}

/**
 * listImages 的异步版：fs.promises.readdir + 每轮最多 8 个并发 lstat，每 32 条让出一次事件循环。
 * HTTP 热路径（status / 缩略图列表）和启动维护用这一条，避免同步扫描把 /healthz 堵住。
 */
async function listImagesAsync(dir, { recursive = true, root = dir, depth = 0, result = [] } = {}) {
  if (depth > 3 || result.length >= MAX_FILES) return result;
  if (!safeScanDir(dir, root)) return result;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch { return result; }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const ent of entries) {
    if (result.length >= MAX_FILES) break;
    if (ent.isSymbolicLink()) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) {
        await listImagesAsync(full, { recursive, root, depth: depth + 1, result });
        await new Promise((resolve) => setImmediate(resolve));
      }
    } else if (EXTS.includes(path.extname(ent.name).toLowerCase())) {
      files.push(full);
    }
  }
  const CONCURRENCY = 8;
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    if (result.length >= MAX_FILES) break;
    const batch = files.slice(i, i + CONCURRENCY);
    const stats = await Promise.all(batch.map((file) => fsp.lstat(file).catch(() => null)));
    stats.forEach((stat, index) => {
      if (stat && stat.isFile() && stat.size > 0 && stat.size <= MAX_FILE_BYTES) result.push(batch[index]);
    });
    await new Promise((resolve) => setImmediate(resolve));
  }
  return result;
}

/**
 * 目录扫描结果缓存：只缓存「不递归」的整目录扫描（status / 提示词 / 选图 / 缩略图都走这条）。
 *
 * 目录 mtime 变了（增删改名、explorer 里拖文件）就重扫；上传和删除还会显式失效，
 * 不指望毫秒级的 mtime 精度兜底。缓存的是路径列表，发送前的 regularFile 校验照旧执行。
 */
const scanCache = new Map();
const SCAN_CACHE_MAX = 32;

function scanStamp(folder) {
  try {
    const stat = fs.statSync(folder);
    return stat.mtimeMs + '/' + stat.size;
  } catch { return ''; }
}

function invalidateScan(folder) {
  if (folder) scanCache.delete(path.resolve(folder));
  // 目录安全缓存也要一起失效：目录可能刚被创建/删除/换成链接
  if (folder) dirSafeCache.delete(path.resolve(folder));
  else dirSafeCache.clear();
}

function clearScanCache() { scanCache.clear(); dirSafeCache.clear(); }

function listImagesCached(folder, root) {
  const t0 = probe.now();
  const stamp = scanStamp(folder);
  if (!stamp) { invalidateScan(folder); return []; }
  const key = path.resolve(folder);
  const hit = scanCache.get(key);
  if (hit && hit.root === root && hit.stamp === stamp) {
    // Map 保持插入顺序：命中后挪到末尾，简单的 LRU。
    scanCache.delete(key);
    scanCache.set(key, hit);
    probe.emit(probeLogger, 'debug', `扫描缓存命中 ${key} 张数=${hit.files.length} 耗时=${probe.ms(probe.now() - t0)}ms`);
    return hit.files.slice();
  }
  const files = listImages(folder, { root, recursive: false });
  scanCache.set(key, { root, stamp, files });
  while (scanCache.size > SCAN_CACHE_MAX) scanCache.delete(scanCache.keys().next().value);
  // 探针：这条是「首次扫描 / 上传后重扫」的真实成本，也是 0.8ms/张 那个数字的来源
  const cost = probe.now() - t0;
  const perFile = files.length ? cost / files.length : 0;
  probe.emit(probeLogger, cost > 50 ? 'warn' : 'debug',
    `扫描 ${key} 张数=${files.length} 耗时=${probe.ms(cost)}ms 单张=${probe.ms(perFile)}ms`);
  return files.slice();
}
// Every public entry has a relative ID, not just a basename: legacy folders can
// contain different images with the same name. Preview/delete must identify one file.
/** 某个分类允许的目录（内置分类含旧别名，自定义分类只有同名目录） */
function categoryFolders(key) {
  if (key.startsWith(EXTRA_PREFIX)) return [key.slice(EXTRA_PREFIX.length)];
  return FOLDERS[key] || [];
}
function categoryImages(dir, emotion) {
  const t0 = probe.now();
  const key = normalizeEmotion(emotion);
  if (!key) return [];
  const out = (() => {
    if (key.startsWith(EXTRA_PREFIX)) {
      // 自定义分类：目录名就是标签，不递归（用户自己往里复制/拖文件）
      return listImagesCached(path.join(dir, categoryFolders(key)[0]), dir);
    }
    const files = FOLDERS[key].flatMap((name) => listImagesCached(path.join(dir, name), dir));
    // 直接扔在 data/stickers 根目录的图也算「开心」：以前这里是 key === 'other'，
    // 但 normalizeEmotion 早把 other 映射成 happy，那段是死代码，根目录的图永远收不到。
    if (key === 'happy') files.push(...listImagesCached(dir, dir));
    return [...new Set(files)].sort((a, b) => a.localeCompare(b));
  })();
  const cost = probe.now() - t0;
  probe.emit(probeLogger, cost > 50 ? 'warn' : 'debug',
    `分类 ${key} 目录=${dir} 张数=${out.length} 耗时=${probe.ms(cost)}ms`);
  return out;
}
function imagesFor(dir, emotion) { return categoryImages(dir, emotion); }

/**
 * categoryImages 的异步版：HTTP 热路径用。规则与同步版逐字一致，
 * 只是把「一次读完整棵树」换成「异步 readdir + 8 路并发 lstat + 每 32 条让出」。
 */
async function categoryImagesAsync(dir, emotion) {
  const t0 = probe.now();
  const key = normalizeEmotion(emotion);
  if (!key) return [];
  let out;
  if (key.startsWith(EXTRA_PREFIX)) {
    out = await listImagesAsync(path.join(dir, categoryFolders(key)[0]), { root: dir, recursive: false });
  } else {
    const groups = await Promise.all(FOLDERS[key].map((name) =>
      listImagesAsync(path.join(dir, name), { root: dir, recursive: false })));
    const files = groups.flat();
    if (key === 'happy') {
      files.push(...await listImagesAsync(dir, { root: dir, recursive: false }));
    }
    out = [...new Set(files)].sort((a, b) => a.localeCompare(b));
  }
  const cost = probe.now() - t0;
  probe.emit(probeLogger, cost > 50 ? 'warn' : 'debug',
    `分类(异步) ${key} 目录=${dir} 张数=${out.length} 耗时=${probe.ms(cost)}ms`);
  return out;
}

/**
 * 分类下的图 + 版本（mtime），给 UI 做缩略图缓存键用。
 * 异步版：每 32 张一批 stat，批间让出事件循环。
 */
async function categoryItemsAsync(dir, emotion) {
  const files = await categoryImagesAsync(dir, emotion);
  const out = [];
  for (let i = 0; i < files.length; i += 32) {
    const batch = files.slice(i, i + 32);
    const stats = await Promise.all(batch.map((file) => fsp.stat(file).catch(() => null)));
    batch.forEach((file, index) => {
      out.push({
        name: path.basename(file),
        id: path.relative(dir, file).split(path.sep).join('/'),
        path: file,
        version: stats[index] ? Math.round(stats[index].mtimeMs) : 0,
      });
    });
    if (i + 32 < files.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return out;
}

/** 同步版：只给测试/老调用方用 */
function categoryItems(dir, emotion) {
  return categoryImages(dir, emotion).map((file) => {
    let version = 0;
    try { version = Math.round(fs.statSync(file).mtimeMs); } catch { /* 读不到就当 0 */ }
    return {
      name: path.basename(file),
      id: path.relative(dir, file).split(path.sep).join('/'),
      path: file,
      version,
    };
  });
}
function anyImages(dir) { return [...new Set(Object.keys(EMOTIONS).flatMap((key) => categoryImages(dir, key)))]; }
function resolveImage(dir, emotion, id) {
  if (typeof id !== 'string' || !id || /[\\:\x00-\x1f]/.test(id)) return '';
  const segments = id.split('/');
  if (segments.some((part) => !part || part === '.' || part === '..')) return '';
  const key = normalizeEmotion(emotion);
  if (!key) return '';
  // 界面一次只要一张（缩略图、删除）：两段形态「分类目录/文件名」直接拼出来校验，
  // 不再把整个分类重扫一遍。真正的安全判断仍由 regularFile 完成，没变。
  if (segments.length === 2) {
    const [folder, name] = segments;
    if (!categoryFolders(key).includes(folder)) return '';
    if (!EXTS.includes(path.extname(name).toLowerCase())) return '';
    const file = path.join(dir, folder, name);
    return regularFile(file, dir) ? file : '';
  }
  // 老调用方按纯文件名（或更深的相对路径）找：只能在分类里比对，回落到扫描。
  const files = categoryImages(dir, emotion);
  const matches = id.includes('/') ? files.filter((file) => path.relative(dir, file).split(path.sep).join('/') === id)
    : files.filter((file) => path.basename(file) === id);
  return matches.length === 1 ? matches[0] : '';
}

/** 某个分类实际落在哪个目录（优先已存在的老别名目录，比如迁移前还在用「撒娇」） */
function categoryDir(dir, emotion, { create = false } = {}) {
  const key = normalizeEmotion(emotion);
  if (!key) return '';
  const folders = categoryFolders(key);
  if (!folders.length) return '';
  for (const name of folders) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) {
        const stat = fs.lstatSync(candidate);
        if (stat.isDirectory() && !stat.isSymbolicLink() && !linkedPath(candidate)) return candidate;
      }
    } catch { /* 坏目录就跳过，继续看下一个别名 */ }
  }
  if (!create) return '';
  const primary = path.join(dir, folders[0]);
  safeDirectory(primary);
  return primary;
}

/** 给「打开目标目录」用：库根 / 分类目录 / 某一张图 */
function targetForOpen(dir, emotion, name) {
  const root = path.resolve(dir);
  if (!emotion) return { dir: root, mode: 'root' };
  const folder = categoryDir(root, emotion, { create: false });
  if (!folder) return null;
  if (!name) return { dir: folder, mode: 'folder' };
  const file = resolveImage(root, normalizeEmotion(emotion), String(name));
  if (!file) return null;
  return { dir: file, mode: 'select' };
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
/** 分块比较两个文件的字节（不整文件读进内存：老实现每张图要读 3 遍 2.4MB） */
function sameBytes(a, b) {
  const fa = fs.openSync(a, 'r');
  const fb = fs.openSync(b, 'r');
  const bufA = Buffer.allocUnsafe(64 * 1024);
  const bufB = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const na = fs.readSync(fa, bufA, 0, bufA.length, null);
      const nb = fs.readSync(fb, bufB, 0, bufB.length, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (!bufA.subarray(0, na).equals(bufB.subarray(0, nb))) return false;
    }
  } finally {
    try { fs.closeSync(fa); } catch { /* ignore */ }
    try { fs.closeSync(fb); } catch { /* ignore */ }
  }
}

/**
 * 把一张旧分类的图并进目标分类目录。返回 'moved' / 'dedup' / 'skip'。
 *
 * 关键改动（2026-11-04）：**先试 rename**。
 * 旧实现是「整文件读 → copyFile → 再读 source/target 比对 → 删源」，一张 2.4MB 的图
 * 要走 4 遍读 + 1 遍写；实测 245 张 611MB 要 11 秒。而这些目录都在同一个
 * data/stickers 树下（safeDirectory 已经拒了链接/目录联接），rename 只是改元数据，
 * 不读内容 → 同样的 245 张降到几十毫秒。只有跨卷/被占用（EXDEV/EPERM/EBUSY）时才退回复制。
 */
function moveInto(source, targetDir, dir) {
  // 这里不再跑整个 regularFile（每张都要逐层 lstat + 两次 realpath，实测 0.8ms/张）：
  // 这些文件刚被 categoryImages 用 regularFile 验过，目录也过了 safeDirectory /
  // rootHasLinkedAncestor 两道链接检查。这里只补一次便宜的 isInside + lstat。
  if (!isInside(dir, source)) return 'skip';
  let sourceStat;
  try { sourceStat = fs.lstatSync(source); } catch { return 'skip'; }
  if (!sourceStat.isFile() || sourceStat.size <= 0 || sourceStat.size > MAX_FILE_BYTES) return 'skip';
  const ext = path.extname(source);
  const stem = path.basename(source, ext);
  const name = path.basename(source);
  const sourceSize = sourceStat.size;
  let target = path.join(targetDir, name);
  let suffix = 1;
  for (;;) {
    let stat = null;
    try { stat = fs.statSync(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    if (!stat) break;
    if (!regularFile(target, dir)) throw fail('迁移目标不是安全文件');
    // 同名且内容相同 → 去重，删掉旧的这份；大小不同就不必读内容
    if (stat.size === sourceSize && sameBytes(source, target)) {
      fs.unlinkSync(source);
      return 'dedup';
    }
    target = path.join(targetDir, stem + '-迁移' + suffix++ + ext);
  }
  if (!isInside(dir, source) || !isInside(dir, target) || source === target) {
    throw fail('迁移校验失败，保留原图');
  }
  try {
    fs.renameSync(source, target);
    return 'moved';
  } catch (err) {
    if (!['EXDEV', 'EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
  }
  // 兜底：跨卷或文件被占用 → 复制、校验、删源（失败一律保留原图）
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  if (fs.statSync(target).size !== sourceSize || !sameBytes(source, target)) {
    try { fs.unlinkSync(target); } catch { /* 删不掉也没关系，源图还在 */ }
    throw fail('迁移校验失败，保留原图');
  }
  fs.unlinkSync(source);
  return 'moved';
}

/**
 * 迁移的**唯一**实现，写成生成器：每搬完一张就 yield 一次。
 *   - 同步调用方（测试、兼容接口）把它抽干 → 行为与以前一致；
 *   - 异步调用方（服务启动后的维护）每 N 张让出一次事件循环 → 不再堵住 /healthz。
 */
function* migrateGen(config, root, state = {}) {
  const report = { moved: 0, deduplicated: 0, rootImages: 0, errors: [] };
  state.report = report;
  state.total = 0;
  // OFF is a hard boundary: do not even stat/create a directory.
  if (!isOn(config)) return report;
  const t0 = probe.now();
  let probeBytes = 0;
  const dir = stickerDir(config, root);
  // 迁移会大量搬文件：先把扫描缓存清掉，避免拿到搬之前的目录内容。
  clearScanCache();
  try { safeDirectory(dir); } catch (err) { report.errors.push(err.message); return report; }
  for (const [key, label] of Object.entries(EMOTIONS)) {
    const targetDir = path.join(dir, label);
    try { safeDirectory(targetDir); } catch (err) { report.errors.push(label + '：' + err.message); continue; }
    for (const source of categoryImages(dir, key)) {
      if (path.dirname(source) === targetDir) continue;
      const fromRoot = path.dirname(path.resolve(source)) === path.resolve(dir);
      state.total++;
      try {
        try { probeBytes += fs.statSync(source).size; } catch { /* 统计失败不影响迁移 */ }
        const outcome = moveInto(source, targetDir, dir);
        if (outcome === 'dedup') report.deduplicated++;
        else if (outcome === 'moved') {
          report.moved++;
          if (fromRoot) report.rootImages++;   // 本次从 data/stickers 根目录并进来的张数
        }
      } catch (err) { report.errors.push(path.relative(dir, source) + '：' + err.message); }
      yield report;   // 让调用方决定是否让出事件循环
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
  // 搬完再清一次：上面按目录读数时又把缓存填回来了。
  clearScanCache();
  probe.emit(probeLogger, 'info',
    `迁移完成 搬=${report.moved} 去重=${report.deduplicated} 根目录=${report.rootImages}`
    + ` 失败=${report.errors.length} 涉及字节=${probeBytes}`
    + ` 耗时=${probe.ms(probe.now() - t0)}ms`);
  return report;
}

/** 同步迁移：抽干生成器。保留给测试与老调用方。 */
function migrateLegacy(config, root) {
  const it = migrateGen(config, root);
  let step = it.next();
  while (!step.done) step = it.next();
  return step.value;
}

/**
 * 异步迁移：按**时间片**让出事件循环（默认 16ms 一片），不是按条数。
 *
 * 为什么不用「每 20 个文件 yield 一次」：单次文件操作的成本并不稳定 ——
 * 实测同一批 rename 在开着实时防护的机器上可能到几十毫秒一张，
 * 按条数让出会攒出 1.5 秒的同步块，/healthz 照样超时。按时间切就一定不会超预算。
 */
async function migrateLegacyAsync(config, root, { budgetMs = 16, onProgress = null, state = {} } = {}) {
  const it = migrateGen(config, root, state);
  let step = it.next();
  let sliceStart = probe.now();
  while (!step.done) {
    if (typeof onProgress === 'function') {
      try { onProgress(state.report, state.total); } catch { /* 进度回调不许影响迁移 */ }
    }
    if (probe.now() - sliceStart >= budgetMs) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = probe.now();
    }
    step = it.next();
  }
  return step.value;
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

// 用户明确「忽略」的目录名，不再自动登记（防止空目录/临时目录污染提示词）
const IGNORE_FILE = 'sticker-categories.ignore.json';

function readIgnored(config, root) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(path.dirname(stickerDir(config, root)), IGNORE_FILE), 'utf8'));
    return Array.isArray(raw) ? raw.map((v) => cleanCategoryLabel(v)).filter(Boolean) : [];
  } catch { return []; }
}

function writeIgnored(config, root, labels) {
  const clean = [...new Set((Array.isArray(labels) ? labels : []).map((v) => cleanCategoryLabel(v)).filter(Boolean))];
  const file = path.join(path.dirname(stickerDir(config, root)), IGNORE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(clean, null, 2) + '\n', 'utf8');
  fs.renameSync(file + '.tmp', file);
  return clean;
}

/**
 * 自动发现「用户自己建的分类目录」（隐形分类 bug 的修复）。
 *
 * 原则：**目录是事实来源，JSON 只是缓存**。以前只认 sticker-categories.json 里
 * 登记过的分类，用户在 data/stickers 里新建「恼怒」放图，页签不出现、模型不知道、
 * [[sticker:恼怒]] 被拒、图彻底收不到。
 *
 * 规则（和交接文档一致）：
 *   - 只看一级子目录，不递归；
 *   - 排除内置三类和所有旧别名（通用/其他/撒娇/cute/happy/嫌弃/meh/敷衍/bored…）；
 *   - 目录要过 safeScanDir（拒链接 / 目录联接 / 非目录）；
 *   - 空目录也登记（建了文件夹就该在页签里出现），但 0 张的分类不会进提示词；
 *   - 名字走 cleanCategoryLabel（去非法字符、截 20 字），和已登记的重名按「已存在」处理。
 */
function discoverCategories(config, root) {
  if (!isOn(config)) return [];
  const dir = stickerDir(config, root);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const reserved = new Set([...Object.values(EMOTIONS), ...Object.values(FOLDERS).flat(), GENERIC]);
  const ignored = new Set(readIgnored(config, root));
  const found = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
    if (reserved.has(ent.name)) continue;
    const label = cleanCategoryLabel(ent.name);
    if (!label || reserved.has(label) || ignored.has(label) || found.includes(label)) continue;
    const full = path.join(dir, ent.name);
    if (!safeScanDir(full, dir)) continue;
    // 空目录也登记：用户建了文件夹就该看见页签（提示词那边会过滤掉 0 张的分类，见 promptCategories）
    found.push(label);
  }
  return found;
}

/** 把新发现的分类补进 sticker-categories.json（幂等：已有的 chance / 顺序都不动） */
function syncDiscoveredCategories(config, root) {
  const dir = stickerDir(config, root);
  const current = readExtraCategories(config, root);
  const found = discoverCategories(config, root);
  // 目录才是事实来源：登记过但文件夹已经没了的分类要摘掉，
  // 否则用户在资源管理器里删掉「恼怒」，页签会一直挂着一个空分类。
  const alive = current.filter((c) => {
    const label = cleanCategoryLabel(c && c.label);
    if (!label) return false;
    try {
      const stat = fs.lstatSync(path.join(dir, label));
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch { return false; }
  });
  const aliveLabels = new Set(alive.map((c) => cleanCategoryLabel(c && c.label)));
  const removed = current
    .map((c) => cleanCategoryLabel(c && c.label))
    .filter((label) => label && !aliveLabels.has(label));
  const added = found.filter((label) => !aliveLabels.has(label));
  if (!added.length && !removed.length) return { added: [], removed: [], categories: current };
  const next = alive.concat(added.map((label) => ({ label, chance: 0.25 })));
  writeExtraCategories(config, root, next);
  return { added, removed, categories: readExtraCategories(config, root) };
}

function isOn(config) { return features.isOn(config, 'stickers'); }
function choose(pool, rng = Math.random, recent = []) {
  const fresh = pool.filter((f) => !recent.includes(f));
  const options = fresh.length ? fresh : (pool.length > 1 ? pool.filter((f) => f !== recent.at(-1)) : pool);
  if (!options.length) return '';
  const random = Number(rng());
  const index = Math.min(options.length - 1, Math.max(0, Math.floor((Number.isFinite(random) ? random : 0) * options.length)));
  return options[index];
}
// 分类由模型在回复里决定（[[sticker:分类]]），这里只负责把名字认成 key、取一张图。
// 同一个会话同时只会存在一个待发任务，避免连发刷屏。
const WANT_RE = /(发|来|甩|扔|给|丢|整|弄|上)(一?个|一?张|一?只|点)?\s*(表情包?|动图|贴纸|梗图|meme|图)/i;
// 「用表情包告诉我你现在什么心情」这类没有“发/来”的索要
const USE_RE = /(用|拿|靠)[^，。！？!?\n]{0,8}(表情包?|动图|贴纸|梗图|meme)/i;
// 「表情包来一个」这种倒装
const REVERSE_RE = /(表情包?|动图|贴纸|梗图|meme)\s*(来|发|整|甩|扔)(一?个|一?张|点)?/i;
const WANT_BARE_RE = /^\s*(表情包|表情)(呗|吧|啊|呀|嘛|啦)?[！!？?~～。]*\s*$/;
const NEGATIVE_RE = /(不要|别|不用|不想|不会|不能|不许|不准|停止)[^，。！？!?]{0,12}(发|来|给|整|弄|甩|扔|上|用|拿).{0,6}(表情|动图|贴纸|梗图|meme|图)/i;
function isStickerRequest(value) {
  const text = String(value ?? '').trim();
  if (NEGATIVE_RE.test(text)) return false;
  return WANT_RE.test(text) || WANT_BARE_RE.test(text) || USE_RE.test(text) || REVERSE_RE.test(text);
}

// 严肃场景：只收明显的坏消息/求助，不收「好累/压力」这种日常词，
// 否则一半闲聊都会被判严肃，表情包频率直接掉下去。
const SERIOUS_RE = /(失恋|分手|离婚|生病|住院|医院|去世|被裁|裁员|失业|崩溃|焦虑|抑郁|委屈|想哭|撑不住|难受|头疼|头痛|疼痛|疼|求助|怎么办|出事|吵架|被骂|挨骂|欺负|伤心|难过|不开心|emo)/i;
const LIVELY_RE = /(没事了|好多了|我好了|想通了|谢谢你|谢谢啦|哈哈|笑死|开心了|好耶|太好了|解决了)/i;
const SERIOUS_WINDOW_MS = 15 * 60 * 1000;
const SERIOUS_TURNS = 4;

function isSeriousText(value) {
  return SERIOUS_RE.test(String(value ?? ''));
}
function isLivelyText(value) {
  return LIVELY_RE.test(String(value ?? ''));
}
/** 模型给的分类名 → 内部 key（cute / angry / other / x:标签）；认不出返回 '' */
function categoryFromName(config, value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const direct = normalizeEmotion(raw);
  if (direct) return hasCategory(config, direct) ? direct : '';
  const byLabel = LABEL_TO_KEY[raw];
  if (byLabel) return byLabel;
  const key = extraKey(raw);
  return key && hasCategory(config, key) ? key : '';
}

/**
 * 内置同义词表：模型爱写「可爱」「生气」这种口语，映射回内置三类。
 * 只在精确匹配和子串都没命中时才用 —— 用户自己建了个「生气」分类时，
 * 「生气」要归到用户的分类，不能被内置的 angry 抢走。
 */
const SYNONYMS = Object.freeze({
  cute: ['可爱', '萌', '撒娇', '害羞', '亲亲'],
  angry: ['生气', '愤怒', '火大', '暴躁', '烦', '讨厌'],
  happy: ['高兴', '开心', '好笑', '搞笑', '哈哈', '乐', '笑', '鼓掌'],
});

/**
 * 模型写的分类名 → 真实存在的分类 key（cute / angry / happy / x:标签）。
 * 候选集每次现读（内置三类 + data/sticker-categories.json 里的自定义分类），
 * 所以用户刚加的分类不用重启就能认出来。认不出返回 ''。
 *
 * 判断顺序：候选为空 → 精确（label / key / ALIASES 旧名）→ 子串 → 内置同义词 → ''。
 * 全用 === / includes / 查表，不用正则。
 */
function resolveCategory(config, value) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return '';
  const candidates = promptCategories(config, config && config.root);
  if (!candidates.length) return '';
  // b. 精确：标签、内部 key、旧别名
  for (const cat of candidates) if (raw === cat.label) return cat.key;
  const direct = normalizeEmotion(raw);
  if (direct && candidates.some((cat) => cat.key === direct)) return direct;
  // c. 子串：标签 ≥2 字才参与；单字（例如用户建的「猫」）只认精确
  const hits = new Map();
  for (const cat of candidates) {
    const label = cat.label;
    if (label.length < 2) continue;
    const byLabel = raw.includes(label);
    const byValue = raw.length >= 2 && label.includes(raw);
    if (byLabel || byValue) hits.set(cat.key, Math.max(hits.get(cat.key) || 0, label.length));
  }
  if (hits.size) {
    const longest = Math.max(...hits.values());
    const top = [...hits.entries()].filter(([, len]) => len === longest);
    if (top.length === 1) return top[0][0];   // 并列第一 → 不猜，留给同义词和兜底
  }
  // d. 内置同义词（必须排在 b、c 之后，否则会抢走用户自建的同名分类）
  for (const [key, words] of Object.entries(SYNONYMS)) if (words.includes(raw)) return key;
  return '';
}

/** 给提示词用：可用分类 + 各自张数（内置三类在前，自定义分类在后） */
function promptCategories(config, root) {
  const dir = stickerDir(config, root);
  const out = Object.keys(EMOTIONS).map((key) => ({
    key, label: EMOTIONS[key], count: categoryImages(dir, key).length,
  }));
  for (const cat of readExtraCategories(config, root)) {
    const label = cleanCategoryLabel(cat && cat.label);
    const key = extraKey(label);
    if (!key) continue;
    // 这里**不过滤**空分类：页签、resolveCategory 都要能看见用户刚建的文件夹。
    // 真正给模型看的清单在 src/persona/index.js 里，那边已经 .filter(c => c.count > 0)。
    out.push({ key, label, count: categoryImages(dir, key).length });
  }
  return out;
}

function isUsableCategory(config, value) {
  const key = categoryFromName(config, value);
  if (!key) return false;
  const dir = stickerDir(config, config.root);
  return categoryImages(dir, key).length > 0;
}

/** 这个分类名属于哪一类老名字（撒娇→cute、嫌弃→angry、其他→happy） */
function familyKey(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^x:/, '');
  if (!raw) return '';
  if (LABEL_TO_KEY[raw]) return LABEL_TO_KEY[raw];
  for (const [key, names] of Object.entries(FOLDERS)) {
    if (names.includes(raw)) return key;
  }
  return '';
}

/** 优先开心，其次傲娇/炸毛，再其次第一个有图的自定义分类；都没有返回 '' */
function defaultCategory(config) {
  const dir = stickerDir(config, config.root);
  for (const key of ['happy', 'cute', 'angry']) {
    if (categoryImages(dir, key).length) return key;
  }
  for (const cat of readExtraCategories(config, config.root)) {
    const key = extraKey(cleanCategoryLabel(cat && cat.label));
    if (key && categoryImages(dir, key).length) return key;
  }
  return '';
}

/** 空分类/写错名字 → 家族映射到有图的分类；实在没有就退回默认分类 */
function resolveUsableCategory(config, value) {
  const direct = categoryFromName(config, value);
  if (direct && isUsableCategory(config, direct)) return direct;
  const fam = familyKey(value);
  if (fam && isUsableCategory(config, fam)) return fam;
  return defaultCategory(config);
}

/** 从一句用户原话里找分类名（“发个阴阳怪气”）；只认有图的分类 */
function categoryInText(config, value) {
  const text = String(value == null ? '' : value);
  const usable = promptCategories(config, config.root)
    .filter((c) => c.count > 0)
    .sort((a, b) => b.label.length - a.label.length);
  for (const c of usable) {
    if (c.label && text.includes(c.label)) return c.key;
  }
  for (const [label, key] of Object.entries(LABEL_TO_KEY)) {
    if (label && text.includes(label) && isUsableCategory(config, key)) return key;
  }
  return '';
}

// 程序补图时按语气挑一个近似的内置分类；挑不到就退回默认有图分类。
// 只在「必发」模式下用，模型自己写标记时完全不参与。
const MOOD_CUES = [
  ['angry', /(气死|烦死|火大|滚|骂|傻|离谱|无语|闭嘴|恶心|欠揍|找打|生气|愤怒)/],
  ['cute', /(抱抱|亲亲|喜欢|想你|可爱|撒娇|贴贴|乖|害羞|心疼)/],
  ['happy', /(哈哈|笑死|好耶|开心|太棒|厉害|牛|恭喜|升职|庆祝|绝了)/],
];
function moodCategory(config, value) {
  const text = String(value == null ? '' : value);
  for (const [key, re] of MOOD_CUES) {
    if (re.test(text) && isUsableCategory(config, key)) return key;
  }
  return defaultCategory(config);
}

/** 内置分类的文件夹是硬编码的：被删掉就补回来（只补缺失的，不动已有内容） */
function ensureBuiltinDirs(config, root) {
  const dir = stickerDir(config, root);
  const created = [];
  for (const label of Object.values(EMOTIONS)) {
    const target = path.join(dir, label);
    if (fs.existsSync(target)) continue;
    fs.mkdirSync(target, { recursive: true });
    created.push(label);
  }
  return created;
}

/**
 * 挑一张表情包。分类由调用方（模型标记）给出，认不出也照样发一张：
 *   ① 认出的分类有图 → 用它；
 *   ② 否则先在有图的自定义分类里随机挑（用户自己建的优先）；
 *   ③ 再退到「开心」，然后按 cute / angry 找第一个有图的；
 *   ④ 整个图库一张图都没有 → null（这是唯一允许不发的情况，外加总闸关着）。
 * 返回带 fallbackFrom：模型原本写的分类名，没写就是空串，方便上层说明「改发了哪类」。
 */
function pick({ config, root, category = '', recent = [], rng = Math.random } = {}) {
  if (!isOn(config)) return null;
  const dir = stickerDir(config, root);
  const wanted = resolveCategory(config, category);
  const original = String(category == null ? '' : category).trim();
  if (wanted) {
    const file = choose(categoryImages(dir, wanted), rng, recent);
    if (file) return { emotion: wanted, path: file, fallbackFrom: '' };
  }
  // 兜底：自定义分类优先，其次开心，最后傲娇/炸毛
  const extras = readExtraCategories(config, root)
    .map((cat) => extraKey(cat && cat.label))
    .filter((key) => key && key !== wanted)
    .map((key) => ({ key, files: categoryImages(dir, key) }))
    .filter((item) => item.files.length);
  if (extras.length) {
    const index = Math.min(extras.length - 1, Math.max(0, Math.floor((Number(rng()) || 0) * extras.length)));
    const picked = extras[index];
    return { emotion: picked.key, path: choose(picked.files, rng, recent), fallbackFrom: original };
  }
  for (const key of ['happy', 'cute', 'angry']) {
    if (key === wanted) continue;
    const file = choose(categoryImages(dir, key), rng, recent);
    if (file) return { emotion: key, path: file, fallbackFrom: original };
  }
  return null;
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
    if (typeof data !== 'string' || data.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4) throw fail('单张图片太大（上限 4 MB）', 413);
    if (!data.length || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw fail('图片编码无效');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw fail('单张图片太大（上限 4 MB）', 413);
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
  // 目录 mtime 通常已经变了，但上传后界面会立刻读状态，别指望毫秒精度。
  invalidateScan(target);
  return uploaded;
}
module.exports = { EMOTIONS, EMOTION_LABELS, EXTRA_PREFIX, cleanCategoryLabel, extraKey, hasCategory, readExtraCategories, writeExtraCategories, categoryFile, discoverCategories, syncDiscoveredCategories, readIgnored, writeIgnored, normalizeEmotion, categoryFromName, resolveCategory, SYNONYMS, promptCategories, GENERIC, EXTS, MAX_FILE_BYTES, MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES,
  hasEmotion, resolveImage, safeDirectory, migrateLegacy, migrateLegacyAsync, ensureBuiltinDirs, stickerDir, regularFile, listImages, listImagesAsync, categoryImages, categoryImagesAsync, categoryItems, categoryItemsAsync, categoryDir, targetForOpen, imagesFor, anyImages, isOn,
  invalidateScan, clearScanCache, choose, pick, isStickerRequest, imageType, upload,
  isSeriousText, isLivelyText, SERIOUS_WINDOW_MS, SERIOUS_TURNS,
  isUsableCategory, defaultCategory, resolveUsableCategory, categoryInText, setProbeLogger, moodCategory };
