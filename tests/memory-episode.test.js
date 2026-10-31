'use strict';

/**
 * Episode：空闲 30 分钟 / 话题切换 / 6,000 token / 3 小时关闭；L2 幂等；启动补写。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const episode = require('../src/memory/episode');
const personCard = require('../src/memory/personCard');
const { LIMITS } = require('../src/memory/constants');
const { Store } = require('../src/memory/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ep-'));
  const file = path.join(dir, 'data', 'store.json');
  const store = new Store({ file, logger: null });
  return { store, file, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
}

const fakeLlm = {
  isMock: false,
  async complete() {
    return JSON.stringify({
      summary: '小海在聊加班，说最近很累，周末想休息；还没决定要不要跟老板提。',
      facts: [{ uid: 'u1', text: '最近在加班', confidence: 0.8 }],
      traits: [{ uid: 'u1', text: '压力大时不想被说教', confidence: 0.7, evidence: ['msg_1', 'msg_2'] }],
      events: [{ uid: 'u1', title: '加班很累', summary: '小海说最近天天加班，周末只想躺着，还没想好怎么跟老板说。', keywords: ['加班', '累'], importance: 0.6, confidence: 0.8 }],
      threads: [{ uid: 'u1', text: '还没决定要不要跟老板提休息' }],
    });
  },
};

test('空闲 30 分钟：关闭旧 episode，写一条 L2 + thread', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:a';
  const t0 = Date.now() - 40 * 60000;
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '今天加班好累', ts: t0 });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '那早点休息', ts: t0 + 1000 });
  // 40 分钟后来的新消息 → 上一段空闲关闭
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我回来了', ts: Date.now() });
  await store.drain();
  store.llm = fakeLlm;
  await store.closeEpisode(key, { llm: fakeLlm, now: Date.now() });
  await store.drain();

  const chat = store.chatStore.chats.get(key);
  assert.ok(chat.meta.closedEpisodes.length >= 1, '应至少关闭一个 episode');
  const card = store.chatStore.getCard(chat, 'u1');
  assert.ok(personCard.activeEvents(card).length >= 1, 'L2 事件要写进当前说话人的卡');
  store.close();
  cleanup(dir);
});

test('L2 幂等：同一个 episode 关两次，事件只写一条', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:a';
  const now = Date.now();
  for (let i = 0; i < 4; i += 1) {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '加班第' + i + '天，好累', ts: now + i });
  }
  const first = await store.closeEpisode(key, { llm: fakeLlm, now: now + 10, reason: 'manual' });
  assert.equal(first.closed, true);
  const card = store.chatStore.getCard(store.chatStore.chats.get(key), 'u1');
  const eventCount = personCard.activeEvents(card).length;
  assert.equal(eventCount, 1, '一段时间只写一条事件');

  const second = await store.closeEpisode(key, { llm: fakeLlm, now: now + 20, reason: 'manual' });
  assert.equal(second.closed, false);
  assert.equal(second.reason, 'already_closed');
  assert.equal(personCard.activeEvents(card).length, eventCount, '不能重复写');
  store.close();
  cleanup(dir);
});

test('话题切换：聊了 6 条后明确换话题 → 关闭', async () => {
  const { store, dir } = tempStore();
  const key = 'wechat:g:g1';
  const now = Date.now();
  for (let i = 0; i < 7; i += 1) {
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '加班第' + i + '天真的顶不住', ts: now + i });
  }
  store.chatStore.chats.get(key).meta.episode.userMessages = 7;
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '换个话题，说说周末去哪玩', ts: now + 10 });
  await store.drain();
  const chat = store.chatStore.chats.get(key);
  assert.ok(chat.meta.closedEpisodes.length >= 1);
  store.close();
  cleanup(dir);
});

test('累计 6,000 token / 持续 3 小时都会强制关闭', () => {
  const { store, dir } = tempStore();
  const key = 'wechat:u:t';
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '第一句', ts: Date.now() });
  const chat = store.chatStore.chats.get(key);
  chat.meta.episode.tokens = LIMITS.episodeMaxTokens;
  assert.equal(episode.shouldClose(chat, { text: '下一句', now: Date.now() }), 'tokens');

  chat.meta.episode.tokens = 0;
  chat.meta.episode.startedAt = Date.now() - LIMITS.episodeMaxHours * 3600000 - 1;
  assert.equal(episode.shouldClose(chat, { text: '下一句', now: Date.now() }), 'max_hours');

  chat.meta.episode.startedAt = Date.now();
  assert.equal(episode.shouldClose(chat, { text: '正常接着聊', now: Date.now() }), null);
  store.close();
  cleanup(dir);
});

test('parseEpisode：越界 uid / 缺字段都能兜住', () => {
  const extractor = require('../src/memory/extractor');
  const parsed = extractor.parseEpisode(JSON.stringify({
    summary: '在聊加班',
    facts: [{ uid: 'u1', text: '在加班', confidence: 2 }, { text: '' }],
    traits: [{ uid: 'u1', text: '嘴硬心软', confidence: 0.7, evidence: ['m1'] }],
    events: [{ uid: 'u2', title: '加班', summary: '很累', keywords: ['加班'], importance: 9 }],
    threads: [{ uid: 'u1', text: '要不要辞职' }],
  }));
  assert.equal(parsed.facts[0].confidence, 1);
  assert.equal(parsed.events[0].importance, 1);
  assert.equal(parsed.threads[0].text, '要不要辞职');
  assert.equal(extractor.parseEpisode('没有 JSON'), null);
});

test('启动恢复：关闭 30 分钟以上，重启后补写上一条 episode 的 L2', async () => {
  const { store, file, dir } = tempStore();
  const key = 'wechat:u:a';
  const old = Date.now() - 2 * 3600 * 1000;
  store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '两小时前聊了换工作', ts: old });
  store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '慢慢想', ts: old + 1000 });
  store.close();

  const store2 = new Store({ file, logger: null });
  store2.llm = fakeLlm;
  const result = await store2.startupRecovery({ llm: fakeLlm });
  assert.ok(result.episodesClosed >= 1, '应补写上一条 episode');
  const chat = store2.chatStore.chats.get(key);
  assert.ok(chat.meta.closedEpisodes.length >= 1);
  store2.close();
  cleanup(dir);
});
