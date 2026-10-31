'use strict';

/**
 * 隔离：私聊 A / 群 G / 群 H 各自独立；群聊只读当前说话人。
 * 这是 v2 最硬的约束，任何一条破了都算事故。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const { Bot } = require('../src/pipeline/chat');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const personCard = require('../src/memory/personCard');

function makeBot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-iso-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {} },
  });
  return { bot, store, dir, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 }); } };
}

const pm = (chatId, uid, name, text) => ({
  platform: 'wechat', chatId, chatType: 'private', senderId: uid, senderName: name, text,
});
const gm = (chatId, uid, name, text) => ({
  platform: 'wechat', chatId, chatType: 'group', senderId: uid, senderName: name, text, atMe: true, chatTitle: '深海鱼塘',
});

test('私聊 A 说的住处，不会出现在群 G 里（B 问也不注入）', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide(pm('wxid_a', 'u-a', '小海', '我搬到上海了'));

  const g = await bot.decide(gm('g1', 'u-b', '阿丙', '@鲸鲸 小海住哪'));
  const joined = [g.system, ...(g.turns || []).map((t) => t.content)].join('\n');
  assert.ok(!joined.includes('上海'), '群聊不能看到私聊记忆：' + joined.slice(-400));

  const ctx = store.buildContext({ key: 'wechat:g:g1', uid: 'u-b', name: '阿丙', query: '小海住哪' });
  assert.ok(!ctx.block.includes('上海'));
  cleanup();
});

test('群 G 里 A 的卡和 B 的卡互不混用', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide(gm('g1', 'u-a', '小海', '@鲸鲸 我喜欢猫'));
  await bot.decide(gm('g1', 'u-b', '阿丙', '@鲸鲸 今天加班好累'));

  const ctxA = store.buildContext({ key: 'wechat:g:g1', uid: 'u-a', name: '小海', query: '猫' });
  const ctxB = store.buildContext({ key: 'wechat:g:g1', uid: 'u-b', name: '阿丙', query: '猫' });
  assert.equal(ctxA.card.uid, 'u-a');
  assert.equal(ctxB.card.uid, 'u-b');
  assert.ok(ctxA.block.includes('猫'), 'A 说话只注入 A 的卡');
  assert.ok(!ctxB.block.includes('猫'), 'B 说话不能注入 A 的卡：' + ctxB.block);

  // B 问「小海喜欢什么」：群历史是公开的，但 B 的卡里不能混进 A 的偏好
  await bot.decide(gm('g1', 'u-b', '阿丙', '@鲸鲸 小海喜欢什么'));
  const afterB = store.buildContext({ key: 'wechat:g:g1', uid: 'u-b', name: '阿丙', query: '小海喜欢什么' });
  assert.ok(!afterB.block.includes('喜欢猫'), 'B 的卡不能混进 A 的偏好');
  cleanup();
});

test('同一个人：私聊卡 ≠ 群卡 ≠ 另一个群的卡', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide(pm('wxid_a', 'u-a', '小海', '我住在杭州'));
  await bot.decide(gm('g1', 'u-a', '小海', '@鲸鲸 我喜欢火锅'));
  await bot.decide(gm('g2', 'u-a', '小海', '@鲸鲸 我喜欢猫'));

  const privateCtx = store.buildContext({ key: 'wechat:u:wxid_a', uid: 'u-a', name: '小海', query: '我住哪' });
  const g1Ctx = store.buildContext({ key: 'wechat:g:g1', uid: 'u-a', name: '小海', query: '火锅' });
  const g2Ctx = store.buildContext({ key: 'wechat:g:g2', uid: 'u-a', name: '小海', query: '猫' });

  assert.ok(privateCtx.block.includes('杭州'));
  assert.ok(!privateCtx.block.includes('火锅'));
  assert.ok(!privateCtx.block.includes('猫'));
  assert.ok(g1Ctx.block.includes('火锅'));
  assert.ok(!g1Ctx.block.includes('杭州'));
  assert.ok(g2Ctx.block.includes('猫'));
  assert.ok(!g2Ctx.block.includes('杭州'));
  assert.ok(!g2Ctx.block.includes('火锅'));
  cleanup();
});

test('物理目录隔离：三个 chat 三个目录，人物卡各存各的', async () => {
  const { store, dir, cleanup } = makeBot();
  store.addNote('wechat:u:wxid_a', 'u-a', '住在杭州');
  store.addNote('wechat:g:g1', 'u-a', '喜欢火锅');
  store.addNote('wechat:g:g2', 'u-a', '养了一只猫');
  await store.drain();
  store.flush();

  const { chatHash } = require('../src/memory/hash');
  const root = path.join(dir, 'data', 'memory', 'chats');
  const dirs = fs.readdirSync(root);
  assert.equal(dirs.length, 3);
  for (const key of ['wechat:u:wxid_a', 'wechat:g:g1', 'wechat:g:g2']) {
    assert.ok(dirs.includes(chatHash(key)), '每个 chat 一个物理目录：' + key);
  }
  const cardA = JSON.parse(fs.readFileSync(path.join(root, chatHash('wechat:u:wxid_a'), 'people', require('../src/memory/hash').personHash('u-a') + '.json'), 'utf8'));
  assert.equal(cardA.chatId, 'wechat:u:wxid_a');
  assert.ok(personCard.activePreferences(cardA).every((p) => p.text.includes('杭州')));
  cleanup();
});
