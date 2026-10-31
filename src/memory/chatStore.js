'use strict';

/**
 * 记忆 v2 的物理存储层。
 *
 * data/memory/
 *   manifest.json
 *   chats/<chatHash>/
 *     meta.json
 *     people/<personHash>.json
 *     messages.jsonl
 *     summary.json
 *     checkpoints/00000123.json
 *
 * 规则：
 *  - 一个 chat 一个目录，物理隔离；没有 global/，没有跨 chat 的 person/。
 *  - 原文只追加；关键节点 fsync；卡片/摘要/checkpoint 先写 .tmp 再 rename。
 *  - 所有磁盘写入都是同步的，天然按事件循环串行；跨 chat 的后台任务由上层排队。
 */
const fs = require('node:fs');
const path = require('node:path');
const { chatHash, personHash } = require('./hash');
const { LIMITS, DAY_MS } = require('./constants');
const { estimateTokens, messageTokens } = require('./tokens');
const personCard = require('./personCard');

const META_SAVE_DEBOUNCE_MS = 400;
const MESSAGE_FSYNC_EVERY = 1;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}

function padSeq(seq) {
  return String(Math.max(0, Math.trunc(seq))).padStart(8, '0');
}

function defaultState() {
  return {
    mutedUntil: 0,
    lastReplyAt: 0,
    consecutiveReplies: 0,
    adminUntil: 0,
    discussUntil: 0,
    engagedUntil: 0,
    engagedBy: '',
    silentUntil: 0,
    externalTargets: {},
    replyTimes: [],
  };
}

function normalizeState(raw) {
  const base = defaultState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    replyTimes: Array.isArray(raw.replyTimes) ? raw.replyTimes.slice(-200) : [],
    externalTargets: raw.externalTargets && typeof raw.externalTargets === 'object' ? raw.externalTargets : {},
  };
}

function normalizeSummary(raw, chatId) {
  const segments = (Array.isArray(raw && raw.segments) ? raw.segments : [])
    .filter((s) => s && typeof s.text === 'string' && s.text.trim())
    .map((s) => ({
      text: s.text.trim(),
      tokens: Number(s.tokens) || estimateTokens(s.text),
      fromSeq: Number(s.fromSeq) || 0,
      toSeq: Number(s.toSeq) || 0,
      at: Number(s.at) || 0,
    }));
  const text = String((raw && raw.text) || '').trim() || segments.map((s) => s.text).join('\n');
  return {
    chatId,
    episodeId: String((raw && raw.episodeId) || ''),
    text,
    tokens: Number((raw && raw.tokens)) || estimateTokens(text),
    coveredThroughSeq: Math.max(0, Number((raw && raw.coveredThroughSeq)) || 0),
    segments,
    updatedAt: Number((raw && raw.updatedAt)) || Date.now(),
  };
}

class ChatStore {
  constructor({ dir, logger = null, now = () => Date.now() }) {
    this.dir = dir;
    this.logger = logger;
    this.now = typeof now === 'function' ? now : () => now;
    this.chats = new Map();
    this.manifest = null;
    this._saveTimers = new Map();
    this.init();
  }

  get chatRoot() {
    return path.join(this.dir, 'chats');
  }

  init() {
    fs.mkdirSync(this.chatRoot, { recursive: true });
    this.manifest = readJson(path.join(this.dir, 'manifest.json'));
    if (!this.manifest || Number(this.manifest.version) !== 2) {
      this.manifest = {
        version: 2,
        createdAt: Number(this.manifest && this.manifest.createdAt) || Date.now(),
        updatedAt: Date.now(),
        migratedFrom: Array.isArray(this.manifest && this.manifest.migratedFrom) ? this.manifest.migratedFrom : [],
        stats: { chats: 0, messages: 0 },
      };
      writeJsonAtomic(path.join(this.dir, 'manifest.json'), this.manifest);
    }
    this.load();
  }

  load() {
    let dirs = [];
    try {
      dirs = fs.readdirSync(this.chatRoot).filter((n) => /^[0-9a-f]{16}$/.test(n));
    } catch {
      dirs = [];
    }
    for (const hash of dirs) {
      const chat = this._loadChat(hash);
      if (chat) this.chats.set(chat.chatId, chat);
    }
    this._refreshManifestStats();
  }

  _loadChat(hash) {
    const dir = path.join(this.chatRoot, hash);
    const meta = readJson(path.join(dir, 'meta.json'));
    if (!meta || !meta.chatId) return null;
    // 目录名必须和 chatId 对应，否则说明有人手动搬过文件：不读，避免串聊
    if (chatHash(meta.chatId) !== hash) {
      if (this.logger) this.logger.warn(`记忆目录名和 chatId 不符，已跳过：${hash}`);
      return null;
    }
    const chat = {
      chatId: String(meta.chatId),
      hash,
      dir,
      platform: String(meta.platform || 'web'),
      chatType: meta.chatType === 'group' ? 'group' : 'private',
      title: String(meta.title || ''),
      createdAt: Number(meta.createdAt) || Date.now(),
      lastActiveAt: Number(meta.lastActiveAt) || Date.now(),
      meta: {
        state: normalizeState(meta.state),
        seenIds: Array.isArray(meta.seenIds) ? meta.seenIds.map(String).slice(-500) : [],
        events: Array.isArray(meta.events) ? meta.events.filter((e) => e && e.type && e.detail).slice(-60) : [],
        stats: {
          messages: Math.max(0, Number(meta.stats && meta.stats.messages) || 0),
          replies: Math.max(0, Number(meta.stats && meta.stats.replies) || 0),
          userMessages: Math.max(0, Number(meta.stats && meta.stats.userMessages) || 0),
          userMessagesSinceExtract: Math.max(0, Number(meta.stats && meta.stats.userMessagesSinceExtract) || 0),
        },
        episode: meta.episode && meta.episode.id ? normalizeEpisode(meta.episode) : null,
        episodeSeq: Math.max(0, Number(meta.episodeSeq) || 0),
        closedEpisodes: Array.isArray(meta.closedEpisodes) ? meta.closedEpisodes.map(String).slice(-LIMITS.closedEpisodeMemory) : [],
        lastClosedEpisodeId: String(meta.lastClosedEpisodeId || ''),
        nextSeq: Math.max(1, Number(meta.nextSeq) || 1),
        checkpointSeq: Math.max(0, Number(meta.checkpointSeq) || 0),
        legacy: Boolean(meta.legacy),
      },
      messages: [],
      summary: null,
      people: new Map(),
      fd: null,
      dirtyMeta: false,
      dirtySummary: false,
    };
    chat.messages = this._loadMessages(chat);
    const lastSeq = Number((chat.messages[chat.messages.length - 1] || {}).seq) || 0;
    chat.meta.nextSeq = Math.max(chat.meta.nextSeq, lastSeq + 1);
    chat.summary = normalizeSummary(readJson(path.join(dir, 'summary.json')), chat.chatId);

    const peopleDir = path.join(dir, 'people');
    let files = [];
    try {
      files = fs.readdirSync(peopleDir).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
    } catch {
      files = [];
    }
    for (const file of files) {
      const raw = readJson(path.join(peopleDir, file));
      const expectedUid = raw && raw.uid;
      if (!raw || personHash(String(expectedUid)) !== file.replace(/\.json$/, '')) {
        if (this.logger) this.logger.warn(`人物卡文件名和 uid 不符，已跳过：${file}`);
        continue;
      }
      const card = personCard.normalizeCard(raw, { chatId: chat.chatId, uid: expectedUid });
      if (!card) {
        if (this.logger) this.logger.warn(`人物卡 chatId 不符，已跳过：${chat.chatId}/${file}`);
        continue;
      }
      chat.people.set(card.uid, card);
    }
    return chat;
  }

  _loadMessages(chat) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(chat.dir, 'messages.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out = [];
    let bad = 0;
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const m = JSON.parse(s);
        if (!m || !m.role || !m.text) { bad += 1; continue; }
        if (m.chatId && String(m.chatId) !== String(chat.chatId)) { bad += 1; continue; }
        const seq = Number(m.seq);
        if (!Number.isFinite(seq) || seq <= 0) { bad += 1; continue; }
        out.push({
          ...m,
          seq,
          text: String(m.text),
          ts: Number(m.ts) || Date.now(),
          tokens: Number(m.tokens) || messageTokens(m),
        });
      } catch {
        bad += 1; // 崩溃时最后一行可能是半截，跳过即可
      }
    }
    if (bad && this.logger) this.logger.warn(`记忆原文有 ${bad} 行损坏，已跳过（聊天 ${chat.chatId}）`);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  _refreshManifestStats() {
    let messages = 0;
    for (const chat of this.chats.values()) messages += chat.messages.length;
    this.manifest.stats = { chats: this.chats.size, messages };
    this.manifest.updatedAt = Date.now();
    try {
      writeJsonAtomic(path.join(this.dir, 'manifest.json'), this.manifest);
    } catch (err) {
      if (this.logger) this.logger.warn('写 manifest 失败：' + (err && err.message));
    }
  }

  /* ------------------------------ chat ------------------------------ */

  ensureChat(chatId, meta = {}) {
    const id = String(chatId || '').slice(0, 240);
    const found = this.chats.get(id);
    if (found) {
      if (meta.title && !found.title) {
        found.title = String(meta.title).slice(0, 60);
        this.saveMeta(found, { immediate: true });
      }
      return found;
    }
    const hash = chatHash(id);
    const dir = path.join(this.chatRoot, hash);
    const chat = {
      chatId: id,
      hash,
      dir,
      platform: String(meta.platform || 'web').slice(0, 20),
      chatType: meta.chatType === 'group' ? 'group' : 'private',
      title: String(meta.title || '').slice(0, 60),
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      meta: {
        state: normalizeState(null),
        seenIds: [],
        events: [],
        stats: { messages: 0, replies: 0, userMessages: 0, userMessagesSinceExtract: 0 },
        episode: null,
        episodeSeq: 0,
        closedEpisodes: [],
        lastClosedEpisodeId: '',
        nextSeq: 1,
        checkpointSeq: 0,
        legacy: Boolean(meta.legacy),
      },
      messages: [],
      summary: normalizeSummary(null, id),
      people: new Map(),
      fd: null,
      dirtyMeta: false,
      dirtySummary: false,
    };
    this.chats.set(id, chat);
    this.saveMeta(chat, { immediate: true });
    this.saveSummary(chat);
    return chat;
  }

  ensurePerson(chat, uid, name = '') {
    const id = String(uid || 'anonymous').slice(0, 100);
    let card = chat.people.get(id);
    const at = this.now();
    if (!card) {
      // 每 chat 最多 50 人：先淘汰最久没出现的
      if (chat.people.size >= LIMITS.maxPeoplePerChat) {
        let victim = null;
        for (const c of chat.people.values()) {
          if (!victim || (c.lastSeenAt || 0) < (victim.lastSeenAt || 0)) victim = c;
        }
        if (victim) {
          chat.people.delete(victim.uid);
          try { fs.unlinkSync(path.join(chat.dir, 'people', `${personHash(victim.uid)}.json`)); } catch { /* ignore */ }
          if (this.logger) this.logger.info(`人物卡到上限，淘汰最久没出现的（chat ${chat.chatId}）`);
        }
      }
      card = personCard.newCard({ chatId: chat.chatId, uid: id, name, now: at });
      chat.people.set(id, card);
    }
    if (name && (card.name !== name || !card.name)) card.name = String(name).slice(0, 60);
    card.lastSeenAt = at;
    card.count = (Number(card.count) || 0) + 1;
    card.updatedAt = at;
    this.saveCard(chat, card);
    return card;
  }

  /** 不改 count 的只读拿卡（后台任务用） */
  getCard(chat, uid) {
    return chat.people.get(String(uid || 'anonymous')) || null;
  }

  saveCard(chat, card) {
    const file = path.join(chat.dir, 'people', `${personHash(card.uid)}.json`);
    try {
      writeJsonAtomic(file, card);
    } catch (err) {
      if (this.logger) this.logger.error('写人物卡失败：' + (err && err.message));
    }
  }

  /* ------------------------------ 原文 ------------------------------ */

  appendMessage(chat, message) {
    const at = Number(message.ts) || this.now();
    const seq = chat.meta.nextSeq;
    chat.meta.nextSeq += 1;
    const entry = {
      id: `msg_${seq}`,
      seq,
      chatId: chat.chatId,
      role: message.role === 'assistant' ? 'assistant' : 'user',
      name: String(message.name || '').slice(0, 60),
      uid: message.uid ? String(message.uid).slice(0, 100) : '',
      text: String(message.text == null ? '' : message.text).slice(0, 4000),
      ts: at,
    };
    for (const key of ['msgId', 'addressedToBot', 'mentionedNames', 'inferredTargetNames', 'replyToName', 'replyToUserId', 'error', 'cleanText']) {
      if (message[key] !== undefined) entry[key] = message[key];
    }
    entry.tokens = messageTokens(entry);

    fs.mkdirSync(chat.dir, { recursive: true });
    const fd = this._fd(chat);
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    // 用户消息必须先落盘再回复；assistant 也 fsync，代价很小
    if (MESSAGE_FSYNC_EVERY === 1 || entry.role === 'user') {
      try { fs.fsyncSync(fd); } catch { /* 有些文件系统不支持，忽略 */ }
    }

    chat.messages.push(entry);
    chat.lastActiveAt = at;
    chat.meta.stats.messages += 1;
    if (entry.role === 'user') {
      chat.meta.stats.userMessages += 1;
      chat.meta.stats.userMessagesSinceExtract += 1;
      chat.meta.state.consecutiveReplies = 0;
    } else {
      chat.meta.stats.replies += 1;
      chat.meta.state.consecutiveReplies += 1;
      chat.meta.state.lastReplyAt = at;
      chat.meta.state.replyTimes.push(at);
      if (chat.meta.state.replyTimes.length > 200) chat.meta.state.replyTimes = chat.meta.state.replyTimes.slice(-200);
    }
    this.saveMeta(chat);
    if (chat.messages.length % 100 === 0) this.pruneRaw(chat, at);
    return entry;
  }

  /** 改写最后一条（魔咒/管理员口令不能留在记忆里） */
  redactLast(chat, replacement = '（已隐藏）') {
    const last = chat.messages[chat.messages.length - 1];
    if (!last) return false;
    last.text = String(replacement).slice(0, 200);
    last.tokens = messageTokens(last);
    this._rewriteMessages(chat);
    this.saveMeta(chat, { immediate: true });
    return true;
  }

  /** 只删「已被 summary 覆盖」的原文；未覆盖的一条都不删 */
  pruneRaw(chat, now = this.now()) {
    const covered = Number(chat.summary && chat.summary.coveredThroughSeq) || 0;
    const cutoff = now - LIMITS.rawRetentionDays * DAY_MS;
    const lastSeq = (chat.messages[chat.messages.length - 1] || {}).seq || 0;
    const hardBefore = lastSeq - LIMITS.maxMessagesPerChat;
    const keep = [];
    let dropped = 0;
    for (const m of chat.messages) {
      const canDrop = m.seq <= covered && (m.ts < cutoff || m.seq <= hardBefore);
      if (canDrop) dropped += 1;
      else keep.push(m);
    }
    if (!dropped) return { dropped: 0 };
    chat.messages = keep;
    this._rewriteMessages(chat);
    if (this.logger) this.logger.info(`记忆原文清理：${dropped} 条已覆盖的旧消息（chat ${chat.chatId}）`);
    return { dropped };
  }

  _rewriteMessages(chat) {
    const file = path.join(chat.dir, 'messages.jsonl');
    const tmp = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(chat.dir, { recursive: true });
    fs.writeFileSync(tmp, chat.messages.map((m) => JSON.stringify(m)).join('\n') + (chat.messages.length ? '\n' : ''), 'utf8');
    this._closeFd(chat);
    fs.renameSync(tmp, file);
  }

  _fd(chat) {
    if (chat.fd != null) return chat.fd;
    fs.mkdirSync(chat.dir, { recursive: true });
    chat.fd = fs.openSync(path.join(chat.dir, 'messages.jsonl'), 'a');
    return chat.fd;
  }

  _closeFd(chat) {
    if (chat.fd == null) return;
    try { fs.closeSync(chat.fd); } catch { /* ignore */ }
    chat.fd = null;
  }

  /* ------------------------------ meta / summary / checkpoint ------------------------------ */

  saveMeta(chat, { immediate = false } = {}) {
    chat.dirtyMeta = true;
    if (immediate) {
      this._flushMeta(chat);
      return;
    }
    if (this._saveTimers.has(chat.chatId)) return;
    const timer = setTimeout(() => {
      this._saveTimers.delete(chat.chatId);
      this._flushMeta(chat);
    }, META_SAVE_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    this._saveTimers.set(chat.chatId, timer);
  }

  _flushMeta(chat) {
    if (!chat.dirtyMeta) return;
    try {
      writeJsonAtomic(path.join(chat.dir, 'meta.json'), {
        version: 2,
        chatId: chat.chatId,
        platform: chat.platform,
        chatType: chat.chatType,
        title: chat.title,
        createdAt: chat.createdAt,
        lastActiveAt: chat.lastActiveAt,
        state: chat.meta.state,
        seenIds: chat.meta.seenIds,
        events: chat.meta.events,
        stats: chat.meta.stats,
        episode: chat.meta.episode,
        episodeSeq: chat.meta.episodeSeq,
        closedEpisodes: chat.meta.closedEpisodes,
        lastClosedEpisodeId: chat.meta.lastClosedEpisodeId || '',
        nextSeq: chat.meta.nextSeq,
        checkpointSeq: chat.meta.checkpointSeq,
        legacy: chat.meta.legacy,
      });
      chat.dirtyMeta = false;
    } catch (err) {
      if (this.logger) this.logger.error('写会话 meta 失败：' + (err && err.message));
    }
  }

  saveSummary(chat) {
    try {
      writeJsonAtomic(path.join(chat.dir, 'summary.json'), chat.summary);
      chat.dirtySummary = false;
    } catch (err) {
      if (this.logger) this.logger.error('写摘要失败：' + (err && err.message));
    }
  }

  checkpoint(chat, extra = {}) {
    const seq = (chat.messages[chat.messages.length - 1] || {}).seq || 0;
    if (!seq) return null;
    const payload = {
      chatId: chat.chatId,
      seq,
      at: this.now(),
      episodeId: chat.meta.episode ? chat.meta.episode.id : '',
      recentTokens: extra.recentTokens || 0,
      summaryTokens: chat.summary.tokens || 0,
      coveredThroughSeq: chat.summary.coveredThroughSeq || 0,
      messageCount: chat.messages.length,
      peopleCount: chat.people.size,
    };
    try {
      writeJsonAtomic(path.join(chat.dir, 'checkpoints', `${padSeq(seq)}.json`), payload);
      chat.meta.checkpointSeq = seq;
      // checkpoint 是「这一轮已经完整落盘」的标记，必须同步写，不能等防抖
      this.saveMeta(chat, { immediate: true });
      this._pruneCheckpoints(chat);
    } catch (err) {
      if (this.logger) this.logger.warn('写 checkpoint 失败：' + (err && err.message));
    }
    return payload;
  }

  _pruneCheckpoints(chat) {
    try {
      const dir = path.join(chat.dir, 'checkpoints');
      const files = fs.readdirSync(dir).filter((n) => /^\d{8}\.json$/.test(n)).sort();
      for (const old of files.slice(0, Math.max(0, files.length - LIMITS.checkpointKeep))) {
        try { fs.unlinkSync(path.join(dir, old)); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /* ------------------------------ 清理 / 归档 ------------------------------ */

  deleteChat(chatId) {
    const chat = this.chats.get(String(chatId));
    if (!chat) return false;
    this._closeFd(chat);
    const timer = this._saveTimers.get(chat.chatId);
    if (timer) clearTimeout(timer);
    this._saveTimers.delete(chat.chatId);
    try { fs.rmSync(chat.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); } catch (err) {
      if (this.logger) this.logger.warn('删除会话目录失败：' + (err && err.message));
      return false;
    }
    this.chats.delete(chat.chatId);
    this._refreshManifestStats();
    return true;
  }

  resetAll() {
    for (const chat of this.chats.values()) this._closeFd(chat);
    for (const timer of this._saveTimers.values()) clearTimeout(timer);
    this._saveTimers.clear();
    this.chats.clear();
    try { fs.rmSync(this.chatRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }); } catch { /* ignore */ }
    fs.mkdirSync(this.chatRoot, { recursive: true });
    this._refreshManifestStats();
  }

  /** 180 天不活跃：整个 chat 目录移到 archive/，不删除 */
  archiveIdle(now = this.now()) {
    const moved = [];
    for (const chat of [...this.chats.values()]) {
      if (now - chat.lastActiveAt < LIMITS.chatArchiveIdleDays * DAY_MS) continue;
      this._closeFd(chat);
      const target = path.join(this.dir, 'archive', chat.hash);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(chat.dir, target);
        this.chats.delete(chat.chatId);
        moved.push(chat.chatId);
      } catch (err) {
        if (this.logger) this.logger.warn('归档不活跃会话失败：' + (err && err.message));
      }
    }
    if (moved.length) this._refreshManifestStats();
    return moved;
  }

  flush() {
    let n = 0;
    for (const chat of this.chats.values()) {
      const timer = this._saveTimers.get(chat.chatId);
      if (timer) { clearTimeout(timer); this._saveTimers.delete(chat.chatId); }
      if (chat.dirtyMeta || chat.dirtySummary) {
        this._flushMeta(chat);
        if (chat.dirtySummary) this.saveSummary(chat);
        n += 1;
      }
      if (chat.fd != null) {
        try { fs.fsyncSync(chat.fd); } catch { /* ignore */ }
      }
    }
    this._refreshManifestStats();
    return n;
  }

  close() {
    for (const timer of this._saveTimers.values()) clearTimeout(timer);
    this._saveTimers.clear();
    this.flush();
    for (const chat of this.chats.values()) this._closeFd(chat);
  }

  reload() {
    for (const chat of this.chats.values()) this._closeFd(chat);
    for (const timer of this._saveTimers.values()) clearTimeout(timer);
    this._saveTimers.clear();
    this.chats.clear();
    this.init();
    return this.chats.size;
  }

  stats() {
    let messages = 0;
    let people = 0;
    let events = 0;
    for (const chat of this.chats.values()) {
      messages += chat.messages.length;
      people += chat.people.size;
      for (const card of chat.people.values()) events += personCard.activeEvents(card).length;
    }
    return { chats: this.chats.size, messages, people, events };
  }
}

function normalizeEpisode(raw) {
  return {
    id: String(raw.id),
    startedAt: Number(raw.startedAt) || Date.now(),
    lastMessageAt: Number(raw.lastMessageAt) || Number(raw.startedAt) || Date.now(),
    tokens: Math.max(0, Number(raw.tokens) || 0),
    userMessages: Math.max(0, Number(raw.userMessages) || 0),
    messageSeqFrom: Math.max(0, Number(raw.messageSeqFrom) || 0),
    messageSeqTo: Math.max(0, Number(raw.messageSeqTo) || 0),
    activeTopic: String(raw.activeTopic || ''),
    participants: Array.isArray(raw.participants) ? raw.participants.map(String).slice(0, 50) : [],
  };
}

module.exports = { ChatStore, writeJsonAtomic, readJson, normalizeSummary, normalizeEpisode, normalizeState, padSeq };
