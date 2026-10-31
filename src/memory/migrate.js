'use strict';

/**
 * 4.0 / 3.x 旧记忆 → v2 chats 目录。
 *
 * 原则：
 *  - 不删、不改旧文件；在 data/memory/legacy/ 留一份只读副本。
 *  - 每个旧会话 key 落到自己的 chat 目录，绝不跨 chat 合并。
 *  - 旧 notes 一律标 legacy、置信度 0.4，等以后被新对话纠正/加强。
 *  - 幂等：manifest.migratedFrom 记源文件大小 + mtime，重复启动不会重复导入。
 */
const fs = require('node:fs');
const path = require('node:path');
const personCard = require('./personCard');
const compression = require('./compression');

const LEGACY_SOURCES = ['memory.json', 'store.json'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function readJournal(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file + '.journal', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 半截行跳过 */ }
  }
  return out;
}

/** 读快照 + 增量；旧版本把最新数据放在 journal 里 */
function readLegacyStore(file) {
  const snap = readJson(file) || {};
  const sessions = snap.sessions && typeof snap.sessions === 'object' ? { ...snap.sessions } : {};
  for (const entry of readJournal(file)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.full) {
      for (const key of Object.keys(sessions)) delete sessions[key];
      Object.assign(sessions, entry.sessions || {});
    } else if (entry.sessions && typeof entry.sessions === 'object') {
      Object.assign(sessions, entry.sessions);
    }
    if (Array.isArray(entry.removed)) for (const key of entry.removed) delete sessions[key];
  }
  return sessions;
}

/** memory.json 可能是 {sessions}，也可能是 {key: session}；都兼容 */
function readMemoryJson(file) {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return {};
  if (raw.sessions && typeof raw.sessions === 'object') return raw.sessions;
  if (raw.chats && typeof raw.chats === 'object') return raw.chats;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === 'object' && (Array.isArray(value.messages) || value.profiles)) out[key] = value;
  }
  return out;
}

function canonicalChatId(key, session) {
  const k = String(key || '');
  if (/^[a-z0-9_-]+:[ug]:.+$/i.test(k)) return k;
  const platform = String((session && session.platform) || 'wechat').slice(0, 20);
  const type = (session && session.chatType) === 'group' ? 'g' : 'u';
  const raw = String((session && session.chatId) || k || 'unknown');
  return `${platform}:${type}:${raw}`;
}

function legacyNoteToPreference(note, now) {
  if (typeof note === 'string') {
    return { text: note, kind: 'fact', confidence: 0.4, createdAt: now, lastMentionedAt: 0, mentions: 0, legacy: true };
  }
  if (!note || typeof note !== 'object') return null;
  const textValue = String(note.text || '').replace(/\s+/g, ' ').trim();
  if (!textValue) return null;
  return {
    text: textValue.slice(0, 80),
    kind: String(note.kind || 'fact').slice(0, 20),
    confidence: 0.4,
    createdAt: Number(note.createdAt) || now,
    lastMentionedAt: Number(note.lastMentionedAt) || 0,
    mentions: Number(note.mentions) || 0,
    legacy: true,
  };
}

function copyLegacyBackup(memoryDir, sourceFile, logger) {
  const legacyDir = path.join(memoryDir, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  const target = path.join(legacyDir, path.basename(sourceFile));
  if (!fs.existsSync(target)) {
    fs.copyFileSync(sourceFile, target);
    if (process.platform !== 'win32') {
      try { fs.chmodSync(target, 0o444); } catch { /* 文件系统不支持就算了 */ }
    }
  }
  const journal = sourceFile + '.journal';
  if (fs.existsSync(journal)) {
    const jt = path.join(legacyDir, path.basename(journal));
    if (!fs.existsSync(jt)) {
      fs.copyFileSync(journal, jt);
      if (process.platform !== 'win32') {
        try { fs.chmodSync(jt, 0o444); } catch { /* ignore */ }
      }
    }
  }
  const readme = path.join(legacyDir, 'README.txt');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, [
      '这些是迁移前的旧记忆文件（只读副本，程序不再读取）。',
      '新数据在 data/memory/chats/<chatHash>/ 下；旧文件没有删除。',
      '确认新记忆正常后，可以自己决定要不要删这个目录。',
    ].join('\r\n'), 'utf8');
  }
  if (logger) logger.info('旧记忆已保留只读副本：' + legacyDir);
}

function importSession({ chatStore, key, session, sourceName, now, logger }) {
  const chatId = canonicalChatId(key, session);
  if (chatStore.chats.has(chatId)) return { imported: false, reason: 'exists' };
  const chat = chatStore.ensureChat(chatId, {
    platform: session.platform || chatId.split(':')[0] || 'wechat',
    chatType: session.chatType === 'group' ? 'group' : 'private',
    title: session.title || '',
    legacy: true,
  });
  chat.meta.legacy = true;
  if (session.state && typeof session.state === 'object') {
    chat.meta.state = { ...chat.meta.state, ...session.state };
  }
  if (Array.isArray(session.seenIds)) chat.meta.seenIds = session.seenIds.map(String).slice(-500);
  if (Array.isArray(session.events)) {
    chat.meta.events = session.events.filter((e) => e && e.type && e.detail).slice(-60);
  }

  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (const m of messages) {
    if (!m || !m.text) continue;
    chatStore.appendMessage(chat, {
      role: m.role === 'assistant' ? 'assistant' : 'user',
      name: m.name || '',
      uid: m.uid || '',
      text: m.text,
      ts: Number(m.ts) || now,
      msgId: m.msgId || '',
      addressedToBot: Boolean(m.addressedToBot),
      error: Boolean(m.error),
    });
  }

  const profiles = session.profiles && typeof session.profiles === 'object' ? session.profiles : {};
  for (const [uid, profile] of Object.entries(profiles)) {
    if (!profile || !uid) continue;
    const card = chatStore.ensurePerson(chat, uid, profile.name || '');
    card.nickname = String(profile.nickname || card.nickname || '');
    card.count = Math.max(0, Number(profile.count) || 0);
    card.firstSeenAt = Number(profile.firstSeenAt) || card.firstSeenAt;
    card.lastSeenAt = Number(profile.lastSeenAt) || card.lastSeenAt;
    for (const note of Array.isArray(profile.notes) ? profile.notes : []) {
      const pref = legacyNoteToPreference(note, now);
      if (!pref) continue;
      personCard.addPreference(card, { ...pref, explicit: false }, { chatId, now });
    }
    chatStore.saveCard(chat, card);
  }

  const summaryText = String(session.summary || '').trim();
  const covered = Math.min(messages.length, Math.max(0, Number(session.summaryUpto) || 0));
  if (summaryText) {
    chat.summary = {
      chatId,
      episodeId: 'legacy',
      text: summaryText.slice(0, 1200),
      tokens: 0,
      coveredThroughSeq: covered,
      segments: [{ text: summaryText.slice(0, 1200), tokens: 0, fromSeq: 1, toSeq: covered, at: now }],
      updatedAt: now,
    };
    compression.recomputeSummary(chat);
    chatStore.saveSummary(chat);
  }
  chat.lastActiveAt = Number(session.lastActiveAt) || now;
  chatStore.saveMeta(chat, { immediate: true });
  chatStore.checkpoint(chat);
  if (logger) logger.info(`迁移旧记忆：${sourceName} → ${chatId}（${messages.length} 条消息）`);
  return { imported: true, chatId, messages: messages.length };
}

/**
 * @returns {{migrated:number, chats:string[]}}
 */
function migrateIfNeeded({ memoryDir, chatStore, logger = null, now = Date.now() }) {
  const dataDir = path.dirname(memoryDir);
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const manifest = readJson(manifestFile) || {};
  const done = new Set((Array.isArray(manifest.migratedFrom) ? manifest.migratedFrom : []).map((x) => `${x.source}:${x.size}:${x.mtimeMs}`));
  const sources = [];
  for (const name of LEGACY_SOURCES) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    sources.push({ name, file, size: st.size, mtimeMs: Math.round(st.mtimeMs), signature: `${name}:${st.size}:${Math.round(st.mtimeMs)}` });
  }
  if (!sources.length) return { migrated: 0, chats: [] };
  const pending = sources.filter((s) => !done.has(s.signature));
  if (!pending.length) return { migrated: 0, chats: [] };

  const merged = new Map();
  for (const source of pending) {
    const sessions = source.name === 'memory.json' ? readMemoryJson(source.file) : readLegacyStore(source.file);
    for (const [key, session] of Object.entries(sessions || {})) {
      // store.json 是 4.0 的主存；memory.json 只补 store.json 没有的 key，避免覆盖新数据
      if (source.name === 'memory.json' && merged.has(key) && merged.get(key).source === 'store.json') continue;
      if (!merged.has(key) || source.name === 'store.json') merged.set(key, { key, session, source: source.name });
    }
  }

  const chats = [];
  for (const item of merged.values()) {
    if (!item.session || typeof item.session !== 'object') continue;
    try {
      const result = importSession({ chatStore, key: item.key, session: item.session, sourceName: item.source, now, logger });
      if (result.imported) chats.push(result.chatId);
    } catch (err) {
      if (logger) logger.warn(`迁移旧记忆失败（${item.key}）：${(err && err.message) || err}`);
    }
  }

  for (const source of pending) {
    copyLegacyBackup(memoryDir, source.file, logger);
    manifest.migratedFrom = [...(manifest.migratedFrom || []), {
      source: source.name,
      size: source.size,
      mtimeMs: source.mtimeMs,
      at: now,
    }].slice(-40);
  }
  manifest.updatedAt = now;
  try {
    fs.writeFileSync(manifestFile, JSON.stringify(manifest), 'utf8');
  } catch { /* 写不了会在下次启动重试 */ }
  if (chats.length && logger) logger.info(`旧记忆迁移完成：${chats.length} 个聊天`);
  return { migrated: chats.length, chats };
}

module.exports = { migrateIfNeeded, readLegacyStore, readMemoryJson, canonicalChatId, LEGACY_SOURCES };
