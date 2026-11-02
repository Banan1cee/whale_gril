'use strict';

/**
 * 记忆 v2 的固定参数（docs/memory-v2-spec.md 第 11 节）。
 *
 * 这些值写死在代码里，不读 config.json、不提供预算接口/滑块。
 * 以后要调，改这一个文件并跑 tests/memory-*.test.js。
 */
const LIMITS = Object.freeze({
  // 对话预算（不含 system prompt）默认 5,500，下面的分片是**比例基准**，
  // 真正生效的值由 src/memory/budgetPlan.js 按 config.memory.dialogueBudget 换算：
  //   recent ≈58% + memory 16.36% + summary 16.36% + reserve 9.09% + relations 2.18%
  // 改预算只需要改 dialogueBudget（启动器滑块），不要再直接改下面的分片值。
  dialogueBudget: 5500,
  // 只有 system + dialogueBudget 超过这个数才拒绝（不再有 7,500 总预算 / 2,000 system 上限）
  // 2026-11 从 32,000 提到 64,000：32k 下 comfort 人设（1,800）没问题，但想写几万字设定的
  // 一保存就被顶回来；64k ≈ 10 万汉字人设空间，单轮最贵也就 ¥0.07（谷时、全未命中）。
  hardTotalTokens: 64000,
  memoryTokens: 900,
  summaryTokens: 900,
  recentMaxTokens: 3200,
  // 关系卡（L1 关系边）的预算基线，@5,500 时占 2.18%。
  // 关系功能未启用时这一份并回 recent；启用后由 budgetPlan 按比例换算。
  relationsTokens: 120,
  recentLowTokens: 2400,
  compressChunkTokens: 800,
  softTriggerTokens: 2400,
  hardTriggerTokens: 3200,
  reserveTokens: 500,
  // 上面这几个压缩阈值只是 3,200 预算下的默认值；实际值由 budgetPlan 从 recent 派生
  // （软触发 = 75% × recent、硬触发 = recent、一次压缩掉 25% × recent）。
  // 单独改这里的常数不会生效，改 dialogueBudget 才会。

  // token 估算：CJK 0.65 / 非 CJK 0.3；预算裁剪时再乘安全系数
  estimateSafety: 1.08,
  usageWarnRatio: 0.15,

  // episode
  episodeMaxTokens: 6000,
  episodeIdleMinutes: 30,
  episodeMaxHours: 3,
  topicShiftMinMessages: 6,
  topicShiftOverlap: 0.15,

  // 读取
  recentMessages: 120,
  groupRecentMessages: 100,
  retrievalTopK: 5,
  retrievalMinScore: 0.25,
  mmrLambda: 0.7,

  // 原文 / 事件保留
  maxMessagesPerChat: 2000,
  rawRetentionDays: 90,
  eventRetentionDays: 365,
  threadIdleCloseDays: 60,
  chatArchiveIdleDays: 180,

  // 人物卡容量
  maxPeoplePerChat: 50,
  maxTraitsPerPerson: 12,
  maxPreferencesPerPerson: 30,
  maxEventsPerPerson: 200,
  maxEventsPerChat: 1000,
  maxThreadsPerPerson: 10,
  traitMinEvidence: 2,
  traitMinConfidence: 0.65,
  factExtractEveryUserMessages: 20,

  // 输出
  maxOutputNormal: 100,
  maxOutputDiscussion: 400,
  thinking: false,

  // 其它
  maxTurnChars: 1800,
  checkpointKeep: 50,
  closedEpisodeMemory: 200,
});

const DAY_MS = 86400000;

module.exports = { LIMITS, DAY_MS };
