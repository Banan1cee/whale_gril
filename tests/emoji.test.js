'use strict';

/**
 * 颜文字 / emoji 控制器必须真的生效。
 *
 * 之前的 bug：调教台的「颜文字用量」只改提示词里的半句话，真正决定「加不加 emoji」的
 * 是 config.chat.emojiChance，默认 0 —— 于是无论选哪档都不出现颜文字；
 * 而且加料池里只有 emoji，没有颜文字。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const persona = require('../src/persona');
const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

const cfgWith = (level, chance) => ({ persona: { emojiLevel: level }, chat: { emojiChance: chance } });

test('四档「颜文字用量」对应四个真实概率', () => {
  assert.equal(persona.emojiChanceFor(cfgWith('关', 0)), 0);
  assert.equal(persona.emojiChanceFor(cfgWith('少', 0)), 0.12);
  assert.equal(persona.emojiChanceFor(cfgWith('正常', 0)), 0.3);
  assert.equal(persona.emojiChanceFor(cfgWith('多', 0)), 0.65);
});

test('没调过档位时按「正常」算，不是永远不说话', () => {
  assert.equal(persona.emojiChanceFor({ persona: {}, chat: { emojiChance: 0 } }), 0.3);
  assert.equal(persona.emojiChanceFor({}), 0.3);
});

test('「关」是硬关，压过手动概率', () => {
  assert.equal(persona.emojiChanceFor(cfgWith('关', 0.9)), 0);
});

test('手动填了概率就用手动的（高级微调）', () => {
  assert.equal(persona.emojiChanceFor(cfgWith('正常', 0.5)), 0.5);
  assert.equal(persona.emojiChanceFor(cfgWith('多', 1)), 1);
});

test('颜文字池里有真的颜文字，不是占位符', () => {
  assert.ok(Array.isArray(persona.KAOMOJI) && persona.KAOMOJI.length >= 5);
  for (const k of persona.KAOMOJI) {
    assert.equal(typeof k, 'string');
    assert.ok(k.length >= 3, '颜文字太短：' + k);
    assert.ok(/[()（）]/.test(k) || /qwq|ᕕ/.test(k), '看起来不像颜文字：' + k);
  }
  assert.equal(typeof persona.kaomojiPick(() => 0.5), 'string');
});

function makeBot(level) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.emojiLevel = level;
  delete config.chat.emojiChance; // 模拟「面板里没调概率」，让它跟着档位走
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-emoji-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('「关」时一条都不加料', () => {
  const { bot, cleanup } = makeBot('关');
  bot.rng = () => 0; // 最容易被抽中
  for (let i = 0; i < 20; i += 1) assert.equal(bot.pickEmoji('今天好累'), '今天好累');
  cleanup();
});

test('「多」时能产出颜文字（以前只有 emoji，颜文字永远不出现）', () => {
  const { bot, cleanup } = makeBot('多');
  bot.rng = () => 0; // 必中，且走颜文字分支（第一次 0 不大于概率，第二次 0 < 0.5）
  const out = bot.pickEmoji('今天好累');
  assert.match(out, /^今天好累 /, '应当在句尾加料');
  const tail = out.replace('今天好累 ', '');
  assert.ok(persona.KAOMOJI.includes(tail), '加的是颜文字：' + tail);
  cleanup();
});

test('「正常」时加了料也不会重复加（本身带 emoji 就跳过）', () => {
  const { bot, cleanup } = makeBot('正常');
  bot.rng = () => 0;
  assert.equal(bot.pickEmoji('好耶🐋'), '好耶🐋');
  cleanup();
});
