'use strict';

/**
 * token 真估算 + 按 provider|model 校准。
 *
 * 这些用例钉住真实故障：
 *   旧口径把 dialogueBudget（预算上限）当输入估算，日志「偏差 188.5%（估算 7036 / 实际 2489）」
 *   其实是 1436 system + 5600 预算。这里要求 estimatePrompt 按实际 turns 算，
 *   calibration 按真实 usage 学 scale，compareUsage 只在实际超出时告警。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { estimatePrompt, estimateTokens, messageTokens } = require('../src/memory/tokens');
const { buildTurns } = require('../src/core/context');
const budget = require('../src/memory/budget');
const calibration = require('../src/memory/calibration');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { LlmError } = require('../src/llm/client');

function tempDir(prefix = 'whale-cal-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
}

test('estimatePrompt：等于 system + 每条 turn，空 turns 不崩', () => {
  const system = '你是鲸鲸。'.repeat(20);
  const turns = buildTurns(
    { chatType: 'private', senderName: '小海', cleanText: '现在呢' },
    [
      { role: 'user', name: '小海', text: '第一句', ts: 1 },
      { role: 'assistant', name: '鲸鲸', text: '第二句', ts: 2 },
    ],
    '【关于对方】喜欢猫。',
  );
  const expected = estimateTokens(system) + turns.reduce((sum, turn) => sum + messageTokens(turn), 0);
  assert.equal(estimatePrompt(system, turns), expected);
  assert.equal(estimatePrompt(system, []), estimateTokens(system));
  assert.equal(estimatePrompt('', []), 0);
  assert.equal(estimatePrompt(null, null), 0);
  // buildPayload 会跳过空 content，估算也不能多算 4 token 的壳子
  assert.equal(estimatePrompt(system, [{ role: 'user', content: '' }]), estimateTokens(system));

  // buildBudget 的硬上限和日志都必须用这个真估算，不能再用 system + dialogueBudget
  const b = budget.buildBudget(system, { turns });
  assert.equal(b.estimatedPromptTokens, expected);
  assert.equal(b.estimatedInputTokens, expected);
  assert.equal(b.dialogueBudget, 5500);
});

test('calibration：连续 10 次 observed=1.3，scale 收敛到 1.2~1.4 且单步 ≤0.05', () => {
  const engine = calibration.createCalibration({ file: null, now: () => 1760000000000 });
  let scale = 1;
  for (let i = 0; i < 10; i += 1) {
    const out = engine.observe({ rawEstimate: 1000, actual: 1300, provider: 'deepseek', model: 'deepseek-flash' });
    assert.equal(out.accepted, true);
    assert.ok(Math.abs(out.step) <= 0.05 + 1e-12, `第 ${i + 1} 步变化 ${out.step}`);
    assert.ok(Math.abs(out.scale - scale) <= 0.05 + 1e-12);
    scale = out.scale;
  }
  assert.ok(scale >= 1.2 && scale <= 1.4, 'scale 应收敛到 1.2~1.4，实际 ' + scale);
  const trim = engine.trimScale({ provider: 'deepseek', model: 'deepseek-flash' });
  assert.equal(trim, 1.3, '裁剪用 scale 量化到 0.05 步长');
  assert.equal(Math.round(trim / 0.05) * 0.05, trim);
});

test('calibration：拒绝 ratio 5 / 0.1 和 rawEstimate<400，scale 不变', () => {
  const engine = calibration.createCalibration({ file: null, now: () => 1 });
  for (let i = 0; i < 6; i += 1) engine.observe({ rawEstimate: 1000, actual: 1300, provider: 'p', model: 'm' });
  const before = engine.scaleFor({ provider: 'p', model: 'm' });
  const nBefore = engine.apply(1000, { provider: 'p', model: 'm' }).n;

  const high = engine.observe({ rawEstimate: 1000, actual: 5000, provider: 'p', model: 'm' });
  const low = engine.observe({ rawEstimate: 1000, actual: 100, provider: 'p', model: 'm' });
  const tiny = engine.observe({ rawEstimate: 399, actual: 500, provider: 'p', model: 'm' });
  assert.equal(high.accepted, false);
  assert.equal(low.accepted, false);
  assert.equal(tiny.accepted, false);
  assert.equal(high.reason, 'ratio_out_of_range');
  assert.equal(tiny.reason, 'raw_too_small');
  assert.equal(engine.scaleFor({ provider: 'p', model: 'm' }), before);
  assert.equal(engine.apply(1000, { provider: 'p', model: 'm' }).n, nBefore);
});

test('calibration：持久化往返；文件损坏时静默回落 1.0 不抛', () => {
  const dir = tempDir();
  const file = path.join(dir, 'data', 'calibration.json');
  try {
    const first = calibration.createCalibration({ file, now: () => 1760000000000 });
    for (let i = 0; i < 6; i += 1) first.observe({ rawEstimate: 1000, actual: 1300, provider: 'deepseek', model: 'x' });
    const expectedScale = first.scaleFor({ provider: 'deepseek', model: 'x' });
    assert.equal(first.flush(), true);

    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entry = raw['deepseek|x'];
    assert.ok(entry, '应按 provider|model 落盘');
    for (const value of Object.values(entry)) assert.equal(typeof value, 'number', '只存数字');

    const second = calibration.createCalibration({ file, now: () => 1760000001000 });
    assert.equal(second.scaleFor({ provider: 'deepseek', model: 'x' }), expectedScale);
    assert.equal(second.apply(1000, { provider: 'deepseek', model: 'x' }).n, 6);

    fs.writeFileSync(file, '{ this is not json', 'utf8');
    const broken = calibration.createCalibration({ file });
    assert.doesNotThrow(() => broken.apply(1000, { provider: 'deepseek', model: 'x' }));
    assert.equal(broken.scaleFor({ provider: 'deepseek', model: 'x' }), 1);
    assert.equal(broken.trimScale({ provider: 'deepseek', model: 'x' }), 1);
    broken.close();
  } finally {
    cleanup(dir);
  }
});

test('calibration：按 provider|model 隔离，deepseek 的样本不影响 qwen', () => {
  const engine = calibration.createCalibration({ file: null, now: () => 1 });
  for (let i = 0; i < 10; i += 1) {
    engine.observe({ rawEstimate: 1000, actual: 1300, provider: 'deepseek', model: 'deepseek-flash' });
  }
  assert.ok(engine.scaleFor({ provider: 'deepseek', model: 'deepseek-flash' }) > 1.2);
  assert.equal(engine.scaleFor({ provider: 'qwen', model: 'qwen3.8-flash' }), 1);
  const qwen = engine.apply(1000, { provider: 'qwen', model: 'qwen3.8-flash' });
  assert.equal(qwen.calibrated, 1000);
  assert.equal(qwen.n, 0);
});

test('Store.buildContext：tokenScale 缩放裁剪窗口，不改全局 plan', () => {
  const dir = tempDir();
  try {
    const store = new Store({ file: path.join(dir, 'store.json') });
    const base = store.buildContext({ key: 'web:u:scale', uid: 'u1', name: '小海' });
    const tighter = store.buildContext({ key: 'web:u:scale', uid: 'u1', name: '小海', tokenScale: 1.3 });
    assert.equal(base.plan.dialogueBudget, 5500);
    assert.ok(tighter.plan.dialogueBudget < base.plan.dialogueBudget, 'scale>1 要缩窗口');
    assert.ok(tighter.plan.recent < base.plan.recent);
    assert.equal(store.plan.dialogueBudget, 5500, '不能污染 Store 的全局 plan');
    store.close();
  } finally {
    cleanup(dir);
  }
});

test('compareUsage：实际小于估算不告警，超出 >15% 才告警', () => {
  const b = { estimatedPromptTokens: 1000 };
  const under = budget.compareUsage(b, { promptTokens: 800 });
  assert.equal(under.warn, false);
  assert.equal(under.direction, 'under');
  assert.equal(under.errorRatio, 0);
  assert.ok(under.underRatio > 0.15);

  const justUnder = budget.compareUsage(b, { promptTokens: 1150 });
  assert.equal(justUnder.warn, false, '正好 15% 不告警');
  const over = budget.compareUsage(b, { promptTokens: 1200 });
  assert.equal(over.warn, true);
  assert.equal(over.direction, 'over');
  assert.ok(over.errorRatio > 0.15);

  // 校准后的比较：raw=1000、scale=1.3，实际 1300 不应该再报偏差
  const scaled = budget.compareUsage(b, { promptTokens: 1300 }, { scale: 1.3 });
  assert.equal(scaled.estimatedPromptTokens, 1300);
  assert.equal(scaled.warn, false);
  assert.equal(scaled.direction, 'even');
});

test('context_length：第一次 400，第二次成功；turns 减半且保留当前消息', async () => {
  const dir = tempDir('whale-ctx-retry-');
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.websearch = { ...(config.websearch || {}), enabled: false };
  config.links = { ...(config.links || {}), enabled: false };
  config.memory = { ...(config.memory || {}), dialogueBudget: 5500 };
  config.paths = { ...(config.paths || {}), dataDir: path.join(dir, 'data') };
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const seen = [];
  const llm = {
    isMock: false,
    model: 'test-model',
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    lastUsage: null,
    reload() {},
    describe() { return {}; },
    async complete({ turns }) {
      seen.push(turns.map((t) => t.content));
      if (seen.length === 1) {
        throw new LlmError('context too long', {
          code: 'http_400',
          status: 400,
          detail: 'HTTP 400: maximum context length exceeded',
        });
      }
      this.lastUsage = { promptTokens: 1200, completionTokens: 20, totalTokens: 1220 };
      return '好';
    },
  };
  const engine = calibration.createCalibration({ file: path.join(dir, 'data', 'calibration.json'), debounceMs: 0 });
  const bot = new Bot({
    config,
    store,
    llm,
    logger: null,
    mockChunkDelayMs: 0,
    calibration: engine,
  });
  try {
    // 直接造 6 条 turn，避免测试依赖 Store 的摘要/窗口实现；这里只验证 context 超长重试本身。
    bot.buildTurns = () => [
      { role: 'user', content: '历史一' },
      { role: 'assistant', content: '历史二' },
      { role: 'user', content: '历史三' },
      { role: 'assistant', content: '历史四' },
      { role: 'user', content: '历史五' },
      { role: 'user', content: '现在呢' },
    ];
    const result = await bot.handle({
      platform: 'web',
      chatId: 's1',
      chatType: 'private',
      senderId: 'u1',
      senderName: '小海',
      text: '现在呢',
    });
    assert.equal(result.action, 'reply');
    assert.equal(seen.length, 2, '应只重试一次');
    assert.equal(seen[0].length, 6);
    assert.equal(seen[1].length, 3, '重试应严格砍掉一半 turns');
    assert.match(seen[1][seen[1].length - 1], /现在呢/, '当前消息不能丢');
  } finally {
    engine.close();
    store.close();
    cleanup(dir);
  }
});
