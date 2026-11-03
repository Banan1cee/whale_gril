'use strict';

/**
 * 单轮预算语义（2026-11 改为按比例分配，覆盖 docs/memory-v2-spec.md 第 11 节的旧值）：
 *
 *   dialogueBudget = D（默认 5,500，启动器可调）
 *     分片由 src/memory/budgetPlan.js 按比例算：recent 吃剩余，memory/summary/reserve
 *     按 16.36% / 16.36% / 9.09% 给并有结构上限，relations 2.18%（默认关闭）。
 *   systemTokens = 运行时估算的 system 实际占用（只测量，不裁剪）
 *   estimatedPromptTokens = estimatePrompt(system, turns)
 *     这才是发出去的真实输入估算：system + 每条 turn。以前拿 system + dialogueBudget
 *     （预算上限）去和 usage.prompt_tokens 比，对话没填满时偏差必然 100%+。
 *
 * 只有 estimatedPromptTokens > hardTotalTokens(64,000) 才拒绝，且必须显式报错，不静默截断。
 * dialogueBudget 仍然保留，给 Store/context 裁剪窗口用；它不再冒充真实输入。
 */
const { LIMITS } = require('./constants');
const { estimateTokens, estimatePrompt } = require('./tokens');
const budgetPlan = require('./budgetPlan');

class BudgetExceededError extends Error {
  constructor(budget) {
    super(
      `单轮输入超过硬上限：system ${budget.systemTokens} + 对话 ${budget.estimatedPromptTokens - budget.systemTokens} = `
      + `${budget.estimatedPromptTokens} > ${budget.hardTotalTokens}`,
    );
    this.name = 'BudgetExceededError';
    this.code = 'BUDGET_EXCEEDED';
    this.budget = budget;
  }
}

/**
 * @param {string} system 组装好的 system prompt
 * @param {{dialogueBudget?:number, relations?:boolean, turns?:Array<{role:string, content:string}>}} [opts]
 * @returns {{
 *   systemTokens:number, dialogueBudget:number, estimatedPromptTokens:number,
 *   estimatedInputTokens:number, budgetCeilingTokens:number, hardTotalTokens:number,
 *   memoryTokens:number, summaryTokens:number, recentMaxTokens:number,
 *   reserveTokens:number, relationsTokens:number, plan:object
 * }}
 */
function buildBudget(system, { dialogueBudget = LIMITS.dialogueBudget, relations = false, turns = [] } = {}) {
  const systemTokens = estimateTokens(system);
  const requested = Math.max(0, Number(dialogueBudget) || LIMITS.dialogueBudget);
  const plan = budgetPlan.planBudget(requested, { relations });
  const estimatedPromptTokens = estimatePrompt(system, turns);
  return {
    systemTokens,
    dialogueBudget: plan.dialogueBudget,
    // 真实输入：system + 实际要发的 turns（没有 turns 就只算 system）
    estimatedPromptTokens,
    // 兼容旧字段名，但语义已经改正，不再返回 system + 预算上限
    estimatedInputTokens: estimatedPromptTokens,
    // 预算上限只用于 UI / 日志参考，不参与硬上限判断
    budgetCeilingTokens: systemTokens + Math.max(requested, plan.dialogueBudget),
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
  if (budget.estimatedPromptTokens > budget.hardTotalTokens) throw new BudgetExceededError(budget);
  return budget;
}

/**
 * 用 API usage 对比「校准后的真实估算」。
 *
 * 旧口径把 dialogueBudget 当估算，只要对话没填满就永远「偏差 180%」；现在只比较
 * estimatedPromptTokens × scale 和实际 prompt_tokens。scale > 1 表示估算偏低，
 * 只有实际比估算高出超过 usageWarnRatio 才告警；实际更少不叫「低估」，不告警。
 *
 * @param {{estimatedPromptTokens?:number, estimatedInputTokens?:number}} budget
 * @param {{promptTokens:number, completionTokens?:number}} usage
 * @param {{scale?:number}} [opts]
 * @returns {{
 *   actualPromptTokens:number, rawEstimatedPromptTokens:number,
 *   estimatedPromptTokens:number, estimatedInputTokens:number,
 *   calibrationScale:number, errorRatio:number, absErrorRatio:number,
 *   overRatio:number, underRatio:number, direction:'over'|'under'|'even', warn:boolean
 * }|null}
 */
function compareUsage(budget, usage, { scale = 1 } = {}) {
  if (!budget || !usage) return null;
  const actual = Number(usage.promptTokens);
  if (!Number.isFinite(actual) || actual <= 0) return null;
  const raw = Number(
    budget.estimatedPromptTokens != null ? budget.estimatedPromptTokens : budget.estimatedInputTokens,
  );
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const factor = Number(scale);
  const calibrationScale = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const estimated = Math.max(1, Math.round(raw * calibrationScale));
  const signed = (actual - estimated) / estimated;
  const absErrorRatio = Math.abs(signed);
  const overRatio = Math.max(0, signed);
  const underRatio = Math.max(0, -signed);
  return {
    actualPromptTokens: actual,
    rawEstimatedPromptTokens: raw,
    estimatedPromptTokens: estimated,
    // 兼容旧调用方；这里同样是校准后的真实估算，不再是预算上限
    estimatedInputTokens: estimated,
    calibrationScale,
    errorRatio: overRatio,
    absErrorRatio,
    overRatio,
    underRatio,
    direction: overRatio > 0 ? 'over' : underRatio > 0 ? 'under' : 'even',
    // 只在「实际用量超出」时告警；低于估算不是故障
    warn: overRatio > LIMITS.usageWarnRatio,
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
