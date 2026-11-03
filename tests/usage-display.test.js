'use strict';

/**
 * 本轮用量面板（调试台「本轮用量」卡片）的底层口径：
 *   - 价格：只有 DeepSeek 官方 deepseek-flash 有价目表，未知服务商一律 null（界面显示「—」）
 *   - 计费：命中输入按 inputHit、未命中按 inputMiss、输出按 output；命中数不可能超过输入
 *   - 一轮调了两次模型（复读重写 / 降级重试）时，usage 取总和，不是只取最后一次
 *   - 演示模式没有 usage 时不能崩
 *   - /api/status 的 budget.lastUsage 字段齐全，且不带 API Key / 消息正文
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { costOf, pricingFor, PRICING } = require('../src/services/budget');
const { createCalibration } = require('../src/memory/calibration');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { startServer } = require('../server');

/* ------------------------------ 价格 ------------------------------ */

test('costOf：谷时 / 高峰按元每百万 token 算，命中与未命中分开计', () => {
  // 1,000,000 token 整，便于直接对元
  assert.equal(costOf(PRICING.idle, 1e6, 0, 0), 1);
  assert.equal(costOf(PRICING.idle, 1e6, 1e6, 0), 0.02);
  assert.equal(costOf(PRICING.idle, 0, 0, 1e6), 4);

  assert.equal(costOf(PRICING.peak, 1e6, 0, 0), 2);
  assert.equal(costOf(PRICING.peak, 1e6, 1e6, 0), 0.04);
  assert.equal(costOf(PRICING.peak, 0, 0, 1e6), 8);

  // 一半命中、一半未命中：1,000,000 未命中（1 元）+ 1,000,000 命中（0.02 元）
  const half = costOf(PRICING.idle, 2e6, 1e6, 0);
  assert.ok(Math.abs(half - (1 + 0.02)) < 1e-12, '混合价：' + half);
});

test('costOf：cacheHit 大于输入时被夹到输入，负数命中被夹到 0', () => {
  const clamped = costOf(PRICING.idle, 1000, 5000, 0);
  assert.equal(clamped, costOf(PRICING.idle, 1000, 1000, 0));
  assert.ok(Math.abs(clamped - (1000 / 1e6) * PRICING.idle.inputHit) < 1e-15, '不能算出负数：' + clamped);
  assert.equal(costOf(PRICING.idle, 1000, -50, 0), costOf(PRICING.idle, 1000, 0, 0));
});

test('pricingFor：谷时 / 高峰 / 未知服务商返回 null', () => {
  // 2026-11-03 周二；2026-11-07 周六
  const peak = new Date(2026, 10, 3, 10, 0, 0);
  const lunch = new Date(2026, 10, 3, 13, 0, 0);
  const offWork = new Date(2026, 10, 3, 18, 0, 0);
  const weekend = new Date(2026, 10, 7, 10, 0, 0);

  const p = pricingFor('deepseek', 'deepseek-flash', peak);
  assert.equal(p.band, 'peak');
  assert.equal(p.model, 'deepseek-flash');
  assert.equal(p.price.inputMiss, 2);
  assert.equal(p.price.inputHit, 0.04);
  assert.equal(p.price.output, 8);

  for (const at of [lunch, offWork, weekend]) {
    const r = pricingFor('deepseek', 'deepseek-flash', at);
    assert.equal(r.band, 'idle', at.toString() + ' 应该是谷时');
    assert.equal(r.price.inputMiss, 1);
    assert.equal(r.price.output, 4);
  }

  // 边界：9:00 / 14:00 算高峰，12:00 / 18:00 不算
  assert.equal(pricingFor('deepseek', 'deepseek-flash', new Date(2026, 10, 3, 9, 0)).band, 'peak');
  assert.equal(pricingFor('deepseek', 'deepseek-flash', new Date(2026, 10, 3, 11, 59)).band, 'peak');
  assert.equal(pricingFor('deepseek', 'deepseek-flash', new Date(2026, 10, 3, 12, 0)).band, 'idle');
  assert.equal(pricingFor('deepseek', 'deepseek-flash', new Date(2026, 10, 3, 14, 0)).band, 'peak');
  assert.equal(pricingFor('deepseek', 'deepseek-flash', new Date(2026, 10, 3, 18, 0)).band, 'idle');

  // 未知服务商 / 未知模型：不猜价格
  assert.equal(pricingFor('zhipu', 'glm-4.7-flash', peak), null);
  assert.equal(pricingFor('qwen', 'qwen3.8-flash', peak), null);
  assert.equal(pricingFor('deepseek', 'deepseek-v4-pro', peak), null);
  assert.equal(pricingFor('', '', peak), null);
  assert.equal(pricingFor(null, null, peak), null);
});

/* ------------------------------ 一轮里的 usage ------------------------------ */

function makeConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // 测试里不联网：否则搜索路由也会调模型，把「一轮两次」的计数搅乱
  cfg.websearch = { ...(cfg.websearch || {}), enabled: false };
  cfg.persona.master = { names: ['Master'], wxids: ['wxid_test_master'] };
  cfg.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  return cfg;
}

/** 按脚本依次返回回复、并记下 usage 的假客户端（和真客户端一样：每次请求换一个新对象） */
function scriptedLlm(steps) {
  const llm = {
    isMock: false,
    provider: 'deepseek',
    providerLabel: 'DeepSeek 官方',
    model: 'deepseek-flash',
    lastUsage: null,
    // 和真客户端一样：每次请求都往 usageEvents 里追加一条，Bot 按 seq 水位累加
    usageSeq: 0,
    usageEvents: [],
    calls: 0,
    reload() {},
    describe() { return {}; },
    async complete() {
      const step = steps[Math.min(llm.calls, steps.length - 1)];
      llm.calls += 1;
      llm.lastUsage = step.usage ? { at: Date.now(), ...step.usage } : null;
      if (llm.lastUsage) {
        llm.usageSeq += 1;
        llm.usageEvents.push({ seq: llm.usageSeq, ...llm.lastUsage });
      }
      return step.text;
    },
  };
  return llm;
}

function makeBot({ llm, logger = null } = {}) {
  const config = makeConfig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-usage-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  // 校准引擎落在临时目录，别让测试往仓库 data/ 里写 calibration.json
  const calibration = createCalibration({ file: path.join(dir, 'calibration.json'), debounceMs: 0 });
  const bot = new Bot({ config, store, llm, logger, mockChunkDelayMs: 0, calibration });
  return {
    bot,
    store,
    config,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

const msg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 's1',
  chatType: 'private',
  senderId: 'u1',
  senderName: '小海',
  text,
  ...extra,
});

function captureLogger() {
  const lines = { info: [], warn: [], error: [], debug: [] };
  return {
    lines,
    info: (m) => lines.info.push(String(m)),
    warn: (m) => lines.warn.push(String(m)),
    error: (m) => lines.error.push(String(m)),
    debug: (m) => lines.debug.push(String(m)),
  };
}

test('一轮调了两次模型（复读重写）：usage 累加，不是只取最后一次', async () => {
  const logger = captureLogger();
  const llm = scriptedLlm([
    // 第一次：复读上一句 → 触发重写
    { text: '早呀', usage: { promptTokens: 1200, promptCacheHitTokens: 900, promptCacheMissTokens: 300, completionTokens: 40 } },
    // 第二次：合格的改写
    { text: '今天风好大，吹得我头发都乱了', usage: { promptTokens: 800, promptCacheHitTokens: 500, promptCacheMissTokens: 300, completionTokens: 60 } },
  ]);
  const { bot, store, cleanup } = makeBot({ llm, logger });
  const key = 'web:u:s1';
  store.ensureSession(key, { platform: 'web', chatId: 's1', chatType: 'private', title: '' });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '早呀', ts: Date.now() });

  const out = await bot.handle(msg('在吗'));
  assert.equal(out.action, 'reply');
  assert.equal(llm.calls, 2, '复读要被重写一次，所以是两次调用');

  const u = bot.lastUsage;
  assert.ok(u, '两次调用后必须写出 lastUsage');
  assert.equal(u.promptTokens, 2000, '输入取两次之和');
  assert.equal(u.cacheHitTokens, 1400, '命中取两次之和');
  assert.equal(u.cacheMissTokens, 600, '未命中取两次之和');
  assert.equal(u.completionTokens, 100, '输出取两次之和');
  assert.ok(Math.abs(u.hitRate - 0.7) < 1e-9, '命中率 = 1400 / 2000');
  assert.ok(u.estimatedPromptTokens > 0, '要有本轮提示词估算');
  assert.ok(Math.abs(u.ratio - (u.estimatedPromptTokens - 2000) / u.estimatedPromptTokens) < 1e-12);
  assert.ok(u.cost && u.cost.model === 'deepseek-flash');
  assert.ok(u.cost.cny > 0, 'deepseek-flash 应该算得出钱');
  assert.ok(u.at > 0);

  // 内核日志里那一行
  const line = logger.lines.info.find((l) => l.startsWith('用量 · '));
  assert.ok(line, '必须打一条 INFO 用量日志');
  assert.match(line, /^用量 · 命中 1400 \/ 输入 2000（70\.0%）\/ 输出 100 · 估算 \d+（[+-]?\d+\.\d%）· ¥[\d.]+（(谷时|高峰) deepseek-flash）$/);
  cleanup();
});

test('hitRate：有命中 / 没命中 / 服务商没给 cache 字段', async () => {
  const llm = scriptedLlm([
    { text: '第一句完全不一样的话', usage: { promptTokens: 1000, promptCacheHitTokens: 400, promptCacheMissTokens: 600, completionTokens: 50 } },
    { text: '第二句也是新说的内容', usage: { promptTokens: 500, completionTokens: 20 } },
  ]);
  const { bot, cleanup } = makeBot({ llm });

  await bot.handle(msg('在吗'));
  assert.equal(bot.lastUsage.hitRate, 0.4);
  assert.equal(bot.lastUsage.cacheHitTokens, 400);
  assert.equal(bot.lastUsage.cacheMissTokens, 600);

  await bot.handle(msg('今天怎么样'));
  assert.equal(bot.lastUsage.hitRate, 0, '没给 cache 字段时命中率为 0');
  assert.equal(bot.lastUsage.cacheHitTokens, 0);
  assert.equal(bot.lastUsage.cacheMissTokens, 500, '没给未命中就按 输入 - 命中 补');
  cleanup();
});

test('演示模式：没有 usage 时不崩，lastUsage 保持 null', async () => {
  const llm = { isMock: true, model: 'mock', reload() {}, describe() { return {}; } };
  const { bot, cleanup } = makeBot({ llm });
  const out = await bot.handle(msg('在吗'));
  assert.equal(out.action, 'reply');
  assert.equal(bot.lastUsage, null);
  cleanup();
});

test('未知服务商：算不出价格就写 null，不猜', async () => {
  const llm = scriptedLlm([{ text: '我是别家的模型', usage: { promptTokens: 1000, completionTokens: 30 } }]);
  llm.provider = 'zhipu';
  llm.model = 'glm-4.7-flash';
  const { bot, cleanup } = makeBot({ llm });
  await bot.handle(msg('在吗'));
  assert.equal(bot.lastUsage.cost.cny, null);
  assert.equal(bot.lastUsage.cost.band, null);
  assert.equal(bot.lastUsage.cost.model, 'glm-4.7-flash');
  cleanup();
});

/* ------------------------------ /api/status ------------------------------ */

test('/api/status：budget.lastUsage 字段齐全，且不含 apiKey / 消息正文', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-usage-api-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ watchConfig: false, server: { port: 0, openBrowser: false } }));
  const app = await startServer({ root: dir, env: { WHALE_LOG_FILE: '' }, port: 0, host: '127.0.0.1', openBrowser: false });
  try {
    app.runtime.bot.lastUsage = {
      promptTokens: 2489,
      cacheHitTokens: 1234,
      cacheMissTokens: 1255,
      completionTokens: 87,
      hitRate: 1234 / 2489,
      estimatedPromptTokens: 2610,
      ratio: (2610 - 2489) / 2610,
      cost: { cny: 0.00042, band: 'idle', model: 'deepseek-flash' },
      at: Date.now(),
      // 故意混进来的东西：接口必须白名单过滤掉
      apiKey: 'sk-should-never-leak-0123456789',
      text: '这条消息正文不该出现在状态接口里',
    };

    const body = await (await fetch(app.url + '/api/status')).json();
    const u = body.budget && body.budget.lastUsage;
    assert.ok(u, 'budget.lastUsage 必须存在');

    for (const key of ['promptTokens', 'cacheHitTokens', 'cacheMissTokens', 'completionTokens',
      'hitRate', 'estimatedPromptTokens', 'ratio', 'cost', 'at']) {
      assert.ok(Object.prototype.hasOwnProperty.call(u, key), '缺字段：' + key);
    }
    assert.equal(u.promptTokens, 2489);
    assert.equal(u.cacheHitTokens, 1234);
    assert.equal(u.completionTokens, 87);
    assert.equal(u.cost.cny, 0.00042);
    assert.equal(u.cost.band, 'idle');
    assert.equal(u.cost.model, 'deepseek-flash');

    const raw = JSON.stringify(u);
    assert.ok(!raw.includes('sk-should-never-leak'), '不能泄露 API Key');
    assert.ok(!raw.includes('这条消息正文'), '不能带消息正文');
    assert.ok(!Object.prototype.hasOwnProperty.call(u, 'apiKey'), 'lastUsage 里不该有 apiKey');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});
