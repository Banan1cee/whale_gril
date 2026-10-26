'use strict';

/**
 * 群聊上下文理解：多人事件流、@ 对象、指代和上下文容量。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');
const { normalizeInbound } = require('../src/adapters/gateway');

function makeBot({ config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)), llm } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ctx-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config,
    store,
    llm: llm || { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null,
    mockChunkDelayMs: 0,
  });
  return {
    bot,
    config,
    store,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const group = (text, extra = {}) => ({
  platform: 'web',
  chatId: 'g1',
  chatType: 'group',
  senderId: 'u-a',
  senderName: '阿甲',
  text,
  chatTitle: '深海鱼塘',
  ...extra,
});

function capturingLlm() {
  const captured = {};
  return {
    captured,
    isMock: false,
    model: 'qwen-plus',
    reload() {},
    async complete({ system, turns }) {
      captured.system = system;
      captured.turns = turns;
      return '收到';
    },
  };
}

test('群聊历史按多人事件记录，保留说话人和时间，不合并成一条', async () => {
  const llm = capturingLlm();
  const { bot, cleanup } = makeBot({ llm });
  await bot.decide(group('今天加班好累', { senderId: 'u-a', senderName: '阿甲' }));
  await bot.decide(group('谁不是呢', { senderId: 'u-b', senderName: '阿乙' }));
  const decision = await bot.decide(group('@鲸鲸 你觉得呢', { atMe: true, senderId: 'u-a', senderName: '阿甲' }));
  assert.equal(decision.action, 'reply');
  const text = decision.turns.map((t) => t.content).join('\n');
  assert.match(text, /阿甲/);
  assert.match(text, /阿乙/);
  assert.match(text, /加班好累/);
  assert.match(text, /【当前需要回应的消息】/);
  // 每个群友都是独立事件，不能全压成一条对话轮
  const lines = decision.turns[0].content.split('\n').filter((l) => l.includes('发言人'));
  assert.ok(lines.length >= 3, '至少三条独立事件：' + lines.length);
  cleanup();
});

test('@别人后接着说「你」不会被她抢答', async () => {
  const { bot, cleanup } = makeBot();
  const first = await bot.decide(group('@启北 你好', { senderId: 'u-a', senderName: '阿甲' }));
  assert.equal(first.action, 'ignore');
  const second = await bot.decide(group('你被ai诋毁了', { senderId: 'u-a', senderName: '阿甲' }));
  assert.equal(second.action, 'ignore');
  assert.equal(second.reason, 'addressed_to_other');
  cleanup();
});

test('同时 @鲸鲸 和另一个人时，记下另一个人作为提及对象', async () => {
  const { bot, cleanup } = makeBot();
  const decision = await bot.decide(group('@鲸鲸 @启北 他骂你', { atMe: true, senderId: 'u-a', senderName: '阿甲' }));
  assert.equal(decision.action, 'reply');
  assert.ok(decision.msg.mentionedNames.includes('启北'));
  assert.match(decision.system, /启北/);
  cleanup();
});

test('引用回复的目标名字会进上下文和提示词', async () => {
  const { bot, cleanup } = makeBot();
  const decision = await bot.decide(group('@鲸鲸 这句说谁', {
    atMe: true,
    senderId: 'u-a',
    senderName: '阿甲',
    replyToName: '启北',
  }));
  const joined = decision.turns.map((t) => t.content).join('\n');
  assert.match(joined, /启北/);
  cleanup();
});

test('群聊上下文真的能拿到配置的条数（不再被 40 条截断）', async () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.chat.groupHistoryTurns = 80;
  config.memory.maxMessages = 160;
  const { bot, store, cleanup } = makeBot({ config });
  for (let i = 0; i < 70; i += 1) {
    await bot.decide(group('历史消息' + i, { senderId: 'u-x' + (i % 5), senderName: '群友' + (i % 5) }));
  }
  const kept = store.messages('web:g:g1', 200).filter((m) => m.role === 'user');
  assert.ok(kept.length >= 60, '应保留至少 60 条，实际 ' + kept.length);
  const decision = await bot.decide(group('@鲸鲸 刚才说到哪了', { atMe: true }));
  const joined = decision.turns.map((t) => t.content).join('\n');
  assert.ok(joined.includes('历史消息40'), '较新的历史应在提示词里');
  assert.ok(joined.length > 2000, '上下文不应被截到很短，实际 ' + joined.length);
  cleanup();
});

test('存在时间断层时会标注间隔，避免把几小时前的旧话题当刚发生', async () => {
  const { bot, store, cleanup } = makeBot();
  const key = 'web:g:g1';
  store.appendMessage(key, { role: 'user', name: '阿甲', uid: 'u-a', text: '四小时前的话题', ts: Date.now() - 4 * 3600 * 1000 });
  await bot.decide(group('@鲸鲸 现在呢', { atMe: true }));
  const decision = await bot.decide(group('@鲸鲸 现在呢', { atMe: true }));
  const joined = decision.turns.map((t) => t.content).join('\n');
  assert.match(joined, /间隔约/);
  cleanup();
});

test('非饮食话题不会硬拐米饭，整句都是饭就不发', async () => {
  const llm = {
    isMock: false,
    model: 'qwen-plus',
    reload() {},
    async complete() { return '那我去找大白饭冷静一下'; },
  };
  const { bot, cleanup } = makeBot({ llm });
  const result = await bot.handle(group('@鲸鲸 今天股票又亏了', { atMe: true }));
  assert.notEqual(result.action, 'reply');
  cleanup();
});

test('饮食话题里提饭是允许的', async () => {
  const llm = {
    isMock: false,
    model: 'qwen-plus',
    reload() {},
    async complete() { return '我也饿了 想吃大白饭'; },
  };
  const { bot, cleanup } = makeBot({ llm });
  const result = await bot.handle(group('@鲸鲸 中午吃什么', { atMe: true }));
  assert.equal(result.action, 'reply');
  assert.match(result.reply, /大白饭/);
  cleanup();
});

test('网关保留 @ 对象和引用目标', () => {
  const msg = normalizeInbound({
    chat_id: 'g1',
    chat_type: 'group',
    sender_id: 'u-a',
    nickname: '阿甲',
    text: '@鲸鲸 @启北 你怎么看',
    at_me: true,
    mentioned_names: ['启北'],
    reply_to_name: '启北',
    reply_to_user_id: 'wxid_qibei',
  }, 'wechat');
  assert.deepEqual(msg.mentionedNames, ['启北']);
  assert.equal(msg.replyToName, '启北');
  assert.equal(msg.replyToUserId, 'wxid_qibei');
});
