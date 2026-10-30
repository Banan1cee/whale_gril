'use strict';

const { randomUUID } = require('node:crypto');
const features = require('./features');

function bounded(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : fallback;
}

/** Ephemeral queue: OFF never reads/writes the old persistent store.digest. */
class DigestService {
  constructor(config, { now = Date.now } = {}) {
    this.config = config;
    this.now = now;
    this.enabled = false;
    this.entries = [];
    this.generation = '';
    this.startedAt = 0;
    this.reconcile();
  }

  reconcile() {
    const enabled = features.isOn(this.config, 'digest');
    if (enabled !== this.enabled) {
      this.entries = [];
      this.generation = randomUUID();
      this.startedAt = this.now();
      this.enabled = enabled;
    }
    return this.enabled;
  }

  collect(msg) {
    if (!this.reconcile() || msg?.platform !== 'wechat' || msg.isMaster) return false;
    const text = String(msg.cleanText ?? msg.text ?? '').trim();
    if (!text || !msg.chatId || !msg.senderId) return false;
    this.entries.push({ ts: this.now(), chat: String(msg.chatTitle || msg.chatId).slice(0, 100),
      chatType: msg.chatType === 'group' ? 'group' : 'private',
      sender: String(msg.senderName || '对方').slice(0, 60), text: text.slice(0, 300) });
    if (this.entries.length > 800) this.entries.splice(0, this.entries.length - 800);
    return true;
  }

  read({ since = 0, until, generation, check = false } = {}) {
    if (!this.reconcile()) return { status: 404, body: { ok: false, error: '消息汇总未开启' } };
    if (generation && generation !== this.generation) {
      return { status: 409, body: { ok: false, error: '消息汇总开关已变更，请丢弃旧任务' } };
    }
    if (check) return { status: 200, body: { ok: true, enabled: true, generation: this.generation } };
    const finite = (n) => n !== '' && n != null && Number.isFinite(Number(n)) && Number(n) >= 0;
    if (!finite(since) || (until != null && !finite(until))) {
      return { status: 400, body: { ok: false, error: '汇总时间范围无效' } };
    }
    // Leave the current millisecond open, so arrivals after this read cannot share the cutoff.
    const end = Math.min(until == null ? Infinity : Number(until), this.now() - 1);
    const start = Math.max(Number(since), this.startedAt - 1);
    const cap = bounded(this.config.digest?.maxItems, 1, 120, 120);
    const all = this.entries.filter((e) => e.ts > start && e.ts <= end);
    const items = all.slice(0, cap);
    const truncated = all.length > cap;
    // 被截断时必须只把游标推到「真正发出去的最后一条」，
    // 否则超出上限的那些消息会永远落在窗口之外，既没发也没下一次。
    const cutoff = truncated && items.length ? items[items.length - 1].ts : end;
    return { status: 200, body: { ok: true, generation: this.generation, until: cutoff,
      ...buildDigest(items, truncated, all.length - items.length) } };
  }
}

function buildDigest(items, truncated = false, deferred = 0) {
  if (!items.length) return { count: 0, text: '' };
  const map = new Map();
  const clean = (text) => String(text || '').replace(/[\r\n\u0000-\u001f]+/g, ' ').trim();
  for (const it of items) {
    const key = (it.chatType === 'group' ? '群 ' : '私聊 ') + clean(it.chat);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  const lines = [`消息汇总（${items.length} 条）`];
  let size = lines[0].length;
  let shown = 0;
  for (const [key, arr] of [...map.entries()].slice(0, 10)) {
    const section = `【${key}】${arr.length} 条`;
    lines.push(section); size += section.length;
    for (const it of arr.slice(-5)) {
      const line = `- ${clean(it.sender || '对方')}：${clean(it.text).slice(0, 80)}`;
      if (size + line.length > 3500) { truncated = true; break; }
      lines.push(line); size += line.length; shown++;
    }
  }
  if (deferred > 0) {
    lines.push(`（还有 ${deferred} 条放不下，留到下一次汇总）`);
  } else if (truncated || shown < items.length) {
    lines.push('（部分消息未展示；每次最多10个会话、每会话5条）');
  }
  return { count: items.length, text: lines.join('\n') };
}

module.exports = { DigestService, buildDigest };
