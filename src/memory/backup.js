'use strict';

/**
 * 记忆备份 / 恢复（只给本机 CLI 和本地文件用，不再有 HTTP 接口、不在 UI 展示正文）。
 *
 * 备份格式 v2：把 data/memory 下的 json/jsonl 原样打包进一个文件；
 * 恢复时先给当前记忆留一份 before-restore 快照，再整体写回。
 */
const fs = require('node:fs');
const path = require('node:path');

const BUNDLE_VERSION = 2;
const KEEP = 20;
const MAX_TOTAL_MB = 300;
const SECRET_SETTING_KEYS = ['apiKey', 'keys', 'visionApiKey', 'voiceApiKey'];

const FILES = [
  { key: 'memory', name: 'memory/' },
  { key: 'persona', name: 'persona.json' },
  { key: 'settings', name: 'settings.json' },
  { key: 'careState', name: 'care-state.json' },
  { key: 'shareState', name: 'share-state.json' },
];

function stampMs(date = new Date()) {
  return stamp(date) + '-' + String(date.getMilliseconds()).padStart(3, '0');
}

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

function scrubSecrets(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const copy = JSON.parse(JSON.stringify(settings));
  for (const k of SECRET_SETTING_KEYS) delete copy[k];
  return copy;
}

/** 只打包记忆本体；legacy/archive 是只读备份，不进 bundle（避免越备越大） */
function collectMemoryFiles(memoryDir) {
  const out = {};
  if (!fs.existsSync(memoryDir)) return out;
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && (entry.name === 'legacy' || entry.name === 'archive')) continue;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), r);
      } else if (/\.(json|jsonl|txt)$/.test(entry.name)) {
        try { out[r] = fs.readFileSync(path.join(dir, entry.name), 'utf8'); } catch { /* 跳过读不了的文件 */ }
      }
    }
  };
  walk(memoryDir, '');
  return out;
}

function collect(root, { withSecrets = false } = {}) {
  const dir = dataDir(root);
  const bundle = {
    kind: 'whale-girl-memory',
    version: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    withSecrets: Boolean(withSecrets),
    files: {},
  };
  const memory = collectMemoryFiles(path.join(dir, 'memory'));
  if (Object.keys(memory).length) bundle.files.memory = memory;
  for (const item of FILES) {
    if (item.key === 'memory') continue;
    const value = readJson(path.join(dir, item.name));
    if (value === null) continue;
    bundle.files[item.key] = item.key === 'settings' && !withSecrets ? scrubSecrets(value) : value;
  }
  return bundle;
}

function countMessages(raw) {
  if (!raw) return 0;
  let n = 0;
  for (const line of String(raw).split('\n')) if (line.trim()) n += 1;
  return n;
}

function summarize(bundle) {
  const memory = (bundle && bundle.files && bundle.files.memory) || {};
  const chats = new Set();
  let messages = 0;
  let notes = 0;
  for (const [rel, body] of Object.entries(memory)) {
    const m = /^chats\/([0-9a-f]{16})\//.exec(rel);
    if (m) chats.add(m[1]);
    if (/^chats\/[0-9a-f]{16}\/messages\.jsonl$/.test(rel)) messages += countMessages(body);
    if (/^chats\/[0-9a-f]{16}\/people\/[0-9a-f]{16}\.json$/.test(rel)) {
      try {
        const card = JSON.parse(body);
        notes += (Array.isArray(card.preferences) ? card.preferences.filter((p) => !p.deleted && !p.superseded).length : 0);
      } catch { /* 坏卡不影响统计 */ }
    }
  }
  return { sessions: chats.size, messages, notes };
}

function writeSnapshot(root, reason = 'manual') {
  const bundle = collect(root, { withSecrets: true });
  const { sessions, messages } = summarize(bundle);
  if (!sessions && !messages && reason !== 'manual') return null;

  const dir = backupDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const stampStr = stampMs();
  let file = path.join(dir, `memory-${stampStr}-${reason}.json`);
  for (let i = 1; fs.existsSync(file); i += 1) {
    file = path.join(dir, `memory-${stampStr}-${reason}-${i}.json`);
  }
  fs.writeFileSync(file, JSON.stringify(bundle), 'utf8');

  const all = fs.readdirSync(dir)
    .filter((n) => n.startsWith('memory-') && n.endsWith('.json'))
    .map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of all.slice(KEEP)) {
    try { fs.unlinkSync(path.join(dir, old.n)); } catch { /* 删不掉就算了 */ }
  }
  try {
    const files = fs.readdirSync(dir)
      .filter((n) => n.startsWith('memory-') && n.endsWith('.json'))
      .map((n) => ({ n, size: fs.statSync(path.join(dir, n)).size, t: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    let total = files.reduce((sum, x) => sum + x.size, 0);
    while (files.length > 3 && total > MAX_TOTAL_MB * 1024 * 1024) {
      const victim = files.pop();
      try {
        fs.unlinkSync(path.join(dir, victim.n));
        total -= victim.size;
      } catch { break; }
    }
  } catch { /* 清理失败不影响备份本身 */ }
  return file;
}

function exportTo(root, destFile, { withSecrets = false } = {}) {
  const bundle = collect(root, { withSecrets });
  if (!bundle.files.memory) throw new Error('还没有记忆可导出（data/memory 是空的）');
  bundle.reason = 'export';
  fs.mkdirSync(path.dirname(path.resolve(destFile)), { recursive: true });
  fs.writeFileSync(destFile, JSON.stringify(bundle), 'utf8');
  return { file: destFile, ...summarize(bundle) };
}

function listBackups(root) {
  const dir = backupDir(root);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((n) => n.startsWith('memory-') && n.endsWith('.json'))
    .map((n) => {
      const full = path.join(dir, n);
      const st = fs.statSync(full);
      return { name: n, file: full, size: st.size, mtime: st.mtime, ...summarize(readJson(full)) };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function validateBundle(bundle) {
  if (!bundle || bundle.kind !== 'whale-girl-memory') {
    throw new Error('这个文件不是鲸鲸的记忆备份（缺少 kind=whale-girl-memory）');
  }
  const files = bundle.files || {};
  if (files.memory && (typeof files.memory !== 'object' || Array.isArray(files.memory))) {
    throw new Error('备份里的 memory 结构不对，为了不毁掉现在的记忆，已取消恢复');
  }
  if (!files.memory && !files.store) throw new Error('备份里没有可恢复的记忆');
  if (files.settings && typeof files.settings !== 'object') throw new Error('备份里的 settings 不是对象，已取消恢复');
  // 路径穿越防护：记忆包里的 key 只能是相对路径
  for (const rel of Object.keys(files.memory || {})) {
    if (rel.includes('..') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
      throw new Error('备份里有非法路径，已取消恢复：' + rel);
    }
  }
  return files;
}

function writeMemoryFiles(memoryDir, memory, { keepLegacy = true } = {}) {
  const legacyDir = path.join(memoryDir, 'legacy');
  const legacyBackup = keepLegacy && fs.existsSync(legacyDir)
    ? fs.readdirSync(legacyDir).map((n) => ({ n, body: fs.readFileSync(path.join(legacyDir, n)) }))
    : [];
  fs.rmSync(memoryDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
  fs.mkdirSync(memoryDir, { recursive: true });
  for (const [rel, body] of Object.entries(memory || {})) {
    const target = path.join(memoryDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(body), 'utf8');
  }
  if (legacyBackup.length) {
    fs.mkdirSync(legacyDir, { recursive: true });
    for (const item of legacyBackup) fs.writeFileSync(path.join(legacyDir, item.n), item.body);
  }
}

/** 从 bundle 恢复；恢复前先另存当前记忆 */
function restoreFrom(root, bundle) {
  const files = validateBundle(bundle);
  writeSnapshot(root, 'before-restore');
  const dir = dataDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const restored = [];

  if (files.memory) {
    writeMemoryFiles(path.join(dir, 'memory'), files.memory);
    restored.push('memory/');
  } else if (files.store) {
    // v1 备份：先落回旧文件，下一次启动会走迁移
    fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify(files.store), 'utf8');
    restored.push('store.json（旧版，启动后自动迁移）');
  }

  for (const item of FILES) {
    if (item.key === 'memory' || !(item.key in files)) continue;
    let value = files[item.key];
    if (item.key === 'settings') {
      const current = readJson(path.join(dir, item.name)) || {};
      const merged = { ...current, ...value };
      for (const k of SECRET_SETTING_KEYS) {
        if (value[k] === undefined && current[k] !== undefined) merged[k] = current[k];
      }
      value = merged;
    }
    fs.writeFileSync(path.join(dir, item.name), JSON.stringify(value, null, 2), 'utf8');
    restored.push(item.name);
  }
  return { restored, ...summarize(bundle) };
}

function restoreFromFile(root, file) {
  const bundle = readJson(file);
  if (!bundle) throw new Error('读不了这个文件，或者不是合法 JSON：' + file);
  return restoreFrom(root, bundle);
}

module.exports = {
  BUNDLE_VERSION,
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
