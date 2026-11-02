'use strict';

/**
 * 单轮预算语义（2026-11 改为按比例分配，覆盖 docs/memory-v2-spec.md 第 11 节的旧值）：
 *
 *   dialogueBudget = D（默认 5,500，启动器可调）
 *     分片由 src/memory/budgetPlan.js 按比例算：recent 吃剩余，memory/summary/reserve
 *     按 16.36% / 16.36% / 9.09% 给并有结构上限，relations 2.18%（默认关闭）。
 *   systemTokens = 运行时估算的 system 实际占用（只测量，不裁剪）
 *   estimatedInputTokens = systemTokens + dialogueBudget
 *
 * system prompt 不参与“总预算”，也不会因为变大去挤 recent/memory。
 * 只有 estimatedInputTokens > hardTotalTokens(64,000) 才拒绝，且必须显式报错，不静默截断。
 */
const { LIMITS } = require('./constants');
const { estimateTokens } = require('./tokens');
const budgetPlan = require('./budgetPlan');

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
 * @param {{dialogueBudget?:number, relations?:boolean}} [opts]
 * @returns {{systemTokens:number, dialogueBudget:number, estimatedInputTokens:number, hardTotalTokens:number, memoryTokens:number, summaryTokens:number, recentMaxTokens:number, reserveTokens:number, relationsTokens:number, plan:object}}
 */
function buildBudget(system, { dialogueBudget = LIMITS.dialogueBudget, relations = false } = {}) {
  const systemTokens = estimateTokens(system);
  const requested = Math.max(0, Number(dialogueBudget) || LIMITS.dialogueBudget);
  const plan = budgetPlan.planBudget(requested, { relations });
  return {
    systemTokens,
    dialogueBudget: plan.dialogueBudget,
    // 用用户填的原值算单轮上限：分片会被夹到 64,000，但「填太大」本身必须报错
    estimatedInputTokens: systemTokens + Math.max(requested, plan.dialogueBudget),
    hardTotalTokens: LIMITS.hardTotalTokens,
    memoryTokens: plan.memory,
    summaryTokens: plan.summary,
    recentMaxTokens: plan.recent,
    reserveTokens: plan.reserve,
    relationsTokens: plan.relations,
    plan,
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
