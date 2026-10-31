'use strict';

/**
 * 事件检索：中文 bigram + BM25，participants 过滤，minScore，MMR，topK。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const retrieval = require('../src/memory/retrieval');
const personCard = require('../src/memory/personCard');

const DAY = 86400000;
const NOW = 1_700_000_000_000;

function cardWith(events, uid = 'u1') {
  const card = personCard.newCard({ chatId: 'wechat:u:a', uid, name: '小海', now: NOW });
  for (const ev of events) {
    personCard.addEvent(card, {
      date: ev.date || '2026-10-28',
      title: ev.title,
      summary: ev.summary,
      keywords: ev.keywords || [],
      participants: ev.participants || [uid],
      importance: ev.importance || 0.6,
      confidence: ev.confidence || 0.8,
      source: { chatId: 'wechat:u:a', messageIds: ev.ids || ['msg_1'] },
    }, { chatId: 'wechat:u:a', now: NOW });
  }
  return card;
}

test('tokens：中文 bigram + 英文词', () => {
  const t = retrieval.tokens('明天去医院 hello world');
  assert.ok(t.includes('医院'));
  assert.ok(t.includes('hello'));
  assert.ok(t.includes('world'));
});

test('相关事件排前面，最多 topK 条', () => {
  const card = cardWith([
    { title: '体检', date: '2026-10-27', summary: '明天去医院体检，约了早上八点', keywords: ['体检', '医院'], importance: 0.8 },
    { title: '吃火锅', date: '2026-09-01', summary: '周末一起去吃火锅', keywords: ['火锅'], importance: 0.5 },
    { title: '养猫', date: '2026-08-01', summary: '养了一只猫叫团子', keywords: ['猫'], importance: 0.5 },
  ]);
  const picked = retrieval.selectEvents(card, { query: '医院体检几点', now: NOW, topK: 2 });
  assert.ok(picked.length <= 2);
  assert.equal(picked[0].title, '体检');
});

test('participants 过滤：不是这个人参与的事件不注入', () => {
  const card = cardWith([
    { title: '别人的事', summary: '另一个人去体检', participants: ['u2'], keywords: ['体检'] },
    { title: '自己的事', summary: '自己去体检', participants: ['u1'], keywords: ['体检'] },
  ]);
  const picked = retrieval.selectEvents(card, { query: '体检', now: NOW, uid: 'u1' });
  assert.ok(picked.every((e) => e.participants.includes('u1')));
  assert.equal(picked.length, 1);
});

test('minScore：完全不相关且很旧的事件被过滤', () => {
  const old = cardWith([{ title: '很久以前', date: '2020-01-01', summary: '完全无关的旧事', keywords: ['甲乙丙'], importance: 0.1, confidence: 0.2 }]);
  const picked = retrieval.selectEvents(old, { query: '今天天气怎么样', now: NOW });
  assert.equal(picked.length, 0);
});

test('MMR 去重：高度重复的事件不会占满 topK', () => {
  const card = cardWith([
    { title: '体检A', date: '2026-10-27', summary: '明天去医院体检', keywords: ['体检'] },
    { title: '体检B', date: '2026-10-27', summary: '明天去医院体检', keywords: ['体检'] },
    { title: '体检C', date: '2026-10-27', summary: '明天去医院体检', keywords: ['体检'] },
    { title: '猫', date: '2026-10-26', summary: '猫今天不吃饭', keywords: ['猫'] },
  ]);
  const picked = retrieval.selectEvents(card, { query: '医院体检', now: NOW, topK: 3 });
  assert.ok(picked.length >= 1);
  assert.ok(picked.filter((e) => e.title.startsWith('体检')).length < 3, '不该三条一模一样都进来');
});

test('topicOverlap：换话题时重合度低', () => {
  assert.ok(retrieval.topicOverlap('今天股票又跌了', ['今晚吃什么', '火锅还是烧烤', '随便吧']) < 0.15);
  assert.ok(retrieval.topicOverlap('火锅还是烧烤', ['今晚吃什么', '火锅还是烧烤', '随便吧']) > 0.15);
});

test('空卡 / 空查询都安全', () => {
  const card = personCard.newCard({ chatId: 'c', uid: 'u', now: NOW });
  assert.deepEqual(retrieval.selectEvents(card, { query: '在吗', now: NOW }), []);
  const one = cardWith([{ title: 'x', summary: 'y' }]);
  assert.ok(Array.isArray(retrieval.selectEvents(one, { query: '', now: NOW })));
});

test('recencyScore：越新越高', () => {
  const now = Date.now();
  const recent = retrieval.recencyScore(new Date(now - DAY).toISOString().slice(0, 10), now, 14);
  const old = retrieval.recencyScore(new Date(now - 400 * DAY).toISOString().slice(0, 10), now, 14);
  assert.ok(recent > old);
  assert.ok(recent <= 1 && old >= 0);
});

test('事件数量到 200 后按重要度/新鲜度淘汰', () => {
  const card = personCard.newCard({ chatId: 'c', uid: 'u', now: NOW });
  for (let i = 0; i < 220; i += 1) {
    personCard.addEvent(card, {
      date: '2026-10-01',
      title: '事件' + i,
      summary: '第 ' + i + ' 件事',
      participants: ['u'],
      importance: i === 0 ? 0.9 : 0.1,
      confidence: 0.6,
      source: { chatId: 'c', messageIds: ['m' + i] },
    }, { chatId: 'c', now: NOW + i });
  }
  const events = personCard.activeEvents(card);
  assert.ok(events.length <= 200);
  assert.ok(events.some((e) => e.title === '事件0'), '高重要度的不能先被淘汰');
  assert.ok(events.some((e) => e.title === '事件219'), '最新的要留下');
});
