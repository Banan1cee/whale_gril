'use strict';

/**
 * 单轮预算估算（只读：不联网、不发真实请求、不写盘）。
 *
 * 给启动器「高级模式 → 高级 → 对话预算」下方的说明用：
 *   system prompt 有多少 token、加上对话预算后单轮最多多少、一次对话大概多少钱。
 *
 * token 口径按 DeepSeek 官方说明（不引词表）：
 *   CJK ≈ 0.65 token / 字，非 CJK ≈ 0.3 token / 字，每条消息另加约 4 token。
 *   和 src/memory/tokens.js 是同一套估算，别在两处各写一份。
 *
 * 价格口径：DeepSeek 官方「空闲时段（谷时）」deepseek-flash 定价，单位 元 / 百万 token：
 *   输入·缓存命中 0.02、输入·未命中 1、输出 4；高峰时段是它的一倍。
 *   谷时 = 除「周一至周五 9:00-12:00、14:00-18:00」以外的所有时段（含周末/节假日）。
 */

const { LIMITS } = require('../memory/constants');
const { estimateTokens } = require('../memory/tokens');
const { planBudget, nearestTier, TIERS } = require('../memory/budgetPlan');
const persona = require('../persona');

const PRICING = Object.freeze({
  model: 'deepseek-flash',
  // 元 / 百万 token
  idle: { inputHit: 0.02, inputMiss: 1, output: 4 },
  peak: { inputHit: 0.04, inputMiss: 2, output: 8 },
});

const PER_MILLION = 1e6;

/** 当前生效的对话预算：config.memory.dialogueBudget 优先，否则 5,500 */
function dialogueBudget(config) {
  const v = config && config.memory ? Number(config.memory.dialogueBudget) : NaN;
  return Number.isFinite(v) && v > 0 ? v : LIMITS.dialogueBudget;
}

/** 按私聊 / 群聊各拼一份 system（system 里本来就带两边的字数与回复限制） */
function systemVariants(config) {
  const now = new Date();
  const make = (msg) => {
    try {
      return persona.buildSystem({
        config,
        msg,
        profile: { count: 1, notes: [] },
        notes: [],
        now,
      });
    } catch {
      return '';
    }
  };
  const priv = make({ chatType: 'private', senderName: '朋友', chatTitle: '' });
  const group = make({ chatType: 'group', senderName: '群友', chatTitle: '群聊' });
  return {
    private: estimateTokens(priv),
    group: estimateTokens(group),
  };
}

/**
 * 一次对话的钱。
 * @param {{inputHit:number, inputMiss:number, output:number}} price 元/百万 token
 * @param {number} inputTokens 总输入 token
 * @param {number} cachedTokens 其中命中缓存的部分
 * @param {number} outputTokens 输出 token
 */
function costOf(price, inputTokens, cachedTokens, outputTokens) {
  const cached = Math.max(0, Math.min(inputTokens, cachedTokens));
  const miss = Math.max(0, inputTokens - cached);
  return (miss / PER_MILLION) * price.inputMiss
    + (cached / PER_MILLION) * price.inputHit
    + (outputTokens / PER_MILLION) * price.output;
}

/**
 * @param {object} config 运行时 config（用 config.memory.dialogueBudget / persona / chat / group）
 * @param {{outputTokens?:number, dialogueBudget?:number}} [opts]
 *   dialogueBudget 传了就用它（启动器滑块实时预览用，不必先保存）
 * @returns {object} 给启动器/调试台看的估算结果
 */
function estimate(config, { outputTokens = LIMITS.maxOutputNormal, dialogueBudget: override } = {}) {
  const overrideNum = Number(override);
  const budget = Number.isFinite(overrideNum) && overrideNum > 0
    ? Math.round(overrideNum)
    : dialogueBudget(config);
  const variants = systemVariants(config);
  // 私聊、群聊各算一份，取中间数（启动器上只显示一个数）
  const systemTokens = Math.round((variants.private + variants.group) / 2);
  const maxInputTokens = systemTokens + budget;
  const out = Math.max(0, Number(outputTokens) || 0);
  // 这个预算实际会被分成几块（recent / memory / summary / reserve / relations），
  // 给启动器的说明区和调试台/status 用
  const plan = planBudget(budget, { relations: false });
  // 启动器只显示三类，太细的拆分别放界面上
  const split = {
    persona: systemTokens,
    memory: plan.memory + plan.summary + plan.relations,
    dialogue: plan.recent + plan.reserve,
  };

  // ── 前缀缓存怎么算才不离谱 ──
  // 服务商缓存的是「前缀」：system 在最前面、历史只往后追加，所以稳定期命中的是
  //   人设 + 历史里除了最后两条以外的部分
  // （上一轮的 user 消息里挂过记忆块、这一轮的又换了，那一段每轮都要重算）。
  const TAIL_REFRESH = 120;   // 最后两条消息 ≈ 120 token
  const promptTokens = systemTokens + plan.memory + plan.summary + plan.recent;   // 一轮真实输入（reserve 是余量，不算正文）
  const hitTokens = Math.min(promptTokens, systemTokens + Math.max(0, plan.recent - TAIL_REFRESH));
  const cache = {
    promptTokens,
    hitTokens,
    missTokens: Math.max(0, promptTokens - hitTokens),
    hitRate: promptTokens > 0 ? hitTokens / promptTokens : 0,
    tailRefresh: TAIL_REFRESH,
  };
  const firstCost = costOf(PRICING.idle, promptTokens, 0, out);
  const cachedCost = costOf(PRICING.idle, promptTokens, hitTokens, out);

  return {
    ok: true,
    systemPrivateTokens: variants.private,
    systemGroupTokens: variants.group,
    systemTokens,
    dialogueBudget: budget,
    maxInputTokens,
    hardTotalTokens: LIMITS.hardTotalTokens,
    overHardLimit: maxInputTokens > LIMITS.hardTotalTokens,
    outputTokens: out,
    plan,
    split,
    cache,
    // 推荐档位：给启动器做「提示」用（不是开关），滑块仍然连续
    tier: nearestTier(budget),
    tiers: TIERS.map((t) => {
      const p = planBudget(t.budget, { relations: false });
      return {
        key: t.key,
        label: t.label,
        budget: t.budget,
        note: t.note,
        recent: p.recent,
        memory: p.memory,
        summary: p.summary,
        reserve: p.reserve,
        recentShare: Number((p.recent / p.dialogueBudget).toFixed(3)),
      };
    }),
    pricing: { model: PRICING.model, idle: PRICING.idle, peak: PRICING.peak },
    cost: {
      // 谷时（空闲时段）
      idle: { first: firstCost, cached: cachedCost },
      // 高峰时段，只为参照
      peak: {
        first: costOf(PRICING.peak, promptTokens, 0, out),
        cached: costOf(PRICING.peak, promptTokens, hitTokens, out),
      },
    },
  };
}

module.exports = { estimate, dialogueBudget, systemVariants, costOf, PRICING };



