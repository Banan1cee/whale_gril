'use strict';

const test = require('node:test');
const assert = require('node:assert');

const recall = require('../src/memory/recall');
const { MemoryStore } = (() => {
  try {
    return require('../src/memory/store');
  } catch {
    return {};
  }
})();

const DAY = 86400000;

test('noteText：老格式字符串和新格式对象都能取到文本', () => {
  assert.equal(recall.noteText('你怕黑'), '你怕黑');
  assert.equal(recall.noteText({ text: '你爱吃辣' }), '你爱吃辣');
  assert.equal(recall.noteText(null), '');
  assert.equal(recall.noteText({}), '');
});

test('normalizeNote：字符串补成结构，字段越界会被夹住', () => {
  const now = 1_700_000_000_000;
  const n = recall.normalizeNote('你怕黑', now);
  assert.equal(n.text, '你怕黑');
  assert.equal(n.kind, 'fact');
  assert.equal(n.createdAt, now);
  assert.equal(n.importance, 1);

  const weird = recall.normalizeNote({ text: 'x', importance: 99, kind: '不存在的类别' }, now);
  assert.equal(weird.importance, 3);
  assert.equal(weird.kind, 'fact');
  assert.equal(recall.normalizeNote('  ', now), null);
});

test('tokens：中文切 2-gram，英文按词', () => {
  const t = recall.tokens('我明天要去体检 hello world');
  assert.ok(t.includes('明天'));
  assert.ok(t.includes('体检'));
  assert.ok(t.includes('hello'));
  assert.ok(t.includes('world'));
});

test('pickNotes：跟当前话题相关的排前面', () => {
  const now = Date.now();
  const notes = [
    { text: '你爱吃辣', createdAt: now - 30 * DAY },
    { text: '你明天要去体检', createdAt: now - 3 * DAY },
    { text: '你养了只猫叫团子', createdAt: now - 10 * DAY },
  ];
  const picked = recall.pickNotes(notes, '明天体检几点啊', { now, limit: 2 });
  assert.equal(picked.length, 2);
  assert.ok(picked[0].text.includes('体检'), '相关的那条必须排第一，实际：' + picked[0].text);
});

test('pickNotes：刚提过的不要马上复读', () => {
  const now = Date.now();
  const notes = [
    { text: '你明天要去体检', createdAt: now - 3 * DAY, lastMentionedAt: now - 5 * 60000 },
    { text: '你养了只猫叫团子', createdAt: now - 10 * DAY },
  ];
  const picked = recall.pickNotes(notes, '明天体检几点啊', { now, limit: 2 });
  assert.equal(picked.length, 1, '半小时内提过的应当被跳过');
  assert.ok(picked[0].text.includes('猫'));
});

test('pickNotes：承诺类记忆权重更高', () => {
  const now = Date.now();
  const notes = [
    { text: '你养了只猫叫团子', createdAt: now - 20 * DAY, kind: 'fact' },
    { text: '答应过周末陪你去医院', createdAt: now - 20 * DAY, kind: 'promise' },
  ];
  const picked = recall.pickNotes(notes, '这周有空吗', { now, limit: 1 });
  assert.equal(picked[0].text, '答应过周末陪你去医院');
});

test('pickNotes：老字符串也能参与排序，不会崩', () => {
  const now = Date.now();
  const picked = recall.pickNotes(['你怕黑', { text: '你爱吃辣' }], '我怕黑', { now, limit: 2 });
  assert.equal(picked.length, 2);
  assert.ok(picked[0].text.includes('怕黑'));
});

test('pickNotes：空输入/非数组都安全', () => {
  assert.deepEqual(recall.pickNotes(null, '在吗'), []);
  assert.deepEqual(recall.pickNotes([], '在吗'), []);
  assert.deepEqual(recall.pickNotes([{ text: '' }], '在吗'), []);
});

test('similarity / findSimilar：几乎一样才算同一条，差一个字的事实不能混', () => {
  assert.ok(recall.similarity('他喜欢吃辣的', '他喜欢吃辣') > 0.85);
  assert.ok(recall.similarity('他喜欢吃辣', '他喜欢吃甜') < 0.85, '辣和甜是两件事');
  assert.equal(recall.similarity('', 'x'), 0);

  const notes = [{ text: '他喜欢吃辣' }, { text: '他养了只猫' }];
  assert.equal(recall.findSimilar(notes, '他喜欢吃辣的'), 0);
  assert.equal(recall.findSimilar(notes, '他明天要去体检'), -1);
});
