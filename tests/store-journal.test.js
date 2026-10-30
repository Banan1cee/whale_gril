'use strict';

/**
 * 记忆落盘改成「快照 + 增量日志」之后的行为。
 *
 * 回归的是：以前每次落盘都要把所有会话重新序列化一遍，会话一多写一次就是 O(全部数据)。
 * 现在只追加动过的会话，store.json 仍是快照，读的时候自动合并。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store, readStoreFile } = require('../src/memory/store');
const backup = require('../src/memory/backup');

function tempStore(limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-journal-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'store.json');
  return { store: new Store({ file, limits }), file, dir, journal: file + '.journal' };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

test('增量落盘只写动过的会话，重新打开能读回来', () => {
  const { store, file, journal, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: '只在日志里' });
  store.flush();

  assert.ok(fs.existsSync(journal), '应该写了增量日志');
  const snapshot = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { sessions: {} };
  assert.equal(Object.keys(snapshot.sessions || {}).length, 0, 'store.json 还是旧快照');

  const store2 = new Store({ file });
  assert.equal(store2.messages('a', 5)[0].text, '只在日志里', '读的时候要合并日志');
  store2.close();
  cleanup(dir);
});

test('close() 压回快照，日志清空', () => {
  const { store, file, journal, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: 'hi' });
  store.flush();
  store.close();

  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(snapshot.sessions.a.messages.length, 1);
  assert.equal(fs.readFileSync(journal, 'utf8'), '', '退出后日志要清空');
  cleanup(dir);
});

test('日志里的半截行不会让记忆整个读不出来', () => {
  const { store, file, journal, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: '完整的一条' });
  store.flush();
  fs.appendFileSync(journal, '{"sessions":{"b":', 'utf8');   // 模拟进程被杀

  const store2 = new Store({ file });
  assert.equal(store2.messages('a', 5)[0].text, '完整的一条');
  store2.close();
  cleanup(dir);
});

test('日志太大时自动压快照，不会无限增长', () => {
  const { store, file, journal, dir } = tempStore({ maxMessages: 800 });
  const big = 'x'.repeat(400);
  for (let s = 0; s < 6; s += 1) {
    for (let i = 0; i < 400; i += 1) {
      store.appendMessage('s' + s, { role: 'user', name: 'u', text: big + i });
    }
    store.flush();
  }
  const size = fs.existsSync(journal) ? fs.statSync(journal).size : 0;
  assert.ok(size < 512 * 1024 + 20000, '压过之后日志应该很小，实际 ' + size);
  const store2 = new Store({ file });
  assert.equal(store2.sessions.size, 6);
  store2.close();
  cleanup(dir);
});

test('恢复备份后清掉旧日志，不会把刚恢复的记忆盖回去', () => {
  const { store, file, journal, dir } = tempStore();
  store.appendMessage('old', { role: 'user', name: '甲', text: '旧的' });
  store.flush();
  assert.ok(fs.statSync(journal).size > 0);

  // 模拟「外部把 store.json 换成了备份内容」
  fs.writeFileSync(file, JSON.stringify({
    version: 1, stats: { messages: 1, replies: 0 }, digest: [],
    sessions: { restored: { key: 'restored', platform: 'web', chatId: 'r', chatType: 'private', messages: [{ role: 'user', text: '恢复的', name: '甲', ts: Date.now() }], profiles: {}, state: {}, seenIds: [] } },
  }));

  store.reloadFromDisk();
  assert.equal(store.messages('restored', 5)[0].text, '恢复的');
  assert.equal(store.messages('old', 5).length, 0, '旧日志不能被重放回来');
  store.close();
  cleanup(dir);
});

test('备份读到的是「快照 + 日志」合并后的最新记忆', () => {
  const { store, file, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: '甲', text: '还在日志里' });
  store.flush();                       // 只进日志，不进 store.json
  const bundle = backup.collect(dir);
  assert.equal(bundle.files.store.sessions.a.messages[0].text, '还在日志里');
  store.close();
  cleanup(dir);
});

test('readStoreFile 对不存在的文件返回空结构', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-journal-empty-'));
  const raw = readStoreFile(path.join(dir, 'nope.json'));
  assert.deepEqual(raw.sessions, {});
  assert.deepEqual(raw.digest, []);
  cleanup(dir);
});
