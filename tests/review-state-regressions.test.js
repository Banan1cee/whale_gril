'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReminderService, CLAIM_TIMEOUT_MS, RETRY_DELAY_MS } = require('../src/services/reminderService');
const { Store, readStoreFile } = require('../src/memory/store');
const backup = require('../src/memory/backup');
const { startServer } = require('../server');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-round2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const config = { paths: { dataDir: path.join(root, 'data') }, reminder: { enabled: true, maxPerDay: 0 } };
  const clock = { ms: Date.now() };
  const make = () => new ReminderService(config, { now: () => clock.ms });
  return { root, config, clock, make };
}
function add(svc, clock, text = '开会') { return svc.add({ wxid: 'wx-test', text, at: clock.ms + 1000 }); }

test('提醒回执不能复活取消任务，成功回执重复到达也不增加次数', t => {
  const { clock, make } = fixture(t); const svc = make();
  const first = add(svc, clock); svc.cancel(first.id); clock.ms += 2000;
  assert.equal(svc.ack(first.id, { ok: true }).statusCode, 409);
  assert.equal(make().list()[0].status, 'cancelled');
  const second = add(svc, clock); clock.ms += 2000; svc.due();
  svc.ack(second.id, { ok: true });
  assert.equal(svc.ack(second.id, { ok: true }).item.attempts, 1);
  assert.equal(svc.ack(second.id, { ok: false }).statusCode, 409);
});

test('提醒领取分多轮进行时，未回执的任务也占每日额度', t => {
  const { clock, config, make } = fixture(t); config.reminder.maxPerDay = 1;
  const svc = make(); add(svc, clock, '一'); add(svc, clock, '二'); clock.ms += 2000;
  assert.equal(svc.due(undefined, { limit: 1 }).length, 1);
  assert.equal(svc.due().length, 0);
  assert.equal(make().list().filter(it => it.status === 'sending').length, 1);
});

test('因关闭功能而过期的提醒必须落盘，重启后不再领取', t => {
  const { clock, config, make } = fixture(t); const svc = make(); add(svc, clock);
  clock.ms += 2000; config.reminder.enabled = false; assert.deepEqual(svc.due(), []);
  config.reminder.enabled = true;
  assert.equal(make().list()[0].status, 'expired');
  assert.deepEqual(make().due(), []);
});

test('提醒保存失败必须报错，不能返回未落盘任务或留下虚假状态', t => {
  const { clock, make } = fixture(t); const svc = make();
  const save = svc.save; svc.save = () => false;
  assert.throws(() => add(svc, clock), /保存失败/); assert.deepEqual(svc.list(), []);
  svc.save = save; const item = add(svc, clock); clock.ms += 2000;
  svc.save = () => false; assert.throws(() => svc.due(), /保存失败/);
  assert.equal(svc.list()[0].status, 'pending');
  svc.save = save; svc.due(); svc.save = () => false;
  assert.throws(() => svc.ack(item.id, { ok: true }), /保存失败/);
  assert.equal(svc.list()[0].status, 'sending');
  assert.equal(svc.cancel(item.id).statusCode, 409);
  assert.equal(svc.list()[0].status, 'sending');
  svc.save = save; const pending = add(svc, clock); svc.save = () => false;
  assert.throws(() => svc.cancel(pending.id), /保存失败/);
  assert.equal(svc.list()[0].status, 'pending');
});

test('没有回执的提醒最多重试一次，重启后超时任务不补发', t => {
  const { clock, make } = fixture(t); const svc = make(); add(svc, clock); clock.ms += 2000; svc.due();
  clock.ms += CLAIM_TIMEOUT_MS + 1; assert.equal(svc.due().length, 1);
  clock.ms += CLAIM_TIMEOUT_MS + 1; assert.equal(svc.due().length, 0);
  assert.equal(make().list()[0].status, 'failed');
  const other = make(); add(other, clock); clock.ms += 2000; other.due(); clock.ms += RETRY_DELAY_MS + 1;
  const restarted = make(); restarted.sweepStale();
  assert.deepEqual(restarted.due(), []);
  assert.equal(restarted.list()[0].status, 'expired');
});

test('小于十的会话上限也会淘汰旧会话并保留当前会话', t => {
  const { root } = fixture(t); const store = new Store({ file: path.join(root, 'store.json'), limits: { maxSessions: 2 } });
  t.after(() => store.close());
  for (const key of ['a', 'b', 'c', 'd']) store.appendMessage(key, { role: 'user', text: key });
  assert.ok(store.sessions.size <= 2);
  assert.equal(store.messages('d', 1)[0].text, 'd');
});

test('命令行直接恢复备份也不能重放恢复前的旧增量', t => {
  const { root } = fixture(t); const file = path.join(root, 'data', 'store.json');
  const store = new Store({ file });
  store.appendMessage('old', { role: 'user', text: '不应复活' }); store.flush();
  // 模拟正常退出前的文件状态；恢复在离线工具内进行。
  if (store.saveTimer) { clearTimeout(store.saveTimer); store.saveTimer = null; }
  backup.restoreFrom(root, { kind: 'whale-girl-memory', files: { store: { sessions: {}, stats: { messages: 0, replies: 0 }, digest: [] } } });
  assert.deepEqual(readStoreFile(file).sessions, {});
});

test('非法备份内容在写盘前拒绝，不得以 null 或数组覆盖现有数据', t => {
  const { root } = fixture(t); fs.mkdirSync(path.join(root, 'data'));
  const file = path.join(root, 'data', 'settings.json'); fs.writeFileSync(file, '{"userName":"保留"}');
  for (const files of [{ settings: null }, { settings: [] }, { store: null }, { store: { sessions: [] } }, { store: { sessions: { bad: null } } }, { unexpected: {} }]) {
    assert.throws(() => backup.restoreFrom(root, { kind: 'whale-girl-memory', files }));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"userName":"保留"}');
  }
});

test('记忆 v2 的正文、导出与恢复 HTTP 入口保持关闭', async t => {
  const { root } = fixture(t);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ server: { openBrowser: false }, watchConfig: false }));
  const inst = await startServer({ root, env: {}, port: 0, openBrowser: false });
  t.after(() => inst.close());
  for (const route of ['/api/memory', '/api/memory/export', '/api/memory/info']) {
    assert.equal((await fetch(inst.url + route)).status, 404);
  }
  assert.equal((await fetch(inst.url + '/api/memory/restore', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' })).status, 404);
});

test('恢复不同服务商的脱敏设置，不得合入当前服务商的 Key', t => {
  const { root } = fixture(t); const dir = path.join(root, 'data'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ provider: 'deepseek', apiKey: 'sk-local-deepseek', keys: { deepseek: 'sk-local-deepseek' } }));
  backup.restoreFrom(root, { kind: 'whale-girl-memory', files: { memory: {}, settings: { provider: 'zhipu' } } });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.apiKey, '');
  assert.equal(settings.keys.deepseek, 'sk-local-deepseek');
});
