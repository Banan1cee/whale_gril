'use strict';

/**
 * 触发判定链（trace）：给「她为什么回 / 为什么不回」留证据，但不留聊天正文。
 *
 * 为什么不是直接把消息写进日志：
 *   日志会被打包发给别人看，正文是隐私；而排查「没触发」真正需要的是
 *   **判定链**（命中了哪条规则、被哪条否决、当时静默期/接话窗口/限流计数是多少），
 *   这些是结构化的，一个字的隐私都没有。
 *
 * 两层：
 *   层 1 trace-YYYYMMDD.jsonl —— 每条消息一行：fp / 会话哈希 / 长度 / 类型 / @ / reason / state
 *   层 2 raw/<fp>.json        —— 原文副本，24 小时 / 200 条自动清，导出日志包时默认不带，
 *                                只有用户在启动器里手动勾选「包含最近消息原文」才进包。
 *
 * fp 是「会话 + 消息 id + 正文」的短哈希：日志和原文靠它对上，看不到内容也知道是哪条。
 * 同一 fp 也用于回放脚本（scripts/replay-trace.js）重跑判定。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RAW_KEEP = 200;                       // 最多留 200 条原文
const RAW_MAX_AGE_MS = 24 * 3600 * 1000;    // 超过 24 小时就删
const TRACE_FILE_KEEP_DAYS = 3;             // jsonl 只留 3 天
const PRUNE_EVERY_MS = 60 * 1000;

function hash8(...parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p == null ? '' : p)).join('\u0000')).digest('hex').slice(0, 8);
}

/** 和 logger 一样用东八区，日志和 trace 的时间能对得上 */
const STAMP = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function localStamp(ms) {
  return STAMP.format(new Date(ms));
}

/** 会话 id 打码后仍可区分：g:3fa2b1c0 / u:9c11ee02 */
function chatTag(msg) {
  const type = msg && msg.chatType === 'group' ? 'g' : 'u';
  return type + ':' + hash8(msg && msg.platform, msg && msg.chatId);
}

/** 只摘判定相关的状态，别把整个 state（还有别人的路由信息）倒出去 */
function stateSummary(state, nowMs) {
  const out = {};
  if (!state) return out;
  const num = (v) => Number(v) || 0;
  const left = (v) => Math.round((num(v) - nowMs) / 1000);
  const silent = left(state.silentUntil);
  if (silent > 0) out.silent = silent;
  const engaged = left(state.engagedUntil);
  if (engaged > 0) out.engaged = engaged;
  const muted = left(state.mutedUntil);
  if (muted > 0) out.muted = muted;
  const replies = Array.isArray(state.replyTimes)
    ? state.replyTimes.filter((t) => nowMs - Number(t) < 60000).length
    : 0;
  if (replies) out.replies1m = replies;
  return out;
}

function createTrace({ dataDir, enabled = true, raw = false, now = () => Date.now() } = {}) {
  const dir = path.join(dataDir, 'trace');
  const rawDir = path.join(dir, 'raw');
  let lastPrune = 0;

  function ensure() {
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 写不了就静默降级 */ }
  }

  function prune(nowMs) {
    if (nowMs - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = nowMs;
    try {
      const cutoff = new Date(nowMs - RAW_MAX_AGE_MS);
      const raws = fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : [];
      const stat = (name) => {
        try { return fs.statSync(path.join(rawDir, name)); } catch { return null; }
      };
      let kept = [];
      for (const name of raws) {
        const st = stat(name);
        if (!st) continue;
        if (st.mtime < cutoff) { try { fs.unlinkSync(path.join(rawDir, name)); } catch { /* 删不掉下次再来 */ } continue; }
        kept.push({ name, mtime: st.mtimeMs });
      }
      // 还超量就按最旧的先删
      kept.sort((a, b) => a.mtime - b.mtime);
      while (kept.length > RAW_KEEP) {
        const gone = kept.shift();
        try { fs.unlinkSync(path.join(rawDir, gone.name)); } catch { /* 同上 */ }
      }
      // jsonl 只留最近几天
      const keepAfter = nowMs - TRACE_FILE_KEEP_DAYS * 86400000;
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!/^trace-\d{8}\.jsonl$/.test(name)) continue;
        const full = path.join(dir, name);
        try {
          if (fs.statSync(full).mtimeMs < keepAfter) fs.unlinkSync(full);
        } catch { /* 忽略 */ }
      }
    } catch { /* 清理失败不影响主流程 */ }
  }

  /**
   * @param {{msg:object, decision:object, state?:object}} input
   * @returns {{fp:string, chat:string}|null}
   */
  function record({ msg, decision, state } = {}) {
    if (!enabled || !msg || !decision) return null;
    const nowMs = now();
    const text = String(msg.text || '');
    const fp = hash8(msg.platform, msg.chatId, msg.msgId || '', text.slice(0, 200));
    const chat = chatTag(msg);
    const stamp = localStamp(nowMs);
    const entry = {
      at: stamp,
      fp,
      chat,
      action: decision.action || '',
      reason: decision.reason || '',
      cmd: decision.commandType || '',
      atMe: msg.atMe ? 1 : 0,
      quote: msg.replyToBot ? 1 : 0,
      // 主人 / 被叫到这类身份信息会直接决定要不要回，回放时得带上
      master: msg.isMaster ? 1 : 0,
      len: Array.from(text).length,
      sender: hash8(msg.senderId || msg.senderName || ''),
      state: stateSummary(state, nowMs),
    };
    ensure();
    try {
      fs.appendFileSync(path.join(dir, 'trace-' + entry.at.slice(0, 10).replace(/-/g, '') + '.jsonl'),
        JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* 写不了就算了，绝不影响回消息 */ }
    if (raw && text) {
      try {
        fs.mkdirSync(rawDir, { recursive: true });
        fs.writeFileSync(path.join(rawDir, fp + '.json'), JSON.stringify({
          at: entry.at,
          fp,
          chat,
          senderName: String(msg.senderName || '').slice(0, 40),
          text,
        }, null, 2), 'utf8');
      } catch { /* 同上 */ }
    }
    prune(nowMs);
    return { fp, chat };
  }

  return { record, enabled, raw, dir, rawDir, chatTag, stateSummary, hash8 };
}

module.exports = { createTrace, hash8, chatTag, stateSummary };
