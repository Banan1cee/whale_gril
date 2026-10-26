'use strict';

/**
 * 记忆备份/恢复：#用户反馈「每次更新记忆就没了」。
 * 现在两份保障：①每次启动自动留快照；②可以导出成 json 带到任何地方。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const backup = require('../src/memoryBackup');

function seed() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'store.json'),
    JSON.stringify({
      sessions: {
        'wechat:p:wxid_a': {
          messages: [
            { role: 'user', text: '我叫小明', ts: 1 },
            { role: 'assistant', text: '记住了', ts: 2 },
          ],
          profiles: { wxid_a: { notes: ['喜欢喝冰美式'] } },
        },
      },
    })
  );
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ userName: '爸爸', provider: 'qwen' }));
  fs.writeFileSync(path.join(root, 'data', 'persona.json'), JSON.stringify({ preset: '温柔' }));
  return root;
}

test('导出：带上记忆/称呼/人设，并且统计得出来', () => {
  const root = seed();
  const dest = path.join(root, 'out', 'mem.json');
  const info = backup.exportTo(root, dest);
  assert.equal(info.sessions, 1);
  assert.equal(info.messages, 2);
  assert.equal(info.notes, 1);
  const bundle = JSON.parse(fs.readFileSync(dest, 'utf8'));
  assert.equal(bundle.kind, 'whale-girl-memory');
  assert.ok(bundle.files.store, '聊天记忆要带上');
  assert.ok(bundle.files.settings, '称呼/设置要带上');
  assert.ok(bundle.files.persona, '人设要带上');
  fs.rmSync(root, { recursive: true, force: true });
});

test('恢复到空目录：记忆真的回来了', () => {
  const src = seed();
  const dest = path.join(src, 'mem.json');
  backup.exportTo(src, dest);

  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-new-'));
  fs.mkdirSync(path.join(fresh, 'data'), { recursive: true });
  const info = backup.restoreFromFile(fresh, dest);
  assert.deepEqual(info.restored.sort(), ['persona.json', 'settings.json', 'store.json'].sort());

  const store = JSON.parse(fs.readFileSync(path.join(fresh, 'data', 'store.json'), 'utf8'));
  assert.ok(store.sessions['wechat:p:wxid_a'], '会话要回来');
  assert.equal(store.sessions['wechat:p:wxid_a'].profiles.wxid_a.notes[0], '喜欢喝冰美式');
  const settings = JSON.parse(fs.readFileSync(path.join(fresh, 'data', 'settings.json'), 'utf8'));
  assert.equal(settings.userName, '爸爸');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
});

test('恢复前会先把当前记忆另存一份（防手滑）', () => {
  const root = seed();
  const dest = path.join(root, 'mem.json');
  backup.exportTo(root, dest);
  const info = backup.restoreFrom(root, JSON.parse(fs.readFileSync(dest, 'utf8')));
  assert.ok(info.restored.length >= 1);
  const snaps = backup.listBackups(root);
  assert.ok(
    snaps.some((s) => s.name.includes('before-restore')),
    '恢复前必须留一份 before-restore 快照'
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test('坏文件要明确报错，不要默默清空记忆', () => {
  const root = seed();
  assert.throws(() => backup.restoreFrom(root, { hello: 1 }), /不是鲸鲸的记忆备份/);
  const store = JSON.parse(fs.readFileSync(path.join(root, 'data', 'store.json'), 'utf8'));
  assert.ok(store.sessions['wechat:p:wxid_a'], '报错之后原记忆不能被破坏');
  fs.rmSync(root, { recursive: true, force: true });
});

test('快照最多留 20 份，不会把盘塞满', () => {
  const root = seed();
  for (let i = 0; i < 25; i += 1) backup.writeSnapshot(root, 'startup');
  const snaps = backup.listBackups(root);
  assert.ok(snaps.length <= backup.KEEP, `最多留 ${backup.KEEP} 份，实际 ${snaps.length}`);
  fs.rmSync(root, { recursive: true, force: true });
});

test('导出默认脱敏：文件里不能出现 API Key', () => {
  const root = seed();
  fs.writeFileSync(
    path.join(root, 'data', 'settings.json'),
    JSON.stringify({ userName: '爸爸', provider: 'qwen', apiKey: 'sk-secret-1234567890', keys: { qwen: 'sk-secret-1234567890' } })
  );
  const dest = path.join(root, 'mem.json');
  backup.exportTo(root, dest);
  const raw = fs.readFileSync(dest, 'utf8');
  assert.ok(!raw.includes('sk-secret-1234567890'), '导出的文件里不能有 Key（要发人/传U盘）');
  assert.ok(raw.includes('爸爸'), '称呼这种有用的信息要留着');
  fs.rmSync(root, { recursive: true, force: true });
});

test('显式 --secrets 才把 Key 一起导出', () => {
  const root = seed();
  fs.writeFileSync(
    path.join(root, 'data', 'settings.json'),
    JSON.stringify({ provider: 'qwen', apiKey: 'sk-secret-1234567890' })
  );
  const dest = path.join(root, 'mem-full.json');
  backup.exportTo(root, dest, { withSecrets: true });
  assert.ok(fs.readFileSync(dest, 'utf8').includes('sk-secret-1234567890'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('用脱敏备份恢复，不会把本机 Key 抹掉（否则恢复完就不说话了）', () => {
  const root = seed();
  fs.writeFileSync(
    path.join(root, 'data', 'settings.json'),
    JSON.stringify({ provider: 'qwen', apiKey: 'sk-keep-me-123456' })
  );
  const dest = path.join(root, 'mem.json');
  backup.exportTo(root, dest);
  // 模拟「先丢了记忆、但 Key 还在」的机器
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ provider: 'qwen', apiKey: 'sk-keep-me-123456' }));
  backup.restoreFromFile(root, dest);
  const after = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
  assert.equal(after.apiKey, 'sk-keep-me-123456', '恢复记忆不能顺手把 Key 清掉');
  fs.rmSync(root, { recursive: true, force: true });
});

test('结构不对的备份要被拦下，别覆盖现有记忆', () => {
  const root = seed();
  assert.throws(() => backup.restoreFrom(root, { kind: 'whale-girl-memory', files: { store: { nope: 1 } } }), /sessions/);
  const store = JSON.parse(fs.readFileSync(path.join(root, 'data', 'store.json'), 'utf8'));
  assert.ok(store.sessions['wechat:p:wxid_a'], '原记忆必须还在');
  fs.rmSync(root, { recursive: true, force: true });
});

test('导出接口默认不带 Key（HTTP 层也要验一遍，别只测模块）', async () => {
  const { startServer } = require('../server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mem-api-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false } }));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'settings.json'),
    JSON.stringify({ provider: 'qwen', apiKey: 'sk-live-secret-999', keys: { qwen: 'sk-live-secret-999' } })
  );
  fs.writeFileSync(path.join(root, 'data', 'store.json'), JSON.stringify({ sessions: { a: { messages: [], profiles: {} } } }));
  const inst = await startServer({ root, env: {}, port: 0, openBrowser: false });
  try {
    const plain = await (await fetch(`${inst.url}/api/memory/export`)).text();
    assert.ok(!plain.includes('sk-live-secret-999'), '默认导出不能带 Key');
    assert.ok(plain.includes('"sessions"'), '但记忆要带上');
    const full = await (await fetch(`${inst.url}/api/memory/export?secrets=1`)).text();
    assert.ok(full.includes('sk-live-secret-999'), '显式 secrets=1 才带 Key');
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
