'use strict';

const test = require('node:test');
const assert = require('node:assert');

const semantic = require('../src/memory/semantic');

const notes = [
  { text: '小海明天要去体检', kind: 'recent' },
  { text: '小海养了只猫叫团子', kind: 'fact' },
  { text: '小海爱吃火锅', kind: 'preference' },
  { text: '答应过陪小海去医院', kind: 'promise' },
];

test('parseKeep：越界/重复/乱写都丢掉，最多到上限', () => {
  assert.deepEqual(semantic.parseKeep('{"keep":[0,1]}', 4, 3), [0, 1]);
  assert.deepEqual(semantic.parseKeep('```json\n{"keep":[3,3,9,-1,1]}\n```', 4, 3), [3, 1]);
  assert.deepEqual(semantic.parseKeep('{"keep":[0,1,2,3]}', 4, 2), [0, 1]);
  assert.deepEqual(semantic.parseKeep('{"keep":[]}', 4, 3), []);
  assert.equal(semantic.parseKeep('我不会', 4, 3), null);
  assert.equal(semantic.parseKeep('{"keep":"0"}', 4, 3), null);
});

test('rerank：模型挑哪几条就返回哪几个下标', async () => {
  semantic.clearCache();
  const llm = { isMock: false, calls: 0, async complete() { this.calls += 1; return '{"keep":[0,3]}'; } };
  const keep = await semantic.rerank(llm, '医院挂号了吗', notes, { limit: 3 });
  assert.deepEqual(keep, [0, 3]);
  assert.equal(llm.calls, 1);
});

test('rerank：同一句话第二次走缓存，不再调模型', async () => {
  semantic.clearCache();
  const llm = { isMock: false, calls: 0, async complete() { this.calls += 1; return '{"keep":[1]}'; } };
  await semantic.rerank(llm, '团子今天乖吗', notes, { limit: 3 });
  await semantic.rerank(llm, '团子今天乖吗', notes, { limit: 3 });
  assert.equal(llm.calls, 1, '第二次应该命中缓存');
});

test('rerank：模型乱答/抛错/演示模式都返回 null，让调用方退回字面排序', async () => {
  semantic.clearCache();
  assert.equal(await semantic.rerank({ isMock: false, async complete() { return '随便说说'; } }, 'x', notes), null);
  assert.equal(await semantic.rerank({ isMock: false, async complete() { throw new Error('boom'); } }, 'y', notes), null);
  assert.equal(await semantic.rerank({ isMock: true, async complete() { return '{"keep":[0]}'; } }, 'z', notes), null);
  assert.equal(await semantic.rerank(null, 'z', notes), null);
});

test('rerank：候选只有一条时不值得再问模型', async () => {
  semantic.clearCache();
  let called = false;
  const llm = { isMock: false, async complete() { called = true; return '{"keep":[0]}'; } };
  assert.equal(await semantic.rerank(llm, 'x', [notes[0]]), null);
  assert.equal(called, false);
});

test('buildPrompt：把候选编号列出来，且带类别提示', () => {
  const p = semantic.buildPrompt('在吗', notes, 3);
  assert.match(p.turns[0].content, /0\. 小海明天要去体检（recent）/);
  assert.match(p.system, /最多挑 3 条/);
});

test('字面找不到、模型能救回来：记忆写「体检」，对方问「医院」', async () => {
  const recall = require('../src/memory/recall');
  semantic.clearCache();
  const now = Date.now();
  const notes = [
    { text: '小海明天要去体检', kind: 'recent', createdAt: now - 2 * 864e5, importance: 2 },
    { text: '小海养了只猫叫团子', kind: 'fact', createdAt: now - 10 * 864e5, importance: 1 },
    { text: '小海爱吃火锅', kind: 'preference', createdAt: now - 20 * 864e5, importance: 1 },
    { text: '答应过陪小海去医院', kind: 'promise', createdAt: now - 30 * 864e5, importance: 2 },
  ];
  // 纯字面：问「医院」不会想到「体检」
  const lexical = recall.pickNotes(notes, '医院那边几点集合', { now, limit: 4 }).map((n) => n.text);
  assert.notEqual(lexical[0], '小海明天要去体检', '字面排序里「体检」排不到前面，这正是要模型的原因');

  // 模型只认 0 号（体检那条）与 3 号（陪去医院）
  const llm = { isMock: false, async complete() { return '{"keep":[0,3]}'; } };
  const all = notes.map((n) => recall.normalizeNote(n, now));
  const keep = await semantic.rerank(llm, '医院那边几点集合', all, { limit: 3 });
  const picked = keep.map((i) => all[i].text);
  assert.deepEqual(picked, ['小海明天要去体检', '答应过陪小海去医院']);
});
