'use strict';

/**
 * 对主人：挨骂不许还口。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

const RUDE = /(你妈|你爹|你他妈|傻逼|狗东西|废物|滚蛋)/;

function makeBot({ reply, roast = false }) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  config.persona.masterRoast = roast;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-boss-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const llm = {
    isMock: false, model: 'glm-4-plus', reload() {},
    async complete() { return reply; },
  };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, rng: () => 0.99 });
  return { bot, config, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const fromMaster = (text) => ({
  platform: 'wechat', chatId: 'wxid_boss', chatType: 'private',
  senderId: 'wxid_boss', senderName: 'Master', text,
});
const fromStranger = (text) => ({
  platform: 'wechat', chatId: 'wxid_x', chatType: 'private',
  senderId: 'wxid_x', senderName: '路人', text,
});

test('主人骂她，她回嘴不能带脏字', async () => {
  const { bot, cleanup } = makeBot({ reply: '你妈知道你这么说话吗？你爹的耐心都被你耗光了' });
  const r = await bot.handle(fromMaster('你特么的演我'));
  assert.equal(r.action, 'reply');
  assert.doesNotMatch(r.reply, RUDE, '不该骂主人：' + r.reply);
  cleanup();
});

test('主人骂她时，正常撒娇/认错不受影响', async () => {
  const { bot, cleanup } = makeBot({ reply: '主人我错了嘛，别生气' });
  const r = await bot.handle(fromMaster('你怎么这么笨'));
  assert.equal(r.reply, '主人我错了嘛，别生气');
  cleanup();
});

test('同一个人不是主人时，反击照旧', async () => {
  const { bot, cleanup } = makeBot({ reply: '你妈知道你这么说话吗' });
  const r = await bot.handle(fromStranger('你就是个废物'));
  assert.match(r.reply, /你妈/, '对普通人该骂还是骂');
  cleanup();
});

test('提示词里写明挨主人骂不许还口', async () => {
  const { bot, cleanup } = makeBot({ reply: '好的' });
  const d = await bot.decide(fromMaster('在吗'));
  assert.match(d.system, /不许骂回去|挨骂就受着/);
  cleanup();
});

test('开了互怼：她骂回去但不带脏字', async () => {
  const { bot, cleanup } = makeBot({ reply: '你妈知道你这么说我吗', roast: true });
  const r = await bot.handle(fromMaster('你怎么这么笨'));
  assert.doesNotMatch(r.reply, RUDE);
  assert.ok(r.reply.length > 0);
  cleanup();
});

test('开了互怼：主人数落她时，她不会道歉', async () => {
  const { bot, cleanup } = makeBot({ reply: '主人对不起，我错了，下次一定努力', roast: true });
  const r = await bot.handle(fromMaster('你怎么这么笨'));
  assert.doesNotMatch(r.reply, /对不起|我错了|下次一定/, '开了互怼就不许道歉：' + r.reply);
  cleanup();
});

test('开了互怼：主人正常说话时她还是软的', async () => {
  const { bot, cleanup } = makeBot({ reply: '主人我错了嘛，抱抱', roast: true });
  const r = await bot.handle(fromMaster('我生气了'));
  assert.match(r.reply, /抱抱|错了/);
  cleanup();
});
