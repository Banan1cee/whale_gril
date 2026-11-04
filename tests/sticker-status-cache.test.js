'use strict';

/**
 * R2 回归：status 的 1.5 秒结果缓存。
 *
 * 启动器每 2 秒、网页每 3 秒都会拉一次 status。以前每次都同步全量扫库
 * （565 张实测 450ms 纯阻塞）；现在异步扫描 + 1.5s 缓存，并且
 * 上传 / 删除 / 改分类 / 维护结束都会显式失效 —— 所以「刚传完立刻看得见」不能退化。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stickers = require('../src/adapters/stickers');
const { StickerService } = require('../src/services/stickerService');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function fixture(t, count = 6) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-status-cache-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const dir = path.join(root, 'data', 'stickers');
  fs.mkdirSync(path.join(dir, '傲娇'), { recursive: true });
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, '傲娇', `s-${i}.gif`), GIF);
  const cfg = { root, features: { stickers: true }, sticker: { dir: 'data/stickers' } };
  return { root, dir, cfg };
}

function spyReaddir(t) {
  const original = fs.promises.readdir;
  const counter = { count: 0 };
  fs.promises.readdir = function (...args) { counter.count += 1; return original.apply(this, args); };
  t.after(() => { fs.promises.readdir = original; });
  return counter;
}

test('两次 status 之间只真扫一次；缓存过期后会重扫', async (t) => {
  const { cfg } = fixture(t);
  let clock = 10_000;
  const service = new StickerService(cfg, { now: () => clock });
  const readdir = spyReaddir(t);

  const first = await service.statusAsync();
  const cold = readdir.count;
  assert.ok(cold >= 1, '第一次必须真的读目录');
  assert.equal(first.emotions.find((e) => e.key === 'cute').count, 6);

  readdir.count = 0;
  clock += 300;
  const second = await service.statusAsync();
  assert.equal(readdir.count, 0, '1.5 秒内的第二次不该再扫库');
  assert.deepEqual(second.emotions.map((e) => e.count), first.emotions.map((e) => e.count));

  // 过了 TTL：允许它重新扫
  readdir.count = 0;
  clock += 2000;
  await service.statusAsync();
  assert.ok(readdir.count >= 1, '缓存过期后要重扫');
});

test('上传后立刻可见（缓存被显式失效，不用等 1.5 秒）', async (t) => {
  const { root, dir, cfg } = fixture(t);
  const service = new StickerService(cfg, { now: () => 10_000 });
  assert.equal((await service.statusAsync()).emotions.find((e) => e.key === 'cute').count, 6);

  stickers.upload(cfg, root, 'cute', [{ name: 'new.gif', data: GIF.toString('base64') }]);
  stickers.invalidateScan(path.join(dir, '傲娇'));
  service.invalidateStatus();
  const after = await service.statusAsync();
  assert.equal(after.emotions.find((e) => e.key === 'cute').count, 7, '刚上传的图必须立刻出现在 status 里');
});

test('删除后立刻消失（缓存不会把删掉的图吐回来）', async (t) => {
  const { dir, cfg } = fixture(t);
  const service = new StickerService(cfg, { now: () => 10_000 });
  await service.statusAsync();
  fs.unlinkSync(path.join(dir, '傲娇', 's-0.gif'));
  stickers.invalidateScan(path.join(dir, '傲娇'));
  service.invalidateStatus();
  const after = await service.statusAsync();
  assert.equal(after.emotions.find((e) => e.key === 'cute').count, 5);
});

test('queueOnly 走轻量路径：不扫库，但能看到维护进度', async (t) => {
  const { cfg } = fixture(t);
  const service = new StickerService(cfg, { now: () => 10_000 });
  const readdir = spyReaddir(t);
  const body = await service.statusAsync(true);
  assert.equal(readdir.count, 0, 'queueOnly 不该读目录');
  assert.equal(body.pending, 0);
  assert.ok(body.maintenance && typeof body.maintenance.phase === 'string');
});
