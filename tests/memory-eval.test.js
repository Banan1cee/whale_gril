'use strict';

/**
 * 评估集：不是测函数，是测「该想起的旧事有没有进 top5」。
 * 目标 recall@5 ≥ 85%（spec 14.3），低于这个就说明检索参数/分词跑偏了。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retrieval = require('../src/memory/retrieval');
const personCard = require('../src/memory/personCard');
const { Store } = require('../src/memory/store');

const NOW = 1_700_000_000_000;
const DAY = 86400000;

function dateOf(ageDays) {
  return new Date(NOW - ageDays * DAY).toISOString().slice(0, 10);
}

const EVENTS = [
  { title: '体检', age: 2, summary: '明天去医院体检，约了早上八点，空腹', keywords: ['体检', '医院'] },
  { title: '考研', age: 5, summary: '在准备考研，每天复习到很晚', keywords: ['考研', '复习'] },
  { title: '养猫', age: 8, summary: '养了一只猫叫团子，最近掉毛厉害', keywords: ['猫', '团子'] },
  { title: '爱吃辣', age: 40, summary: '特别爱吃辣，火锅只吃麻辣锅', keywords: ['辣', '火锅'] },
  { title: '住杭州', age: 60, summary: '住在杭州，公司在滨江', keywords: ['杭州', '滨江'] },
  { title: '学吉他', age: 90, summary: '在学吉他，刚学会一首歌', keywords: ['吉他'] },
  { title: '成都读书', age: 120, summary: '以前在成都读大学', keywords: ['成都', '大学'] },
  { title: '花生过敏', age: 200, summary: '对花生过敏，吃饼干要看配料表', keywords: ['花生', '过敏'] },
  { title: '陪去医院', age: 30, summary: '答应过周末陪去医院复查', keywords: ['医院', '复查'] },
  { title: '带底料', age: 70, summary: '答应过带火锅底料', keywords: ['火锅', '底料'] },
];

const TURNS = [
  ['明天几点去医院啊', '体检'],
  ['考研复习到哪了', '考研'],
  ['团子今天乖不乖', '养猫'],
  ['晚上吃火锅吧', '爱吃辣'],
  ['杭州下雨了吗', '住杭州'],
  ['吉他练得怎么样', '学吉他'],
  ['你还在成都吗', '成都读书'],
  ['这个饼干有花生吗', '花生过敏'],
  ['医院那边我陪你去', '陪去医院'],
  ['火锅底料买了没', '带底料'],
  ['今天好累啊', null],
  ['在干嘛', null],
  ['哈哈哈哈', null],
  ['晚安', null],
  ['明天见', null],
  ['体检约的几点', '体检'],
  ['考研压力大不大', '考研'],
  ['团子掉毛厉害吗', '养猫'],
  ['今天想吃点辣的', '爱吃辣'],
  ['杭州有什么好玩的', '住杭州'],
  ['吉他学了多久了', '学吉他'],
  ['成都的火锅和这边比呢', '成都读书'],
  ['这个菜里有花生碎吗', '花生过敏'],
  ['陪你去医院那事我记着', '陪去医院'],
  ['底料我挑好了', '带底料'],
  ['早上好', null],
  ['吃了吗', null],
  ['我先忙一会', null],
  ['地铁好挤', null],
  ['到家了', null],
];

function buildCard() {
  const card = personCard.newCard({ chatId: 'wechat:u:a', uid: 'u1', name: '小海', now: NOW });
  for (const ev of EVENTS) {
    personCard.addEvent(card, {
      date: dateOf(ev.age),
      title: ev.title,
      summary: ev.summary,
      keywords: ev.keywords,
      participants: ['u1'],
      importance: ev.age <= 10 ? 0.8 : 0.5,
      confidence: 0.8,
      source: { chatId: card.chatId, messageIds: ['m'] },
    }, { chatId: card.chatId, now: NOW });
  }
  return card;
}

test('recall@5：该想起的旧事至少 85% 进 top5', () => {
  const card = buildCard();
  let expected = 0;
  let hit = 0;
  for (const [say, want] of TURNS) {
    if (!want) continue;
    expected += 1;
    const picks = retrieval.selectEvents(card, { query: say, now: NOW, topK: 5, uid: 'u1' }).map((e) => e.title);
    if (picks.includes(want)) hit += 1;
    else assert.fail(`「${say}」该想起「${want}」，实际：${picks.join(' / ') || '（空）'}`);
  }
  const rate = hit / expected;
  console.log(`  recall@5：${hit}/${expected} = ${(rate * 100).toFixed(0)}%`);
  assert.ok(rate >= 0.85, `recall@5 ${(rate * 100).toFixed(0)}% < 85%`);
});

test('不同 chat 的卡不会互相检索', () => {
  const a = buildCard();
  const b = personCard.newCard({ chatId: 'wechat:g:g1', uid: 'u1', name: '小海', now: NOW });
  personCard.addEvent(b, {
    date: dateOf(1), title: '另一群的秘密', summary: '在别的群里说了一个秘密', participants: ['u1'],
    source: { chatId: 'wechat:g:g1', messageIds: ['m'] },
  }, { chatId: 'wechat:g:g1', now: NOW });
  const picks = retrieval.selectEvents(a, { query: '秘密', now: NOW, topK: 5, uid: 'u1' });
  assert.ok(!picks.some((e) => e.title === '另一群的秘密'));
});

test('端到端：两个 chat 的 buildContext 互相看不到对方事件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-eval-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null });
  const chatA = store.chatStore.ensureChat('wechat:u:a', { platform: 'wechat', chatType: 'private' });
  const cardA = store.chatStore.ensurePerson(chatA, 'u1', '小海');
  personCard.addEvent(cardA, {
    date: '2026-10-30', title: '私聊秘密', summary: '私聊里说了一个秘密', participants: ['u1'],
    source: { chatId: chatA.chatId, messageIds: ['m'] },
  }, { chatId: chatA.chatId, now: NOW });
  store.chatStore.saveCard(chatA, cardA);

  const chatB = store.chatStore.ensureChat('wechat:g:g1', { platform: 'wechat', chatType: 'group' });
  store.chatStore.ensurePerson(chatB, 'u1', '小海');

  const ctxA = store.buildContext({ key: 'wechat:u:a', uid: 'u1', name: '小海', query: '秘密', now: NOW });
  const ctxB = store.buildContext({ key: 'wechat:g:g1', uid: 'u1', name: '小海', query: '秘密', now: NOW });
  assert.ok(ctxA.block.includes('私聊秘密'));
  assert.ok(!ctxB.block.includes('私聊秘密'));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});
