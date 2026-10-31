'use strict';

/**
 * 备份 / 恢复：本地文件 + CLI 用；没有 HTTP 接口、不展示记忆正文。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backup = require('../src/memory/backup');
const { Store } = require('../src/memory/store');

function seed({ settings } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-bk-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  store.appendMessage('wechat:u:wxid_a', { role: 'user', name: '小明', uid: 'wxid_a', text: '在吗' });
  store.profile('wechat:u:wxid_a', 'wxid_a', '小明');
  store.addNote('wechat:u:wxid_a', 'wxid_a', '喜欢喝冰美式');
  store.flush();
  await0(store);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(settings || { userName: '爸爸', provider: 'qwen' }));
  fs.writeFileSync(path.join(data, 'persona.json'), JSON.stringify({ preset: '温柔' }));
  return { root, store };
}

function await0(store) {
  // 同步落盘：flush 已经写了 meta/summary，卡片是即时写的
  try { store.chatStore.flush(); } catch { /* ignore */ }
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

test('导出：带记忆本体 / 称呼 / 人设，并统计得出来', () => {
  const { root, store } = seed();
  const dest = path.join(root, 'out', 'mem.json');
  const info = backup.exportTo(root, dest);
  store.close();
  assert.equal(info.sessions, 1);
  assert.equal(info.messages, 1);
  assert.equal(info.notes, 1);
  const bundle = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(bundle.kind, 'whale-girl-memory');
  assert.equal(bundle.version, 2);
  assert.ok(Object.keys(bundle.files.memory).some((k) => k.endsWith('messages.jsonl')));
  assert.ok(bundle.files.settings);
  assert.ok(bundle.files.persona);
  cleanup(root);
});

test('恢复到空目录：记忆真的回来了', () => {
  const { root, store } = seed();
  const dest = path.join(root, 'mem.json');
  backup.exportTo(root, dest);
  store.close();

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-new-'));
  fs.mkdirSync(path.join(fresh, 'data'), { recursive: true });
  const info = backup.restoreFromFile(fresh, dest);
  assert.ok(info.restored.includes('memory/'));

  const store2 = new Store({ file: path.join(fresh, 'data', 'store.json'), logger: null });
  assert.equal(store2.messages('wechat:u:wxid_a', 10)[0].text, '在吗');
  assert.equal(store2.listNotes('wechat:u:wxid_a')[0].notes[0], '喜欢喝冰美式');
  store2.close();
  const settings = JSON.parse(fs.readFileSync(path.join(fresh, 'data', 'settings.json'), 'utf8'));
  assert.equal(settings.userName, '爸爸');
  cleanup(root);
  cleanup(fresh);
});

test('恢复前会先把当前记忆另存一份（before-restore）', () => {
  const { root, store } = seed();
  const dest = path.join(root, 'mem.json');
  backup.exportTo(root, dest);
  store.close();
  backup.restoreFrom(root, JSON.parse(fs.readFileSync(dest, 'utf8')));
  const snaps = backup.listBackups(root);
  assert.ok(snaps.some((s) => s.name.includes('before-restore')));
  cleanup(root);
});

test('坏文件要明确报错，不要默默清空记忆', () => {
  const { root, store } = seed();
  store.close();
  assert.throws(() => backup.restoreFrom(root, { hello: 1 }), /不是鲸鲸的记忆备份/);
  const check = new Store({ file: path.join(root, 'data', 'store.json'), logger: null });
  assert.equal(check.listNotes('wechat:u:wxid_a')[0].notes[0], '喜欢喝冰美式');
  check.close();
  cleanup(root);
});

test('快照最多留 20 份', () => {
  const { root, store } = seed();
  store.close();
  for (let i = 0; i < 25; i += 1) backup.writeSnapshot(root, 'startup');
  const snaps = backup.listBackups(root);
  assert.ok(snaps.length <= backup.KEEP, `最多留 ${backup.KEEP} 份，实际 ${snaps.length}`);
  cleanup(root);
});

test('导出默认脱敏；显式 withSecrets 才带 Key', () => {
  const { root, store } = seed({ settings: { provider: 'qwen', apiKey: 'sk-secret-1234567890', keys: { qwen: 'sk-secret-1234567890' }, userName: '爸爸' } });
  store.close();
  const plain = path.join(root, 'plain.json');
  backup.exportTo(root, plain);
  const raw = fs.readFileSync(plain, 'utf8');
  assert.ok(!raw.includes('sk-secret-1234567890'), '导出不能带 Key');
  assert.ok(raw.includes('爸爸'));

  const full = path.join(root, 'full.json');
  backup.exportTo(root, full, { withSecrets: true });
  assert.ok(fs.readFileSync(full, 'utf8').includes('sk-secret-1234567890'));
  cleanup(root);
});

test('脱敏备份恢复不会把本机 Key 抹掉', () => {
  const { root, store } = seed({ settings: { provider: 'qwen', apiKey: 'sk-keep-me-123456' } });
  const dest = path.join(root, 'mem.json');
  backup.exportTo(root, dest);
  store.close();
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ provider: 'qwen', apiKey: 'sk-keep-me-123456' }));
  backup.restoreFromFile(root, dest);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
  assert.equal(after.apiKey, 'sk-keep-me-123456');
  cleanup(root);
});

test('路径穿越/结构不对的备份要被拦下', () => {
  const { root, store } = seed();
  store.close();
  assert.throws(() => backup.restoreFrom(root, {
    kind: 'whale-girl-memory',
    version: 2,
    files: { memory: { 'chats/../../etc/passwd': 'x' } },
  }), /非法路径/);
  const check = new Store({ file: path.join(root, 'data', 'store.json'), logger: null });
  assert.ok(check.listNotes('wechat:u:wxid_a').length);
  check.close();
  cleanup(root);
});

test('旧版 v1 备份（files.store）能恢复，下一次启动走迁移', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-v1-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const dest = path.join(root, 'old.json');
  fs.writeFileSync(dest, JSON.stringify({
    kind: 'whale-girl-memory',
    version: 1,
    files: {
      store: {
        sessions: {
          'wechat:u:a': {
            messages: [{ role: 'user', name: '甲', uid: 'u-a', text: '旧备份里的话', ts: 1 }],
            profiles: { 'u-a': { uid: 'u-a', name: '甲', notes: ['旧偏好'] } },
          },
        },
      },
    },
  }));
  const info = backup.restoreFromFile(root, dest);
  assert.ok(info.restored.some((x) => x.includes('store.json')));
  const store = new Store({ file: path.join(data, 'store.json'), logger: null });
  assert.equal(store.messages('wechat:u:a', 10)[0].text, '旧备份里的话');
  store.close();
  cleanup(root);
});

test('没有记忆时导出会明确报错，而不是生成空文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-empty-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  assert.throws(() => backup.exportTo(root, path.join(root, 'x.json')), /还没有记忆/);
  cleanup(root);
});
