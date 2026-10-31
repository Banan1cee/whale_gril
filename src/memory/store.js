'use strict';

/**
 * 记忆 v2 的门面（对外仍是 Store，调用方不用大改）。
 *
 * 数据落在 data/memory/chats/<chatHash>/；每个 chat 物理隔离。
 * 这层负责把「消息 / 人物卡 / episode / 压缩 / 检索」串起来，
 * 并把旧 API（messages/profile/addNote/setSummary/state/events）映射到新结构。
 */
const fs = require('node:fs');
const path = require('node:path');
const { ChatStore } = require('./chatStore');
const personCard = require('./personCard');
const episode = require('./episode');
const compression = require('./compression');
const retrieval = require('./retrieval');
const format = require('./format');
const extractor = require('./extractor');
const migrate = require('./migrate');
const { LIMITS, DAY_MS } = require('./constants');
const { estimateTokens, estimateBudgetTokens } = require('./tokens');

/* ------------------------------ 旧文件读取（兼容工具） ------------------------------ */

function readJsonQuiet(file) {
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
    try { out.push(JSON.parse(s)); } catch { /* 半截行 */ }
  }
  return out;
}

/** 旧版 store.json + journal 的合并读取；v2 不再写这个文件，只给迁移/工具用 */
function readStoreFile(file) {
  const snap = readJsonQuiet(file) || {};
  const base = {
    version: snap.version || 1,
    savedAt: snap.savedAt || null,
    stats: Object.assign({ messages: 0, replies: 0 }, snap.stats || {}),
    digest: Array.isArray(snap.digest) ? snap.digest.slice(-800) : [],
    sessions: snap.sessions && typeof snap.sessions === 'object' ? { ...snap.sessions } : {},
  };
  for (const entry of readJournal(file)) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.full) base.sessions = entry.sessions && typeof entry.sessions === 'object' ? { ...entry.sessions } : {};
    else if (entry.sessions && typeof entry.sessions === 'object') Object.assign(base.sessions, entry.sessions);
    if (Array.isArray(entry.removed)) for (const key of entry.removed) delete base.sessions[key];
  }
  return base;
}

/* ------------------------------ 工具 ------------------------------ */

function trimText(value, max = 2000) {
  const s = String(value == null ? '' : value).replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function importanceToConfidence(importance) {
  const n = Number(importance);
  if (!Number.isFinite(n)) return 0.75;
  if (n >= 3) return 0.95;
  if (n <= 1) return 0.7;
  return 0.85;
}

function activePreferenceTexts(card) {
  return personCard.activePreferences(card).map((p) => p.text);
}

class Store {
  constructor({ file, dir, limits = {}, logger = null, now = Date.now, llm = null } = {}) {
    this.file = file || path.resolve(process.cwd(), 'data', 'store.json');
    this.memoryDir = dir || path.join(path.dirname(this.file), 'memory');
    this.logger = logger;
    this.nowFn = typeof now === 'function' ? now : () => now;
    this.llm = llm;
    this.limits = {
      maxSessions: Number(limits.maxSessions) || 200,
      maxMessages: Number(limits.maxMessages) || LIMITS.maxMessagesPerChat,
      maxNotesPerUser: Number(limits.maxNotesPerUser) || LIMITS.maxPreferencesPerPerson,
    };
    this.sessions = new Map();
    this.digest = [];
    this.stats = { messages: 0, replies: 0 };
    this._background = new Set();
    this.chatStore = new ChatStore({ dir: this.memoryDir, logger, now: () => this._now() });
    try {
      const result = migrate.migrateIfNeeded({ memoryDir: this.memoryDir, chatStore: this.chatStore, logger });
      if (result.migrated) this.chatStore.load();
    } catch (err) {
      if (this.logger) this.logger.warn('旧记忆迁移失败（不影响新记忆）：' + ((err && err.message) || err));
    }
    this._syncSessions();
  }

  _now() {
    const v = this.nowFn();
    return v instanceof Date ? v.getTime() : Number(v) || Date.now();
  }

  _syncSessions() {
    this.sessions.clear();
    for (const chat of this.chatStore.chats.values()) this.sessions.set(chat.chatId, this._view(chat));
  }

  _view(chat) {
    const view = {
      key: chat.chatId,
      platform: chat.platform,
      chatId: chat.chatId,
      chatType: chat.chatType,
      title: chat.title,
      createdAt: chat.createdAt,
      lastActiveAt: chat.lastActiveAt,
    };
    Object.defineProperty(view, 'messages', { enumerable: true, get: () => chat.messages });
    Object.defineProperty(view, 'profiles', {
      enumerable: true,
      get: () => {
        const out = {};
        for (const card of chat.people.values()) out[card.uid] = this._profileView(card);
        return out;
      },
    });
    Object.defineProperty(view, 'state', { enumerable: true, get: () => chat.meta.state });
    Object.defineProperty(view, 'seenIds', { enumerable: true, get: () => chat.meta.seenIds });
    Object.defineProperty(view, 'events', { enumerable: true, get: () => chat.meta.events });
    Object.defineProperty(view, 'summary', { enumerable: true, get: () => chat.summary.text || undefined });
    Object.defineProperty(view, 'summaryUpto', { enumerable: true, get: () => chat.summary.coveredThroughSeq });
    return view;
  }

  _profileView(card) {
    return {
      uid: card.uid,
      name: card.name,
      nickname: card.nickname,
      firstSeenAt: card.firstSeenAt,
      lastSeenAt: card.lastSeenAt,
      count: card.count,
      notes: personCard.activePreferences(card).map(personCard.preferenceToNote),
      traitCount: personCard.activeTraits(card).length,
      eventCount: personCard.activeEvents(card).length,
      threadCount: personCard.openThreads(card).length,
    };
  }

  /* ------------------------------ 会话 ------------------------------ */

  ensureSession(key, meta = {}) {
    const chatId = String(key || 'default').slice(0, 240);
    const chat = this.chatStore.ensureChat(chatId, meta);
    if (!this.sessions.has(chatId)) this.sessions.set(chatId, this._view(chat));
    else if (meta.title && !chat.title) chat.title = String(meta.title).slice(0, 60);
    return this.sessions.get(chatId);
  }

  getState(key) {
    return this.ensureSession(key).state;
  }

  isDuplicate(key, msgId) {
    if (!msgId) return false;
    return this.ensureSession(key).seenIds.includes(String(msgId));
  }

  markSeen(key, msgId) {
    if (!msgId) return;
    const chat = this.chatStore.ensureChat(key);
    const id = String(msgId);
    if (!chat.meta.seenIds.includes(id)) {
      chat.meta.seenIds.push(id);
      if (chat.meta.seenIds.length > 500) chat.meta.seenIds = chat.meta.seenIds.slice(-500);
      this.chatStore.saveMeta(chat, { immediate: true });
    }
  }

  redactLastMessage(key, replacement = '（已隐藏）') {
    const chat = this.chatStore.ensureChat(key);
    return this.chatStore.redactLast(chat, replacement);
  }

  /* ------------------------------ 消息 ------------------------------ */

  appendMessage(key, message = {}) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(message.ts) || this._now();
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (role === 'user' && message.text) {
      episode.ensureEpisode(chat, { now: at });
      const rotation = episode.rotateIfNeeded({
        chat,
        text: String(message.text || ''),
        now: at,
        chatStore: this.chatStore,
        llm: this.llm,
        logger: this.logger,
      });
      if (rotation && rotation.promise) this._track(rotation.promise);
    }
    const entry = this.chatStore.appendMessage(chat, {
      ...message,
      role,
      ts: at,
    });
    // 消息和去重 id 一起落盘：崩溃后重启不会把同一条再回一遍
    if (entry.msgId) this.markSeen(key, entry.msgId);
    episode.touchEpisode(chat, entry, { now: at });
    if (role === 'user') this._onUserMessage(chat, entry);
    // 直接关停/断电也不能把 episode 水位、seenIds、stats 丢在 400ms 防抖里：
    // 原文已经 fsync，这里同步写 meta（每轮 1 次，很小的文件）。
    this.chatStore.saveMeta(chat, { immediate: true });
    return entry;
  }

  _onUserMessage(chat, entry) {
    if (!entry.uid || !entry.text) return;
    try {
      // 已有卡就直接用，别在这里重复把 count 加一次（profile() 那步才算“聊过一次”）
      const card = this.chatStore.getCard(chat, entry.uid) || this.chatStore.ensurePerson(chat, entry.uid, entry.name);
      const { facts } = extractor.extractSelfFacts(entry.text, { msgId: entry.id, now: entry.ts });
      if (facts.length) {
        extractor.applyFacts(card, facts, { chatId: chat.chatId, now: entry.ts });
        // 人生事件：即时补一条事件卡
        for (const fact of facts) {
          if (!String(fact.key || '').startsWith('life:')) continue;
          personCard.addEvent(card, {
            id: `evt_${entry.id}`,
            date: personCard.dateString(entry.ts),
            title: trimText(entry.text, 20),
            summary: trimText(entry.text, 150),
            keywords: [],
            participants: [entry.uid],
            importance: 0.65,
            confidence: 0.8,
            source: { chatId: chat.chatId, messageIds: [entry.id] },
          }, { chatId: chat.chatId, now: entry.ts });
        }
        this.chatStore.saveCard(chat, card);
      }
    } catch (err) {
      if (err && err.code === 'MEMORY_CHAT_MISMATCH') throw err;
      if (this.logger) this.logger.warn('自述抽取失败（不影响聊天）：' + ((err && err.message) || err));
    }

    // 连续 20 条 user 消息：轻量候选，只写偏好，不写 L2
    if (chat.meta.stats.userMessagesSinceExtract >= LIMITS.factExtractEveryUserMessages) {
      try {
        const last = chat.messages.filter((m) => m.role === 'user').slice(-LIMITS.factExtractEveryUserMessages);
        const candidates = extractor.lightweightCandidates(last, { now: entry.ts });
        const byUid = new Map();
        for (const c of candidates) {
          if (!c.uid) continue;
          if (!byUid.has(c.uid)) byUid.set(c.uid, []);
          byUid.get(c.uid).push(c);
        }
        for (const [uid, list] of byUid) {
          const person = this.chatStore.getCard(chat, uid) || this.chatStore.ensurePerson(chat, uid, list[0].name);
          extractor.applyFacts(person, list, { chatId: chat.chatId, now: entry.ts });
          this.chatStore.saveCard(chat, person);
        }
        chat.meta.stats.userMessagesSinceExtract = 0;
      } catch (err) {
        if (this.logger) this.logger.warn('轻量抽取失败（不影响聊天）：' + ((err && err.message) || err));
      }
    }

    // 软阈值：后台准备「最旧 800 token」摘要，不删消息、不阻塞回复
    if (this.llm && !this.llm.isMock && !chat.softPreparing) {
      const currentSeq = chat.meta.nextSeq;
      if (compression.recentTokens(chat, { currentSeq }) >= LIMITS.softTriggerTokens) {
        chat.softPreparing = true;
        const task = compression.prepareSoft(chat, { currentSeq, llm: this.llm, logger: this.logger, now: entry.ts })
          .catch(() => false)
          .then(() => { chat.softPreparing = false; });
        this._track(Promise.resolve(task));
      }
    }
  }

  _track(promise) {
    this._background.add(promise);
    Promise.resolve(promise).catch(() => {}).then(() => this._background.delete(promise));
  }

  messages(key, limit = 24) {
    const chat = this.chatStore.ensureChat(key);
    return chat.messages.slice(-Math.max(0, Number(limit) || 0));
  }

  /** 当前说话人的卡 + 这个 chat 的最近原文 + 摘要 + 相关事件 */
  buildContext({ key, uid = '', name = '', query = '', now = null, isGroup = false, currentSeq = 0 } = {}) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(now) || this._now();
    let card = this.chatStore.getCard(chat, uid);
    if (!card) card = this.chatStore.ensurePerson(chat, uid, name);
    const last = chat.messages[chat.messages.length - 1];
    const protectSeq = Number(currentSeq) || (last && last.role === 'user' ? last.seq : 0);
    const compressed = compression.compressSync(chat, { currentSeq: protectSeq, now: at });
    if (compressed.chunks) {
      this.chatStore.saveSummary(chat);
      this.chatStore.saveMeta(chat);
    }
    const recent = compression.recentForPrompt(chat, {
      currentSeq: protectSeq,
      maxTokens: LIMITS.recentMaxTokens,
      maxCount: isGroup ? LIMITS.groupRecentMessages : LIMITS.recentMessages,
    });
    const recentUser = chat.messages
      .filter((m) => m.role === 'user' && m.seq !== protectSeq && m.text)
      .slice(-2)
      .map((m) => m.text);
    const events = retrieval.selectEvents(card, {
      query,
      recentTexts: recentUser,
      activeTopic: chat.meta.episode ? chat.meta.episode.activeTopic : '',
      now: at,
      uid,
      topK: LIMITS.retrievalTopK,
    });
    const block = format.buildMemoryBlock({ card, events, summary: chat.summary.text });
    return {
      chatId: chat.chatId,
      card,
      events,
      block,
      summary: chat.summary.text,
      recent: recent.messages,
      recentTokens: recent.tokens,
      summaryTokens: chat.summary.tokens,
      memoryTokens: estimateBudgetTokens(block),
      // 对话预算（不含 system）：system 只由上层测量，不参与这里的挤压
      dialogueBudget: LIMITS.dialogueBudget,
      hardTotalTokens: LIMITS.hardTotalTokens,
      reserveTokens: LIMITS.reserveTokens,
      notes: activePreferenceTexts(card),
      compressed,
    };
  }

  checkpoint(key) {
    const chat = this.chatStore.ensureChat(key);
    const stats = compression.recentTokens(chat, { currentSeq: 0 });
    return this.chatStore.checkpoint(chat, { recentTokens: stats });
  }

  /** 旧 API：把当前会话 meta 落盘（state 改动后调用） */
  markDirty(key) {
    if (key) {
      const chat = this.chatStore.chats.get(String(key));
      if (chat) this.chatStore.saveMeta(chat, { immediate: true });
      return;
    }
    this.chatStore.flush();
  }

  /* ------------------------------ 人物卡 ------------------------------ */

  profile(key, uid, name) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid, name);
    return this._profileView(card);
  }

  setNickname(key, uid, nickname) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid);
    card.nickname = trimText(nickname, 60);
    this.chatStore.saveCard(chat, card);
    return this._profileView(card);
  }

  displayName(key, uid, fallback = '群友') {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.getCard(chat, uid);
    if (!card) return fallback;
    return card.nickname || card.name || fallback;
  }

  /**
   * 旧 API：写一条记忆。
   * kind 支持 fact/preference/promise/recent/taboo；promise 同时开一条 thread。
   */
  addNote(key, uid, note, meta = {}) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid, meta.name || '');
    const raw = typeof note === 'string' ? { text: note } : (note || {});
    const textValue = trimText(raw.text, 80);
    if (!textValue) return activePreferenceTexts(card);
    const kind = ['fact', 'preference', 'promise', 'recent', 'taboo'].includes(raw.kind) ? raw.kind : (meta.kind || 'fact');
    const lastMsg = chat.messages[chat.messages.length - 1];
    personCard.addPreference(card, {
      text: textValue,
      kind,
      confidence: Number.isFinite(Number(meta.confidence)) ? Number(meta.confidence) : importanceToConfidence(raw.importance || meta.importance),
      source: meta.source || (lastMsg && lastMsg.id) || '',
      explicit: meta.explicit !== false,
    }, { chatId: chat.chatId, now: this._now() });
    if (kind === 'promise') personCard.addThread(card, { text: textValue }, { chatId: chat.chatId, now: this._now() });
    this.chatStore.saveCard(chat, card);
    return activePreferenceTexts(card);
  }

  manualRemember(key, uid, textValue) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid);
    const lastMsg = chat.messages[chat.messages.length - 1];
    personCard.addPreference(card, {
      text: trimText(textValue, 80),
      kind: 'fact',
      confidence: 1,
      source: lastMsg && lastMsg.id,
      explicit: true,
    }, { chatId: chat.chatId, now: this._now() });
    this.chatStore.saveCard(chat, card);
    return activePreferenceTexts(card);
  }

  removeNote(key, uid, needle) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid);
    const removed = personCard.forget(card, needle, this._now());
    this.chatStore.saveCard(chat, card);
    return { removed, notes: activePreferenceTexts(card) };
  }

  touchNotes(key, uid, texts, now = null) {
    const chat = this.chatStore.ensureChat(key);
    const card = this.chatStore.ensurePerson(chat, uid);
    const at = Number(now) || this._now();
    const targets = new Set((texts || []).map((t) => personCard.normalizeText(t)).filter(Boolean));
    if (!targets.size) return activePreferenceTexts(card);
    let touched = false;
    for (const list of [card.preferences, card.threads, card.events]) {
      for (const item of Array.isArray(list) ? list : []) {
        const body = personCard.normalizeText(item.text || item.title || '');
        if (!body || !targets.has(body)) continue;
        item.lastMentionedAt = at;
        item.mentions = (Number(item.mentions) || 0) + 1;
        touched = true;
      }
    }
    if (touched) this.chatStore.saveCard(chat, card);
    return activePreferenceTexts(card);
  }

  listNotes(key) {
    const chat = this.chatStore.ensureChat(key);
    const out = [];
    for (const card of chat.people.values()) {
      const notes = activePreferenceTexts(card);
      if (notes.length) out.push({ uid: card.uid, name: card.name, notes });
      else if (personCard.openThreads(card).length) {
        out.push({ uid: card.uid, name: card.name, notes: personCard.openThreads(card).map((t) => t.text) });
      }
    }
    return out;
  }

  /* ------------------------------ 摘要 / 兼容 ------------------------------ */

  setSummary(key, textValue, meta = {}) {
    const chat = this.chatStore.ensureChat(key);
    const body = trimText(textValue, 1200);
    const lastSeq = (chat.messages[chat.messages.length - 1] || {}).seq || 0;
    const covered = Math.max(0, Math.min(lastSeq, Number(meta.upto) || lastSeq));
    chat.summary.text = body;
    chat.summary.tokens = estimateTokens(body);
    chat.summary.coveredThroughSeq = covered;
    chat.summary.segments = body ? [{ text: body, tokens: chat.summary.tokens, fromSeq: 1, toSeq: covered, at: this._now() }] : [];
    chat.summary.updatedAt = this._now();
    this.chatStore.saveSummary(chat);
    return body;
  }

  setMuted(key, ms) {
    const chat = this.chatStore.ensureChat(key);
    chat.meta.state.mutedUntil = this._now() + Math.max(0, ms);
    this.chatStore.saveMeta(chat, { immediate: true });
    return chat.meta.state.mutedUntil;
  }

  resetSession(key) {
    const chatId = String(key || '');
    this.sessions.delete(chatId);
    return this.chatStore.deleteChat(chatId);
  }

  resetAll() {
    this.sessions.clear();
    this.digest = [];
    this.stats = { messages: 0, replies: 0 };
    this.chatStore.resetAll();
  }

  reloadFromDisk() {
    const n = this.chatStore.reload();
    this._syncSessions();
    return n;
  }

  summary() {
    let messages = 0;
    let notes = 0;
    let totalMessages = 0;
    let totalReplies = 0;
    for (const chat of this.chatStore.chats.values()) {
      messages += chat.messages.length;
      totalMessages += chat.meta.stats.messages || 0;
      totalReplies += chat.meta.stats.replies || 0;
      for (const card of chat.people.values()) notes += personCard.activePreferences(card).length;
    }
    this.stats = { messages: totalMessages, replies: totalReplies };
    return {
      sessions: this.chatStore.chats.size,
      messages,
      notes,
      totalMessages,
      totalReplies,
      budget: {
        dialogueBudget: LIMITS.dialogueBudget,
        hardTotalTokens: LIMITS.hardTotalTokens,
        memoryTokens: LIMITS.memoryTokens,
        summaryTokens: LIMITS.summaryTokens,
        recentMaxTokens: LIMITS.recentMaxTokens,
        reserveTokens: LIMITS.reserveTokens,
      },
    };
  }

  archiveCount() {
    return 0;
  }

  /* ------------------------------ 动作账本 ------------------------------ */

  appendEvent(key, event) {
    if (!key) return null;
    let clamped = null;
    try {
      // 复用动作账本的类型/长度约束；core/events 不依赖 memory，避免循环
      const actionEvents = require('../core/events');
      clamped = actionEvents.clampEvent(event, this._now());
    } catch {
      clamped = event;
    }
    if (!clamped) return null;
    const chat = this.chatStore.ensureChat(key);
    const list = chat.meta.events;
    const last = list[list.length - 1];
    if (last && last.type === clamped.type && last.status === clamped.status && last.detail === clamped.detail
      && Number(clamped.ts) - Number(last.ts) < 5000) return last;
    list.push(clamped);
    if (list.length > 60) list.splice(0, list.length - 60);
    this.chatStore.saveMeta(chat, { immediate: true });
    return clamped;
  }

  events(key, limit = 12) {
    const chat = this.chatStore.ensureChat(key);
    return chat.meta.events.slice(-Math.max(0, Number(limit) || 0));
  }

  updateEvent(key, ts, patch = {}) {
    if (!key || !ts) return null;
    const chat = this.chatStore.ensureChat(key);
    for (let i = chat.meta.events.length - 1; i >= 0; i -= 1) {
      if (Number(chat.meta.events[i].ts) !== Number(ts)) continue;
      let next = { ...chat.meta.events[i], ...patch, ts };
      try {
        const actionEvents = require('../core/events');
        next = actionEvents.clampEvent(next, next.ts) || next;
      } catch { /* ignore */ }
      chat.meta.events[i] = next;
      this.chatStore.saveMeta(chat);
      return next;
    }
    return null;
  }

  /* ------------------------------ episode / 维护 ------------------------------ */

  async closeEpisode(key, { reason = 'manual', now = null, llm = null } = {}) {
    const chat = this.chatStore.ensureChat(key);
    const at = Number(now) || this._now();
    if (!chat.meta.episode) {
      return { closed: false, reason: chat.meta.lastClosedEpisodeId ? 'already_closed' : 'no_episode' };
    }
    const result = await episode.closeEpisode({
      chat,
      chatStore: this.chatStore,
      llm: llm || this.llm,
      logger: this.logger,
      now: at,
      reason,
    });
    this._syncSessions();
    return result;
  }

  /** 启动：30 分钟空闲补写 L2；超预算按需压缩。不阻塞服务启动。 */
  async startupRecovery({ llm = null } = {}) {
    const model = llm || this.llm;
    const tasks = [];
    for (const chat of this.chatStore.chats.values()) {
      const idle = episode.closeIdleEpisodes({
        chat,
        chatStore: this.chatStore,
        llm: model,
        logger: this.logger,
        now: this._now(),
      });
      if (idle) tasks.push(idle.then((r) => (r && r.closed ? 1 : 0)));
    }
    const closed = (await Promise.all(tasks)).reduce((a, b) => a + b, 0);
    for (const chat of this.chatStore.chats.values()) {
      const before = compression.recentTokens(chat, { currentSeq: 0 });
      if (before > LIMITS.hardTriggerTokens) {
        await compression.compressAsync(chat, { currentSeq: 0, llm: model, logger: this.logger, now: this._now() });
        this.chatStore.saveSummary(chat);
        this.chatStore.saveMeta(chat);
      }
    }
    this._syncSessions();
    return { chats: this.chatStore.chats.size, episodesClosed: closed };
  }

  /** 每天一次：合并、过期、归档 */
  sweep(now = null) {
    const at = Number(now) || this._now();
    let evicted = 0;
    for (const chat of this.chatStore.chats.values()) {
      this.chatStore.pruneRaw(chat, at);
      for (const card of chat.people.values()) {
        evicted += this._consolidateCard(chat, card, at);
      }
      evicted += this._enforceChatEventCap(chat, at);
      this.chatStore.saveMeta(chat);
    }
    const archived = this.chatStore.archiveIdle(at);
    this._syncSessions();
    if (evicted || archived.length) {
      if (this.logger) this.logger.info(`记忆清理：淘汰 ${evicted} 条，归档 ${archived.length} 个聊天`);
    }
    return { archived: archived.length, evicted, purged: 0 };
  }

  _consolidateCard(chat, card, now) {
    let evicted = 0;
    const cutoff = now - LIMITS.eventRetentionDays * DAY_MS;
    const keptEvents = [];
    for (const ev of card.events || []) {
      const ts = Date.parse(`${ev.date}T00:00:00`);
      if (Number.isFinite(ts) && ts < cutoff && !ev.pinned) evicted += 1;
      else keptEvents.push(ev);
    }
    card.events = keptEvents.slice(0, LIMITS.maxEventsPerPerson);
    for (const t of card.threads || []) {
      if (t.status === 'open' && now - (t.lastMentionedAt || t.createdAt || now) > LIMITS.threadIdleCloseDays * DAY_MS) {
        t.status = 'closed';
        t.closedAt = now;
      }
    }
    // 合并完全同文的偏好：留置信度最高的
    const seen = new Map();
    const merged = [];
    for (const p of card.preferences || []) {
      if (p.deleted) { merged.push(p); continue; }
      const key = `${p.key || ''}|${personCard.normalizeText(p.text)}`;
      const prev = seen.get(key);
      if (!prev) {
        seen.set(key, p);
        merged.push(p);
        continue;
      }
      if ((p.confidence || 0) > (prev.confidence || 0)) {
        prev.superseded = true;
        seen.set(key, p);
        merged[merged.indexOf(prev)] = p;
      } else {
        p.superseded = true;
        merged.push(p);
      }
      evicted += 1;
    }
    card.preferences = merged;
    // 很老的软删记录直接清掉，别让文件越滚越大
    for (const list of [card.preferences, card.traits, card.threads]) {
      for (let i = (list || []).length - 1; i >= 0; i -= 1) {
        const item = list[i];
        if ((item.deleted || item.superseded) && now - (item.deletedAt || item.createdAt || now) > 30 * DAY_MS) {
          list.splice(i, 1);
        }
      }
    }
    this.chatStore.saveCard(chat, card);
    return evicted;
  }

  _enforceChatEventCap(chat, now) {
    const all = [];
    for (const card of chat.people.values()) {
      for (const ev of card.events || []) {
        if (ev.deleted) continue;
        const ageDays = Math.max(0, (now - (Date.parse(`${ev.date}T00:00:00`) || now)) / DAY_MS);
        all.push({ card, ev, score: (ev.importance || 0.3) * Math.pow(0.5, ageDays / 30) + (ev.pinned ? 1 : 0) });
      }
    }
    const overflow = all.length - LIMITS.maxEventsPerChat;
    if (overflow <= 0) return 0;
    all.sort((a, b) => a.score - b.score);
    const affected = new Set();
    for (const item of all.slice(0, overflow)) {
      item.ev.deleted = true;
      item.ev.deletedAt = now;
      affected.add(item.card);
    }
    for (const card of affected) this.chatStore.saveCard(chat, card);
    return overflow;
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  flush() {
    return this.chatStore.flush();
  }

  close() {
    try { this.chatStore.close(); } catch { /* ignore */ }
  }

  /** 等后台任务（测试/退出用） */
  async drain() {
    await Promise.all([...this._background]);
  }
}

module.exports = { Store, readStoreFile, trimText };
