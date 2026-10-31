'use strict';

/**
 * v2 物理存储：一个 chat 一个目录、原文追加、checkpoint、重启恢复、删除隔离。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const { chatHash, personHash } = require('../src/memory/hash');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-v2-'));
  const file = path.join(dir, 'data', 'store.json');
  const store = new Store({ file, logger: null });
  return { store, dir, file, memoryDir: path.join(dir, 'data', 'memory') };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
}

test('布局：data/memory/chats/<chatHash>/，没有全局用户目录', () => {
  const { store, memoryDir, dir } = tempStore();
  store.ensureSession('wechat:u:wxid_a', { platform: 'wechat', chatType: 'private' });
  store.appendMessage('wechat:u:wxid_a', { role: 'user', name: '小海', uid: 'u-a', text: '在吗' });
  store.flush();

  const hash = chatHash('wechat:u:wxid_a');
  const chatDir = path.join(memoryDir, 'chats', hash);
  assert.ok(fs.existsSync(path.join(chatDir, 'meta.json')), '要有 meta.json');
  assert.ok(fs.existsSync(path.join(chatDir, 'messages.jsonl')), '要有 messages.jsonl');
  assert.ok(fs.existsSync(path.join(chatDir, 'summary.json')), '要有 summary.json');
  const meta = JSON.parse(fs.readFileSync(path.join(chatDir, 'meta.json'), 'utf8'));
  assert.equal(meta.chatId, 'wechat:u:wxid_a', 'meta 保留原始 chatId');
  assert.ok(fs.existsSync(path.join(memoryDir, 'manifest.json')));
  assert.ok(!fs.existsSync(path.join(memoryDir, 'global')), '不能有全局记忆目录');
  assert.equal(personHash('u-a').length, 16);
  store.close();
  cleanup(dir);
});

test('用户消息先落盘：append 后立刻能在 jsonl 里读到', () => {
  const { store, memoryDir, dir } = tempStore();
  store.appendMessage('wechat:u:wxid_a', { role: 'user', name: '小海', uid: 'u-a', text: '先落盘再回复' });
  const file = path.join(memoryDir, 'chats', chatHash('wechat:u:wxid_a'), 'messages.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /先落盘再回复/);
  store.close();
  cleanup(dir);
});

test('每条消息 seq 递增，restart 后继续接上', () => {
  const { store, file, dir } = tempStore();
  store.appendMessage('k', { role: 'user', name: 'u', text: '一' });
  store.appendMessage('k', { role: 'assistant', name: '鲸鲸', text: '二' });
  assert.deepEqual(store.messages('k', 10).map((m) => m.seq), [1, 2]);
  store.close();

  const store2 = new Store({ file, logger: null });
  store2.appendMessage('k', { role: 'user', name: 'u', text: '三' });
  assert.deepEqual(store2.messages('k', 10).map((m) => m.seq), [1, 2, 3]);
  assert.equal(store2.messages('k', 10)[2].text, '三');
  store2.close();
  cleanup(dir);
});

test('checkpoint 每轮一份，且只留最近 50 份', () => {
  const { store, memoryDir, dir } = tempStore();
  for (let i = 0; i < 60; i += 1) {
    store.appendMessage('k', { role: 'user', name: 'u', text: 'm' + i });
    store.checkpoint('k');
  }
  const ckDir = path.join(memoryDir, 'chats', chatHash('k'), 'checkpoints');
  const files = fs.readdirSync(ckDir);
  assert.ok(files.length >= 1);
  assert.ok(files.length <= 50, 'checkpoint 不能无限涨：' + files.length);
  const payload = JSON.parse(fs.readFileSync(path.join(ckDir, files.sort().pop()), 'utf8'));
  assert.equal(payload.seq, 60);
  assert.equal(payload.chatId, 'k');
  store.close();
  cleanup(dir);
});

test('重启恢复：消息、人物卡、昵称都在', async () => {
  const { store, file, dir } = tempStore();
  store.appendMessage('wechat:u:a', { role: 'user', name: '小海', uid: 'u-a', text: '记住我' });
  store.profile('wechat:u:a', 'u-a', '小海');
  store.addNote('wechat:u:a', 'u-a', '是只海马');
  store.setNickname('wechat:u:a', 'u-a', '小海豚');
  await store.drain();
  store.close();

  const store2 = new Store({ file, logger: null });
  assert.equal(store2.messages('wechat:u:a', 10)[0].text, '记住我');
  assert.equal(store2.listNotes('wechat:u:a')[0].notes[0], '是只海马');
  assert.equal(store2.displayName('wechat:u:a', 'u-a'), '小海豚');
  store2.close();
  cleanup(dir);
});

test('损坏的半截行不会让整个聊天读不出来', () => {
  const { store, memoryDir, file, dir } = tempStore();
  store.appendMessage('k', { role: 'user', name: 'u', text: '完整的一条' });
  store.close();
  const target = path.join(memoryDir, 'chats', chatHash('k'), 'messages.jsonl');
  fs.appendFileSync(target, '{"seq":999,"role":"user"', 'utf8');

  const store2 = new Store({ file, logger: null });
  assert.equal(store2.messages('k', 5)[0].text, '完整的一条');
  store2.close();
  cleanup(dir);
});

test('resetSession 只删指定 chat 的物理目录', () => {
  const { store, memoryDir, dir } = tempStore();
  store.appendMessage('wechat:u:a', { role: 'user', name: 'u', text: 'a' });
  store.appendMessage('wechat:u:b', { role: 'user', name: 'u', text: 'b' });
  store.resetSession('wechat:u:a');
  assert.ok(!fs.existsSync(path.join(memoryDir, 'chats', chatHash('wechat:u:a'))));
  assert.ok(fs.existsSync(path.join(memoryDir, 'chats', chatHash('wechat:u:b'))));
  assert.equal(store.messages('wechat:u:a', 10).length, 0);
  assert.equal(store.messages('wechat:u:b', 10).length, 1);
  store.close();
  cleanup(dir);
});
