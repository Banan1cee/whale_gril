'use strict';

/**
 * 4.0 / 3.x 旧记忆 → v2 chats 目录。
 *
 * 原则：
 *  - 不删、不改旧文件；在 data/memory/legacy/ 留一份只读副本。
 *  - 每个旧会话 key 落到自己的 chat 目录，绝不跨 chat 合并。
 *  - 旧 notes 一律标 legacy、置信度 0.4，等以后被新对话纠正/加强。
 *  - 幂等：manifest.migratedFrom 记源文件 + journal 的大小/时间，重复启动不会重复导入。
 *  - 4.0 已经存在的 chat 不再整段跳过：按消息时间线合并进来（去重后重排 seq），
 *    这样「先升级到 4.0、又有 3.x 旧记忆」的情况不会把旧对话丢掉。
 */
const fs = require('node:fs');
const path = require('node:path');
const personCard = require('./personCard');
const compression = require('./compression');
const { writeJsonAtomic } = require('./chatStore');
const { describeError } = require('../infra/errors');

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

/** 快照 + 增量合并；旧版本把最新数据放在 journal 里 */
function mergeStoreSessions(snap, journal = []) {
  const sessions = snap && snap.sessions && typeof snap.sessions === 'object' ? { ...snap.sessions } : {};
  for (const entry of Array.isArray(journal) ? journal : []) {
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

/** 读快照 + 增量；旧版本把最新数据放在 journal 里 */
function readLegacyStore(file) {
  return mergeStoreSessions(readJson(file) || {}, readJournal(file));
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
      try { fs.chmodSync(target, 0o444); } catch { /* 来说文件系统不支持就算了 */ }
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

/* ------------------------------ 消息 / 人物卡 ------------------------------ */

function normalizeLegacyMessages(list, now) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    if (!m || !m.text) continue;
    const text = String(m.text);
    if (!text.trim()) continue;
    out.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      name: String(m.name || ''),
      uid: m.uid ? String(m.uid) : '',
      text,
      ts: Number(m.ts) || now,
      msgId: m.msgId || '',
      addressedToBot: Boolean(m.addressedToBot),
      error: Boolean(m.error),
    });
  }
  return out;
}

function messageKey(m) {
  // v2 落盘时正文最多 4000 字；旧消息更长时要先截断再比对，否则每次重导都会当成新消息
  const text = String(m.text || '').slice(0, 4000).trim();
  return `${m.role === 'assistant' ? 'assistant' : 'user'}|${text}|${Math.floor(Number(m.ts) || 0)}`;
}

function activeTextSet(card) {
  return new Set(personCard.activePreferences(card).map((p) => p.text));
}

/** 算出这个 session 里有、但目标 chat 还没有的 notes（dry-run 也用它） */
function planNotes({ session, chat, chatStore, now }) {
  const profiles = session.profiles && typeof session.profiles === 'object' ? session.profiles : {};
  const plan = [];
  let total = 0;
  for (const [uid, profile] of Object.entries(profiles)) {
    if (!profile || !uid) continue;
    const card = chat ? chatStore.getCard(chat, uid) : null;
    const have = activeTextSet(card);
    const fresh = (Array.isArray(profile.notes) ? profile.notes : [])
      .map((note) => legacyNoteToPreference(note, now))
      .filter((pref) => pref && !have.has(pref.text));
    if (fresh.length) plan.push({ uid, profile, fresh });
    total += fresh.length;
  }
  return { plan, total };
}

function applyNotes({ chat, chatStore, plan, now }) {
  let applied = 0;
  for (const item of plan) {
    let card = chatStore.getCard(chat, item.uid);
    const beforeCount = card ? Number(card.count) || 0 : 0;
    if (!card) card = chatStore.ensurePerson(chat, item.uid, item.profile.name || '');
    if (item.profile.name && !card.name) card.name = String(item.profile.name).slice(0, 60);
    if (item.profile.nickname && !card.nickname) card.nickname = String(item.profile.nickname).slice(0, 60);
    card.count = Math.max(beforeCount, Number(item.profile.count) || 0);
    if (Number(item.profile.firstSeenAt)) card.firstSeenAt = Math.min(Number(card.firstSeenAt) || Infinity, Number(item.profile.firstSeenAt));
    if (Number(item.profile.lastSeenAt)) card.lastSeenAt = Math.max(Number(card.lastSeenAt) || 0, Number(item.profile.lastSeenAt));
    for (const pref of item.fresh) {
      personCard.addPreference(card, { ...pref, explicit: false }, { chatId: chat.chatId, now });
      applied += 1;
    }
    chatStore.saveCard(chat, card);
  }
  return applied;
}

function mergeChatMeta({ chat, session }) {
  const seen = new Set(Array.isArray(chat.meta.seenIds) ? chat.meta.seenIds : []);
  for (const id of Array.isArray(session.seenIds) ? session.seenIds : []) if (id) seen.add(String(id));
  chat.meta.seenIds = [...seen].slice(-500);

  const events = new Map();
  for (const e of Array.isArray(chat.meta.events) ? chat.meta.events : []) {
    if (e && e.type && e.detail) events.set(`${e.ts}|${e.type}|${e.detail}`, e);
  }
  for (const e of Array.isArray(session.events) ? session.events : []) {
    if (e && e.type && e.detail) events.set(`${e.ts}|${e.type}|${e.detail}`, e);
  }
  chat.meta.events = [...events.values()].slice(-60);
}

/** 合并后 seq 全变了，把摘要的 coveredThroughSeq / segments 跟着映射 */
function remapSummary({ chat, chatStore, seqOf, oldCovered, coveredBroken = false }) {
  if (!chat.summary || !oldCovered) return;
  const mapped = seqOf.get(Number(oldCovered));
  if (!mapped || coveredBroken) {
    // 覆盖边界已经对不上（原文被裁过），或者合并进来的旧消息落在覆盖线之前，
    // 摘要就不再是「从头连续覆盖」了。留着会和原文重复/漏掉旧内容，清空让下一轮重压。
    chat.summary = { chatId: chat.chatId, episodeId: '', text: '', tokens: 0, coveredThroughSeq: 0, segments: [], updatedAt: Date.now() };
    chatStore.saveSummary(chat);
    return;
  }
  const segments = Array.isArray(chat.summary.segments) ? chat.summary.segments : [];
  let mappedSegs = [];
  for (const seg of segments) {
    const from = seqOf.get(Number(seg.fromSeq)) || 0;
    const to = seqOf.get(Number(seg.toSeq)) || 0;
    if (to) mappedSegs.push({ ...seg, fromSeq: from || 1, toSeq: to });
  }
  if (segments.length && mappedSegs.length !== segments.length) {
    mappedSegs = [{ text: chat.summary.text, tokens: chat.summary.tokens, fromSeq: 1, toSeq: mapped, at: Date.now() }];
  }
  chat.summary.coveredThroughSeq = mapped;
  if (mappedSegs.length) chat.summary.segments = mappedSegs;
  chat.summary.updatedAt = Date.now();
  chatStore.saveSummary(chat);
}

/** 合并后 episode 的 seq 区间也要跟着映射，对不上就开新 episode */
function remapEpisode({ chat, seqOf, oldEp }) {
  if (!oldEp) return;
  const from = seqOf.get(Number(oldEp.messageSeqFrom));
  const to = seqOf.get(Number(oldEp.messageSeqTo));
  if (from && to) {
    chat.meta.episode = { ...chat.meta.episode, messageSeqFrom: from, messageSeqTo: Math.max(from, to) };
  } else {
    chat.meta.episode = null;
  }
}

/* ------------------------------ 导入 / 合并 ------------------------------ */

/**
 * 旧 session 已有同名 chat：只补缺的消息和 notes，按时间重排。
 * 返回 { merged, messages, notes, totalMessages }。
 */
function mergeSession({ chat, chatStore, session, sourceName, logger, now, dryRun }) {
  const incoming = normalizeLegacyMessages(session.messages, now);
  const seen = new Set(chat.messages.map(messageKey));
  const add = [];
  for (const m of incoming) {
    const key = messageKey(m);
    if (seen.has(key)) continue;
    seen.add(key);
    add.push(m);
  }
  const { plan, total: notes } = planNotes({ session, chat, chatStore, now });

  if (dryRun) {
    return {
      imported: false, merged: true, dryRun: true, chatId: chat.chatId,
      messages: add.length, notes, totalMessages: chat.messages.length + add.length, source: sourceName,
    };
  }
  if (!add.length && !plan.length) {
    return { imported: false, merged: true, unchanged: true, chatId: chat.chatId, messages: 0, notes: 0, totalMessages: chat.messages.length };
  }

  const oldCovered = Number(chat.summary && chat.summary.coveredThroughSeq) || 0;
  const oldEp = chat.meta.episode ? { ...chat.meta.episode } : null;

  if (add.length) {
    // 已存在的消息保持原有相对顺序，新旧一起按 ts 排；同 ts 用 __order 稳定排序
    const merged = [];
    chat.messages.forEach((m, i) => merged.push({ ...m, __order: i }));
    add.forEach((m, i) => merged.push({ ...m, __order: chat.messages.length + i }));
    merged.sort((a, b) => (a.ts - b.ts) || (a.__order - b.__order));

    // 补进来的旧消息如果比「摘要覆盖线」还早，摘要就不再连续覆盖，必须清空重压
    const coveredMsg = oldCovered ? chat.messages.find((m) => m.seq === oldCovered) : null;
    const coveredBroken = Boolean(oldCovered) && (!coveredMsg || add.some((m) => m.ts < coveredMsg.ts));

    const { seqOf } = chatStore.replaceMessages(chat, merged);
    remapSummary({ chat, chatStore, seqOf, oldCovered, coveredBroken });
    remapEpisode({ chat, seqOf, oldEp });
  }
  // 只有 notes 变化时不重写原文、不动 seq，摘要/episode 也就无需映射
  const applied = applyNotes({ chat, chatStore, plan, now });
  mergeChatMeta({ chat, session });
  chat.meta.importedAt = now;
  chatStore.saveMeta(chat, { immediate: true });
  if (logger) {
    logger.info(`合并旧记忆：${sourceName} → ${chat.chatId}（补 ${add.length} 条消息 / ${applied} 条偏好，共 ${chat.messages.length} 条）`);
  }
  return {
    imported: false, merged: true, chatId: chat.chatId,
    messages: add.length, notes: applied, totalMessages: chat.messages.length,
  };
}

function importSession({ chatStore, key, session, sourceName, now, logger, dryRun }) {
  const chatId = canonicalChatId(key, session);
  const existing = chatStore.chats.get(chatId);
  if (existing) return mergeSession({ chat: existing, chatStore, session, sourceName, logger, now, dryRun });

  const messages = normalizeLegacyMessages(session.messages, now);
  const { plan, total: notes } = planNotes({ session, chat: null, chatStore, now });

  if (dryRun) {
    return {
      imported: true, dryRun: true, chatId, messages: messages.length,
      notes, totalMessages: messages.length, source: sourceName,
    };
  }

  const chat = chatStore.ensureChat(chatId, {
    platform: session.platform || chatId.split(':')[0] || 'wechat',
    chatType: session.chatType === 'group' ? 'group' : 'private',
    title: session.title || '',
    legacy: true,
  });
  chat.meta.legacy = true;
  chat.meta.importedAt = now;
  if (session.state && typeof session.state === 'object') {
    chat.meta.state = { ...chat.meta.state, ...session.state };
  }
  if (Array.isArray(session.seenIds)) chat.meta.seenIds = session.seenIds.map(String).slice(-500);
  if (Array.isArray(session.events)) {
    chat.meta.events = session.events.filter((e) => e && e.type && e.detail).slice(-60);
  }

  for (const m of messages) {
    chatStore.appendMessage(chat, {
      role: m.role,
      name: m.name,
      uid: m.uid,
      text: m.text,
      ts: m.ts,
      msgId: m.msgId,
      addressedToBot: m.addressedToBot,
      error: m.error,
    });
  }

  const applied = applyNotes({ chat, chatStore, plan, now });

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
  return { imported: true, merged: false, chatId, messages: messages.length, notes: applied, totalMessages: messages.length };
}

/**
 * 把一组旧 session 灌进 v2。CLI 的 import / 启动迁移都走这里。
 * @returns {{imported:number, merged:number, unchanged:number, skipped:number, messages:number, notes:number, chats:string[], plan:Array}}
 */
function migrateSessions({ chatStore, sessions, sourceName = 'legacy', now = Date.now(), logger = null, dryRun = false }) {
  const report = { imported: 0, merged: 0, unchanged: 0, skipped: 0, messages: 0, notes: 0, chats: [], plan: [] };
  for (const [key, session] of Object.entries(sessions || {})) {
    if (!session || typeof session !== 'object') {
      report.skipped += 1;
      continue;
    }
    try {
      const result = importSession({ chatStore, key, session, sourceName, now, logger, dryRun });
      if (result.imported) report.imported += 1;
      else if (result.merged && result.unchanged) report.unchanged += 1;
      else if (result.merged) report.merged += 1;
      report.messages += Number(result.messages) || 0;
      report.notes += Number(result.notes) || 0;
      if (result.chatId) report.chats.push(result.chatId);
      report.plan.push(result);
    } catch (err) {
      report.skipped += 1;
      if (logger) logger.warn(`迁移旧记忆失败（${key}）：${describeError(err)}`);
    }
  }
  return report;
}

/* ------------------------------ 启动时自动迁移 ------------------------------ */

/** 签名带上 journal：3.x 只追加 journal 时 store.json 的 size/mtime 不变，也要能再次迁移 */
function sourceSignature(file) {
  const parts = [];
  for (const f of [file, `${file}.journal`]) {
    try {
      const st = fs.statSync(f);
      parts.push(`${st.size}:${Math.round(st.mtimeMs)}`);
    } catch {
      parts.push('-');
    }
  }
  return parts.join('|');
}

const IMPORT_NOTICE_FILE = 'import-report.json';

function noticePath(memoryDir) {
  return path.join(memoryDir, IMPORT_NOTICE_FILE);
}

/** data\store.json / data\memory.json 存在哪些、各自签名是什么 */
function collectLegacySources(memoryDir) {
  const dataDir = path.dirname(memoryDir);
  const sources = [];
  for (const name of LEGACY_SOURCES) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) continue;
    let st;
    try { st = fs.statSync(file); } catch { continue; }
    sources.push({
      name,
      file,
      size: st.size,
      mtimeMs: Math.round(st.mtimeMs),
      signature: `${name}:${sourceSignature(file)}`,
    });
  }
  return sources;
}

function doneSignatures(manifest) {
  return new Set((Array.isArray(manifest && manifest.migratedFrom) ? manifest.migratedFrom : [])
    .map((x) => (x && x.signature ? String(x.signature) : `${x.source}:${x.size}:${x.mtimeMs}`)));
}

function pendingSources(sources, manifest) {
  const done = doneSignatures(manifest);
  return sources.filter((s) => !done.has(s.signature));
}

/** 把多个旧源合并成一份 { key: session }；store.json 优先，memory.json 只补缺 */
function sessionsFromSources(pending) {
  const merged = new Map();
  for (const source of pending) {
    const sessions = source.name === 'memory.json' ? readMemoryJson(source.file) : readLegacyStore(source.file);
    for (const [key, session] of Object.entries(sessions || {})) {
      if (source.name === 'memory.json' && merged.has(key) && merged.get(key).source === 'store.json') continue;
      if (!merged.has(key) || source.name === 'store.json') merged.set(key, { key, session, source: source.name });
    }
  }
  return Object.fromEntries([...merged.values()].map((item) => [item.key, item.session]));
}

/**
 * 启动器「记忆已导入并转换格式」提示用：记一份待确认的报告。
 * 启动时自动迁移、设置页手动转换都会写；launcher 展示后调 ackImportNotice。
 */
function writeImportNotice(memoryDir, report, { sources = [], now = Date.now() } = {}) {
  if (!report) return null;
  if (!(report.imported + report.merged + report.skipped > 0)) return null;
  const payload = {
    version: 1,
    at: now,
    sources,
    imported: report.imported,
    merged: report.merged,
    unchanged: report.unchanged,
    skipped: report.skipped,
    messages: report.messages,
    notes: report.notes,
    chats: report.chats.length,
    acked: false,
  };
  try {
    writeJsonAtomic(noticePath(memoryDir), payload);
    return payload;
  } catch {
    return null;
  }
}

function readImportNotice(memoryDir) {
  const raw = readJson(noticePath(memoryDir));
  if (!raw || raw.acked) return null;
  return raw;
}

function ackImportNotice(memoryDir) {
  const raw = readJson(noticePath(memoryDir));
  if (!raw) return { ok: true, missing: true };
  if (raw.acked) return { ok: true, already: true };
  raw.acked = true;
  raw.ackedAt = Date.now();
  writeJsonAtomic(noticePath(memoryDir), raw);
  return { ok: true, at: raw.at };
}

/**
 * 只读检测：有没有待转换的旧记忆、会补多少（dry-run，不写盘）。
 * 设置页「一键识别转换记忆」和启动器启动检查都读它。
 */
function legacyStatus({ memoryDir, chatStore, now = Date.now() }) {
  const sources = collectLegacySources(memoryDir);
  const manifest = readJson(path.join(memoryDir, 'manifest.json')) || {};
  const pending = pendingSources(sources, manifest);
  const pendingNames = new Set(pending.map((s) => s.name));
  const status = {
    pending: pending.length > 0,
    sources: sources.map((s) => ({ name: s.name, size: s.size, mtimeMs: s.mtimeMs, imported: !pendingNames.has(s.name) })),
    plan: null,
    notice: readImportNotice(memoryDir),
  };
  if (pending.length && chatStore) {
    const report = migrateSessions({
      chatStore,
      sessions: sessionsFromSources(pending),
      sourceName: pending.map((s) => s.name).join('+'),
      now,
      dryRun: true,
    });
    status.plan = {
      imported: report.imported,
      merged: report.merged,
      messages: report.messages,
      notes: report.notes,
      chats: report.chats.length,
    };
  }
  return status;
}

/**
 * @returns {{migrated:number, chats:string[], report:object|null, sources:string[]}}
 */
function migrateIfNeeded({ memoryDir, chatStore, logger = null, now = Date.now(), force = false, dryRun = false }) {
  const manifestFile = path.join(memoryDir, 'manifest.json');
  const manifest = readJson(manifestFile) || {};
  const sources = collectLegacySources(memoryDir);
  if (!sources.length) return { migrated: 0, chats: [], report: null, sources: [] };
  const pending = force ? sources : pendingSources(sources, manifest);
  if (!pending.length) return { migrated: 0, chats: [], report: null, sources: [] };

  const report = migrateSessions({
    chatStore,
    sessions: sessionsFromSources(pending),
    sourceName: pending.map((s) => s.name).join('+'),
    now,
    logger,
    dryRun,
  });
  const chats = report.chats;

  if (!dryRun) {
    for (const source of pending) {
      copyLegacyBackup(memoryDir, source.file, logger);
      manifest.migratedFrom = [...(manifest.migratedFrom || []), {
        source: source.name,
        size: source.size,
        mtimeMs: source.mtimeMs,
        signature: source.signature,
        at: now,
      }].slice(-40);
    }
    manifest.updatedAt = now;
    if (chatStore) {
      if (typeof chatStore.stats === 'function') {
        const s = chatStore.stats();
        manifest.stats = { chats: s.chats, messages: s.messages };
      }
      // 关键：把迁移记录交回 ChatStore。否则它内存里还是迁移前的 manifest，
      // 下一次 saveMeta 的 _refreshManifestStats 会把 migratedFrom 覆盖成旧值。
      chatStore.manifest = manifest;
    }
    try {
      writeJsonAtomic(manifestFile, manifest);
    } catch { /* 写不了会在下次启动重试 */ }
    writeImportNotice(memoryDir, report, { sources: pending.map((s) => s.name), now });
  }
  if (chats.length && logger) logger.info(`旧记忆迁移完成：${chats.length} 个聊天`);
  return { migrated: chats.length, chats, report, sources: pending.map((s) => s.name) };
}

/** CLI import 用：认 store.json / memory.json / v1 备份包（files.store） */
function readSessionsFile(file) {
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind === 'whale-girl-memory' && raw.files && typeof raw.files === 'object') {
    const store = raw.files.store;
    if (store && typeof store === 'object' && store.sessions) {
      return { name: path.basename(file), format: '备份包 v1（store）', sessions: mergeStoreSessions(store, []) };
    }
    return null;
  }
  if (raw.sessions && typeof raw.sessions === 'object') {
    return { name: path.basename(file), format: 'store.json', sessions: mergeStoreSessions(raw, readJournal(file)) };
  }
  const sessions = readMemoryJson(file);
  if (Object.keys(sessions).length) return { name: path.basename(file), format: 'memory.json', sessions };
  return null;
}

module.exports = {
  migrateIfNeeded,
  migrateSessions,
  legacyStatus,
  readImportNotice,
  writeImportNotice,
  ackImportNotice,
  readSessionsFile,
  readLegacyStore,
  readMemoryJson,
  canonicalChatId,
  LEGACY_SOURCES,
};
