'use strict';

/**
 * 复读检测：她不能把别人刚说的话原样发回去。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot({ replies }) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-echo-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const calls = [];
  const llm = {
    isMock: false,
    model: 'qwen-plus',
    reload() {},
    async complete({ system }) {
      calls.push(system);
      const next = replies.shift();
      return next === undefined ? '我也不知道' : next;
    },
  };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, rng: () => 0.9 });
  return { bot, calls, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const g = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g-echo', chatType: 'group',
  senderId: 'wxid_e1', senderName: '路人', text, chatTitle: '深海鱼塘', atMe: true, ...extra,
});

test('模型原样复读对方的话 → 会重写', async () => {
  const { bot, calls, cleanup } = makeBot({ replies: ['我打完了', '那你先歇会儿吧'] });
  const r = await bot.handle(g('@鲸鲸 我打完了'));
  assert.equal(r.action, 'reply');
  assert.notEqual(r.reply, '我打完了');
  assert.match(r.reply, /歇/);
  assert.equal(calls.length, 2, '应该重写一次');
  assert.match(calls[1], /重写要求/, '重写时要带明确要求');
  cleanup();
});

test('只加一个问号也算复读', async () => {
  const { bot, cleanup } = makeBot({ replies: ['好蠢？', '你才蠢，我是故意的'] });
  const r = await bot.handle(g('@鲸鲸 好蠢'));
  assert.doesNotMatch(r.reply, /^好蠢/);
  cleanup();
});

test('重写还是复读 → 换成不重复的兜底话', async () => {
  const { bot, cleanup } = makeBot({ replies: ['好蠢', '好蠢啊'] });
  const r = await bot.handle(g('@鲸鲸 好蠢'));
  assert.ok(!['好蠢', '好蠢啊'].includes(r.reply), '不该把对方的话发回去：' + r.reply);
  cleanup();
});

test('不会重复自己上一句', async () => {
  const { bot, cleanup } = makeBot({ replies: ['嘴硬', '行吧，那就当我嘴硬', '嘴硬', '那你说个不嘴硬的'] });
  const first = await bot.handle(g('@鲸鲸 你是不是嘴硬'));
  assert.equal(first.action, 'reply');
  // 第二次她本来会再回一次「嘴硬」，应被判定成自我复读并重写
  const second = await bot.handle(g('@鲸鲸 再说一遍', { msgId: 'm2' }));
  assert.notEqual(second.reply, '嘴硬');
  cleanup();
});

test('正常回答不会被改动，也不会白跑一次重写', async () => {
  const { bot, calls, cleanup } = makeBot({ replies: ['那就先休息，别硬撑'] });
  const r = await bot.handle(g('@鲸鲸 我今天好累'));
  assert.equal(r.reply, '那就先休息，别硬撑');
  assert.equal(calls.length, 1);
  cleanup();
});

test('提示词里明确禁止复读', async () => {
  const { bot, cleanup } = makeBot({ replies: ['随便'] });
  const d = await bot.decide(g('@鲸鲸 在吗'));
  assert.match(d.system, /不要复读对方刚说的话/);
  cleanup();
});

test('私聊也不会复读', async () => {
  const { bot, cleanup } = makeBot({ replies: ['在吗', '在的，说吧'] });
  const r = await bot.handle({
    platform: 'wechat', chatId: 'wxid_p1', chatType: 'private',
    senderId: 'wxid_p1', senderName: '老王', text: '在吗',
  });
  assert.notEqual(r.reply, '在吗');
  cleanup();
});
