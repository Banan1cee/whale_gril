'use strict';
// 表情包图库的扫描缓存与缩略图路径解析：改坏这两处会退化成「每个请求全库重扫」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stickers = require('../src/adapters/stickers');
const { startServer } = require('../server');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const cfg = { root, features: { stickers: true }, sticker: { dir: 'data/stickers' } };
  const dir = stickers.stickerDir(cfg, root);
  fs.mkdirSync(dir, { recursive: true });
  function put(rel, bytes = GIF) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }
  stickers.clearScanCache();
  return { root, cfg, dir, put };
}

/** 让目录 mtime 真的走过去：同一毫秒内改目录，Windows 上看不出区别。 */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** 数一数某个 fs 调用被用了几次，测完恢复原函数。 */
function spy(t, name) {
  const original = fs[name];
  const counter = { count: 0 };
  fs[name] = function (...args) { counter.count += 1; return original.apply(this, args); };
  t.after(() => { fs[name] = original; });
  return counter;
}

test('热路径命中缓存：第二次扫描不再读目录', (t) => {
  const { dir, put } = fixture(t);
  for (let i = 0; i < 20; i++) put(`傲娇/${i}.gif`);
  const readdir = spy(t, 'readdirSync');
  stickers.categoryImages(dir, 'cute');
  const cold = readdir.count;
  assert.ok(cold >= 1, '第一次必须真的读目录');
  readdir.count = 0;
  stickers.categoryImages(dir, 'cute');
  assert.equal(readdir.count, 0, '目录没变时不该再读');
});

test('缓存把系统调用从 O(N) 降到常数', (t) => {
  const { dir, put } = fixture(t);
  for (let i = 0; i < 100; i++) put(`傲娇/${i}.gif`);
  const lstat = spy(t, 'lstatSync');
  stickers.categoryImages(dir, 'cute');
  const cold = lstat.count;
  lstat.count = 0;
  stickers.categoryImages(dir, 'cute');
  const warm = lstat.count;
  // 2026-11-04 起：链接/联接检查按「目录」做一次（以前每张图都要逐层 lstat + realpath，
  // 实测 0.8ms/张），单文件只剩一次 lstat。安全边界不变，见下面的软链用例。
  assert.ok(cold >= 100, `冷扫描应该每个文件校验一次，实际 ${cold} 次`);
  assert.ok(cold <= 130, `冷扫描不该再有每文件多层校验，实际 ${cold} 次`);
  assert.ok(warm <= 5, `热扫描只该 stat 目录本身，实际 ${warm} 次`);
});

test('目录级校验没有放松安全边界：软链逃逸仍然列不出来', (t) => {
  const { dir, put } = fixture(t);
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-outside-'));
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }));
  const outside = path.join(outsideDir, 'secret.gif');
  fs.writeFileSync(outside, Buffer.from('not-in-library'));
  put('傲娇/real.gif');
  let madeSomething = false;
  try { fs.symlinkSync(outside, path.join(dir, '傲娇/link.gif'), 'file'); madeSomething = true; }
  catch (err) { if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code)) throw err; }
  try {
    fs.symlinkSync(outsideDir, path.join(dir, '傲娇/linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    madeSomething = true;
  } catch (err) { if (!['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code)) throw err; }
  if (!madeSomething) return t.skip('无创建链接权限（Windows 需要开发者模式或管理员）');
  stickers.clearScanCache();
  const files = stickers.categoryImages(dir, 'cute').map((f) => path.basename(f));
  assert.deepEqual(files, ['real.gif'], '软链/目录联接不能被当成表情包列出来');
});

test('外部增删即时可见：目录 mtime 变化会让缓存失效', (t) => {
  const { dir, put } = fixture(t);
  put('傲娇/a.gif');
  assert.deepEqual(stickers.categoryImages(dir, 'cute').map((f) => path.basename(f)), ['a.gif']);

  pause(20);
  put('傲娇/b.gif');
  assert.deepEqual(stickers.categoryImages(dir, 'cute').map((f) => path.basename(f)), ['a.gif', 'b.gif'],
    '在资源管理器里丢进去的图要能马上看到');

  pause(20);
  fs.unlinkSync(path.join(dir, '傲娇/a.gif'));
  assert.deepEqual(stickers.categoryImages(dir, 'cute').map((f) => path.basename(f)), ['b.gif'],
    '外部删掉的图不能还留在列表里');
});

test('上传后立刻可见，不依赖毫秒级 mtime', (t) => {
  const { cfg, root, dir } = fixture(t);
  assert.deepEqual(stickers.categoryImages(dir, 'cute'), []);
  const uploaded = stickers.upload(cfg, root, 'cute', [{ name: '新图.gif', data: GIF.toString('base64') }]);
  const names = stickers.categoryImages(dir, 'cute').map((f) => path.basename(f));
  assert.deepEqual(names, [uploaded[0].name], '上传完界面会立刻读状态，不能还看到旧列表');
});

test('缩略图路径解析：两段形态直接拼路径，越权一律拒绝', (t) => {
  const { dir, put } = fixture(t);
  const cute = put('傲娇/a.gif');
  put('炸毛/b.gif');
  put('cat/d.gif');

  assert.equal(stickers.resolveImage(dir, 'cute', '傲娇/a.gif'), cute);
  assert.equal(stickers.resolveImage(dir, 'cute', '傲娇/nothere.gif'), '');
  assert.equal(stickers.resolveImage(dir, 'cute', '炸毛/b.gif'), '', '别的分类目录不能借道');
  assert.equal(stickers.resolveImage(dir, 'angry', '傲娇/a.gif'), '', '分类对不上就不能返回');
  assert.equal(stickers.resolveImage(dir, 'cute', 'cat/d.gif'), '', '自定义分类没登记也不能借道');
  assert.equal(stickers.resolveImage(dir, 'cute', '傲娇/a.svg'), '', '扩展名白名单之外的不能返回');
  assert.equal(stickers.resolveImage(dir, 'cute', '傲娇/../炸毛/b.gif'), '');
  assert.equal(stickers.resolveImage(dir, 'cute', '/etc/passwd'), '');
  assert.equal(stickers.resolveImage(dir, 'cute', '傲娇\\a.gif'), '');
  assert.equal(stickers.resolveImage(dir, 'cute', '傲娇/sub/a.gif'), '');
  assert.equal(stickers.resolveImage(dir, 'cute', ''), '');
  assert.equal(stickers.resolveImage(dir, 'constructor', '傲娇/a.gif'), '');
  // 老调用方按 basename 找的老路还要能用
  assert.equal(stickers.resolveImage(dir, 'cute', 'a.gif'), cute);
});

test('旧别名目录（撒娇 / cute）里的图既能解析，也会被迁移收进内置目录', (t) => {
  const { cfg, root, dir, put } = fixture(t);
  const legacy = put('撒娇/x.gif');
  assert.equal(stickers.resolveImage(dir, 'cute', '撒娇/x.gif'), legacy);
  assert.deepEqual(stickers.categoryImages(dir, 'cute').map((f) => path.basename(f)), ['x.gif']);

  const report = stickers.migrateLegacy(cfg, root);
  assert.equal(report.moved, 1);
  const after = stickers.categoryImages(dir, 'cute').map((f) => path.relative(dir, f));
  assert.deepEqual(after, [path.join('傲娇', 'x.gif')], '迁移后缓存不能还留着旧路径');
});

test('列表是副本：调用方改返回值不会污染缓存', (t) => {
  const { dir, put } = fixture(t);
  put('傲娇/a.gif');
  const list = stickers.categoryImages(dir, 'cute');
  list.push('污染');
  assert.equal(stickers.categoryImages(dir, 'cute').includes('污染'), false);
  assert.equal(stickers.categoryImages(dir, 'cute').length, 1);
});

test('HTTP 层：上传和删除后 status 立刻反映，缓存不会让新图消失或旧图残留', async (t) => {
  const { root, dir } = fixture(t);
  const config = JSON.stringify({
    server: { port: 0, openBrowser: false }, watchConfig: false,
    features: { stickers: true }, persona: { name: '测试名字', ownerName: '测试主人' },
    sticker: { dir: 'data/stickers' },
  });
  fs.writeFileSync(path.join(root, 'config.json'), config);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/settings.json'), '{}');

  const inst = await startServer({ root, env: { WHALE_LOG_FILE: '', WHALE_TEST_NO_SHELL: '1' }, port: 0, openBrowser: false });
  t.after(() => inst.close());
  const status = async () => (await (await fetch(inst.url + '/api/stickers/status')).json()).emotions.find((e) => e.key === 'cute').count;
  const upload = (name) => fetch(inst.url + '/api/stickers/upload', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emotion: 'cute', files: [{ name, data: GIF.toString('base64') }] }),
  });

  assert.equal(await status(), 0);
  assert.equal((await upload('一.gif')).status, 200);
  assert.equal(await status(), 1, '上传后立刻读 status 必须看到新图');
  assert.equal((await upload('二.gif')).status, 200);
  assert.equal(await status(), 2);

  const items = (await (await fetch(inst.url + '/api/stickers/status')).json()).emotions.find((e) => e.key === 'cute').items;
  const del = await fetch(inst.url + '/api/stickers/delete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ emotion: 'cute', name: items[0].id }),
  });
  assert.equal(del.status, 200);
  assert.equal(await status(), 1, '删除后立刻读 status 必须少一张');
  assert.equal(fs.existsSync(dir), true);
});
