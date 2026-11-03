'use strict';

/**
 * 把人物卡 / 事件 / 摘要拼成 soft block。
 *
 * 位置：最后一条 user 消息里（不是 system），避免打断前缀缓存。
 * 预算：由 budgetPlan 按 dialogueBudget 换算（默认 5,500 时是 900 token），
 *      调用方通过 budget 传进来；不传就用默认值，保持旧行为。
 *
 * 2026-11 修「超预算把结尾声明和摘要切掉半句」：
 *   以前超预算先整体减半，最后还超就 `block.slice(0, limit)` 硬裁字符串——
 *   被切掉的正好是**结尾那句「只来自当前这个聊天」**（等于把「别提别的聊天」这条
 *   硬约束弄丢了，串聊泄漏的入口），摘要也会被切成半句 / 半截 JSON。
 *   现在：
 *   - 按段组织：【这个聊天里的 TA】/【相关事件】/【这段之前聊过】，结尾声明单独一段；
 *   - 结尾声明永远保留在最后、不参与任何裁剪；
 *   - 超预算按固定顺序丢：相关事件从最旧删 → 摘要从尾部整句删（按 。！？； 和换行切，
 *     不切半句）→ 人物卡条数减半（反复减半，规格里的「再减半」）→ 最后才按字符硬裁；
 *   - 预算口径仍是 estimateBudgetTokens（含结尾声明，因为声明也要占 prompt）。
 */
const { LIMITS } = require('./constants');
const { estimateBudgetTokens } = require('./tokens');
const personCard = require('./personCard');

/** 结尾声明：独立一段、永远在最后。改这句话前先看 docs/memory-v2-spec.md 第 7.7 节 */
const MEMORY_SCOPE_NOTICE = '（这些只来自当前这个聊天；别提别的聊天里的事，被问到就说“这个我不清楚”。）';

/** 摘要的原文上限（字符）。按整句丢，不切半句，所以只是「最多留这么多句」 */
const SUMMARY_MAX_CHARS = 1200;

/** 句子边界：中文句末标点 + 换行 */
const SENTENCE_END = new Set(['。', '！', '？', '；', '\n']);

/** 按码点截断：emoji 这类代理对不会被切成半个字符 */
function clip(textValue, max) {
  const s = String(textValue || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

function listLine(items) {
  return (items || []).filter(Boolean).join('；');
}

/**
 * 按 。！？；和换行切句，切出来的每一段都以边界符结尾（末尾不足一句的残句单独成段）。
 * 不在这里丢任何东西：丢整句的地方在收预算时。
 */
function splitSentences(textValue) {
  const out = [];
  let buf = '';
  for (const ch of String(textValue == null ? '' : textValue)) {
    buf += ch;
    if (SENTENCE_END.has(ch)) {
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** 摘要在原文层面只留前 1,200 字符，但同样是整句地丢，不切半句 */
function capSentences(sentences) {
  const list = sentences.slice();
  let total = list.reduce((n, s) => n + s.length, 0);
  while (list.length > 1 && total > SUMMARY_MAX_CHARS) {
    total -= list.pop().length;
  }
  return list;
}

/** 事件的时间戳：优先 date（ISO），没有就退回 createdAt */
function eventTime(ev) {
  const date = ev && ev.date ? Date.parse(`${ev.date}T00:00:00`) : NaN;
  if (Number.isFinite(date)) return date;
  return Number(ev && ev.createdAt) || 0;
}

/** 最旧的那条事件（按时间，不按检索排名——排名靠前不代表新） */
function oldestEventIndex(events) {
  let idx = 0;
  let best = Infinity;
  for (let i = 0; i < events.length; i += 1) {
    const t = eventTime(events[i]);
    if (t < best) {
      best = t;
      idx = i;
    }
  }
  return idx;
}

function halve(list) {
  return list.length <= 1 ? list : list.slice(0, Math.max(1, Math.ceil(list.length / 2)));
}

/**
 * 渲染三段正文（不含结尾声明）。
 * 每段只在有内容时出现，段间空行分隔；空段不占位置。
 */
function renderBody({ traits, prefs, threads, events, summary }) {
  const sections = [];
  if (traits.length || prefs.length || threads.length) {
    const lines = ['【这个聊天里的 TA】'];
    if (traits.length) lines.push(`- 性格：${listLine(traits)}`);
    if (prefs.length) lines.push(`- 偏好：${listLine(prefs)}`);
    if (threads.length) lines.push(`- 没聊完：${listLine(threads)}`);
    sections.push(lines.join('\n'));
  }
  if (events.length) {
    const lines = ['【相关事件】'];
    for (const ev of events) {
      lines.push(`- [${ev && ev.date ? ev.date : ''}] ${clip(ev && ev.title, 24)}：${clip(ev && ev.summary, 100)}`);
    }
    sections.push(lines.join('\n'));
  }
  const summaryText = summary.join('').trim();
  if (summaryText) sections.push(`【这段之前聊过】\n${summaryText}`);
  return sections.join('\n\n');
}

/**
 * 最后手段：按字符硬裁，但按码点裁，代理对不会被切开。
 * 用二分找「最长的、加上结尾声明仍不超预算的前缀」，不再用字符数当 token 数拍脑袋。
 */
function hardCut(body, limit, measure) {
  const chars = Array.from(body);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join('')) <= limit) lo = mid;
    else hi = mid - 1;
  }
  // 结尾的空白去掉，避免正文和声明之间多出空行
  return chars.slice(0, lo).join('').replace(/[\s\u3000]+$/, '');
}

/**
 * @param {{card?:object, events?:object[], summary?:string, now?:number, budget?:number, caps?:object}} input
 *   budget：这一块能用的 token 上限（默认 LIMITS.memoryTokens = 900）
 *   caps：每类展示几条 { traits, prefs, threads, events }，默认 6/10/4/5（= 900 预算下的旧值）
 * @returns {string}
 */
function buildMemoryBlock({ card = null, events = [], summary = '', budget = LIMITS.memoryTokens, caps = null } = {}) {
  const limit = Math.max(0, Number(budget) || LIMITS.memoryTokens);
  const show = {
    traits: Math.max(1, Number(caps && caps.traits) || 6),
    prefs: Math.max(1, Number(caps && caps.prefs) || 10),
    threads: Math.max(1, Number(caps && caps.threads) || 4),
    events: Math.max(1, Number(caps && caps.events) || LIMITS.retrievalTopK),
  };
  if (!card) return '';
  const traits = personCard.activeTraits(card)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .map((t) => clip(t.text, 40));
  const prefs = personCard.activePreferences(card)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .map((p) => clip(p.text, 40));
  const threads = personCard.openThreads(card)
    .sort((a, b) => (b.lastMentionedAt || 0) - (a.lastMentionedAt || 0))
    .map((t) => clip(t.text, 40));
  const recentEvents = (events || []).slice(0, show.events);

  // 分级的「可丢弃状态」：后面的裁剪只改这里的条数，渲染交给 renderBody
  const state = {
    traits: traits.slice(0, show.traits),
    prefs: prefs.slice(0, show.prefs),
    threads: threads.slice(0, show.threads),
    events: recentEvents.slice(),
    summary: capSentences(splitSentences(summary)),
  };

  // 结尾声明也算这块的 prompt 成本，所以测量时一起算进去；但它自己永远不参与裁剪
  const measure = (body) => estimateBudgetTokens(body ? `${body}\n\n${MEMORY_SCOPE_NOTICE}` : MEMORY_SCOPE_NOTICE);
  let body = renderBody(state);
  if (!body) return '';

  // 1) 相关事件：从最旧的一条开始删，直到不超预算
  while (measure(body) > limit && state.events.length) {
    state.events.splice(oldestEventIndex(state.events), 1);
    body = renderBody(state);
  }

  // 2) 摘要：从尾部按整句删，直到不超预算（删的是整句，不会切半句 / 半截 JSON）
  while (measure(body) > limit && state.summary.length) {
    state.summary.pop();
    body = renderBody(state);
  }

  // 3) 人物卡条数减半：先减一半，还超就再减一半，一直减到每条只剩 1 条
  while (measure(body) > limit) {
    const before = state.traits.length + state.prefs.length + state.threads.length;
    state.traits = halve(state.traits);
    state.prefs = halve(state.prefs);
    state.threads = halve(state.threads);
    const after = state.traits.length + state.prefs.length + state.threads.length;
    if (after === before) break; // 每条都只剩 1 条，再减不下去，只能硬裁
    body = renderBody(state);
  }

  // 4) 最后才是按字符硬裁（按码点，不切开代理对）；结尾声明仍在最后
  if (measure(body) > limit) body = hardCut(body, limit, measure);

  return body ? `${body}\n\n${MEMORY_SCOPE_NOTICE}` : MEMORY_SCOPE_NOTICE;
}

module.exports = { buildMemoryBlock, MEMORY_SCOPE_NOTICE, splitSentences };
