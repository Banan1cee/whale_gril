'use strict';

/**
 * L1 + L3：群里「分不清宾语」的防护 + 功能开关体系。
 *
 * 背景（用户反馈）：别人之间聊天、甚至没提她，她也跳出来怼；她在群里分不清「你」指的是谁。
 * L1 触发层：@ 了别人 / 出现第三人称 / 讨论「机器人」但没指代她 → 不接话。
 * L3 模型层：提示词要求先判断在跟谁说话；开火必须有原话依据，否则降级成「？」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const features = require('../src/features');
const { loadConfig } = require('../src/config');

const ROOT = path.resolve(__dirname, '..');

function boot(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-l1-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false, ...overrides })
  );
  return { root, cfg: loadConfig({ root, env: {} }) };
}

test('开关默认值都在 DEFAULT_CONFIG 里（不写配置也有）', () => {
  const { root, cfg } = boot();
  assert.equal(cfg.features.groupAddressGuard, true, '群聊分清对象默认开');
  assert.equal(cfg.features.fightQuoteCheck, true, '开火需原话依据默认开');
  assert.equal(cfg.features.mediaCleanup, true);
  assert.equal(cfg.features.memorySnapshot, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('开关能被配置关掉，关了就走旧行为', () => {
  const { root, cfg } = boot({ features: { groupAddressGuard: false } });
  assert.equal(features.isOn(cfg, 'groupAddressGuard'), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('每个开关都有 label/desc，控制台才显示得出来', () => {
  const { root, cfg } = boot();
  const list = features.list(cfg);
  assert.ok(list.length >= 5);
  for (const f of list) {
    assert.ok(f.key && f.label && f.desc, '开关要有 key/label/desc');
    assert.equal(typeof f.value, 'boolean');
  }
  assert.ok(list.some((f) => f.key === 'quoteReply' && f.default === false), '引用回复默认必须是关');
  fs.rmSync(root, { recursive: true, force: true });
});

test('L1：@ 了别人时不算在说她（用 mentionedNames 判）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  assert.match(src, /msg\.mentionedNames/, '必须用到桥接传来的 @ 名单');
  assert.match(src, /talkingToOthers/, '要有「在跟别人说话」的判断');
});

test('L1：「机器人」不再裸算叫她，要带指代', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  assert.match(src, /function namedHerIn/, '要有统一的「是否在叫她」helper');
  assert.match(src, /这个\|那个\|你\|破\|臭\|傻\|烂\|死/, '机器人需要带指代才算叫她');
});

test('L2/L3：开火要有原话依据，否则降级', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'bot.js'), 'utf8');
  assert.match(src, /开怼缺少原话依据/, '要有 finalize 兜底');
});

test('L3：群聊提示词要求先判断在跟谁说话', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'persona.js'), 'utf8');
  assert.match(src, /先说清楚在跟谁说话/);
  assert.match(src, /如果里面没有你，那就是在跟别人说话/);
});

test('功能开关 API：能读、能写、写错 key 报错', async () => {
  const { startServer } = require('../server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-feat-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false }));
  const inst = await startServer({ root, env: {}, port: 0, openBrowser: false });
  try {
    const list = await (await fetch(`${inst.url}/api/features`)).json();
    assert.equal(list.ok, true);
    assert.ok(list.features.length >= 5);

    const off = await (
      await fetch(`${inst.url}/api/features`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: inst.url },
        body: JSON.stringify({ key: 'fightQuoteCheck', value: false }),
      })
    ).json();
    assert.equal(off.ok, true);
    assert.equal(off.value, false);

    // 写进文件了吗
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    assert.equal(saved.features.fightQuoteCheck, false, '开关要落盘');

    const bad = await (
      await fetch(`${inst.url}/api/features`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: inst.url },
        body: JSON.stringify({ key: 'no-such-flag', value: true }),
      })
    ).json();
    assert.equal(bad.ok, false);
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
