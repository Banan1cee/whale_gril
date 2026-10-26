'use strict';

/**
 * 记忆备份 / 恢复。
 *
 * 为什么需要：以前的更新方式是把文件夹整个换掉，新目录里没有 data\，
 * 用户看起来就是「更新完记忆全没了」。现在每份记忆都能导出成一个 json，
 * 换机器、换目录、重装都能搬回去；启动时也会自动留一份快照。
 */
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_VERSION = 1;
/** 要带走的都在 data\ 下：store=聊天记忆，persona=调教台覆盖，settings=Key/称呼/群设置 */
const FILES = [
  { key: 'store', name: 'store.json' },
  { key: 'persona', name: 'persona.json' },
  { key: 'settings', name: 'settings.json' },
  { key: 'careState', name: 'care-state.json' },
  { key: 'shareState', name: 'share-state.json' },
];
const KEEP = 20;

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function dataDir(root) {
  return path.join(root, 'data');
}

function backupDir(root) {
  return path.join(dataDir(root), 'backups');
}

/** 打包记忆（不落盘），返回 bundle 对象 */
function collect(root) {
  const dir = dataDir(root);
  const bundle = {
    kind: 'whale-girl-memory',
    version: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    files: {},
  };
  for (const item of FILES) {
    const value = readJson(path.join(dir, item.name));
    if (value !== null) bundle.files[item.key] = value;
  }
  return bundle;
}

/** 统计一下，给页面/命令行看得懂的数字 */
function summarize(bundle) {
  const store = bundle && bundle.files && bundle.files.store;
  const sessions = store && store.sessions ? Object.keys(store.sessions) : [];
  let messages = 0;
  let notes = 0;
  for (const key of sessions) {
    const s = store.sessions[key] || {};
    if (Array.isArray(s.messages)) messages += s.messages.length;
    const profiles = s.profiles || {};
    for (const uid of Object.keys(profiles)) {
      if (Array.isArray(profiles[uid].notes)) notes += profiles[uid].notes.length;
    }
  }
  return { sessions: sessions.length, messages, notes };
}

/** 写一份快照到 data\backups\，保留最近 KEEP 份 */
function writeSnapshot(root, reason = 'manual') {
  const bundle = collect(root);
  const { sessions, messages } = summarize(bundle);
  // 空库不占位（第一次启动时 data 是干净的）
  if (!sessions && !messages && reason !== 'manual') return null;

  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `memory-${stamp()}-${reason}.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2), 'utf8');

  // 只留最近 KEEP 份，别把盘塞满
  const all = fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('memory-') && n.endsWith('.json'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of all.slice(KEEP)) {
    try {
      fs.unlinkSync(path.join(dir, old.n));
    } catch {
      /* 删不掉就算了 */
    }
  }
  return file;
}

/** 导出到指定路径（用户自己选位置，比如桌面/U 盘） */
function exportTo(root, destFile) {
  const bundle = collect(root);
  bundle.reason = 'export';
  fs.mkdirSync(path.dirname(path.resolve(destFile)), { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(bundle, null, 2), 'utf8');
  return { file: destFile, ...summarize(bundle) };
}

function listBackups(root) {
  const dir = backupDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith('memory-') && n.endsWith('.json'))
    .map((n) => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      const bundle = readJson(full);
      return { name: n, file: full, size: st.size, mtime: st.mtime, ...summarize(bundle) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 从 bundle 恢复。恢复前先把「当前的样子」另存一份，避免误操作把新记忆也弄没。
 * 返回恢复了哪些文件。
 */
function restoreFrom(root, bundle) {
  if (!bundle || bundle.kind !== 'whale-girl-memory') {
    throw new Error('这个文件不是鲸鲸的记忆备份（缺少 kind=whale-girl-memory）');
  }
  const files = bundle.files || {};
  const keys = Object.keys(files);
  if (!keys.length) throw new Error('备份里没有可恢复的内容');

  writeSnapshot(root, 'before-restore');

  const dir = dataDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const restored = [];
  for (const item of FILES) {
    if (!(item.key in files)) continue;
    fs.writeFileSync(path.join(dir, item.name), JSON.stringify(files[item.key], null, 2), 'utf8');
    restored.push(item.name);
  }
  return { restored, ...summarize(bundle) };
}

/** 从磁盘上的备份文件恢复 */
function restoreFromFile(root, file) {
  const bundle = readJson(file);
  if (!bundle) throw new Error('读不了这个文件，或者不是合法 JSON：' + file);
  return restoreFrom(root, bundle);
}

module.exports = {
  collect,
  summarize,
  writeSnapshot,
  exportTo,
  listBackups,
  restoreFrom,
  restoreFromFile,
  backupDir,
  FILES,
  KEEP,
};
