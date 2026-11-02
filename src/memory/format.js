'use strict';

/**
 * 把人物卡 / 事件 / 摘要拼成 soft block。
 *
 * 位置：最后一条 user 消息里（不是 system），避免打断前缀缓存。
 * 预算：由 budgetPlan 按 dialogueBudget 换算（默认 5,500 时是 900 token），
 *      调用方通过 budget 传进来；不传就用默认值，保持旧行为。
 */
const { LIMITS } = require('./constants');
const { estimateBudgetTokens } = require('./tokens');
const personCard = require('./personCard');

function clip(textValue, max) {
  const s = String(textValue || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function listLine(items, max) {
  return items.filter(Boolean).slice(0, max).join('；');
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

  const sections = [];
  if (traits.length || prefs.length || threads.length) {
    const lines = ['【这个聊天里的 TA】'];
    if (traits.length) lines.push(`- 性格：${listLine(traits, show.traits)}`);
    if (prefs.length) lines.push(`- 偏好：${listLine(prefs, show.prefs)}`);
    if (threads.length) lines.push(`- 没聊完：${listLine(threads, show.threads)}`);
    sections.push(lines.join('\n'));
  }
  if (recentEvents.length) {
    const lines = ['【相关事件】'];
    for (const ev of recentEvents) {
      lines.push(`- [${ev.date}] ${clip(ev.title, 24)}：${clip(ev.summary, 100)}`);
    }
    sections.push(lines.join('\n'));
  }
  const summaryText = clip(summary, 1200);
  if (summaryText) sections.push(`【这段之前聊过】\n${summaryText}`);

  let block = sections.join('\n\n');
  if (!block) return '';
  // 预算不足时从最旧的摘要段 / 事件开始收缩（条数也跟着减半，不写死 4/6/2/3）
  if (estimateBudgetTokens(block) > limit) {
    const half = { traits: Math.max(4, Math.round(show.traits / 2)), prefs: Math.max(6, Math.round(show.prefs / 2)), threads: Math.max(2, Math.round(show.threads / 2)) };
    const compact = [];
    if (traits.length || prefs.length || threads.length) {
      const lines = ['【这个聊天里的 TA】'];
      if (traits.length) lines.push(`- 性格：${listLine(traits, half.traits)}`);
      if (prefs.length) lines.push(`- 偏好：${listLine(prefs, half.prefs)}`);
      if (threads.length) lines.push(`- 没聊完：${listLine(threads, half.threads)}`);
      compact.push(lines.join('\n'));
    }
    if (recentEvents.length) {
      compact.push(['【相关事件】', ...recentEvents.slice(0, Math.max(3, Math.round(show.events / 2))).map((ev) => `- [${ev.date}] ${clip(ev.title, 16)}`)].join('\n'));
    }
    const shortSummary = clip(summaryText, 400);
    if (shortSummary) compact.push(`【这段之前聊过】\n${shortSummary}`);
    block = compact.join('\n\n');
  }
  if (estimateBudgetTokens(block) > limit) {
    // 极端情况：按字符硬裁，保留开头（人物卡优先）
    block = block.slice(0, limit);
  }
  return block + '\n（这些只来自当前这个聊天；别提别的聊天里的事，被问到就说“这个我不清楚”。）';
}

module.exports = { buildMemoryBlock };
