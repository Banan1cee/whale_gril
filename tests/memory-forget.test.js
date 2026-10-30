'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const forget = require('../src/memory/forget');
const { Store } = require('../src/memory/store');

const DAY = 86400000;
const NOW = 1_700_000_000_000;

function note(over = {}) {
  return { text: 'x', kind: 'fact', createdAt: NOW - 10 * DAY, lastMentionedAt: 0, mentions: 0, importance: 1, ...over };
}

function tempStore(limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-forget-'));
  const store = new Store({ file: path.join(dir, 'memory.json'), limits });
  return { store, dir };
}

test('decayScore：同年龄下，承诺 > 偏好 > 普通事实', () => {
  const a = forget.decayScore(note({ kind: 'promise' }), NOW);
  const b = forget.decayScore(note({ kind: 'preference' }), NOW);
  const c = forget.decayScore(note({ kind: 'fact' }), NOW);
  assert.ok(a > b && b > c, `${a} > ${b} > ${c}`);
});

test('decayScore：越老越低，最近被想起会回升', () => {
  const fresh = forget.decayScore(note({ createdAt: NOW - 1 * DAY }), NOW);
  const old = forget.decayScore(note({ createdAt: NOW - 200 * DAY }), NOW);
  assert.ok(fresh > old, '新记忆分更高');
  const oldButUsed = forget.decayScore(note({ createdAt: NOW - 200 * DAY, lastMentionedAt: NOW - 1 * DAY }), NOW);
  assert.ok(oldButUsed > old, '刚被用到过，应该回升');
});

test('pickEvictions：超限时扔分低的，承诺和雷区最后才动', () => {
  const notes = [
    note({ kind: 'promise', createdAt: NOW - 300 * DAY, importance: 1 }), // 最老，但受保护
    note({ kind: 'fact', createdAt: NOW - 300 * DAY }),                   // 该走
    note({ kind: 'fact', createdAt: NOW - 1 * DAY }),                     // 该留
  ];
  const idx = forget.pickEvictions(notes, 2, NOW);
  assert.deepEqual(idx, [1], '要走的是分数最低的普通事实，不是受保护的承诺');
});

test('shouldArchive：老 + 没被想起 + 不重要的才沉底；承诺永不沉底', () => {
  assert.equal(forget.shouldArchive(note({ createdAt: NOW - 90 * DAY }), NOW), true);
  assert.equal(forget.shouldArchive(note({ kind: 'promise', createdAt: NOW - 900 * DAY }), NOW), false);
  assert.equal(forget.shouldArchive(note({ createdAt: NOW - 90 * DAY, lastMentionedAt: NOW - 2 * DAY }), NOW), false, '刚提过不能沉');
  assert.equal(forget.shouldArchive(note({ createdAt: NOW - 3 * DAY }), NOW), false, '太新不能沉');
});

test('trimArchive：归档也有上限，超了按时间扔最老的', () => {
  const entries = Array.from({ length: 5 }, (_, i) => ({ archivedAt: i, text: 't' + i }));
  const { kept, dropped } = forget.trimArchive(entries, 3);
  assert.equal(kept.length, 3);
  assert.equal(dropped.length, 2);
  assert.deepEqual(dropped.map((x) => x.text), ['t0', 't1']);
});

test('store.sweep：老记忆沉到归档文件，主存里不再有', () => {
  const { store } = tempStore({ maxNotesPerUser: 6 });
  const p = store.profile('k', 'u1');
  p.notes = [
    { text: '很久以前说过怕黑', kind: 'fact', createdAt: NOW - 200 * DAY, lastMentionedAt: 0, importance: 1 },
    { text: '答应过周末去医院', kind: 'promise', createdAt: NOW - 200 * DAY, lastMentionedAt: 0, importance: 1 },
  ];
  const out = store.sweep(NOW);
  assert.equal(out.archived, 1, '只沉普通事实，承诺不动');
  const notes = store.ensureSession('k').profiles.u1.notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, '答应过周末去医院');
  assert.equal(store.archiveCount(), 1);
  const archived = store.archive[store.archive.length - 1];
  assert.equal(archived.note.text, '很久以前说过怕黑');
  assert.equal(archived.reason, 'archive');
});

test('store.addNote：超上限按分数淘汰，被淘汰的进归档', () => {
  const { store } = tempStore({ maxNotesPerUser: 2 });
  store.profile('k', 'u1');
  const now = Date.now();
  store.addNote('k', 'u1', '很早以前的小事', { kind: 'fact' });
  const p = store.ensureSession('k').profiles.u1;
  p.notes[0].createdAt = now - 500 * DAY;      // 把它变老
  store.addNote('k', 'u1', '答应过陪你看电影', { kind: 'promise' });
  store.addNote('k', 'u1', '今天新知道的事', { kind: 'fact' });
  const notes = store.ensureSession('k').profiles.u1.notes;
  assert.equal(notes.length, 2);
  assert.ok(notes.some((n) => n.text === '答应过陪你看电影'), '承诺不能被淘汰');
  assert.ok(notes.some((n) => n.text === '今天新知道的事'));
  assert.equal(store.archiveCount(), 1);
  assert.equal(store.archive[store.archive.length - 1].note.text, '很早以前的小事');
});

test('消息：只删已经被摘要覆盖的那部分', () => {
  const { store } = tempStore({ maxMessages: 4 });
  const p = store.ensureSession('k');
  for (let i = 0; i < 6; i += 1) {
    store.appendMessage('k', { role: 'user', name: '小海', uid: 'u1', text: 'm' + i, ts: Date.now() + i });
  }
  // 没有摘要覆盖 → 一条都不该删（硬上限之前）
  assert.equal(store.ensureSession('k').messages.length, 6);
  store.setSummary('k', '摘要', { upto: 2 });
  store.appendMessage('k', { role: 'user', name: '小海', uid: 'u1', text: 'm6', ts: Date.now() + 10 });
  const sess = store.ensureSession('k');
  assert.equal(sess.messages.length, 5, '7 条里只有 2 条被摘要覆盖，所以只删得动 2 条');
  assert.equal(sess.messages[0].text, 'm2');
  assert.equal(sess.summaryUpto, 0);
});
