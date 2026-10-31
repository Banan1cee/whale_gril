'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReminderService, RETRY_DELAY_MS, CLAIM_TIMEOUT_MS } = require('../src/services/reminderService');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reminder-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const clock = { ms: Date.now() };
  const config = { paths: { dataDir: dir } };
  const make = () => new ReminderService(config, { now: () => clock.ms });
  const svc = make();
  const add = (text = '开会') => svc.add({ wxid: 'wx-test', text, at: clock.ms + 1000 });
  return { clock, svc, make, add };
}

test('报告：重启的 sending 超过原始到期窗口必须持久化过期', t => {
  const { clock, svc, make, add } = setup(t);
  add(); clock.ms += 2000; svc.due();
  clock.ms += RETRY_DELAY_MS;
  const restarted = make();
  assert.equal(restarted.sweepStale().expired, 1);
  assert.equal(make().list()[0].status, 'expired');
  assert.deepEqual(restarted.due(), []);
});

test('报告：正在发送不能声称取消成功；重复失败回执不能消耗重试次数', t => {
  const { clock, svc, make, add } = setup(t);
  const item = add(); clock.ms += 2000; svc.due();
  assert.equal(svc.cancel(item.id).statusCode, 409);
  assert.equal(make().list()[0].status, 'sending');
  assert.equal(svc.ack(item.id, { ok: false }).item.attempts, 1);
  assert.equal(svc.ack(item.id, { ok: false }).statusCode, 409);
  assert.equal(make().list()[0].attempts, 1);
  clock.ms += RETRY_DELAY_MS;
  assert.equal(svc.due().length, 1);
  assert.equal(svc.ack(item.id, { ok: true }).item.attempts, 2);
  assert.equal(svc.ack(item.id, { ok: true }).item.attempts, 2);
});

test('报告：同批 11 条领取前 10 条后应立即唤醒领取剩余一条', t => {
  const { clock, svc, add } = setup(t);
  for (let i = 0; i < 11; i++) add(String(i));
  clock.ms += 2000;
  const first = svc.due(); assert.equal(first.length, 10);
  assert.equal(svc.nextDueAt(), clock.ms);
  for (const it of first) svc.ack(it.id, { ok: true });
  assert.equal(svc.due().length, 1);
  assert.equal(svc.nextDueAt(), clock.ms + CLAIM_TIMEOUT_MS + 1);
});

test('报告：损坏主文件从最新备份恢复，已完成的提醒不能重新待发', t => {
  const { clock, svc, make, add } = setup(t);
  const it = add(); clock.ms += 2000; svc.due(); svc.ack(it.id, { ok: true });
  fs.writeFileSync(svc.file, '{broken');
  const restored = make();
  assert.equal(restored.list()[0].status, 'done');
  assert.deepEqual(restored.due(), []);
  restored.add({ wxid: 'wx-test', text: '新提醒', at: clock.ms + 1000 });
  assert.equal(make().list().length, 2);
});

test('报告：主文件与备份都损坏时阻止覆盖；结构错误也能回退备份', t => {
  const { clock, svc, make, add } = setup(t);
  add(); fs.writeFileSync(svc.file, '{"items":null}');
  assert.equal(make().list().length, 1);
  fs.writeFileSync(svc.file + '.bak', 'broken-backup');
  const broken = make();
  assert.throws(() => broken.add({ wxid: 'wx-test', text: '不能覆盖', at: clock.ms + 1000 }), /保存失败/);
  assert.equal(fs.readFileSync(svc.file, 'utf8'), '{"items":null}');
  assert.equal(fs.readFileSync(svc.file + '.bak', 'utf8'), 'broken-backup');
});
