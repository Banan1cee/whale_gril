'use strict';

/**
 * 有人骂主人：她要能看出来，并且知道骂的是谁。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot({ reply = '你算什么东西', rng = () => 0.99 } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-defend-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const llm = { isMock: false, model: 'deepseek-chat', reload() {}, async complete() { return reply; } };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, rng });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const g = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group',
  senderId: 'wxid_other', senderName: '赔笙', text, chatTitle: '马➕', ...extra,
});
const boss = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group',
  senderId: 'wxid_boss', senderName: 'Master', text, chatTitle: '马➕', atMe: false, ...extra,
});

test('「你个臭机器人还挑衅上我了」算骂她，会进火力模式', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('你个臭机器人还挑衅上我了'));
  assert.equal(r.msg.fight, true, '这种话应该被识别成骂她');
  cleanup();
});

test('主人说「有人骂我」，她能揪出刚才骂人的那个', async () => {
  const { bot, cleanup } = makeBot();
  // 先让对方骂一句，再让主人来告状
  await bot.decide(g('你个臭机器人还挑衅上我了', { msgId: 'm1' }));
  const r = await bot.decide(boss('有人骂我'));
  assert.equal(r.msg.fight, true, '主人被骂要开战');
  assert.equal(r.msg.fightOnMaster, true);
  assert.ok(r.msg.fightTarget, '要找出骂人的是谁');
  assert.equal(r.msg.fightTarget.name, '赔笙');
  assert.match(r.msg.fightTarget.text, /臭机器人/);
  assert.match(r.system, /赔笙/, '提示词里要写上靶子');
  cleanup();
});

test('没人骂主人时，不会凭空开战', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(boss('有人骂我吗'));
  assert.notEqual(r.msg.fight, true);
  cleanup();
});

test('普通对话里出现「机器人」不算骂人', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('这个机器人挺好用的'));
  assert.notEqual(r.msg.fight, true);
  cleanup();
});
