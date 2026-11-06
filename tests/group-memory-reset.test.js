'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer } = require('../server');
const { Store } = require('../src/memory/store');
const episode = require('../src/memory/episode');

const target = 'wechat:g:test_group@chatroom';
const other = 'wechat:g:other_group@chatroom';
const privateKey = 'wechat:u:test_user';

function seed(store, key, title, chatType = 'group') {
  store.ensureSession(key, { platform: 'wechat', chatType, title });
  store.appendMessage(key, { role: 'user', uid: 'test_person', name: '测试成员', text: '我喜欢喝茶' });
  store.setSummary(key, '测试摘要');
  const chat = store.chatStore.chats.get(key);
  store.chatStore.checkpoint(chat);
  return chat;
}

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-reset-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    env: { autoDetect: false }, log: { traceRaw: false },
    features: { memorySnapshot: false },
  }));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0 });
  t.after(async () => {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  });
  return app;
}

async function reset(app, payload, headers = {}) {
  const res = await fetch(app.url + '/api/memory/groups/reset', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('群列表不截断且不包含私聊或记忆正文；只清空选中群并持久化', async (t) => {
  const app = await boot(t);
  const store = app.runtime.store;
  const oldChat = seed(store, target, '待清空群');
  seed(store, other, '保留群');
  seed(store, privateKey, '保留私聊', 'private');
  for (let i = 0; i < 51; i++) store.ensureSession(`wechat:g:extra_${i}`, { platform: 'wechat', chatType: 'group' });
  const listing = await (await fetch(app.url + '/api/memory/groups')).json();
  assert.equal(listing.groups.length, 53);
  assert.ok(!JSON.stringify(listing).includes('我喜欢喝茶'));
  assert.ok(!listing.groups.some((g) => g.key === privateKey));
  const out = await reset(app, { key: target, confirm: true });
  assert.equal(out.status, 200);
  assert.equal(fs.existsSync(oldChat.dir), false);
  assert.equal(store.sessions.has(target), false);
  assert.equal(store.chatStore.chats.has(target), false);
  assert.equal(store.messages(other).length, 1);
  assert.equal(store.messages(privateKey).length, 1);
  store.reloadFromDisk();
  assert.equal(store.chatStore.chats.has(target), false);
  assert.equal(store.messages(other).length, 1);
  seed(store, target, '重新开始');
  assert.equal(store.messages(target).length, 1);
});

test('未确认、私聊、未知会话、忙碌群和跨站请求均不能清空', async (t) => {
  const app = await boot(t);
  seed(app.runtime.store, target, '测试群');
  seed(app.runtime.store, privateKey, '测试私聊', 'private');
  assert.equal((await reset(app, { key: target })).status, 400);
  assert.equal((await reset(app, { key: privateKey, confirm: true })).status, 404);
  assert.equal((await reset(app, { key: '../../invalid', confirm: true })).status, 404);
  app.runtime.bot._handleChains.set(target, Promise.resolve());
  assert.equal((await reset(app, { key: target, confirm: true })).status, 409);
  app.runtime.bot._handleChains.delete(target);
  assert.equal((await reset(app, { key: target, confirm: true }, { origin: 'https://example.com' })).status, 403);
  assert.equal(app.runtime.store.messages(target).length, 1);
});

test('文件删除失败时保留会话视图并返回失败', async (t) => {
  const app = await boot(t);
  const chat = seed(app.runtime.store, target, '测试群');
  const rm = fs.rmSync;
  t.mock.method(fs, 'rmSync', (dir, options) => {
    if (dir === chat.dir) throw Object.assign(new Error('test locked'), { code: 'EACCES' });
    return rm(dir, options);
  });
  assert.equal((await reset(app, { key: target, confirm: true })).status, 500);
  assert.equal(app.runtime.store.sessions.has(target), true);
  assert.equal(chat.deleted, undefined);
  t.mock.restoreAll();
});

test('所有对话列表包含群聊、私聊及其他渠道；可单独清空私聊', async (t) => {
  const app = await boot(t);
  const store = app.runtime.store;
  seed(store, target, '保留群聊');
  const removed = seed(store, privateKey, '待清空私聊', 'private');
  seed(store, 'wechat:u:test_other_user', '保留私聊', 'private');
  store.ensureSession('douyin:u:test_person', { platform: 'douyin', chatType: 'private', title: '其他渠道' });
  const listing = await (await fetch(app.url + '/api/memory/chats')).json();
  assert.equal(listing.chats.length, 4);
  assert.ok(listing.chats.some((c) => c.key === privateKey && c.chatType === 'private'));
  assert.ok(listing.chats.some((c) => c.platform === 'douyin'));
  assert.ok(!JSON.stringify(listing).includes('我喜欢喝茶'));
  const resetChat = (body) => fetch(app.url + '/api/memory/chats/reset', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await resetChat({ key: privateKey })).status, 400);
  app.runtime.bot._handleChains.set(privateKey, Promise.resolve());
  assert.equal((await resetChat({ key: privateKey, confirm: true })).status, 409);
  app.runtime.bot._handleChains.delete(privateKey);
  assert.equal((await resetChat({ key: privateKey, confirm: true })).status, 200);
  assert.equal(fs.existsSync(removed.dir), false);
  store.reloadFromDisk();
  assert.equal(store.chatStore.chats.has(privateKey), false);
  assert.equal(store.messages(target).length, 1);
  assert.equal(store.messages('wechat:u:test_other_user').length, 1);
  assert.equal((await resetChat({ key: privateKey, confirm: true })).status, 404);
});

test('清空期间完成的后台抽取及旧对象写入不能复活或覆盖旧记忆', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-background-'));
  const store = new Store({ dir: root });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const oldChat = seed(store, target, '测试群');
  let finish;
  const task = episode.closeEpisode({ chat: oldChat, chatStore: store.chatStore,
    llm: { isMock: false, complete: () => new Promise((resolve) => { finish = resolve; }) } });
  assert.equal(typeof finish, 'function');
  assert.equal(store.resetSession(target), true);
  finish('{}');
  await task;
  store.chatStore.saveSummary(oldChat);
  store.chatStore.saveMeta(oldChat, { immediate: true });
  store.chatStore.saveCard(oldChat, [...oldChat.people.values()][0]);
  store.chatStore.checkpoint(oldChat);
  assert.equal(fs.existsSync(oldChat.dir), false);
  const fresh = seed(store, target, '新会话');
  oldChat.summary.text = '旧摘要不该复活';
  store.chatStore.saveSummary(oldChat);
  assert.equal(JSON.parse(fs.readFileSync(path.join(fresh.dir, 'summary.json'), 'utf8')).text, '测试摘要');
});
