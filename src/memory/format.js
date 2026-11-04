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

/** 索引行上限：一条 5000 字的记忆进来也只占这一行 */
const INDEX_MAX_CHARS = 60;
/** 详情展开：最多 2 条、每条 ≤200 字（单条配额另算，见 buildMemoryBlock） */
const DETAIL_MAX_CHARS = 200;
const DETAIL_MAX_ITEMS = 2;
/** importance 到这个档位：索引行永不被「挤占」丢掉 */
const IMPORTANCE_KEEP = 0.8;
/** 低 importance 索引行先丢的界线 */
const IMPORTANCE_LOW = 0.5;

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

function halve(list) {
  return list.length <= 1 ? list : list.slice(0, Math.max(1, Math.ceil(list.length / 2)));
}

/** 事件首句：只取第一个句末标点之前的部分，别把整段 5000 字塞进索引 */
function firstSentence(textValue, max) {
  const s = String(textValue || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const end = s.search(/[。！？；!?;\n]/);
  const first = end >= 0 ? s.slice(0, end + 1) : s;
  return clip(first, Math.max(0, max));
}

/**
 * 索引行：`- [日期] 标题：首句`，整条 ≤60 字。
 * 每条事件都至少有一行，详情另段展开 —— 以前一条 400 字会占掉 44% 窗口。
 */
function indexLine(ev) {
  const date = ev && ev.date ? ev.date : '';
  const title = clip(ev && ev.title, 24);
  const prefix = `- [${date}] ${title}：`;
  const room = Math.max(0, INDEX_MAX_CHARS - Array.from(prefix).length);
  return clip(prefix + firstSentence(ev && ev.summary, room), INDEX_MAX_CHARS);
}

/** 事件 importance（缺省 0） */
function importanceOf(ev) {
  return Number(ev && ev.importance) || 0;
}

/**
 * 从候选里挑一条「可丢」的事件：优先最不重要，同分丢最旧。
 * maxImportance 用来分档：先丢 <0.5 的，再 <0.8 的；≥0.8 永不在这里丢。
 */
function pickDroppableEvent(events, maxImportance) {
  let best = -1;
  let bestImp = Infinity;
  let bestTime = Infinity;
  for (let i = 0; i < events.length; i += 1) {
    const imp = importanceOf(events[i]);
    if (imp >= maxImportance) continue;
    const t = eventTime(events[i]);
    if (imp < bestImp || (imp === bestImp && t < bestTime)) {
      best = i;
      bestImp = imp;
      bestTime = t;
    }
  }
  return best;
}

/**
 * 渲染三段正文（不含结尾声明）。
 * 每段只在有内容时出现，段间空行分隔；空段不占位置。
 *
 * 事件分两层：【相关事件·索引】每条一行常驻；命中的少数事件另起【展开：标题】段。
 */
function renderBody({ traits, prefs, threads, events, expand = [], summary }) {
  const sections = [];
  if (traits.length || prefs.length || threads.length) {
    const lines = ['【这个聊天里的 TA】'];
    if (traits.length) lines.push(`- 性格：${listLine(traits)}`);
    if (prefs.length) lines.push(`- 偏好：${listLine(prefs)}`);
    if (threads.length) lines.push(`- 没聊完：${listLine(threads)}`);
    sections.push(lines.join('\n'));
  }
  if (events.length) {
    const lines = ['【相关事件·索引】'];
    for (const ev of events) lines.push(indexLine(ev));
    sections.push(lines.join('\n'));
  }
  for (const ev of expand) {
    const detail = clip(ev && ev.summary, DETAIL_MAX_CHARS);
    if (detail) sections.push(`【展开：${clip(ev && ev.title, 24)}】\n${detail}`);
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

  // 单条配额：一条记忆最多占窗口的 25%（≈225 token @900）。
  // 超过就只留索引行、不展开 —— 否则一条 400 字会把别人全挤掉。
  const itemLimit = Math.max(60, Math.round(limit * 0.25));
  const expandable = recentEvents
    .filter((ev) => ev && (
      ev.expand === true
      || ev._expand === true
      || importanceOf(ev) >= IMPORTANCE_KEEP
    ))
    .filter((ev) => estimateBudgetTokens(clip(ev && ev.summary, DETAIL_MAX_CHARS)) <= itemLimit)
    .sort((a, b) => importanceOf(b) - importanceOf(a))
    .slice(0, DETAIL_MAX_ITEMS);

  // 分级的「可丢弃状态」：后面的裁剪只改这里的条数，渲染交给 renderBody
  const state = {
    traits: traits.slice(0, show.traits),
    prefs: prefs.slice(0, show.prefs),
    threads: threads.slice(0, show.threads),
    events: recentEvents.slice(),
    expand: expandable.slice(),
    summary: capSentences(splitSentences(summary)),
  };

  // 结尾声明也算这块的 prompt 成本，所以测量时一起算进去；但它自己永远不参与裁剪
  const measure = (body) => estimateBudgetTokens(body ? `${body}\n\n${MEMORY_SCOPE_NOTICE}` : MEMORY_SCOPE_NOTICE);
  let body = renderBody(state);
  if (!body) return '';

  const dropEvent = (idx) => {
    const [gone] = state.events.splice(idx, 1);
    // 索引行没了，它对应的详情段也不能单独留着
    state.expand = state.expand.filter((ev) => ev !== gone);
    body = renderBody(state);
  };

  // 1) 挤占顺序①：低 importance（<0.5）的索引行先整条丢，不看新旧
  while (measure(body) > limit) {
    const idx = pickDroppableEvent(state.events, IMPORTANCE_LOW);
    if (idx < 0) break;
    dropEvent(idx);
  }

  // 2) 挤占顺序②：详情展开从最不重要的一条开始整段丢（索引行还留着）
  while (measure(body) > limit && state.expand.length) {
    state.expand.pop();
    body = renderBody(state);
  }

  // 3) 挤占顺序③：中 importance（<0.8）的索引行整条丢；≥0.8 的永不在这里丢
  while (measure(body) > limit) {
    const idx = pickDroppableEvent(state.events, IMPORTANCE_KEEP);
    if (idx < 0) break;
    dropEvent(idx);
  }

  // 4) 摘要：从尾部按整句删，直到不超预算（删的是整句，不会切半句 / 半截 JSON）
  while (measure(body) > limit && state.summary.length) {
    state.summary.pop();
    body = renderBody(state);
  }

  // 5) 人物卡条数减半：先减一半，还超就再减一半，一直减到每条只剩 1 条
  while (measure(body) > limit) {
    const before = state.traits.length + state.prefs.length + state.threads.length;
    state.traits = halve(state.traits);
    state.prefs = halve(state.prefs);
    state.threads = halve(state.threads);
    const after = state.traits.length + state.prefs.length + state.threads.length;
    if (after === before) break; // 每条都只剩 1 条，再减不下去，只能走下一步
    body = renderBody(state);
  }

  // 6) 硬裁前先整条丢：从最不重要的一条开始整条删除（各留 1 条），避免切出半句
  while (measure(body) > limit) {
    const lists = [state.traits, state.prefs, state.threads].filter((list) => list.length > 1);
    if (!lists.length) break;
    // 人物卡各列表都按 confidence 降序排过，pop 掉的就是最不重要的一条
    lists.sort((a, b) => b.length - a.length)[0].pop();
    body = renderBody(state);
  }

  // 7) 最后才是按字符硬裁（按码点，不切开代理对）；结尾声明仍在最后
  if (measure(body) > limit) body = hardCut(body, limit, measure);

  return body ? `${body}\n\n${MEMORY_SCOPE_NOTICE}` : MEMORY_SCOPE_NOTICE;
}

module.exports = { buildMemoryBlock, MEMORY_SCOPE_NOTICE, splitSentences, indexLine };
