'use strict';

/**
 * R1 回归：启动期不能再被「旧分类迁移」堵住。
 *
 * 老行为：`new StickerService()` 在构造函数里同步跑 migrateLegacy，245 张 611MB 实测
 * 要让内核 11.5 秒不监听 —— 启动器 WaitForNodeAsync 只等 40×250ms，直接判「内核未就绪」，
 * 桥接压根不起来，同时这也是「点上传就报积极拒绝」的窗口。
 *
 * 现在：构造函数零磁盘 I/O，迁移由 server.js 在 listen 之后 setImmediate 触发，
 * 每 16 张让出一次事件循环。这里用带旧分类的库真起一次服务，验证四件事：
 *   1. /healthz 3 秒内可用；
 *   2. 迁移期间 /healthz 不会被长时间堵住；
 *   3. maintenance 最终 done，且张数对得上；
 *   4. 图一张不少（全部并入「开心」），旧目录被清掉。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../server');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
// 旧别名目录：通用/其他 → 开心；撒娇 → 傲娇（FOLDERS 的家族映射）
const LEGACY_HAPPY = { 其他: 24, 通用: 18 };
const LEGACY_CUTE = { 撒娇: 6 };
const CANONICAL = { 开心: 4, 傲娇: 3, 炸毛: 2 };
const ROOT_IMAGES = 2;
const LEGACY_TOTAL = 24 + 18 + 6;

function makeLibrary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const dir = path.join(root, 'data', 'stickers');
  const put = (rel, bytes = GIF) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  for (const [label, count] of Object.entries({ ...LEGACY_HAPPY, ...LEGACY_CUTE, ...CANONICAL })) {
    for (let i = 0; i < count; i++) put(`${label}/img-${label}-${i}.gif`);
  }
  // 根目录散图：以前完全收不到，现在并进「开心」
  put('root-a.gif');
  put('root-b.gif');
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    watchConfig: false,
    features: { stickers: true },
    sticker: { dir: 'data/stickers' },
  }), 'utf8');
  return { root, dir, put };
}

function countFiles(dir) {
  let n = 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) n += countFiles(path.join(dir, ent.name));
    else n++;
  }
  return n;
}

test('带旧分类的库启动：listen 快、维护期间不堵、图一张不少', async (t) => {
  const { root, dir } = makeLibrary(t);
  const before = countFiles(dir);
  assert.equal(before, LEGACY_TOTAL
    + Object.values(CANONICAL).reduce((a, b) => a + b, 0) + ROOT_IMAGES);

  const t0 = Date.now();
  const inst = await startServer({
    root,
    env: { WHALE_LOG_FILE: '', WHALE_TEST_NO_SHELL: '1' },
    port: 0,
    openBrowser: false,
  });
  t.after(() => inst.close());

  // 1. /healthz 必须立刻可用（老实现这里要等十几秒）
  let healthzAt = -1;
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(inst.url + '/healthz');
      if (res.ok) { healthzAt = Date.now() - t0; break; }
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(healthzAt >= 0, '/healthz 应该可用');
  assert.ok(healthzAt < 3000, `/healthz 应在 3 秒内可用，实测 ${healthzAt}ms`);

  // 2. 边迁移边打 /healthz：不能被单次扫描/搬迁堵太久
  let maxHz = 0;
  let maintenance = null;
  for (let i = 0; i < 400; i++) {
    const started = Date.now();
    const res = await fetch(inst.url + '/healthz');
    assert.equal(res.status, 200);
    maxHz = Math.max(maxHz, Date.now() - started);
    const body = await (await fetch(inst.url + '/api/stickers/status?queueOnly=1')).json();
    maintenance = body.maintenance || null;
    if (maintenance && maintenance.phase === 'done') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(maintenance && maintenance.phase, 'done', '维护要跑到 done：' + JSON.stringify(maintenance));
  assert.ok(maxHz < 1000, `维护期间 /healthz 不应被堵住，实测最长 ${maxHz}ms`);

  // 3. 张数对得上：旧分类 + 根目录散图全部搬走
  assert.equal(maintenance.done, LEGACY_TOTAL + ROOT_IMAGES, '维护进度要报出实际搬走的张数');
  assert.deepEqual(maintenance.errors, []);

  // 4. 图一张不少，旧目录被清掉，各自的家族目录收下对应旧图
  assert.equal(countFiles(dir), before, '迁移不能丢图');
  const happy = fs.readdirSync(path.join(dir, '开心')).filter((f) => f.endsWith('.gif'));
  assert.equal(happy.length, CANONICAL.开心 + 24 + 18 + ROOT_IMAGES, '「开心」要收下 通用/其他 + 根目录散图');
  const cute = fs.readdirSync(path.join(dir, '傲娇')).filter((f) => f.endsWith('.gif'));
  assert.equal(cute.length, CANONICAL.傲娇 + 6, '「傲娇」要收下 撒娇');
  for (const label of [...Object.keys(LEGACY_HAPPY), ...Object.keys(LEGACY_CUTE)]) {
    assert.equal(fs.existsSync(path.join(dir, label)), false, label + ' 空掉之后应该被删掉');
  }

  // 5. 再读一次状态不应该重复搬运（幂等）：目录内容与维护计数都不变
  const status = await (await fetch(inst.url + '/api/stickers/status')).json();
  assert.equal(status.maintenance.phase, 'done');
  assert.equal(status.maintenance.done, LEGACY_TOTAL + ROOT_IMAGES);
  assert.equal(fs.readdirSync(path.join(dir, '开心')).filter((f) => f.endsWith('.gif')).length, happy.length);
  assert.equal(countFiles(dir), before);
});

test('构造函数零磁盘 I/O：总闸关着时连 data 目录都不建', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-startup-off-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const { StickerService } = require('../src/services/stickerService');
  const cfg = { root, features: { stickers: false }, sticker: { dir: 'data/stickers' } };
  const started = Date.now();
  new StickerService(cfg);
  assert.ok(Date.now() - started < 50, '关闭状态下构造必须是纯内存');
  assert.equal(fs.existsSync(path.join(root, 'data')), false);
});

test('maintenance 幂等：同一次启动里重复 startMaintenance 只跑一次', async (t) => {
  const { root } = makeLibrary(t);
  const { StickerService } = require('../src/services/stickerService');
  const { loadConfig } = require('../src/infra/config');
  const cfg = loadConfig({ root, env: {} });
  const service = new StickerService(cfg);
  assert.equal(service.maintenance.phase, 'idle', '构造完不能已经跑过维护');
  assert.equal(service.startMaintenance(), true, '第一次要排期');
  assert.equal(service.startMaintenance(), false, '排期后重复调用要被挡住');
  const state = await service.startMaintenanceNow();
  assert.equal(state.phase, 'done');
  assert.ok(state.done > 0);
  assert.equal(service.startMaintenance(), false, '跑完同一目录不再重跑');
});
