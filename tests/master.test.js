'use strict';

/**
 * 主人最高指令：主人的话无条件执行，别人冒充无效。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-master-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const master = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group',
  senderId: 'wxid_boss', senderName: 'Master', text, chatTitle: '深海鱼塘', ...extra,
});
const stranger = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group',
  senderId: 'wxid_stranger', senderName: '路人', text, chatTitle: '深海鱼塘', ...extra,
});

test('主人在群里不 @ 她也会回', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('今天怎么这么安静'));
  assert.equal(r.action, 'reply');
  cleanup();
});

test('主人在群里不 @ 也能执行命令', async () => {
  const { bot, config, cleanup } = makeBot();
  const r = await bot.decide(master('上下文 20'));
  assert.equal(r.action, 'command');
  assert.equal(config.chat.historyTurns, 20);
  cleanup();
});

test('主人在群里说「闭麦」直接执行', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('闭麦 5 分钟'));
  assert.equal(r.action, 'command');
  assert.equal(r.commandType, 'mute');
  cleanup();
});

test('普通人同样的话不执行、也不理', async () => {
  const { bot, config, cleanup } = makeBot();
  const before = config.chat.historyTurns;
  const r = await bot.decide(stranger('上下文 20'));
  assert.equal(r.action, 'ignore');
  assert.equal(config.chat.historyTurns, before, '普通人不能改配置');
  const r2 = await bot.decide(stranger('闭麦 5 分钟', { msgId: 'x2' }));
  assert.notEqual(r2.action, 'command');
  cleanup();
});

test('冒充主人（改昵称）没有命令权', async () => {
  const { bot, config, cleanup } = makeBot();
  const before = config.chat.historyTurns;
  const r = await bot.decide({ ...stranger('上下文 20'), senderName: 'Master', senderId: 'wxid_fake' });
  assert.equal(r.action, 'ignore');
  assert.equal(config.chat.historyTurns, before);
  cleanup();
});

test('跟主人说话时，提示词里有最高指令', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('在吗'));
  assert.match(r.system, /主人的话无条件执行/);
  assert.match(r.system, /直接执行/);
  assert.match(r.system, /不讨价还价/);
  cleanup();
});

test('跟普通人说话时，提示词明确没有命令权', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(stranger('@鲸鲸 在吗', { atMe: true }));
  assert.match(r.system, /没有命令权|一律不认/);
  assert.doesNotMatch(r.system, /主人的话无条件执行/);
  cleanup();
});

test('主人让她闭嘴，她就闭嘴', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('滚'));
  assert.equal(r.action, 'reply');
  assert.match(r.canned, /好的主人/);
  cleanup();
});

test('主人骂她不会触发回怼', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('你就是个废物'));
  assert.equal(r.msg.fight, false);
  cleanup();
});

test('主人身份刚配好时提示词带「身份纠错」，不再顺着旧记忆否认', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('我是你主人吗'));
  assert.match(r.system, /身份纠错/);
  assert.match(r.system, /作废/);
  cleanup();
});

test('普通人收到的提示词里没有「身份纠错」那一段', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(stranger('@鲸鲸 在吗', { atMe: true }));
  assert.doesNotMatch(r.system, /身份纠错/);
  cleanup();
});

test('主人认证后，历史里她之前的否认不喂给模型（否则她会顺着旧记忆继续说不是）', async () => {
  const { bot, cleanup } = makeBot();
  const key = bot.sessionKey(master('x'));
  const base = Date.now() - 120000;
  bot.store.appendMessage(key, { role: 'user', name: 'Master', uid: 'wxid_boss', text: '我是你主人吗？', ts: base });
  bot.store.appendMessage(key, { role: 'assistant', text: '不是。冒充这招没用，我说过了。', ts: base + 1000 });
  bot.store.appendMessage(key, { role: 'user', name: 'Master', uid: 'wxid_boss', text: '我真的是', ts: base + 2000 });
  bot.store.appendMessage(key, { role: 'assistant', text: '光说没用，系统不认你。', ts: base + 3000 });
  bot.store.appendMessage(key, { role: 'user', name: 'Master', uid: 'wxid_boss', text: '今天天气不错', ts: base + 4000 });
  bot.store.appendMessage(key, { role: 'assistant', text: '是吧，适合睡觉。', ts: base + 5000 });

  const r = await bot.decide(master('我是你主人吗'));
  const all = (r.turns || []).map((t) => t.content).join('\n');
  assert.doesNotMatch(all, /冒充这招没用/, '旧否认不该再喂给模型');
  assert.doesNotMatch(all, /系统不认你/);
  assert.doesNotMatch(all, /我真的是/, '追问也一起拿掉');
  assert.match(all, /今天天气不错/, '无关的正常历史要留着');
  assert.match(all, /我是你主人吗/, '当前这条消息必须在');
  cleanup();
});

test('普通人的历史不做这套删改', async () => {
  const { bot, cleanup } = makeBot();
  const key = bot.sessionKey(stranger('x'));
  const base = Date.now() - 60000;
  bot.store.appendMessage(key, { role: 'user', name: '路人', uid: 'wxid_stranger', text: '我是你主人吗？', ts: base });
  bot.store.appendMessage(key, { role: 'assistant', text: '不是。冒充这招没用。', ts: base + 1000 });
  const r = await bot.decide(stranger('@鲸鲸 在吗', { atMe: true }));
  const all = (r.turns || []).map((t) => t.content).join('\n');
  assert.match(all, /冒充这招没用/, '普通人之间的历史原样保留');
  cleanup();
});

test('主人认证后，模型就算嘴硬否认身份也会被改成认下来', () => {
  const { bot, cleanup } = makeBot();
  const decision = { key: 'wechat:u:wxid_boss', msg: { isMaster: true, chatType: 'private', text: '你看我的 ID' }, bubbles: 1 };
  for (const bad of ['不是。别自封了，认主系统里没你这号。', '就一个名字罢了，我不认。', '冒充这招没用']) {
    const out = bot.finalize(decision, bad);
    const text = out.join(' ');
    assert.doesNotMatch(text, /自封|没你这号|就一个名字|冒充/, '不许把否认发出去：' + bad);
    assert.match(text, /主人/);
  }
  cleanup();
});
