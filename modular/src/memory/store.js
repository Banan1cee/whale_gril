'use strict';

/**
 * 聊天记忆存储（纯 JSON 文件，无需数据库）。
 *
 * 结构：
 *   sessions[chatKey] = {
 *     key, platform, chatId, chatType, title,
 *     createdAt, lastActiveAt,
 *     messages: [{ role: 'user'|'assistant', name, uid, text, ts, msgId, error? }],
 *     profiles: { [uid]: { uid, name, firstSeenAt, lastSeenAt, count, notes: [] } },
 *     state: { mutedUntil, lastReplyAt, consecutiveReplies, replyTimes: [] },
 *     seenIds: [最近去重用的消息 id]
 *   }
 */
const fs = require('node:fs');
const path = require('node:path');
const recall = require('./recall');
const forget = require('./forget');

const SAVE_DEBOUNCE_MS = 800;
/** 日志文件超过这么大就压回快照（避免无限增长） */
const JOURNAL_COMPACT_BYTES = 512 * 1024;

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function trimText(text, max = 2000) {
  const s = String(text ?? '').replace(/\u0000/g, '').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/* ------------------------------------------------------------------ */
/* 存储格式：store.json 快照 + store.json.journal 增量日志              */
/*                                                                     */
/* 以前每次落盘都把「所有会话」重新序列化一遍，会话一多、写一次就是      */
/* O(全部数据)。现在只把「这次动过的会话」追加一行 JSONL，日志变大       */
/* （或程序退出）时再压回快照。对外仍然是同一个 store.json，备份/工具     */
/* 读到的也是合并后的结果，不用改任何调用方。                           */
/* ------------------------------------------------------------------ */

function readJsonQuiet(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 读增量日志；崩溃时最后一行可能是半截，跳过即可。 */
function readJournal(file) {
  let text = '';
  try {
    text = fs.readFileSync(file + '.journal', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch { /* 半截行：跳过 */ }
  }
  return out;
}

/**
 * 读「快照 + 增量」，返回和旧 store.json 完全一样的结构。
 * 备份 / CLI 工具 / Store.load 都走这里，保证读到的都是最新数据。
 */
function readStoreFile(file) {
  const snap = readJsonQuiet(file) || {};
  const base = {
    version: snap.version || 1,
    savedAt: snap.savedAt || null,
    stats: Object.assign({ messages: 0, replies: 0 }, snap.stats || {}),
    digest: Array.isArray(snap.digest) ? snap.digest.slice(-800) : [],
    sessions: snap.sessions && typeof snap.sessions === 'object' ? snap.sessions : {},
  };
  for (const e of readJournal(file)) {
    if (!e || typeof e !== 'object') continue;
    if (e.full) {
      base.sessions = e.sessions && typeof e.sessions === 'object' ? { ...e.sessions } : {};
    } else if (e.sessions && typeof e.sessions === 'object') {
      for (const [k, v] of Object.entries(e.sessions)) base.sessions[k] = v;
    }
    if (Array.isArray(e.removed)) for (const k of e.removed) delete base.sessions[k];
    if (e.stats) base.stats = Object.assign(base.stats, e.stats);
    if (Array.isArray(e.digest)) base.digest = e.digest.slice(-800);
  }
  return base;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

class Store {
  constructor({ file, limits = {}, logger = null }) {
    this.file = file;
    this.logger = logger;
    this.limits = {
      maxSessions: clampInt(limits.maxSessions, 1, 10000, 200),
      maxMessages: clampInt(limits.maxMessages, 4, 500, 40),
      maxNotesPerUser: clampInt(limits.maxNotesPerUser, 1, 50, 6),
    };
    this.sessions = new Map();
    this.dirty = false;
    this.saveTimer = null;
    this.journalFile = file + '.journal';
    this.archiveFile = path.join(path.dirname(file), 'memory-archive.json');
    this.archive = this._loadArchive();
    this.dirtyKeys = new Set();
    this.digestDirty = false;
    this.fullDirty = false;
    this.stats = { messages: 0, replies: 0 };
    this.digest = [];
    this.load();
  }

  /** 记忆文件被外部改过（比如恢复备份）之后，重新读一遍，不用重启服务 */
  reloadFromDisk() {
    // 恢复备份时 store.json 已经被整个替换了；增量日志里此刻都是「恢复前」的旧数据，
    // 留着会在重放时把刚恢复的内容盖回去，所以先清掉。
    try {
      fs.writeFileSync(this.journalFile, '', 'utf8');
    } catch { /* 文件不存在或写不了都无所谓 */ }
    this.sessions.clear();
    this.digest = [];
    this.stats = { messages: 0, replies: 0 };
    this.dirtyKeys.clear();
    this.digestDirty = false;
    this.fullDirty = false;
    this.load();
    this.dirty = false;
    return this.sessions.size;
  }

  load() {
    try {
      const raw = readStoreFile(this.file);
      for (const [key, sess] of Object.entries(raw.sessions || {})) {
        this.sessions.set(key, this.normalizeSession(key, sess));
      }
      if (raw.stats) this.stats = { ...this.stats, ...raw.stats };
      if (Array.isArray(raw.digest)) this.digest = raw.digest.slice(-800);
    } catch (err) {
      this.logger && this.logger.warn('记忆文件读取失败，将使用空记忆：' + err.message);
    }
  }

  normalizeSession(key, sess) {
    return {
      key,
      platform: sess.platform || 'web',
      chatId: sess.chatId || key,
      chatType: sess.chatType || 'private',
      title: sess.title || '',
      createdAt: sess.createdAt || Date.now(),
      lastActiveAt: sess.lastActiveAt || Date.now(),
      messages: Array.isArray(sess.messages) ? sess.messages.slice(-this.limits.maxMessages) : [],
      profiles: sess.profiles && typeof sess.profiles === 'object' ? sess.profiles : {},
      state: {
        mutedUntil: sess.state?.mutedUntil || 0,
        lastReplyAt: sess.state?.lastReplyAt || 0,
        consecutiveReplies: sess.state?.consecutiveReplies || 0,
        adminUntil: sess.state?.adminUntil || 0,
        discussUntil: sess.state?.discussUntil || 0,
        engagedUntil: sess.state?.engagedUntil || 0,
        engagedBy: sess.state?.engagedBy || '',
        silentUntil: sess.state?.silentUntil || 0,
        replyTimes: Array.isArray(sess.state?.replyTimes) ? sess.state.replyTimes.slice(-200) : [],
      },
      seenIds: Array.isArray(sess.seenIds) ? sess.seenIds.slice(-200) : [],
    };
  }

  ensureSession(key, meta = {}) {
    const safeKey = String(key).slice(0, 200);
    let sess = this.sessions.get(safeKey);
    if (!sess) {
      sess = this.normalizeSession(safeKey, {
        platform: meta.platform || 'web',
        chatId: meta.chatId || safeKey,
        chatType: meta.chatType || 'private',
        title: meta.title || '',
        createdAt: Date.now(),
        lastActiveAt: Date.now(),
      });
      this.sessions.set(safeKey, sess);
      this.prune();
    } else if (meta.title && !sess.title) {
      sess.title = String(meta.title).slice(0, 60);
    }
    return sess;
  }

  prune() {
    if (this.sessions.size <= this.limits.maxSessions) return;
    const list = [...this.sessions.values()].sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    const overflow = this.sessions.size - Math.max(10, Math.floor(this.limits.maxSessions * 0.9));
    for (let i = 0; i < overflow && i < list.length; i++) {
      this.sessions.delete(list[i].key);
    }
    this.markDirty();            // 整张表变了 → 压快照
  }

  getState(key) {
    return this.ensureSession(key).state;
  }

  isDuplicate(key, msgId) {
    if (!msgId) return false;
    const sess = this.ensureSession(key);
    return sess.seenIds.includes(String(msgId));
  }

  markSeen(key, msgId) {
    if (!msgId) return;
    const sess = this.ensureSession(key);
    const id = String(msgId);
    if (!sess.seenIds.includes(id)) {
      sess.seenIds.push(id);
      if (sess.seenIds.length > 200) sess.seenIds = sess.seenIds.slice(-200);
      this.markDirty(key);
    }
  }

  /** 把最后一条消息的正文替换掉（用于隐藏魔咒这类敏感内容） */
  redactLastMessage(key, replacement = '（已隐藏）') {
    const sess = this.ensureSession(key);
    const last = sess.messages[sess.messages.length - 1];
    if (!last) return false;
    last.text = String(replacement).slice(0, 200);
    this.markDirty(key);
    return true;
  }

  /** 收集别人的消息，供主人汇总查看 */
  addDigest(entry) {
    this.digest.push(entry);
    if (this.digest.length > 800) this.digest.splice(0, this.digest.length - 800);
    this.markDirty(null, { digest: true });
  }

  listDigest(since = 0) {
    const list = this.digest || [];
    return list.filter((d) => (d.ts || 0) > since);
  }

  appendMessage(key, message) {
    const sess = this.ensureSession(key);
    const entry = {
      role: message.role === 'assistant' ? 'assistant' : 'user',
      name: trimText(message.name || (message.role === 'assistant' ? '鲸鲸' : '群友'), 60),
      uid: message.uid ? String(message.uid).slice(0, 100) : '',
      text: trimText(message.text),
      ts: Number(message.ts) || Date.now(),
    };
    if (message.addressedToBot) entry.addressedToBot = true;
    if (Array.isArray(message.mentionedNames)) entry.mentionedNames = message.mentionedNames.slice(0, 4).map((n) => trimText(n, 60));
    if (Array.isArray(message.inferredTargetNames)) entry.inferredTargetNames = message.inferredTargetNames.slice(0, 4).map((n) => trimText(n, 60));
    if (message.replyToName) entry.replyToName = trimText(message.replyToName, 60);
    if (message.replyToUserId) entry.replyToUserId = String(message.replyToUserId).slice(0, 100);
    if (message.msgId) entry.msgId = String(message.msgId).slice(0, 120);
    if (message.error) entry.error = true;
    sess.messages.push(entry);
    if (sess.messages.length > this.limits.maxMessages) {
      // 只删已经被摘要覆盖的那部分：未摘要的宁可先留着，等整理时压进摘要。
      // 硬上限 2 倍，防止一直没整理（演示模式/关掉整理）把内存撑爆。
      const upto = Number(sess.summaryUpto) || 0;
      const overflow = sess.messages.length - this.limits.maxMessages;
      const droppable = Math.min(upto, overflow, Math.max(0, sess.messages.length - this.limits.maxMessages));
      if (droppable > 0) {
        sess.messages.splice(0, droppable);
        sess.summaryUpto = Math.max(0, upto - droppable);
      }
      const hard = this.limits.maxMessages * 2;
      if (sess.messages.length > hard) sess.messages.splice(0, sess.messages.length - hard);
    }
    sess.lastActiveAt = entry.ts;
    if (entry.role === 'user') {
      sess.state.consecutiveReplies = 0;
      this.stats.messages += 1;
    } else {
      sess.state.consecutiveReplies += 1;
      sess.state.lastReplyAt = entry.ts;
      sess.state.replyTimes.push(entry.ts);
      if (sess.state.replyTimes.length > 200) sess.state.replyTimes = sess.state.replyTimes.slice(-200);
      this.stats.replies += 1;
    }
    this.markDirty(key);
    return entry;
  }

  messages(key, limit = 24) {
    const sess = this.ensureSession(key);
    return sess.messages.slice(-limit);
  }

  profile(key, uid, name) {
    const sess = this.ensureSession(key);
    const id = String(uid || 'anonymous').slice(0, 100);
    let p = sess.profiles[id];
    const now = Date.now();
    if (!p) {
      p = { uid: id, name: trimText(name || '群友', 60), nickname: '', firstSeenAt: now, lastSeenAt: now, count: 0, notes: [] };
      sess.profiles[id] = p;
    }
    if (!p.nickname) p.nickname = '';
    if (name) p.name = trimText(name, 60);
    p.lastSeenAt = now;
    p.count += 1;
    this.markDirty(key);
    return p;
  }

  /** 用户指定的称呼（「叫我小海」），优先级高于群昵称 */
  setNickname(key, uid, nickname) {
    const p = this.profile(key, uid);
    p.nickname = trimText(nickname, 60);
    this.markDirty(key);
    return p;
  }

  /** 展示用名字 */
  displayName(key, uid, fallback = '群友') {
    const p = this.ensureSession(key).profiles[String(uid || '')];
    if (!p) return fallback;
    return p.nickname || p.name || fallback;
  }

  _loadArchive() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.archiveFile, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }

  _saveArchive() {
    try {
      fs.mkdirSync(path.dirname(this.archiveFile), { recursive: true });
      fs.writeFileSync(this.archiveFile, JSON.stringify(this.archive, null, 2), 'utf8');
    } catch (err) {
      if (this.logger) this.logger.warn('归档写盘失败：' + ((err && err.message) || err));
    }
  }

  /** 把记忆沉到归档（不是删除，还能翻出来 / 导出） */
  _archivePush(entries) {
    if (!entries || !entries.length) return { archived: 0, purged: 0 };
    const now = Date.now();
    for (const e of entries) this.archive.push({ ...e, id: newId(), archivedAt: now });
    const { kept, dropped } = forget.trimArchive(this.archive, 3000);
    this.archive = kept;
    this._saveArchive();
    return { archived: entries.length, purged: dropped.length };
  }

  /** 归档里有多少条（记忆页要显示「已忘掉多少」） */
  archiveCount() {
    return this.archive.length;
  }


  /**
   * 定期「忘」一遍：
   *  - 太旧、很久没被想起、又不是承诺/雷区的记忆 → 沉到归档（不再进提示词）
   *  - 池子超上限 → 淘汰分数最低的
   * 返回 { archived, evicted, purged }
   */
  sweep(now = Date.now(), opts = {}) {
    let archived = 0;
    let evicted = 0;
    let purged = 0;
    for (const [key, sess] of this.sessions) {
      let touched = false;
      for (const p of Object.values(sess.profiles || {})) {
        if (!Array.isArray(p.notes) || !p.notes.length) continue;
        const keep = [];
        const move = [];
        for (const n of p.notes) {
          if (forget.shouldArchive(n, now, opts)) move.push(n);
          else keep.push(n);
        }
        if (move.length) {
          p.notes = keep;
          touched = true;
          archived += move.length;
          purged += this._archivePush(move.map((n) => ({ key, uid: p.uid, note: n, reason: 'archive' }))).purged;
        }
        if (p.notes.length > this.limits.maxNotesPerUser) {
          const idx = new Set(forget.pickEvictions(p.notes, this.limits.maxNotesPerUser, now));
          const gone = p.notes.filter((_, i) => idx.has(i));
          p.notes = p.notes.filter((_, i) => !idx.has(i));
          touched = true;
          evicted += gone.length;
          purged += this._archivePush(gone.map((n) => ({ key, uid: p.uid, note: n, reason: 'evict' }))).purged;
        }
      }
      if (touched) this.markDirty(key);
    }
    if (archived || evicted || purged) {
      if (this.logger) this.logger.info(`记忆清理：归档 ${archived}、淘汰 ${evicted}、归档文件顶掉 ${purged}`);
    }
    return { archived, evicted, purged };
  }

  /**
   * 写入一条记忆。note 可以是字符串（老调用方），也可以是
   * {text, kind, importance} —— kind 取值 fact/preference/promise/recent/taboo。
   */
  addNote(key, uid, note, meta = {}) {
    const p = this.profile(key, uid);
    const raw = typeof note === 'string' ? { text: note } : (note || {});
    const text = trimText(raw.text, 60);
    if (!text) return p.notes;
    const fresh = recall.normalizeNote({ ...raw, text, ...meta }, Date.now());
    if (!fresh) return p.notes;
    const dup = p.notes.some((n) => {
      const t = recall.noteText(n);
      return t.includes(text) || text.includes(t);
    });
    if (!dup) {
      // 同一件事的不同说法（「他爱吃辣」/「他爱吃火锅」）合成一条，别白占名额
      const idx = recall.findSimilar(p.notes, text, 0.85);
      if (idx >= 0) {
        const old = p.notes[idx];
        const oldText = recall.noteText(old);
        const merged = oldText.length >= text.length ? oldText : text;
        p.notes[idx] = {
          ...(typeof old === 'object' ? old : { createdAt: Date.now() }),
          text: merged,
          kind: fresh.kind === 'fact' ? (typeof old === 'object' && old.kind) || fresh.kind : fresh.kind,
          importance: Math.max(Number(old.importance) || 1, fresh.importance),
        };
        this.markDirty(key);
        return p.notes;
      }
      p.notes.push(fresh);
      if (p.notes.length > this.limits.maxNotesPerUser) {
        // 按分数淘汰（承诺/雷区有保护），不是按时间淘汰最老的
        const idx = new Set(forget.pickEvictions(p.notes, this.limits.maxNotesPerUser, Date.now()));
        const gone = p.notes.filter((_, i) => idx.has(i));
        p.notes = p.notes.filter((_, i) => !idx.has(i));
        if (gone.length) {
          this._archivePush(gone.map((n) => ({ key, uid: p.uid, note: n, reason: 'evict' })));
        }
      }
    }
    this.markDirty(key);
    return p.notes;
  }

  /** 滚动摘要：记下「你们最近聊了什么」，并记住整理到第几条消息 */
  setSummary(key, text, meta = {}) {
    const sess = this.ensureSession(key);
    sess.summary = trimText(text, 800);
    sess.summaryAt = Date.now();
    sess.summaryUpto = Number(meta.upto) || (sess.messages || []).length;
    this.markDirty(key);
    return sess.summary;
  }

  /** 这些记忆刚被用上：记下时间，下次别急着复读 */
  touchNotes(key, uid, texts, now = Date.now()) {
    const p = this.profile(key, uid);
    const set = new Set((texts || []).map((t) => recall.noteText(t)).filter(Boolean));
    if (!set.size) return p.notes;
    p.notes = p.notes.map((n) => {
      const t = recall.noteText(n);
      if (!set.has(t) || typeof n === 'string') return n;
      return { ...n, lastMentionedAt: now, mentions: (Number(n.mentions) || 0) + 1 };
    });
    this.markDirty(key);
    return p.notes;
  }

  removeNote(key, uid, needle) {
    const p = this.profile(key, uid);
    const raw = trimText(needle, 60);
    const before = p.notes.length;
    if (!raw) {
      p.notes = [];
    } else {
      p.notes = p.notes.filter((n) => {
        const t = recall.noteText(n);
        return !t.includes(raw) && !raw.includes(t);
      });
    }
    this.markDirty(key);
    return { removed: before - p.notes.length, notes: p.notes };
  }

  listNotes(key) {
    const sess = this.ensureSession(key);
    return Object.values(sess.profiles)
      .filter((p) => p.notes.length > 0)
      .map((p) => ({ uid: p.uid, name: p.name, notes: p.notes.map((n) => recall.noteText(n)) }));
  }

  setMuted(key, ms) {
    const st = this.getState(key);
    st.mutedUntil = Date.now() + Math.max(0, ms);
    this.markDirty(key);
    return st.mutedUntil;
  }

  resetSession(key) {
    const sess = this.ensureSession(key);
    sess.messages = [];
    sess.seenIds = [];
    sess.state = { mutedUntil: 0, lastReplyAt: 0, consecutiveReplies: 0, replyTimes: [], adminUntil: 0, discussUntil: 0, engagedUntil: 0, engagedBy: '', silentUntil: 0 };
    this.markDirty(key);
  }

  resetAll() {
    this.sessions.clear();
    this.stats = { messages: 0, replies: 0 };
    this.digest = [];
    this.markDirty();
  }

  summary() {
    let messages = 0;
    let notes = 0;
    for (const sess of this.sessions.values()) {
      messages += sess.messages.length;
      for (const p of Object.values(sess.profiles)) notes += p.notes.length;
    }
    return { sessions: this.sessions.size, messages, notes, totalMessages: this.stats.messages, totalReplies: this.stats.replies };
  }

  markDirty(key, { digest = false } = {}) {
    this.dirty = true;
    if (digest) this.digestDirty = true;
    if (key) this.dirtyKeys.add(String(key));
    else if (!digest) this.fullDirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, SAVE_DEBOUNCE_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /** 全量落盘：写快照 + 清空增量日志（原子写，tmp + rename） */
  compact() {
    const payload = { version: 1, savedAt: new Date().toISOString(), stats: this.stats, digest: this.digest, sessions: {} };
    for (const [key, sess] of this.sessions) payload.sessions[key] = sess;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, this.file);
    try {
      fs.writeFileSync(this.journalFile, '', 'utf8');
    } catch { /* 日志清不掉不影响快照 */ }
    this.dirtyKeys.clear();
    this.digestDirty = false;
    this.fullDirty = false;
    this.dirty = false;
  }

  /** 增量落盘：只追加这一轮动过的会话。返回写入的条目数。 */
  flush() {
    if (!this.dirty) return 0;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // prune / resetAll 这种「整张表变了」的操作直接压快照，别写日志
      if (this.fullDirty) {
        this.compact();
        return 1;
      }
      const entry = { t: Date.now() };
      const sessions = {};
      for (const key of this.dirtyKeys) {
        const sess = this.sessions.get(key);
        if (sess) sessions[key] = sess;
      }
      if (Object.keys(sessions).length) entry.sessions = sessions;
      if (this.digestDirty) entry.digest = this.digest;
      entry.stats = this.stats;
      if (!entry.sessions && !entry.digest) {
        this.dirty = false;
        return 0;
      }
      fs.appendFileSync(this.journalFile, JSON.stringify(entry) + '\n', 'utf8');
      this.dirtyKeys.clear();
      this.digestDirty = false;
      this.dirty = false;
      // 日志太长了就压回快照，避免启动时要重放几千行
      try {
        if (fs.statSync(this.journalFile).size > JOURNAL_COMPACT_BYTES) this.compact();
      } catch { /* stat 失败就算了 */ }
      return 1;
    } catch (err) {
      this.logger && this.logger.error('保存记忆失败：' + err.message);
      return 0;
    }
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // 退出时压一次快照：下次启动不用重放日志，store.json 也是最新的，
    // 用户直接拷 data\store.json 走人也不会丢东西。
    this.dirty = true;
    this.fullDirty = true;
    this.flush();
  }
}

module.exports = { Store, readStoreFile };
