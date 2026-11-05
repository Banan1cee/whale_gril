'use strict';

/**
 * 轻量 token 估算（不引 tokenizer、不联网）。
 *
 * 校准值（不是拍脑袋，是对着实际 usage 调过的经验值）：
 *   CJK ≈ 0.65 token / 字
 *   非 CJK ≈ 0.3 token / 字（约 3.2 字符 / token）
 *   每条消息另加约 4 token 的 role / 分隔开销
 *
 * 预算裁剪时统一乘 1.08 安全系数（LIMITS.estimateSafety），
 * 宁可早一点压缩，也不要因为低估把 prompt 顶爆。
 *
 * 说明：以后接官方 tokenizer 只用于人设保存/导入时的精确校验，
 * 不进每轮热路径；这里保持纯函数、无依赖。
 */
const { LIMITS } = require('./constants');

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f]/;

function estimateTokens(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') continue;
    if (CJK_RE.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.65 + other * 0.3);
}

/** 预算裁剪用：估算值 × 安全系数 */
function estimateBudgetTokens(text, factor = LIMITS.estimateSafety) {
  return Math.ceil(estimateTokens(text) * (Number(factor) || 1));
}

/**
 * 一条消息进 prompt 的估算（含角色/名字的固定开销）。
 * 记忆里的消息用 text，真正发给模型的 turns 用 content；两个字段都要认，
 * 否则 estimatePrompt 会把每条消息只算成 4 token 的壳子。
 */
function messageTokens(message) {
  if (!message) return 0;
  const text = message.text != null ? message.text : message.content;
  const body = estimateTokens(text);
  return body + 4 + estimateTokens(message.name || '');
}

/**
 * 一轮真实 prompt 的估算：system + 每条 turn。
 * 这是 buildBudget / compareUsage 的唯一口径，不再拿 dialogueBudget（预算上限）冒充实际输入。
 */
function estimatePrompt(system, turns) {
  let total = estimateTokens(system);
  for (const turn of turns || []) {
    if (!turn) continue;
    // buildPayload 会跳过空 content 的消息；估算也要跳过，否则对不上真实拼装结果
    const text = turn.text != null ? turn.text : turn.content;
    if (!text) continue;
    total += messageTokens(turn);
  }
  return total;
}

/** 预算裁剪用：消息估算 × 安全系数 */
function messageBudgetTokens(message, factor = LIMITS.estimateSafety) {
  const raw = message && message.tokens ? Number(message.tokens) : messageTokens(message);
  return Math.ceil((Number(raw) || 0) * (Number(factor) || 1));
}

module.exports = {
  estimateTokens,
  estimateBudgetTokens,
  messageTokens,
  messageBudgetTokens,
  estimatePrompt,
  CJK_RE,
};
