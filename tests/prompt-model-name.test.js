'use strict';

// 默认人设不能把部署用的模型名写进 system：
// 一是会向对方暴露具体型号，二是 system 会随模型/服务商变化，前缀缓存跟着全部失效。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { buildSystem } = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const NOW = new Date('2026-11-03T15:48:00+08:00');

function randomModel() {
  return 'deepseek-' + crypto.randomBytes(8).toString('hex');
}

function makeConfig({ model, customPrompt = '', staticSystem = true } = {}) {
  return {
    ...DEFAULT_CONFIG,
    deepseek: { ...DEFAULT_CONFIG.deepseek, model },
    features: { ...DEFAULT_CONFIG.features, staticSystem },
    persona: { ...DEFAULT_CONFIG.persona, name: '鲸鲸', customPrompt },
    chat: { ...DEFAULT_CONFIG.chat },
  };
}

function systemFor(config, msg = {}) {
  return buildSystem({
    config,
    msg: { platform: 'wechat', chatType: 'private', senderName: '小海', text: '你是什么模型？', ...msg },
    profile: { count: 0 },
    now: NOW,
  });
}

for (const staticSystem of [true, false]) {
  const mode = staticSystem ? '静态 system' : '旧行为 system';

  test(`${mode}：默认人设不含 config.deepseek.model 的随机型号`, () => {
    const model = randomModel();
    const sys = systemFor(makeConfig({ model, staticSystem }));
    assert.ok(sys.length > 500, '正常生成了默认人设 system');
    assert.equal(sys.includes(model), false, '明确要求不向对方报型号');
  });

  test(`${mode}：默认人设要求「别报具体型号」，且没有「我的模型是」模板`, () => {
    const sys = systemFor(makeConfig({ model: randomModel(), staticSystem }));
    assert.match(sys, /别报具体型号/, '被问模型时不能报型号');
    assert.doesNotMatch(sys, /我的模型是/, '旧的报型号模板必须删掉');
  });
}

test('自定义人设分支同样不含模型名（防止以后被加回来）', () => {
  const model = randomModel();
  for (const staticSystem of [true, false]) {
    const sys = systemFor(makeConfig({ model, customPrompt: '你是鲸鲸，保持一点俏皮。', staticSystem }));
    assert.ok(sys.startsWith('你是鲸鲸'), '自定义人设原文保留');
    assert.equal(sys.includes(model), false, '自定义人设也不能拼模型名');
    assert.doesNotMatch(sys, /我的模型是/);
  }
});

test('换模型前后 system 字节完全相同（换模型不再破前缀缓存）', () => {
  const before = systemFor(makeConfig({ model: randomModel() }));
  const after = systemFor(makeConfig({ model: randomModel() }));
  assert.equal(Buffer.from(after, 'utf8').equals(Buffer.from(before, 'utf8')), true,
    '模型名变了 system 必须一个字节都不差');
});

test('调用方把模型/服务商塞进 msg 也不影响 system', () => {
  const model = randomModel();
  const provider = randomModel();
  const base = systemFor(makeConfig({ model: randomModel() }));
  const polluted = systemFor(makeConfig({ model: randomModel() }), { model, provider });
  assert.equal(polluted, base, 'system 不能再读 msg.model / msg.provider');
  assert.equal(polluted.includes(model), false);
});

test('演示模式台词不点名模型（mockReply 输出不含 DeepSeek）', () => {
  const { mockReply } = require('../src/persona');
  const asks = ['你是谁', '你叫什么', '你是不是 AI', '你是不是机器人', '你是什么模型', '你用的什么 AI', '你是什么版本'];
  // 把 rng 从 0 扫到 0.99，覆盖每个规则里的所有备选台词
  for (const text of asks) {
    for (const chatType of ['private', 'group']) {
      for (const rng of [0, 0.2, 0.4, 0.6, 0.8, 0.99]) {
        const reply = mockReply({ text, chatType, rng: () => rng });
        assert.equal(/deepseek/i.test(reply), false, `演示台词不能提模型名：${reply}`);
      }
    }
  }
});
