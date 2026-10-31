'use strict';

/**
 * 人设 token 精确校验：只在保存/导入时跑；优先用当前模型官方 usage，失败退回估算。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { DEFAULT_CONFIG } = require('../src/infra/config');
const { checkPersonaTokens, previewConfig, longestSystem, PERSONA_MAX_TOKENS } = require('../src/persona/tokenCheck');
const { estimateBudgetTokens } = require('../src/memory/tokens');
const { LIMITS } = require('../src/memory/constants');

function runtimeWith(llm, configPatch = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(config, configPatch);
  return { config, llm, logger: null };
}

test('人设上限 = hardTotalTokens - dialogueBudget = 26,500', () => {
  assert.equal(PERSONA_MAX_TOKENS, 26500);
  assert.equal(PERSONA_MAX_TOKENS, LIMITS.hardTotalTokens - LIMITS.dialogueBudget);
});

test('previewConfig：保存前就能把 patch 合进 system，不写盘', () => {
  const runtime = runtimeWith({ isMock: true });
  const preview = previewConfig(runtime.config, { name: '小鲸', customPrompt: '只说短句' });
  assert.equal(preview.persona.name, '小鲸');
  assert.equal(preview.persona.customPrompt, '只说短句');
  assert.notEqual(runtime.config.persona.name, '小鲸', '原 config 不能被改动');
  const system = longestSystem(preview);
  assert.match(system, /只说短句/);
});

test('演示模式 / 没有官方计数：退回估算并标 exact=false', async () => {
  const runtime = runtimeWith({ isMock: true, provider: 'mock', model: 'mock' });
  const check = await checkPersonaTokens(runtime, { customPrompt: '测试一下' });
  assert.equal(check.exact, false);
  assert.equal(check.source, 'estimate');
  assert.ok(check.tokens > 0);
  assert.equal(check.overLimit, false);
});

test('有官方 usage 时用官方计数（精确值覆盖估算）', async () => {
  const runtime = runtimeWith({
    isMock: false,
    provider: 'deepseek',
    model: 'deepseek-chat',
    async countPromptTokens() { return { tokens: 4321, promptTokens: 5000, basePromptTokens: 679 }; },
  });
  const check = await checkPersonaTokens(runtime, { customPrompt: '测试一下' });
  assert.equal(check.exact, true);
  assert.equal(check.source, 'provider-usage');
  assert.equal(check.tokens, 4321);
  assert.equal(check.model, 'deepseek-chat');
});

test('官方计数超上限：overLimit=true', async () => {
  const runtime = runtimeWith({
    isMock: false,
    provider: 'deepseek',
    model: 'deepseek-chat',
    async countPromptTokens() { return { tokens: 30000 }; },
  });
  const check = await checkPersonaTokens(runtime, {});
  assert.equal(check.overLimit, true);
  assert.ok(check.tokens > PERSONA_MAX_TOKENS);
});

test('官方计数失败：不阻断保存，退回估算', async () => {
  const runtime = runtimeWith({
    isMock: false,
    async countPromptTokens() { throw new Error('network down'); },
  });
  const check = await checkPersonaTokens(runtime, { customPrompt: '测试' });
  assert.equal(check.exact, false);
  assert.equal(check.source, 'estimate');
  assert.ok(check.tokens > 0);
});

test('system 变长只影响人设计数，不改变对话预算 5,500', async () => {
  const short = await checkPersonaTokens(runtimeWith({ isMock: true }), {});
  const long = await checkPersonaTokens(runtimeWith({ isMock: true }), { customPrompt: '长'.repeat(3000) });
  assert.ok(long.tokens > short.tokens);
  assert.equal(LIMITS.dialogueBudget, 5500);
  assert.ok(estimateBudgetTokens('长'.repeat(3000)) > 0);
});
