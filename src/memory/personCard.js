'use strict';

/**
 * 人物卡：一个 chat 里的一个人，一张卡。
 *
 * 硬约束：card.chatId === source.chatId。
 * 任何写入都先校验 chatId，不一致直接抛 MEMORY_CHAT_MISMATCH —— 不做“自动改过去”，
 * 也不做“合并到当前 chat”，因为那正是串聊泄漏的入口。
 */
const { LIMITS, DAY_MS } = require('./constants');
const { shortId } = require('./hash');

class MemoryIsolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryIsolationError';
    this.code = 'MEMORY_CHAT_MISMATCH';
  }
}

function text(value, max = 200) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function norm(value) {
  return text(value, 400)
    .toLowerCase()
    .replace(/[\s，,。.!！？?；;：:、"'“”‘’（）()【】\[\]]/g, '');
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function nowOf(now) {
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

/* ------------------------------ 隔离校验 ------------------------------ */

function assertChat(card, chatId, action = 'write') {
  if (!card) throw new MemoryIsolationError('人物卡不存在');
  if (String(card.chatId) !== String(chatId)) {
    throw new MemoryIsolationError(
      `拒绝跨聊天${action}：card.chatId=${card.chatId}，source.chatId=${chatId}`,
    );
  }
  return card;
}

/* ------------------------------ 文本相似度 ------------------------------ */

function grams(value) {
  const s = norm(value);
  const out = new Set();
  if (s.length <= 1) {
    if (s) out.add(s);
    return [...out];
  }
  for (let i = 0; i + 1 < s.length; i += 1) out.add(s.slice(i, i + 2));
  return [...out];
}

function similarity(a, b) {
  const ta = grams(a);
  const tb = grams(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hit = 0;
  for (const g of ta) if (setB.has(g)) hit += 1;
  // 用较长的一条做分母：短文本是长文本前缀时不能算 1.0（“标签1”≠“标签14”）
  return hit / Math.max(ta.length, tb.length);
}

/* ------------------------------ 建卡 / 规范化 ------------------------------ */

function newCard({ chatId, uid, name = '', nickname = '', now = Date.now() }) {
  const at = nowOf(now);
  const id = text(uid, 100) || 'anonymous';
  return {
    version: 2,
    chatId: String(chatId),
    uid: id,
    name: text(name, 60) || '群友',
    nickname: text(nickname, 60),
    traits: [],
    preferences: [],
    events: [],
    threads: [],
    count: 0,
    firstSeenAt: at,
    lastSeenAt: at,
    updatedAt: at,
  };
}

/**
 * 从磁盘读出来的卡做一次规范化。
 * @param {object} raw
 * @param {{chatId:string, uid?:string}} expected 目录所代表的 chat / person
 * @returns {object|null} chatId 对不上返回 null（宁可不读，也不串）
 */
function normalizeCard(raw, expected = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (!raw.uid || !raw.chatId) return null;
  if (expected.chatId && String(raw.chatId) !== String(expected.chatId)) return null;
  if (expected.uid && String(raw.uid) !== String(expected.uid)) return null;
  const now = Date.now();
  const card = newCard({ chatId: raw.chatId, uid: raw.uid, name: raw.name, nickname: raw.nickname, now });
  card.count = Math.max(0, Number(raw.count) || 0);
  card.firstSeenAt = Number(raw.firstSeenAt) || now;
  card.lastSeenAt = Number(raw.lastSeenAt) || now;
  card.updatedAt = Number(raw.updatedAt) || now;
  card.traits = (Array.isArray(raw.traits) ? raw.traits : []).map((t) => normalizeTrait(t, now)).filter(Boolean).slice(0, LIMITS.maxTraitsPerPerson);
  card.preferences = (Array.isArray(raw.preferences) ? raw.preferences : [])
    .map((p) => normalizePreference(p, now)).filter(Boolean)
    .slice(0, LIMITS.maxPreferencesPerPerson + 50);
  card.events = (Array.isArray(raw.events) ? raw.events : []).map((e) => normalizeEvent(e, raw.chatId, now)).filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0))
    .slice(0, LIMITS.maxEventsPerPerson);
  card.threads = (Array.isArray(raw.threads) ? raw.threads : []).map((t) => normalizeThread(t, now)).filter(Boolean).slice(0, LIMITS.maxThreadsPerPerson);
  return card;
}

function normalizeTrait(raw, now) {
  if (!raw) return null;
  const body = text(typeof raw === 'string' ? raw : raw.text, 60);
  if (!body) return null;
  const evidence = Array.isArray(raw.evidence) ? raw.evidence.map((x) => text(x, 120)).filter(Boolean).slice(0, 20) : [];
  return {
    id: text(raw.id, 40) || `tr_${shortId(body)}`,
    text: body,
    confidence: clampNum(raw.confidence, 0, 1, 0.65),
    evidence,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || now,
    deleted: Boolean(raw.deleted),
  };
}

function normalizePreference(raw, now) {
  if (!raw) return null;
  const body = text(typeof raw === 'string' ? raw : raw.text, 80);
  if (!body) return null;
  const source = typeof raw.source === 'object' && raw.source ? text(raw.source.messageId || raw.source.id, 120) : text(raw.source, 120);
  return {
    id: text(raw.id, 48) || `pf_${shortId(body)}`,
    key: text(raw.key, 60),
    text: body,
    kind: text(raw.kind, 20) || 'fact',
    confidence: clampNum(raw.confidence, 0, 1, 0.7),
    source,
    createdAt: Number(raw.createdAt) || now,
    lastMentionedAt: Number(raw.lastMentionedAt) || 0,
    mentions: Math.max(0, Number(raw.mentions) || 0),
    legacy: Boolean(raw.legacy),
    superseded: Boolean(raw.superseded),
    deleted: Boolean(raw.deleted),
  };
}

function normalizeEvent(raw, chatId, now) {
  if (!raw || typeof raw !== 'object') return null;
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  // 读盘也校验：来源 chatId 和卡不一致的事件直接丢掉
  if (source.chatId && String(source.chatId) !== String(chatId)) return null;
  const body = text(raw.summary, 180);
  const title = text(raw.title, 24);
  if (!body && !title) return null;
  const event = {
    id: text(raw.id, 60) || `evt_${shortId(`${chatId}|${raw.date || ''}|${title || body}`)}`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || '')) ? String(raw.date) : dateString(now),
    title: title || body.slice(0, 20),
    summary: body,
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : []).map((k) => text(k, 16)).filter(Boolean).slice(0, 10),
    participants: (Array.isArray(raw.participants) ? raw.participants : []).map((p) => text(p, 100)).filter(Boolean).slice(0, 20),
    importance: clampNum(raw.importance, 0, 1, 0.4),
    confidence: clampNum(raw.confidence, 0, 1, 0.6),
    source: {
      chatId: String(chatId),
      messageIds: (Array.isArray(source.messageIds) ? source.messageIds : []).map((m) => text(m, 120)).filter(Boolean).slice(0, 40),
    },
    createdAt: Number(raw.createdAt) || now,
  };
  if (raw.valence != null) event.valence = clampNum(raw.valence, -1, 1, 0);
  if (typeof raw.resolved === 'boolean') event.resolved = raw.resolved;
  if (raw.threadId) event.threadId = text(raw.threadId, 60);
  if (raw.pinned) event.pinned = true;
  return event;
}

function normalizeThread(raw, now) {
  if (!raw) return null;
  const body = text(typeof raw === 'string' ? raw : raw.text, 80);
  if (!body) return null;
  return {
    id: text(raw.id, 40) || `th_${shortId(body)}`,
    text: body,
    status: raw.status === 'closed' ? 'closed' : 'open',
    createdAt: Number(raw.createdAt) || now,
    lastMentionedAt: Number(raw.lastMentionedAt) || Number(raw.createdAt) || now,
    closedAt: Number(raw.closedAt) || 0,
    deleted: Boolean(raw.deleted),
  };
}

function dateString(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------ 读取视图 ------------------------------ */

function active(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && !x.deleted && !x.superseded);
}

function activeTraits(card) {
  return active(card && card.traits);
}

function activePreferences(card) {
  return active(card && card.preferences);
}

function activeEvents(card) {
  return active(card && card.events);
}

function openThreads(card) {
  return active(card && card.threads).filter((t) => t.status === 'open');
}

/** 老 API 兼容：把偏好映射成 {text, kind, ...} 的 note */
function preferenceToNote(p) {
  return {
    text: p.text,
    kind: p.kind || 'fact',
    confidence: p.confidence,
    importance: Math.max(1, Math.min(3, Math.round((Number(p.confidence) || 0.7) * 3))),
    createdAt: p.createdAt,
    lastMentionedAt: p.lastMentionedAt,
    mentions: p.mentions,
    source: p.source,
    id: p.id,
  };
}

/* ------------------------------ 写入：偏好 ------------------------------ */

function addPreference(card, entry, { chatId, now = Date.now() } = {}) {
  assertChat(card, chatId || (entry && entry.chatId) || card.chatId);
  const at = nowOf(now);
  const body = text(entry && entry.text, 80);
  if (!body) return null;
  const key = text(entry.key, 60);
  const source = text(entry.source, 120);
  const confidence = clampNum(entry.confidence, 0, 1, 0.7);
  card.preferences = Array.isArray(card.preferences) ? card.preferences : [];

  // 1) 同一 key 的新值：旧值标 superseded（不删，留审计）
  if (key) {
    for (const p of card.preferences) {
      if (p.key !== key || p.superseded || p.deleted) continue;
      if (norm(p.text) === norm(body)) continue;
      if (confidence >= (p.confidence || 0) - 0.05) p.superseded = true;
    }
  }
  // 2) 明确纠正：把旧值标掉
  for (const oldText of Array.isArray(entry.supersedes) ? entry.supersedes : []) {
    const target = norm(oldText);
    if (!target) continue;
    for (const p of card.preferences) {
      if (p.deleted) continue;
      const bodyNorm = norm(p.text);
      if (bodyNorm === target || bodyNorm.includes(target) || target.includes(bodyNorm)) p.superseded = true;
    }
  }
  // 3) 完全同文：合并置信度 / mentions，不新增
  const n = norm(body);
  const dup = card.preferences.find((p) => !p.deleted && !p.superseded && norm(p.text) === n);
  if (dup) {
    dup.confidence = Math.max(dup.confidence || 0, confidence);
    if (source && !dup.source) dup.source = source;
    dup.lastMentionedAt = at;
    dup.mentions = (dup.mentions || 0) + 1;
    card.updatedAt = at;
    return dup;
  }
  // 4) 近似同文：合并进老条目，避免“爱吃辣/爱吃辣的”两条
  const near = card.preferences.find((p) => {
    if (p.deleted || p.superseded) return false;
    if (similarity(p.text, body) >= 0.85) return true;
    // 短后缀差异（“喜欢猫” / “喜欢猫的”）按包含关系合并，但长度差不能太大
    const a = norm(p.text);
    return (a.includes(n) || n.includes(a)) && Math.abs(a.length - n.length) <= 2;
  });
  if (near) {
    if (body.length > near.text.length) near.text = body;
    near.confidence = Math.max(near.confidence || 0, confidence);
    near.lastMentionedAt = at;
    near.mentions = (near.mentions || 0) + 1;
    card.updatedAt = at;
    return near;
  }

  const item = normalizePreference({
    id: `pf_${shortId(`${card.chatId}|${key}|${body}`)}`,
    key, text: body, kind: entry.kind || 'fact', confidence, source,
    createdAt: at, lastMentionedAt: at, mentions: 1, legacy: Boolean(entry.legacy),
  }, at);
  // 用户明确纠正 / 手动记住：最高置信度
  if (entry.explicit) item.confidence = 1;
  card.preferences.push(item);
  evictOverflow(card.preferences, LIMITS.maxPreferencesPerPerson, at);
  card.updatedAt = at;
  return item;
}

/* ------------------------------ 写入：性格 ------------------------------ */

function addTrait(card, entry, { chatId, now = Date.now() } = {}) {
  assertChat(card, chatId || card.chatId);
  const at = nowOf(now);
  const body = text(entry && entry.text, 60);
  if (!body) return null;
  const confidence = clampNum(entry.confidence, 0, 1, 0.65);
  if (confidence < LIMITS.traitMinConfidence) return null;
  const evidence = (Array.isArray(entry.evidence) ? entry.evidence : [entry.source])
    .map((x) => text(x, 120)).filter(Boolean);
  const explicit = Boolean(entry.explicit);
  if (!explicit && evidence.length < LIMITS.traitMinEvidence) return null;

  card.traits = Array.isArray(card.traits) ? card.traits : [];
  const n = norm(body);
  const existing = card.traits.find((t) => !t.deleted && (norm(t.text) === n || similarity(t.text, body) >= 0.9));
  if (existing) {
    existing.confidence = Math.max(existing.confidence || 0, confidence);
    for (const e of evidence) if (!existing.evidence.includes(e)) existing.evidence.push(e);
    existing.evidence = existing.evidence.slice(-20);
    existing.updatedAt = at;
    card.updatedAt = at;
    return existing;
  }
  const trait = normalizeTrait({
    id: `tr_${shortId(`${card.chatId}|${body}`)}`,
    text: body, confidence, evidence, createdAt: at, updatedAt: at,
  }, at);
  if (!trait) return null;
  card.traits.push(trait);
  // 只按置信度淘汰，不淘汰证据多的
  evictOverflow(card.traits, LIMITS.maxTraitsPerPerson, at, (t) => (t.confidence || 0) + Math.min(0.2, (t.evidence || []).length * 0.02));
  card.updatedAt = at;
  return trait;
}

/* ------------------------------ 写入：事件 ------------------------------ */

function addEvent(card, event, { chatId, now = Date.now() } = {}) {
  const sourceChat = event && event.source && event.source.chatId;
  const expected = chatId || card.chatId;
  assertChat(card, expected);
  if (sourceChat && String(sourceChat) !== String(card.chatId)) {
    throw new MemoryIsolationError(`拒绝跨聊天写事件：card.chatId=${card.chatId}，source.chatId=${sourceChat}`);
  }
  const at = nowOf(now);
  card.events = Array.isArray(card.events) ? card.events : [];
  const normalized = normalizeEvent({
    ...event,
    source: { chatId: card.chatId, messageIds: (event && event.source && event.source.messageIds) || [] },
  }, card.chatId, at);
  if (!normalized) return null;

  // 幂等：同 id 或 同日期+同标题 只写一次
  const dup = card.events.find((e) => !e.deleted && (e.id === normalized.id
    || (e.date === normalized.date && norm(e.title) === norm(normalized.title))));
  if (dup) {
    const merged = new Set([...(dup.source.messageIds || []), ...(normalized.source.messageIds || [])]);
    dup.source.messageIds = [...merged].slice(-40);
    dup.importance = Math.max(dup.importance || 0, normalized.importance);
    dup.confidence = Math.max(dup.confidence || 0, normalized.confidence);
    card.updatedAt = at;
    return dup;
  }
  card.events.push(normalized);
  // 事件按“重要度 × 新鲜度”淘汰，别只看时间
  evictOverflow(card.events, LIMITS.maxEventsPerPerson, at, (e) => {
    const age = Math.max(0, at - Date.parse(`${e.date}T00:00:00`)) / DAY_MS;
    return (e.importance || 0.3) * Math.pow(0.5, age / 14) + (e.pinned ? 1 : 0);
  });
  card.events.sort((a, b) => String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0));
  card.updatedAt = at;
  return normalized;
}

/* ------------------------------ 写入：未完成话题 ------------------------------ */

function addThread(card, entry, { chatId, now = Date.now() } = {}) {
  assertChat(card, chatId || card.chatId);
  const at = nowOf(now);
  const body = text(entry && entry.text, 80);
  if (!body) return null;
  card.threads = Array.isArray(card.threads) ? card.threads : [];
  const n = norm(body);
  const dup = card.threads.find((t) => !t.deleted && t.status === 'open'
    && (norm(t.text) === n || similarity(t.text, body) >= 0.9));
  if (dup) {
    dup.lastMentionedAt = at;
    if (body.length > dup.text.length) dup.text = body;
    card.updatedAt = at;
    return dup;
  }
  const thread = normalizeThread({ text: body, status: 'open', createdAt: at, lastMentionedAt: at }, at);
  card.threads.push(thread);
  // 只能留 10 条：先关最久没提的 open，再删最老 closed
  const open = card.threads.filter((t) => !t.deleted && t.status === 'open');
  if (open.length > LIMITS.maxThreadsPerPerson) {
    open.sort((a, b) => (a.lastMentionedAt || 0) - (b.lastMentionedAt || 0));
    for (const t of open.slice(0, open.length - LIMITS.maxThreadsPerPerson)) {
      t.status = 'closed';
      t.closedAt = at;
    }
  }
  const live = card.threads.filter((t) => !t.deleted);
  if (live.length > LIMITS.maxThreadsPerPerson * 2) {
    live.sort((a, b) => (a.lastMentionedAt || 0) - (b.lastMentionedAt || 0));
    for (const t of live.slice(0, live.length - LIMITS.maxThreadsPerPerson * 2)) t.deleted = true;
  }
  card.updatedAt = at;
  return thread;
}

function closeThread(card, needle, now = Date.now()) {
  const at = nowOf(now);
  const target = norm(needle);
  let closed = 0;
  for (const t of active(card.threads)) {
    if (t.status !== 'open') continue;
    if (!target || norm(t.text).includes(target) || target.includes(norm(t.text))) {
      t.status = 'closed';
      t.closedAt = at;
      closed += 1;
    }
  }
  if (closed) card.updatedAt = at;
  return closed;
}

/* ------------------------------ 删除 / 合并 ------------------------------ */

function forget(card, needle, now = Date.now()) {
  const at = nowOf(now);
  const target = norm(needle);
  let removed = 0;
  const match = (s) => {
    const n = norm(s);
    if (!n) return false;
    if (!target) return true;
    return n.includes(target) || target.includes(n);
  };
  for (const list of [card.traits, card.preferences, card.events, card.threads]) {
    for (const item of Array.isArray(list) ? list : []) {
      if (item.deleted) continue;
      const body = item.text || item.title || '';
      if (match(body)) {
        item.deleted = true;
        item.deletedAt = at;
        removed += 1;
      }
    }
  }
  if (removed) card.updatedAt = at;
  return removed;
}

module.exports = {
  MemoryIsolationError,
  assertChat,
  newCard,
  normalizeCard,
  activeTraits,
  activePreferences,
  activeEvents,
  openThreads,
  preferenceToNote,
  addPreference,
  addTrait,
  addEvent,
  addThread,
  closeThread,
  forget,
  similarity,
  normalizeText: norm,
  dateString,
};

/* ------------------------------ 内部工具 ------------------------------ */

function evictOverflow(list, cap, now, scoreFn = (x) => (x.confidence || 0) * Math.pow(0.5, Math.max(0, now - (x.createdAt || now)) / (90 * DAY_MS))) {
  if (!Array.isArray(list)) return;
  while (list.length > cap) {
    let victim = -1;
    let lowest = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const item = list[i];
      // 已删除 / 已取代的先走，不占名额
      if (item.deleted || item.superseded) { victim = i; break; }
      const s = scoreFn(item);
      if (s < lowest) { lowest = s; victim = i; }
    }
    if (victim < 0) break;
    list.splice(victim, 1);
  }
}
