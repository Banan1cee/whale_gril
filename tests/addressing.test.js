'use strict';

/**
 * 别人叫她但不 @ 的情况：句尾叫名字、被人骂但没 @，都得理。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');
const persona = require('../src/persona');

function makeBot({ llm } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-call-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: llm || { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const g = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g-call', chatType: 'group',
  senderId: 'wxid_stranger', senderName: '路人', text, chatTitle: '深海鱼塘', ...extra,
});

test('句尾叫名字也算在叫她：你好响呀鲸鲸', () => {
  const { cleanup } = makeBot();
  const r = persona.cleanIncoming('你好响呀鲸鲸', DEFAULT_CONFIG);
  assert.equal(r.hadAlias, true);
  assert.equal(r.text, '你好响呀');
  cleanup();
});

test('句中说名字也算：鲸鲸你别装了', () => {
  const r = persona.cleanIncoming('鲸鲸你别装了', DEFAULT_CONFIG);
  assert.equal(r.hadAlias, true);
});

test('「小鲸鱼」不能误判成「小鲸」叫她', () => {
  const r = persona.cleanIncoming('@小鲸鱼 你好', DEFAULT_CONFIG);
  assert.equal(r.hadAlias, false);
});

test('「大肥鱼人工智能」这种连写也要认出来', () => {
  // 名字后面直接跟汉字，也要算叫到她
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.aliases = ['鲸鲸', '大肥鱼'];
  assert.equal(persona.cleanIncoming('大肥鱼人工智能是吧', cfg).hadAlias, true);
  assert.equal(persona.cleanIncoming('这大肥鱼是不是人工智能', cfg).hadAlias, true);
  // 但更长的昵称不能被截断
  assert.equal(persona.cleanIncoming('大肥鱼儿来了', cfg).hadAlias, false);
});

test('图片描述里出现名字不算叫她', () => {
  const r = persona.cleanIncoming('（对方发了一张图片，图里是：有人 @鲸鲸 骂了一句）', DEFAULT_CONFIG);
  assert.equal(r.hadAlias, false);
});

test('群里句尾叫她，会真的接话', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('你好响呀鲸鲸'));
  assert.equal(r.action, 'reply');
  cleanup();
});

test('被骂但没 @，只要她刚说过话就回怼', async () => {
  const { bot, cleanup } = makeBot();
  // 先让她在群里说一句，制造「刚说过话」的上下文
  const first = await bot.decide(g('@鲸鲸 在吗', { atMe: true }));
  bot.finalize(first, '在');
  const r = await bot.decide(g('你就是个傻逼'));
  assert.equal(r.action, 'reply');
  assert.ok(r.canned || r.system, '应该有回应');
  cleanup();
});

test('群里随便有人骂人、跟她没关系时不开炮', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('张三你个傻逼'));
  assert.equal(r.action, 'ignore');
  cleanup();
});

test('被骂且刚说过话，回的是硬话不是软话', async () => {
  const llm = { isMock: false, model: 'qwen-plus', reload() {}, async complete() { return '别生气，我理解你'; } };
  const { bot, cleanup } = makeBot({ llm });
  const first = await bot.decide(g('@鲸鲸 在吗', { atMe: true }));
  bot.finalize(first, '在');
  const out = await bot.handle(g('傻逼'));
  assert.equal(out.action, 'reply');
  assert.doesNotMatch(out.reply, /别生气|我理解/);
  cleanup();
});
