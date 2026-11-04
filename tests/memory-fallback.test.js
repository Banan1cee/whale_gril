'use strict';

/**
 * 记忆拉取失败 ≠ 这条不回话。
 *
 * 记忆（人物卡 / 事件 / 摘要 / 关系 / 动作账本）是加分项：读不出来时应当
 * 整块放弃、只带本会话最近的原文继续回复，同时把失败照常打成 error 日志。
 * 以前 buildContext 一抛错就一路抛到 _handleOnce，用户看到的是「她突然不理我」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { promptOf } = require('./support/prompt');

function makeBot() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: [], wxids: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-fallback-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const logs = [];
  const logger = {
    error: (m) => logs.push(['error', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    info: () => {},
    debug: () => {},
  };
  const bot = new Bot({
    config,
    store,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger,
    mockChunkDelayMs: 0,
  });
  return {
    bot,
    store,
    logs,
    key: 'web:u:s1',
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

const privateMsg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 's1',
  chatType: 'private',
  senderId: 'u1',
  senderName: '小海',
  text,
  ...extra,
});

function seedHistory(store, key) {
  const now = Date.now();
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我住在杭州，公司在滨江', ts: now - 60000 });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '杭州啊，西湖边好逛', ts: now - 50000 });
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '周末想去看展', ts: now - 40000 });
}

test('buildContext 抛错：仍然回复，只是不带记忆块，并报 error', async () => {
  const { bot, store, logs, key, cleanup } = makeBot();
  try {
    seedHistory(store, key);
    store.buildContext = () => { throw new Error('EIO: 记忆文件读不出来'); };

    const decision = await bot.decide(privateMsg('还记得我住哪吗'));

    assert.equal(decision.action, 'reply', '记忆坏了也必须回复');
    const prompt = promptOf(decision);
    // 放弃的是记忆块，不是历史原文
    assert.ok(prompt.includes('我住在杭州'), '应该带上 recent 里的原话');
    assert.ok(!prompt.includes('【这个聊天里的 TA】'), '记忆块应当整块放弃');
    assert.ok(
      logs.some(([level, text]) => level === 'error' && text.includes('拉取记忆失败')),
      '失败本身要打 error'
    );
  } finally {
    cleanup();
  }
});

test('buildContext 抛错：handle() 端到端仍然给出回复气泡', async () => {
  const { bot, store, cleanup } = makeBot();
  try {
    seedHistory(store, 'web:u:s1');
    store.buildContext = () => { throw new Error('EIO: 记忆文件读不出来'); };

    const res = await bot.handle(privateMsg('在吗'));

    assert.equal(res.action, 'reply');
    assert.equal(res.reason !== 'error', true, '不能退化成 reason=error');
    assert.ok(Array.isArray(res.bubbles) && res.bubbles.length >= 1);
  } finally {
    cleanup();
  }
});

test('动作账本读取失败：不影响回复', async () => {
  const { bot, store, cleanup } = makeBot();
  try {
    seedHistory(store, 'web:u:s1');
    store.events = () => { throw new Error('EIO: 账本读不出来'); };

    const res = await bot.handle(privateMsg('在吗'));

    assert.equal(res.action, 'reply');
    assert.ok(res.reply && res.reply.length > 0);
  } finally {
    cleanup();
  }
});

test('连 recent 都读不出来：至少回当前这条', async () => {
  const { bot, store, cleanup } = makeBot();
  try {
    store.buildContext = () => { throw new Error('EIO: 记忆文件读不出来'); };
    store.messages = () => { throw new Error('EIO: 原文也读不出来'); };

    const res = await bot.handle(privateMsg('你还在吗'));

    assert.equal(res.action, 'reply');
    assert.ok(res.reply && res.reply.length > 0);
  } finally {
    cleanup();
  }
});

test('人物卡读取失败：按空卡继续回复，昵称退回微信名', async () => {
  const { bot, store, cleanup } = makeBot();
  try {
    store.profile = () => { throw new Error('EIO: 人物卡读不出来'); };

    const res = await bot.handle(privateMsg('在吗'));

    assert.equal(res.action, 'reply');
    assert.ok(res.reply && res.reply.length > 0);
  } finally {
    cleanup();
  }
});

test('finalize 写库失败：回复已经生成，仍然返回气泡', async () => {
  const { bot, store, logs, cleanup } = makeBot();
  try {
    const append = store.appendMessage.bind(store);
    store.appendMessage = (key, payload) => {
      // 只让「写回复」失败；用户消息照常落库
      if (payload && payload.role === 'assistant') throw new Error('EIO: 磁盘满了');
      return append(key, payload);
    };

    const res = await bot.handle(privateMsg('在吗'));

    assert.equal(res.action, 'reply', '写库失败不能把回复吞掉');
    assert.ok(Array.isArray(res.bubbles) && res.bubbles.length >= 1, '要有气泡');
    assert.ok(res.reply && res.reply.length > 0);
    assert.ok(
      logs.some(([level, text]) => level === 'error' && text.includes('写入回复失败')),
      '失败本身要报 error'
    );
  } finally {
    cleanup();
  }
});
