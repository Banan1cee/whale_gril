'use strict';

/**
 * 迁移：4.0 / 3.x 旧 store.json（+ journal）和 memory.json → v2 chats。
 * 要求：不删旧文件、留只读副本、legacy 低置信度、不跨 chat 合并、幂等。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const { ChatStore } = require('../src/memory/chatStore');
const { migrateIfNeeded } = require('../src/memory/migrate');
const { chatHash } = require('../src/memory/hash');
const personCard = require('../src/memory/personCard');

function legacyRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-migrate-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  const store = {
    version: 1,
    stats: { messages: 3, replies: 1 },
    sessions: {
      'wechat:u:wxid_a': {
        platform: 'wechat', chatId: 'wxid_a', chatType: 'private', title: '小海',
        createdAt: 1, lastActiveAt: 2,
        messages: [
          { role: 'user', name: '小海', uid: 'u-a', text: '我叫小海', ts: 1 },
          { role: 'assistant', name: '鲸鲸', text: '记住啦', ts: 2 },
        ],
        profiles: {
          'u-a': { uid: 'u-a', name: '小海', nickname: '海海', count: 2, notes: ['住在杭州', { text: '喜欢猫', kind: 'preference', importance: 2 }] },
        },
        state: { mutedUntil: 0, lastReplyAt: 2 },
        seenIds: ['m1'],
        summary: '他们刚认识，小海说住在杭州。',
        summaryUpto: 2,
      },
      'wechat:g:g1': {
        platform: 'wechat', chatId: 'g1', chatType: 'group', title: '深海鱼塘',
        messages: [{ role: 'user', name: '阿丙', uid: 'u-b', text: '大家好', ts: 3 }],
        profiles: { 'u-b': { uid: 'u-b', name: '阿丙', notes: ['在群里很活跃'] } },
      },
    },
  };
  fs.writeFileSync(path.join(data, 'store.json'), JSON.stringify(store), 'utf8');
  return { dir, data, store };
}

test('旧 store.json → chats：每个会话独立目录，notes 标 legacy 低置信度', async () => {
  const { dir, data } = legacyRoot();
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  assert.equal(store.chatStore.chats.size, 2);
  assert.ok(fs.existsSync(path.join(data, 'memory', 'chats', chatHash('wechat:u:wxid_a'), 'messages.jsonl')));
  assert.ok(fs.existsSync(path.join(data, 'memory', 'chats', chatHash('wechat:g:g1'), 'messages.jsonl')));

  const privateCard = store.chatStore.chats.get('wechat:u:wxid_a').people.get('u-a');
  const groupCard = store.chatStore.chats.get('wechat:g:g1').people.get('u-b');
  assert.ok(privateCard);
  assert.ok(groupCard);
  const privateTexts = personCard.activePreferences(privateCard).map((p) => p.text);
  assert.ok(privateTexts.includes('住在杭州'));
  assert.ok(privateTexts.includes('喜欢猫'));
  assert.ok(personCard.activePreferences(privateCard).every((p) => p.legacy === true && p.confidence <= 0.4), '旧笔记要低置信度');
  assert.ok(!personCard.activePreferences(groupCard).some((p) => p.text.includes('杭州')), '不能跨 chat 合并');
  assert.equal(privateCard.nickname, '海海');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('旧文件保留：原 store.json 不动，legacy/ 有只读副本和说明', () => {
  const { dir, data, store: legacy } = legacyRoot();
  const before = fs.readFileSync(path.join(data, 'store.json'), 'utf8');
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  store.close();
  assert.equal(fs.readFileSync(path.join(data, 'store.json'), 'utf8'), before, '不能删/改旧文件');
  assert.ok(fs.existsSync(path.join(data, 'memory', 'legacy', 'store.json')));
  assert.ok(fs.existsSync(path.join(data, 'memory', 'legacy', 'README.txt')));
  assert.ok(JSON.parse(before).sessions['wechat:u:wxid_a']);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('幂等：第二次启动不会重复导消息 / 重复加偏好', () => {
  const { dir, data } = legacyRoot();
  const s1 = new Store({ file: path.join(data, 'store.json'), logger: null });
  const msgs1 = s1.messages('wechat:u:wxid_a', 50).length;
  const notes1 = s1.listNotes('wechat:u:wxid_a')[0].notes.length;
  s1.close();

  const s2 = new Store({ file: path.join(data, 'store.json'), logger: null });
  assert.equal(s2.messages('wechat:u:wxid_a', 50).length, msgs1);
  assert.equal(s2.listNotes('wechat:u:wxid_a')[0].notes.length, notes1);
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('旧 journal 里的最新消息也能迁移', () => {
  const { dir, data } = legacyRoot();
  fs.appendFileSync(path.join(data, 'store.json.journal'), JSON.stringify({
    sessions: {
      'wechat:u:wxid_a': {
        platform: 'wechat', chatId: 'wxid_a', chatType: 'private',
        messages: [
          { role: 'user', name: '小海', uid: 'u-a', text: '我叫小海', ts: 1 },
          { role: 'assistant', name: '鲸鲸', text: '记住啦', ts: 2 },
          { role: 'user', name: '小海', uid: 'u-a', text: '只写在日志里的一条', ts: 3 },
        ],
        profiles: { 'u-a': { uid: 'u-a', name: '小海', notes: [] } },
      },
    },
  }) + '\n', 'utf8');
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  const texts = store.messages('wechat:u:wxid_a', 50).map((m) => m.text);
  assert.ok(texts.includes('只写在日志里的一条'));
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('独立 data/memory.json 也能迁移（没有 store.json 时）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-migrate2-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'memory.json'), JSON.stringify({
    sessions: {
      'web:u:s1:private': {
        platform: 'web', chatType: 'private', title: '网页私聊',
        messages: [{ role: 'user', name: '你', uid: 'web-u-s1', text: '你好', ts: 1 }],
        profiles: { 'web-u-s1': { uid: 'web-u-s1', notes: ['旧网页里的一句话'] } },
      },
    },
  }), 'utf8');
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  assert.equal(store.chatStore.chats.size, 1);
  assert.equal(store.listNotes('web:u:s1:private')[0].notes[0], '旧网页里的一句话');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('4.0 已有的 chat 也能合并旧记忆：按时间补消息、notes 去重、seq 重排', () => {
  const { dir, data } = legacyRoot();
  const s1 = new Store({ file: path.join(data, 'store.json'), logger: null });
  assert.equal(s1.messages('wechat:u:wxid_a', 50).length, 2);
  s1.appendMessage('wechat:u:wxid_a', { role: 'user', name: '小海', uid: 'u-a', text: '今天的新消息', ts: Date.now() });
  s1.close();

  // 3.x 那边又补了一条旧消息 + 一条新 note
  const legacy = JSON.parse(fs.readFileSync(path.join(data, 'store.json'), 'utf8'));
  legacy.sessions['wechat:u:wxid_a'].messages.push({ role: 'user', name: '小海', uid: 'u-a', text: '补一条旧的', ts: 3 });
  legacy.sessions['wechat:u:wxid_a'].profiles['u-a'].notes = ['住在杭州', '喜欢猫', '养了只狗'];
  fs.writeFileSync(path.join(data, 'store.json'), JSON.stringify(legacy), 'utf8');

  const s2 = new Store({ file: path.join(data, 'store.json'), logger: null });
  const chat = s2.chatStore.chats.get('wechat:u:wxid_a');
  assert.deepEqual(chat.messages.map((m) => m.text), ['我叫小海', '记住啦', '补一条旧的', '今天的新消息']);
  assert.deepEqual(chat.messages.map((m) => m.seq), [1, 2, 3, 4], '重排后 seq 必须连续');
  const notes = s2.listNotes('wechat:u:wxid_a')[0].notes;
  assert.equal(notes.length, 3, '重复的「住在杭州」不能再加一份');
  assert.ok(notes.includes('养了只狗'));
  s2.close();

  // migratedFrom 不能被 ChatStore 用迁移前的 manifest 覆盖掉
  const manifest = JSON.parse(fs.readFileSync(path.join(data, 'memory', 'manifest.json'), 'utf8'));
  assert.ok(manifest.migratedFrom.length >= 1);
  assert.ok(JSON.stringify(manifest.migratedFrom).includes('store.json'));

  // 再启动一次：签名已记录，不重复合并
  const s3 = new Store({ file: path.join(data, 'store.json'), logger: null });
  assert.equal(s3.messages('wechat:u:wxid_a', 50).length, 4);
  s3.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('首次迁移后 journal 再追加：签名含 journal，仍会被合并进来', () => {
  const { dir, data } = legacyRoot();
  const s1 = new Store({ file: path.join(data, 'store.json'), logger: null });
  s1.close();

  fs.appendFileSync(path.join(data, 'store.json.journal'), JSON.stringify({
    sessions: {
      'wechat:u:wxid_a': {
        platform: 'wechat', chatId: 'wxid_a', chatType: 'private',
        messages: [
          { role: 'user', name: '小海', uid: 'u-a', text: '我叫小海', ts: 1 },
          { role: 'assistant', name: '鲸鲸', text: '记住啦', ts: 2 },
          { role: 'user', name: '小海', uid: 'u-a', text: '只写在 journal 的一条', ts: 5 },
        ],
        profiles: { 'u-a': { uid: 'u-a', name: '小海', notes: [] } },
      },
    },
  }) + '\n', 'utf8');

  const s2 = new Store({ file: path.join(data, 'store.json'), logger: null });
  const texts = s2.messages('wechat:u:wxid_a', 50).map((m) => m.text);
  assert.ok(texts.includes('只写在 journal 的一条'));
  assert.equal(texts.length, 3, '已在 v2 里的两条不能重复');
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('刚导入的老 chat 不会被启动 sweep 立刻归档', () => {
  const { dir, data } = legacyRoot();
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  store.sweep();
  assert.equal(store.chatStore.chats.size, 2, '刚导入的会话不能当天就被扫进 archive/');
  const chat = store.chatStore.chats.get('wechat:u:wxid_a');
  assert.ok(chat.meta.importedAt > 0);
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('补进来的旧消息早于摘要覆盖线：摘要清空重压，不冒充已覆盖', () => {
  const { dir, data } = legacyRoot();
  const s1 = new Store({ file: path.join(data, 'store.json'), logger: null });
  s1.close();

  const legacy = JSON.parse(fs.readFileSync(path.join(data, 'store.json'), 'utf8'));
  legacy.sessions['wechat:u:wxid_a'].messages.push({ role: 'user', name: '小海', uid: 'u-a', text: '更早的一句话', ts: 1 });
  fs.writeFileSync(path.join(data, 'store.json'), JSON.stringify(legacy), 'utf8');

  const s2 = new Store({ file: path.join(data, 'store.json'), logger: null });
  const chat = s2.chatStore.chats.get('wechat:u:wxid_a');
  assert.ok(chat.messages.map((m) => m.text).includes('更早的一句话'));
  assert.equal(chat.summary.coveredThroughSeq, 0, '覆盖线被旧消息打断，不能继续宣称已覆盖');
  assert.equal(chat.summary.text, '');
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});

test('dry-run 只出报告，不写记忆', () => {
  const { dir, data } = legacyRoot();
  const s1 = new Store({ file: path.join(data, 'store.json'), logger: null });
  s1.close();

  const legacy = JSON.parse(fs.readFileSync(path.join(data, 'store.json'), 'utf8'));
  legacy.sessions['wechat:u:wxid_a'].messages.push({ role: 'user', name: '小海', uid: 'u-a', text: '只做预览的一条', ts: 9 });
  fs.writeFileSync(path.join(data, 'store.json'), JSON.stringify(legacy), 'utf8');

  const chatStore = new ChatStore({ dir: path.join(data, 'memory') });
  const before = chatStore.chats.get('wechat:u:wxid_a').messages.length;
  const res = migrateIfNeeded({ memoryDir: path.join(data, 'memory'), chatStore, dryRun: true });
  assert.equal(res.report.messages, 1);
  assert.equal(chatStore.chats.get('wechat:u:wxid_a').messages.length, before, 'dry-run 不能改原文');
  chatStore.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
});
