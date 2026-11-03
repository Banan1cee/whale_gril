'use strict';

// Prompt-only regressions: no server, bridge, UIA, network, or model invocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSystem } = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { assemblePrompt } = require('./support/prompt');

function build(customPrompt, enabled, ...platformArg) {
  const platform = platformArg.length ? platformArg[0] : 'wechat';
  // root 指到一个空目录，图库为空，提示词里的分类清单才是确定的
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cap-'));
  const config = {
    ...DEFAULT_CONFIG,
    root,
    features: { ...DEFAULT_CONFIG.features, stickers: enabled },
    persona: { ...DEFAULT_CONFIG.persona, name: '审计测试角色', customPrompt },
    chat: { ...DEFAULT_CONFIG.chat },
  };
  return assemblePrompt({
    config,
    msg: { platform, chatType: 'private', senderName: '测试朋友', text: '发个表情包' },
    now: new Date('2026-01-01T12:00:00Z'),
  }).prompt;
}

for (const [label, customPrompt] of [['默认', ''], ['自定义', '你是审计测试角色，保持原有身份。']]) {
  for (const enabled of [true, 'true', 'on', 1]) {
    test(`${label}微信开启 ${JSON.stringify(enabled)} 时有真实能力且按回执说话`, () => {
      const prompt = build(customPrompt, enabled);
      assert.equal(prompt.split('【表情包】').length - 1, 1);
      assert.match(prompt, /当前微信通道具备真实的图片\/动图附件发送能力/);
      assert.match(prompt, /不要否认这项能力/);
      // 分类由模型决定：必须教它怎么写标记
      assert.match(prompt, /\[\[sticker:分类名\]\]/);
      assert.match(prompt, /一条回复最多写一个标记/);
      assert.match(prompt, /想发就在整段回复的最末尾/);
      assert.match(prompt, /自定义分类按名字理解/);
      assert.match(prompt, /对方在难过、求助、说正事时别发/);
      assert.doesNotMatch(prompt, /是否发送由程序按开关、图库、概率和安全校验决定/);
      assert.doesNotMatch(prompt, /不要输出控制标签/);
      // 现在不靠「一律不许提」堵嘴，而是让它按【最近做过的事】里的真实记录说
      assert.match(prompt, /发没发出去只看【最近做过的事】里的记录/);
      assert.match(prompt, /不要编造送达结果/);
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
  const block = (prompt) => prompt.match(/【表情包】[^]*?假装没这回事。/)[0];
  assert.equal(block(build('', true)), block(build('保留自定义角色。', true)));
});

test('图库有图时，提示词里带上分类名和张数', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cap-pics-'));
  try {
    fs.mkdirSync(path.join(root, 'data/stickers/炸毛'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/stickers/炸毛/a.gif'), 'x');
    fs.writeFileSync(path.join(root, 'data/stickers/炸毛/b.gif'), 'x');
    const config = {
      ...DEFAULT_CONFIG,
      root,
      features: { ...DEFAULT_CONFIG.features, stickers: true },
      persona: { ...DEFAULT_CONFIG.persona, name: '审计测试角色', customPrompt: '' },
      chat: { ...DEFAULT_CONFIG.chat },
    };
    const prompt = assemblePrompt({
      config,
      msg: { platform: 'wechat', chatType: 'private', senderName: '测试朋友', text: '发个表情包' },
      now: new Date('2026-01-01T12:00:00Z'),
    }).prompt;
    assert.match(prompt, /炸毛\(2张\)/);
    assert.doesNotMatch(prompt, /图库现在是空的/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('四分类只有三个有图：只把有图的三个给模型，自定义分类按名字出现', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cap-four-'));
  try {
    for (const [dir, file] of [['傲娇', 'a.gif'], ['炸毛', 'b.gif'], ['开心', 'c.gif']]) {
      fs.mkdirSync(path.join(root, 'data/stickers', dir), { recursive: true });
      fs.writeFileSync(path.join(root, 'data/stickers', dir, file), 'x');
    }
    fs.mkdirSync(path.join(root, 'data/stickers/阴阳怪气'), { recursive: true }); // 空分类
    fs.writeFileSync(path.join(root, 'data/sticker-categories.json'),
      JSON.stringify([{ label: '阴阳怪气', chance: 0.25 }]), 'utf8');
    const config = {
      ...DEFAULT_CONFIG,
      root,
      features: { ...DEFAULT_CONFIG.features, stickers: true },
      persona: { ...DEFAULT_CONFIG.persona, name: '审计测试角色', customPrompt: '' },
      chat: { ...DEFAULT_CONFIG.chat },
    };
    const prompt = assemblePrompt({
      config,
      msg: { platform: 'wechat', chatType: 'private', senderName: '测试朋友', text: '在吗' },
      now: new Date('2026-01-01T12:00:00Z'),
    }).prompt;
    assert.match(prompt, /傲娇\(1张\)/);
    assert.match(prompt, /炸毛\(1张\)/);
    assert.match(prompt, /开心\(1张\)/);
    assert.doesNotMatch(prompt, /阴阳怪气/, '没图的分类不能出现在提示词的可用分类里');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('stickerDemand 只加在尾部，system 一个字节都不变', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cap-demand-'));
  try {
    fs.mkdirSync(path.join(root, 'data/stickers/开心'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/stickers/开心/a.gif'), 'x');
    const base = {
      ...DEFAULT_CONFIG,
      root,
      features: { ...DEFAULT_CONFIG.features, stickers: true },
      persona: { ...DEFAULT_CONFIG.persona, name: '审计测试角色', customPrompt: '' },
      chat: { ...DEFAULT_CONFIG.chat },
    };
    const msg = { platform: 'wechat', chatType: 'private', senderName: '测试朋友', text: '在吗' };
    const off = assemblePrompt({ config: base, msg, now: new Date('2026-01-01T12:00:00Z') });
    const on = assemblePrompt({ config: base, msg: { ...msg, stickerDemand: true }, now: new Date('2026-01-01T12:00:00Z') });
    assert.equal(on.system, off.system, '尾部提示不能改 system');
    assert.doesNotMatch(off.tail, /这条带一张/);
    assert.match(on.tail, /这条带一张/);
    assert.match(on.tail, /\[\[sticker:分类名\]\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
