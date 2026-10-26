'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory');

function tempStore(limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-store-'));
  const file = path.join(dir, 'store.json');
  const store = new Store({ file, limits });
  return { store, file, dir };
}

test('写入/读取消息并保持顺序', () => {
  const { store, dir } = tempStore();
  store.ensureSession('k', { platform: 'web', chatId: 'c', chatType: 'private' });
  store.appendMessage('k', { role: 'user', name: '小海', text: '在吗' });
  store.appendMessage('k', { role: 'assistant', name: '鲸鲸', text: '在的~' });
  const msgs = store.messages('k', 10);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].text, '在吗');
  assert.equal(msgs[1].role, 'assistant');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('消息数量有上限，超出后丢弃最旧的', () => {
  const { store, dir } = tempStore({ maxMessages: 4 });
  for (let i = 0; i < 10; i++) {
    store.appendMessage('k', { role: 'user', name: 'u', text: 'm' + i });
  }
  const msgs = store.messages('k', 100);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[3].text, 'm9');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('去重 id 记住最近的消息', () => {
  const { store, dir } = tempStore();
  store.markSeen('k', 'm1');
  assert.equal(store.isDuplicate('k', 'm1'), true);
  assert.equal(store.isDuplicate('k', 'm2'), false);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('用户画像、昵称和笔记', () => {
  const { store, dir } = tempStore({ maxNotesPerUser: 3 });
  store.profile('k', 'u1', '小明');
  store.addNote('k', 'u1', '喜欢猫');
  store.addNote('k', 'u1', '喜欢猫'); // 重复不叠加
  store.addNote('k', 'u1', '怕黑');
  store.addNote('k', 'u1', '爱吃辣');
  store.addNote('k', 'u1', '住海边');
  const listed = store.listNotes('k');
  assert.equal(listed.length, 1);
  assert.ok(listed[0].notes.length <= 3);
  assert.ok(listed[0].notes.includes('怕黑'));

  store.profile('k', 'u1', '小明明');
  assert.equal(store.profile('k', 'u1').name, '小明明');

  const removed = store.removeNote('k', 'u1', '怕黑');
  assert.equal(removed.removed, 1);
  assert.ok(!store.listNotes('k')[0].notes.includes('怕黑'));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('记忆落盘后能重新读回来', () => {
  const { store, file, dir } = tempStore();
  store.appendMessage('k', { role: 'user', name: '阿螈', text: '记住我' });
  store.addNote('k', 'u1', '是只海马');
  store.flush();
  store.close();

  const store2 = new Store({ file });
  const msgs = store2.messages('k', 10);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].text, '记住我');
  assert.equal(store2.listNotes('k')[0].notes[0], '是只海马');
  store2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('重置会话只清空指定聊天', () => {
  const { store, dir } = tempStore();
  store.appendMessage('a', { role: 'user', name: 'u', text: 'hi' });
  store.appendMessage('b', { role: 'user', name: 'u', text: 'hi' });
  store.resetSession('a');
  assert.equal(store.messages('a', 10).length, 0);
  assert.equal(store.messages('b', 10).length, 1);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('会话数量超限时会淘汰最久未活跃的', () => {
  const { store, dir } = tempStore({ maxSessions: 12 });
  for (let i = 0; i < 40; i++) {
    store.ensureSession('s' + i);
    store.appendMessage('s' + i, { role: 'user', name: 'u', text: 'x' });
  }
  const summary = store.summary();
  assert.ok(summary.sessions <= 40);
  assert.ok(store.sessions.size <= 12);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
