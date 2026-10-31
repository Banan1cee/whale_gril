'use strict';

/**
 * 人设 token 精确校验（只在保存 / 导入人设时跑，不进每轮聊天）。
 *
 * 优先用当前选中模型的官方 tokenizer/usage 计数：
 *   client.countPromptTokens(system) → 服务商返回的 usage.prompt_tokens
 * 没有 Key、演示模式、离线或接口不支持时，退回本地轻量估算，并明确标记 exact=false。
 *
 * system prompt 不占对话预算（dialogueBudget），但单轮硬上限是
 * systemTokens + dialogueBudget <= hardTotalTokens，所以人设上限是 32,000 - 5,500 = 26,500。
 */
const persona = require('./index');
const { LIMITS } = require('../memory/constants');
const { estimateBudgetTokens } = require('../memory/tokens');

const PERSONA_MAX_TOKENS = LIMITS.hardTotalTokens - LIMITS.dialogueBudget;

/** 只把这几个字段合进预览 config，不写盘 */
function previewConfig(config, patch = {}) {
  const preview = JSON.parse(JSON.stringify({
    persona: config.persona || {},
    chat: config.chat || {},
    group: config.group || {},
  }));
  const p = preview.persona || {};
  const c = preview.chat || {};
  const g = preview.group || {};
  const direct = ['name', 'age', 'job', 'appearance', 'personality', 'background', 'customPrompt',
    'emotions', 'proactive', 'opinions', 'masterRoast', 'sourcePreset'];
  for (const key of direct) if (patch[key] !== undefined) p[key] = patch[key];
  if (patch.preset !== undefined) {
    p.stylePreset = patch.preset;
    p.preset = patch.preset;
  }
  if (patch.text !== undefined) {
    p.styleText = patch.text;
    p.text = patch.text;
  }
  if (patch.emoji !== undefined) p.emojiLevel = patch.emoji;
  for (const key of ['privateMaxChars', 'groupMaxChars', 'historyTurns', 'groupHistoryTurns', 'maxBubbles', 'discussionMaxChars', 'emojiChance']) {
    if (patch[key] !== undefined) c[key] = patch[key];
  }
  for (const key of ['freeChat', 'mutedGroups']) if (patch[key] !== undefined) g[key] = patch[key];
  return { ...config, persona: p, chat: c, group: g };
}

/** 取私聊 / 群聊 / 主人三种场景里最长的 system，按最坏情况校验 */
function longestSystem(config) {
  const now = new Date();
  const variants = [
    { chatType: 'group', senderName: '群友', chatTitle: '深海鱼塘', profile: { count: 1 }, now },
    { chatType: 'private', senderName: '小海', profile: { count: 1 }, now },
    { chatType: 'private', senderName: 'Master', isMaster: true, profile: { count: 1 }, now },
  ];
  let best = '';
  let bestTokens = -1;
  for (const msg of variants) {
    try {
      const system = persona.buildSystem({ config, msg, profile: msg.profile, now });
      const tokens = estimateBudgetTokens(system);
      if (tokens > bestTokens) {
        best = system;
        bestTokens = tokens;
      }
    } catch { /* 场景构造失败不影响其它变体 */ }
  }
  return best;
}

/**
 * @param {{config:object, llm:object, logger?:object}} runtime
 * @param {object} patch 即将保存的人设补丁（与 applyPersonaPatch 的 patch 一致）
 * @returns {Promise<{tokens:number, estimated:number, exact:boolean, source:string, model:string, provider:string, limit:number, overLimit:boolean, systemChars:number}>}
 */
async function checkPersonaTokens(runtime, patch = {}) {
  const config = previewConfig(runtime.config, patch);
  const system = longestSystem(config);
  const estimated = estimateBudgetTokens(system);
  let exact = null;
  try {
    const client = runtime.llm;
    if (client && !client.isMock && typeof client.countPromptTokens === 'function') {
      exact = await client.countPromptTokens(system, { timeoutMs: 6000 });
    }
  } catch (err) {
    if (runtime.logger) runtime.logger.warn('人设 token 精确计数失败，退回估算：' + ((err && err.message) || err));
  }
  const tokens = exact && Number(exact.tokens) > 0 ? Number(exact.tokens) : estimated;
  return {
    tokens,
    estimated,
    exact: Boolean(exact && Number(exact.tokens) > 0),
    source: exact && Number(exact.tokens) > 0 ? 'provider-usage' : 'estimate',
    model: (runtime.llm && runtime.llm.model) || '',
    provider: (runtime.llm && runtime.llm.provider) || '',
    limit: PERSONA_MAX_TOKENS,
    overLimit: tokens > PERSONA_MAX_TOKENS,
    systemChars: system.length,
  };
}

module.exports = { PERSONA_MAX_TOKENS, checkPersonaTokens, previewConfig, longestSystem };
