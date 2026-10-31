'use strict';

/**
 * 记忆 v2 的固定参数（docs/memory-v2-spec.md 第 11 节）。
 *
 * 这些值写死在代码里，不读 config.json、不提供预算接口/滑块。
 * 以后要调，改这一个文件并跑 tests/memory-*.test.js。
 */
const LIMITS = Object.freeze({
  // 对话预算（不含 system prompt）：memory 900 + summary 900 + recent 3200 + reserve 500
  dialogueBudget: 5500,
  // 只有 system + dialogueBudget 超过这个数才拒绝（不再有 7,500 总预算 / 2,000 system 上限）
  hardTotalTokens: 32000,
  memoryTokens: 900,
  summaryTokens: 900,
  recentMaxTokens: 3200,
  recentLowTokens: 2400,
  compressChunkTokens: 800,
  softTriggerTokens: 2400,
  hardTriggerTokens: 3200,
  reserveTokens: 500,

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
