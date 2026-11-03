'use strict';

/**
 * 对话预算分片：**唯一事实源**。
 *
 * 只需要配一个数（`config.memory.dialogueBudget = D`），下面所有分片按比例重新算：
 *
 *   分片          比例          @5,500    作用
 *   recent       剩余(≈58%)     3,200     最近原文 —— 唯一跟着 D 线性长的
 *   memory       16.36%           900     人物卡 + 相关事件
 *   summary      16.36%           900     L3 摘要
 *   reserve       9.09%           500     token 估算误差的安全余量
 *   relations     2.18%           120     关系卡（features.relations 默认开；关掉时份额并回 recent）
 *
 * 为什么不是纯比例：memory / summary 有**结构上限**，过了就只是重复同一批内容。
 *   - 人物卡一屏最多 12 traits + 20 preferences + 10 threads + 10 事件 ≈ 1,700 token
 *     （显示条数由 plan.caps 按预算缩放，见 format.js）；再多也只是把同一个人写得更啰嗦；
 *   - 单段摘要 400 字 ≈ 260 token，合并策略按段走，超过 ~1,500 会开始丢细节而不是变好。
 * D 从 5,500 涨到 20,000 时：memory 900→1,700、summary 900→1,500 都涨到上限为止，
 * 剩下的全部给 recent（原文才是多带就多有用的）。5,500 下与旧值 1:1 相同。
 *
 * 小预算（D < ~2,700）时按比例分出来的 recent 会不够看，这时按
 * 「摘要 → 预留 → 记忆」的顺序回收，保证 recent 至少拿到 min(1,600, 60% × D)。
 */

const { LIMITS } = require('./constants');

/** 比例基准：默认对话预算（改这个数会同时改所有比例的分母） */
const REF = LIMITS.dialogueBudget;

const SHARES = Object.freeze({
  memory: LIMITS.memoryTokens / REF,
  summary: LIMITS.summaryTokens / REF,
  reserve: LIMITS.reserveTokens / REF,
  relations: LIMITS.relationsTokens / REF,
});

/** 结构上限：超过就是浪费（理由见文件头） */
const CEILINGS = Object.freeze({
  memory: 2200,
  summary: 1500,
  reserve: 800,
  relations: 200,
});

/** 回收时的下限：保证「摘要/记忆/预留」不会被 recent 吃到 0 */
const BOTTOMS = Object.freeze({
  summary: 300,
  reserve: 300,
  memory: 400,
});

/** recent 的软下限 */
const RECENT_FLOOR = 1600;
/** 小预算时 recent 至少占这么多 */
const RECENT_FLOOR_RATIO = 0.6;
/** recent 占比的红线：超过它说明再往上加预算只是在堆原文 */
const RECENT_SHARE_MAX = 0.85;
/** 启动器输入框 / configSchema 的下限 */
const MIN_DIALOGUE = 1000;
/**
 * 分片计算的绝对上限 = 单轮硬上限。
 * 配置本身不限上限（ui 输入框可以填任意值，填超了 buildBudget 会拒绝这一轮），
 * 但分片不能跟着涨到 10 万——那样 recent 会分到 9.6 万 token，纯属幻觉。
 * 所以超过 64,000 时按 64,000 切分片，并保留 requested 给硬上限判断用。
 */
const MAX_DIALOGUE = LIMITS.hardTotalTokens;

/** 压缩阈值 = recent 的比例（@3,200 时正好是 2,400 / 3,200 / 800，与旧常量一致） */
const SOFT_RATIO = 0.75;
const CHUNK_RATIO = 0.25;

/**
 * 条数上限也跟着 recent 走：不然预算调到 20,000、条数还卡在 100 条，
 * 多出来的 token 根本装不满（等于白调）。
 * @3,200 时正好是私聊 120 条 / 群聊 100 条，与旧常量一致。
 *
 * 注意这是**两条腿**：token 上限和条数上限谁先到谁算数。
 * 消息短（10 token 一条）时条数先到，消息长（150 token 一条）时 token 先到，
 * 所以两个上限都要随预算放大，否则总有一边够不着。
 */
const MESSAGE_RATIO_PRIVATE = LIMITS.recentMessages / LIMITS.recentMaxTokens;
const MESSAGE_RATIO_GROUP = LIMITS.groupRecentMessages / LIMITS.recentMaxTokens;
const MAX_COUNT_PRIVATE = 1500;
const MAX_COUNT_GROUP = 1200;

/** 人物卡显示条数的基准（@900 memory 时就是旧值 6/10/4/5） */
const CARD_BASE = Object.freeze({ traits: 6, prefs: 10, threads: 4, events: 5 });
const CARD_MAX = Object.freeze({ traits: 12, prefs: 30, threads: 10, events: 10 });

function clamp(value, lo, hi) {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * 人物卡显示几条：以 900 token 的旧值（6 traits / 10 偏好 / 4 threads / 5 事件）为基准，
 * 按 memory 预算等比放大，封顶 CARD_MAX。
 * 只放大 token 不放大条数的话，format 会把内容裁掉，预算等于没用上。
 */
function cardCaps(memoryTokens) {
  const scale = Math.max(0.5, (Number(memoryTokens) || LIMITS.memoryTokens) / Math.max(1, LIMITS.memoryTokens));
  const pick = (key) => clamp(Math.round(CARD_BASE[key] * scale), CARD_BASE[key], CARD_MAX[key]);
  return {
    traits: pick('traits'),
    prefs: pick('prefs'),
    threads: pick('threads'),
    events: pick('events'),
  };
}

/**
 * 推荐档位：只是给 UI/文档的「提示」，不是开关——滑块仍然是连续的。
 * 数值依据见 docs/记忆系统.md 6.2：滑块 2,000–20,000，20,000 是建议上限。
 */
const TIERS = Object.freeze([
  { key: 'lite', label: '极简', budget: 2000, note: '只想让她接话，不指望记人' },
  { key: 'default', label: '默认', budget: 5500, note: '开箱值，日常闲聊一晚上的群聊' },
  { key: 'standard', label: '标准', budget: 10000, note: '主力档，人物卡接近满配' },
  { key: 'heavy', label: '重度', budget: 20000, note: '长会话 / 大群，滑块顶格' },
]);

/** 当前值最接近哪个推荐档位（只用于提示，不改变任何分配） */
function nearestTier(dialogueBudget) {
  const D = Number(dialogueBudget) || LIMITS.dialogueBudget;
  let best = TIERS[0];
  for (const tier of TIERS) {
    if (Math.abs(tier.budget - D) < Math.abs(best.budget - D)) best = tier;
  }
  return best;
}

/**
 * @param {number} dialogueBudget 对话预算（config.memory.dialogueBudget），非法值退回 5,500
 * @param {{relations?:boolean}} [opts] relations=true 才从 recent 里切出关系卡份额
 * @returns {{
 *   dialogueBudget:number, recent:number, memory:number, summary:number, reserve:number, relations:number,
 *   recentSoft:number, recentLow:number, compressChunk:number,
 *   mode:'clamped'|'reclaim', shares:object, total:number, ok:boolean, warnings:string[]
 * }}
 */
function planBudget(dialogueBudget, { relations = false } = {}) {
  const wantedRaw = Math.round(Number(dialogueBudget));
  const wanted = Number.isFinite(wantedRaw) && wantedRaw > 0 ? wantedRaw : REF;
  const D = clamp(wanted, MIN_DIALOGUE, MAX_DIALOGUE);
  const keys = relations ? ['memory', 'summary', 'reserve', 'relations'] : ['memory', 'summary', 'reserve'];

  const parts = {};
  for (const key of keys) {
    parts[key] = clamp(Math.round(SHARES[key] * D), 0, CEILINGS[key]);
  }

  let recent = Math.max(0, D - keys.reduce((sum, key) => sum + parts[key], 0));
  const floor = Math.min(RECENT_FLOOR, Math.round(D * RECENT_FLOOR_RATIO));
  let mode = 'clamped';

  // recent 不够：按「摘要 → 预留 → 记忆」的顺序回收，谁最先被压缩谁影响最小
  for (const key of ['summary', 'reserve', 'memory']) {
    if (recent >= floor) break;
    const give = Math.min(parts[key] - BOTTOMS[key], floor - recent);
    if (give > 0) {
      parts[key] -= give;
      recent += give;
      mode = 'reclaim';
    }
  }

  const plan = {
    dialogueBudget: D,
    // 用户实际填的值（可能 > D，用来判断单轮硬上限，不能被夹掉）
    requested: wanted,
    recent,
    memory: parts.memory || 0,
    summary: parts.summary || 0,
    reserve: parts.reserve || 0,
    relations: parts.relations || 0,
    recentSoft: Math.round(recent * SOFT_RATIO),
    recentLow: Math.round(recent * SOFT_RATIO),
    compressChunk: Math.round(recent * CHUNK_RATIO),
    recentCount: clamp(Math.round(recent * MESSAGE_RATIO_PRIVATE), 20, MAX_COUNT_PRIVATE),
    groupRecentCount: clamp(Math.round(recent * MESSAGE_RATIO_GROUP), 20, MAX_COUNT_GROUP),
    // 人物卡显示几条：预算变大 → 多显示几条（最多到 CARD_MAX），而不是只多给 token
    caps: cardCaps(parts.memory || 0),
    tier: nearestTier(D).key,
    tierLabel: nearestTier(D).label,
    mode,
    shares: { ...SHARES },
    warnings: [],
  };
  plan.total = plan.recent + plan.memory + plan.summary + plan.reserve + plan.relations;
  plan.ok = plan.total === D;
  if (recent < floor) plan.warnings.push('recent_below_floor');
  if (wanted > MAX_DIALOGUE) plan.warnings.push('budget_above_hard_limit');
  // recent 占比超过 85% 就说明「记忆/摘要已经封顶、钱全砸在原文上」，该收手了
  if (plan.recent / D > RECENT_SHARE_MAX) plan.warnings.push('recent_share_high');
  if (D < floor + plan.memory + plan.summary + plan.reserve + plan.relations) {
    plan.warnings.push('budget_tight');
  }
  return plan;
}

/** 给日志/调试台用的一行摘要（不打印任何记忆正文） */
function describePlan(plan) {
  if (!plan) return '';
  const pct = (v, d) => `${Math.round((v / Math.max(1, d)) * 100)}%`;
  return `预算 ${plan.dialogueBudget}：recent ${plan.recent}(${pct(plan.recent, plan.dialogueBudget)})`
    + ` memory ${plan.memory}(${pct(plan.memory, plan.dialogueBudget)})`
    + ` summary ${plan.summary}(${pct(plan.summary, plan.dialogueBudget)})`
    + ` reserve ${plan.reserve}(${pct(plan.reserve, plan.dialogueBudget)})`
    + ` relations ${plan.relations}(${pct(plan.relations, plan.dialogueBudget)})`
    + ` [${plan.mode}]`;
}

module.exports = {
  planBudget,
  TIERS,
  nearestTier,
  describePlan,
  cardCaps,
  SHARES,
  CEILINGS,
  BOTTOMS,
  CARD_BASE,
  CARD_MAX,
  RECENT_FLOOR,
  MIN_DIALOGUE,
};




