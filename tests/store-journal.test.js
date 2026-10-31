'use strict';

/**
 * 追加写 / 原子替换 / 覆盖水位：以前是 store.json + journal，现在是 per-chat messages.jsonl。
 * 回归点：
 *  - 崩溃留下的半截行不能把整个聊天读废
 *  - 只有被 summary 覆盖的旧原文才能删
 *  - 恢复/重载后不会把旧数据盖回去
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const { chatHash } = require('../src/memory/hash');
const { DAY_MS } = require('../src/memory/constants');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-append-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'store.json');
  return { store: new Store({ file, logger: null }), file, dataDir, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

test('原文只追加：不写 store.json 快照', () => {
  const { store, file, dataDir, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: '只在 jsonl 里' });
  store.flush();
  const target = path.join(dataDir, 'memory', 'chats', chatHash('a'), 'messages.jsonl');
  assert.ok(fs.existsSync(target));
  assert.match(fs.readFileSync(target, 'utf8'), /只在 jsonl 里/);
  assert.ok(!fs.existsSync(file), 'v2 不再写 data/store.json');
  store.close();
  cleanup(dir);
});

test('半截行不影响整个聊天', () => {
  const { store, dataDir, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: '完整的一条' });
  store.close();
  const target = path.join(dataDir, 'memory', 'chats', chatHash('a'), 'messages.jsonl');
  fs.appendFileSync(target, '{"seq":99,"role":"user"', 'utf8');

  const store2 = new Store({ file: path.join(dataDir, 'store.json'), logger: null });
  assert.equal(store2.messages('a', 5)[0].text, '完整的一条');
  store2.close();
  cleanup(dir);
});

test('未覆盖的原文永不删除；覆盖且超 90 天的才删', () => {
  const { store, dataDir, dir } = tempStore();
  const key = 'a';
  const old = Date.now() - 100 * DAY_MS;
  for (let i = 0; i < 6; i += 1) {
    store.appendMessage(key, { role: 'user', name: '甲', text: 'm' + i, ts: old + i });
  }
  // 没有 summary 覆盖 → 一条都不能删
  store.chatStore.pruneRaw(store.chatStore.chats.get(key), Date.now());
  assert.equal(store.messages(key, 10).length, 6);

  // 覆盖前 3 条 → 只删这 3 条
  store.setSummary(key, '前三条的摘要', { upto: 3 });
  store.chatStore.pruneRaw(store.chatStore.chats.get(key), Date.now());
  const left = store.messages(key, 10);
  assert.deepEqual(left.map((m) => m.text), ['m3', 'm4', 'm5']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'memory', 'chats', chatHash(key), 'summary.json'), 'utf8')).coveredThroughSeq, 3);
  store.close();
  cleanup(dir);
});

test('reloadFromDisk：外部删掉 chat 目录后内存也跟着清空', () => {
  const { store, dataDir, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: 'hi' });
  store.appendMessage('b', { role: 'user', name: '乙', text: 'yo' });
  store.close();
  fs.rmSync(path.join(dataDir, 'memory', 'chats', chatHash('a')), { recursive: true, force: true });

  const store2 = new Store({ file: path.join(dataDir, 'store.json'), logger: null });
  assert.equal(store2.messages('a', 5).length, 0);
  assert.equal(store2.messages('b', 5).length, 1);
  store2.close();
  cleanup(dir);
});

test('卡片先写 tmp 再 rename：不会留下半个 JSON', () => {
  const { store, dataDir, dir } = tempStore();
  store.addNote('a', 'u1', '喜欢猫');
  const peopleDir = path.join(dataDir, 'memory', 'chats', chatHash('a'), 'people');
  const files = fs.readdirSync(peopleDir);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
  assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '不能留下临时文件');
  for (const f of files) JSON.parse(fs.readFileSync(path.join(peopleDir, f), 'utf8'));
  store.close();
  cleanup(dir);
});
