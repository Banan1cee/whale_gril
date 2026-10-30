'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const digest = require('../src/memory/digest');
const { Store } = require('../src/memory/store');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-digest-'));
  const store = new Store({ file: path.join(dir, 'memory.json'), limits: {} });
  return { store, dir };
}

function fill(store, key, uid, n) {
  for (let i = 0; i < n; i += 1) {
    store.appendMessage(key, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      name: i % 2 === 0 ? '小海' : '鲸鲸',
      uid,
      text: i % 2 === 0 ? `第${i}句：我明天要去体检` : `第${i}句：记得啊`,
      ts: Date.now() + i,
    });
  }
}

const fakeLlm = (reply) => ({
  isMock: false,
  complete: async () => reply,
});

test('shouldDigest：攒够才整理，别每句都调模型', () => {
  const { store } = tempStore();
  fill(store, 'k', 'u1', 5);
  assert.equal(digest.shouldDigest(store.ensureSession('k'), 12), false);
  fill(store, 'k', 'u1', 10);
  assert.equal(digest.shouldDigest(store.ensureSession('k'), 12), true);
  // 整理过之后从新的位置重新计数
  store.setSummary('k', '他们最近在聊体检的事', { upto: 15 });
  assert.equal(digest.shouldDigest(store.ensureSession('k'), 12), false);
});

test('parseDigest：能从带前言 / 代码块的输出里抠出 JSON', () => {
  const a = digest.parseDigest('```json\n{"summary":"他在准备体检","facts":[{"text":"明天体检","kind":"promise","importance":2}]}\n```');
  assert.equal(a.summary, '他在准备体检');
  assert.equal(a.facts.length, 1);
  assert.equal(a.facts[0].kind, 'promise');
  assert.equal(a.facts[0].importance, 2);

  const b = digest.parseDigest('好的，结果如下：{"summary":"s","facts":[]}');
  assert.equal(b.summary, 's');
  assert.deepEqual(b.facts, []);

  assert.equal(digest.parseDigest('没有 JSON'), null);
  assert.equal(digest.parseDigest('{"facts":[]}'), null, '摘要和事实都空就当失败');
});

test('parseDigest：类别越界回退 fact，重要度夹到 1~3，最多 3 条', () => {
  const r = digest.parseDigest(JSON.stringify({
    summary: 'x',
    facts: [
      { text: 'a', kind: '乱写', importance: 99 },
      { text: 'b', kind: 'taboo', importance: -5 },
      'c',
      { text: 'd' },
    ],
  }));
  assert.equal(r.facts.length, 3);
  assert.equal(r.facts[0].kind, 'fact');
  assert.equal(r.facts[0].importance, 3);
  assert.equal(r.facts[1].kind, 'taboo');
  assert.equal(r.facts[1].importance, 1);
  assert.equal(r.facts[2].text, 'c');
});

test('digest：会把摘要写进会话，并按 uid 抽事实进 notes', async () => {
  const { store } = tempStore();
  fill(store, 'k', 'u1', 14);
  const out = await digest.digest(store, fakeLlm('{"summary":"他最近在忙体检","facts":[{"text":"明天要去体检","kind":"recent","importance":2}]}'), 'k', { uid: 'u1', every: 12 });
  assert.ok(out, '应该真的整理了一次');
  assert.equal(store.ensureSession('k').summary, '他最近在忙体检');
  const notes = store.ensureSession('k').profiles.u1.notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, '明天要去体检');
  assert.equal(notes[0].kind, 'recent');
});

test('digest：模型给不出 JSON 时不写任何东西，也不抛', async () => {
  const { store } = tempStore();
  fill(store, 'k', 'u1', 14);
  const out = await digest.digest(store, fakeLlm('我不会输出 json'), 'k', { uid: 'u1', every: 12 });
  assert.equal(out, null);
  assert.equal(store.ensureSession('k').summary, undefined);
  const prof = store.ensureSession('k').profiles.u1;
  assert.equal(prof ? prof.notes.length : 0, 0);
});

test('digest：演示模式不发请求', async () => {
  const { store } = tempStore();
  fill(store, 'k', 'u1', 14);
  let called = false;
  const out = await digest.digest(store, { isMock: true, complete: async () => { called = true; return ''; } }, 'k', { uid: 'u1' });
  assert.equal(out, null);
  assert.equal(called, false);
});
