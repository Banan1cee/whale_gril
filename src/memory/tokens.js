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

/** 一条消息进 prompt 的估算（含角色/名字的固定开销） */
function messageTokens(message) {
  if (!message) return 0;
  const body = estimateTokens(message.text);
  return body + 4 + estimateTokens(message.name || '');
}

/** 预算裁剪用：消息估算 × 安全系数 */
function messageBudgetTokens(message, factor = LIMITS.estimateSafety) {
  const raw = message && message.tokens ? Number(message.tokens) : messageTokens(message);
  return Math.ceil((Number(raw) || 0) * (Number(factor) || 1));
}

function sumTokens(list, pick = (x) => x) {
  let total = 0;
  for (const item of list || []) total += pick(item) || 0;
  return total;
}

module.exports = {
  estimateTokens,
  estimateBudgetTokens,
  messageTokens,
  messageBudgetTokens,
  sumTokens,
  CJK_RE,
};
