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
