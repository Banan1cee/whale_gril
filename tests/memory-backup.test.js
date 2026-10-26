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
