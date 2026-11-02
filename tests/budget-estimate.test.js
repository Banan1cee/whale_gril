'use strict';

/**
 * 对话预算估算（/api/budget/estimate 的底层）：
 *   - system prompt 取私聊 / 群聊的中间数
 *   - 合计 = system + 对话预算
 *   - 价格按 DeepSeek 谷时（空闲时段）口径：输入未命中 1、命中 0.02、输出 4（元/百万 token）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { estimate, dialogueBudget, PRICING } = require('../src/services/budget');
const { loadConfig } = require('../src/infra/config');
const { LIMITS } = require('../src/memory/constants');
const { startServer } = require('../server');

const FIXTURE = path.join(__dirname, '__nonexistent_budget_fixture__');
const defaults = () => loadConfig({ root: FIXTURE, env: {} });

test('默认口径：预算 5,500，system 取私聊/群聊中间数，合计 = 两者相加', () => {
  const r = estimate(defaults());
  assert.equal(r.dialogueBudget, 5500);
  assert.equal(r.dialogueBudget, LIMITS.dialogueBudget);
  assert.ok(r.systemPrivateTokens > 0, '私聊 system 应该有内容');
  assert.ok(r.systemGroupTokens > 0, '群聊 system 应该有内容');
  assert.equal(r.systemTokens, Math.round((r.systemPrivateTokens + r.systemGroupTokens) / 2));
  assert.equal(r.maxInputTokens, r.systemTokens + r.dialogueBudget);
  assert.equal(r.overHardLimit, false);
});

test('滑块预览：传 dialogueBudget 就按它算，不用先写 config', () => {
  const r = estimate(defaults(), { dialogueBudget: 8000 });
  assert.equal(r.dialogueBudget, 8000);
  assert.equal(r.maxInputTokens, r.systemTokens + 8000);
});

test('价格：首次全按未命中，高命中时只有新增对话要重新计费', () => {
  const r = estimate(defaults(), { dialogueBudget: 5500, outputTokens: 100 });
  const sys = r.systemTokens;
  const expectedFirst = (sys + 5500) / 1e6 * PRICING.idle.inputMiss + 100 / 1e6 * PRICING.idle.output;
  const expectedCached = 5500 / 1e6 * PRICING.idle.inputMiss + sys / 1e6 * PRICING.idle.inputHit
    + 100 / 1e6 * PRICING.idle.output;
  assert.ok(Math.abs(r.cost.idle.first - expectedFirst) < 1e-9, '首次成本：' + r.cost.idle.first);
  assert.ok(Math.abs(r.cost.idle.cached - expectedCached) < 1e-9, '命中成本：' + r.cost.idle.cached);
  assert.ok(r.cost.idle.first > r.cost.idle.cached, '命中缓存后应该更便宜');
  assert.ok(r.cost.peak.first > r.cost.idle.first, '高峰比谷时贵');
  assert.equal(r.pricing.model, 'deepseek-flash');
});

test('超过 64,000 硬上限会被标出来，而不是静默截断', () => {
  const r = estimate(defaults(), { dialogueBudget: 70000 });
  assert.equal(r.overHardLimit, true);
  assert.equal(r.maxInputTokens, r.systemTokens + 70000);
});

test('刚好卡在 64,000 以内不算超限', () => {
  const config = defaults();
  const system = estimate(config).systemTokens;
  const r = estimate(config, { dialogueBudget: 64000 - system });
  assert.equal(r.overHardLimit, false);
});

test('config 没有 memory 段时回退默认 5,500', () => {
  const config = defaults();
  delete config.memory;
  assert.equal(dialogueBudget(config), 5500);
  assert.equal(estimate(config).dialogueBudget, 5500);
});

test('非法预算（0 / 负数 / 非数字）回退默认值', () => {
  const config = defaults();
  config.memory = { dialogueBudget: 0 };
  assert.equal(dialogueBudget(config), 5500);
  config.memory = { dialogueBudget: 'abc' };
  assert.equal(dialogueBudget(config), 5500);
});

test('GET /api/budget/estimate：真实 HTTP 上支持 dialogueBudget 覆盖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-budget-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false } }));
  const app = await startServer({ root: dir, env: {}, port: 0, openBrowser: false });
  try {
    const res = await fetch(app.url + '/api/budget/estimate?dialogueBudget=8000');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.dialogueBudget, 8000);
    assert.ok(body.systemTokens > 0);
    assert.equal(body.maxInputTokens, body.systemTokens + 8000);
    assert.ok(body.cost.idle.cached < body.cost.idle.first);

    // 不传就按 config 里的值（默认 5,500）
    const plain = await (await fetch(app.url + '/api/budget/estimate')).json();
    assert.equal(plain.dialogueBudget, 5500);
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});
