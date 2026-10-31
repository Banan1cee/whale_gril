'use strict';

/**
 * 单轮预算语义（2026-10 调整，覆盖 docs/memory-v2-spec.md 第 11 节的旧值）：
 *
 *   dialogueBudget = 5500
 *     = memory 900 + summary 900 + recent 3200 + reserve 500
 *   systemTokens = 运行时估算的 system 实际占用（只测量，不裁剪）
 *   estimatedInputTokens = systemTokens + dialogueBudget
 *
 * system prompt 不参与“总预算”，也不会因为变大去挤 recent/memory。
 * 只有 estimatedInputTokens > hardTotalTokens(32,000) 才拒绝，且必须显式报错，不静默截断。
 */
const { LIMITS } = require('./constants');
const { estimateTokens } = require('./tokens');

class BudgetExceededError extends Error {
  constructor(budget) {
    super(
      `单轮输入超过硬上限：system ${budget.systemTokens} + 对话 ${budget.dialogueBudget} = `
      + `${budget.estimatedInputTokens} > ${budget.hardTotalTokens}`,
    );
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.budget = budget;
  }
}

/**
 * @param {string} system 组装好的 system prompt
 * @param {{dialogueBudget?:number}} [opts]
 * @returns {{systemTokens:number, dialogueBudget:number, estimatedInputTokens:number, hardTotalTokens:number, memoryTokens:number, summaryTokens:number, recentMaxTokens:number, reserveTokens:number}}
 */
function buildBudget(system, { dialogueBudget = LIMITS.dialogueBudget } = {}) {
  const systemTokens = estimateTokens(system);
  const dialogue = Math.max(0, Number(dialogueBudget) || LIMITS.dialogueBudget);
  return {
    systemTokens,
    dialogueBudget: dialogue,
    estimatedInputTokens: systemTokens + dialogue,
    hardTotalTokens: LIMITS.hardTotalTokens,
    memoryTokens: LIMITS.memoryTokens,
    summaryTokens: LIMITS.summaryTokens,
    recentMaxTokens: LIMITS.recentMaxTokens,
    reserveTokens: LIMITS.reserveTokens,
  };
}

/** 超硬上限就抛；否则原样返回 budget */
function assertWithinHardLimit(budget) {
  if (!budget || typeof budget !== 'object') throw new TypeError('budget 不能为空');
  if (budget.estimatedInputTokens > budget.hardTotalTokens) throw new BudgetExceededError(budget);
  return budget;
}

/**
 * 用 API usage 校准估算。
 * @param {{estimatedInputTokens:number}} budget
 * @param {{promptTokens:number, completionTokens?:number}} usage
 * @returns {{actualPromptTokens:number, estimatedInputTokens:number, errorRatio:number, warn:boolean}|null}
 */
function compareUsage(budget, usage) {
  if (!budget || !usage) return null;
  const actual = Number(usage.promptTokens);
  if (!Number.isFinite(actual) || actual <= 0) return null;
  const estimated = Number(budget.estimatedInputTokens) || 0;
  const errorRatio = Math.abs(actual - estimated) / actual;
  return {
    actualPromptTokens: actual,
    estimatedInputTokens: estimated,
    errorRatio,
    warn: errorRatio > LIMITS.usageWarnRatio,
  };
}

module.exports = {
  BudgetExceededError,
  buildBudget,
  assertWithinHardLimit,
  compareUsage,
  DIALOGUE_BUDGET: LIMITS.dialogueBudget,
  HARD_TOTAL_TOKENS: LIMITS.hardTotalTokens,
};
