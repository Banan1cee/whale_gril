'use strict';

// Prompt-only regressions: no server, bridge, UIA, network, or model invocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSystem } = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/config');

function build(customPrompt, enabled, ...platformArg) {
  const platform = platformArg.length ? platformArg[0] : 'wechat';
  const config = {
    ...DEFAULT_CONFIG,
    features: { ...DEFAULT_CONFIG.features, stickers: enabled },
    persona: { ...DEFAULT_CONFIG.persona, name: '审计测试角色', customPrompt },
    chat: { ...DEFAULT_CONFIG.chat },
  };
  return buildSystem({
    config,
    msg: { platform, chatType: 'private', senderName: '测试朋友', text: '发个表情包' },
    now: new Date('2026-01-01T12:00:00Z'),
  });
}

for (const [label, customPrompt] of [['默认', ''], ['自定义', '你是审计测试角色，保持原有身份。']]) {
  for (const enabled of [true, 'true', 'on', 1]) {
    test(`${label}微信开启 ${JSON.stringify(enabled)} 时有真实能力且不伪造送达`, () => {
      const prompt = build(customPrompt, enabled);
      assert.equal(prompt.split('【表情包】').length - 1, 1);
      assert.match(prompt, /当前微信通道具备真实的图片\/动图附件发送能力/);
      assert.match(prompt, /不要否认这项能力/);
      assert.match(prompt, /是否发送由程序按开关、图库、概率和安全校验决定/);
      assert.match(prompt, /没有实际发送确认时，不要声称「已发」「发过去了」或编造送达结果/);
      assert.match(prompt, /不要输出控制标签/);
      assert.doesNotMatch(prompt, /就直接发一张|发完接着正常说话/);
      assert.match(prompt, /审计测试角色/);
      if (customPrompt) assert.ok(prompt.startsWith(customPrompt));
    });
  }

  for (const disabled of [false, 'false', 'off', '0', 0, undefined]) {
    test(`${label}关闭 ${JSON.stringify(disabled)} 不宣称附件能力`, () => {
      assert.doesNotMatch(build(customPrompt, disabled), /【表情包】|当前微信通道具备真实的/);
    });
  }

  for (const platform of ['web', 'qq', undefined]) {
    test(`${label}其他平台 ${JSON.stringify(platform)} 不宣称微信附件能力`, () => {
      const prompt = build(customPrompt, true, platform);
      assert.doesNotMatch(prompt, /【表情包】|当前微信通道具备真实的/);
    });
  }
}

test('默认和自定义路径注入同一份能力说明', () => {
  const block = (prompt) => prompt.match(/【表情包】[^]*?编造送达结果。/)[0];
  assert.equal(block(build('', true)), block(build('保留自定义角色。', true)));
});
