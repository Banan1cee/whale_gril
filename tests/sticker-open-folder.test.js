'use strict';

/**
 * 「打开目标目录」的接口契约（交接文档步骤 7 的 ① ② ③ ⑤）。
 *
 * 这条接口会真的 spawn explorer.exe，所以安全边界要逐个钉住：
 *   - 只能本机访问（router 里已有的 loopback 检查）；
 *   - 目标必须在图库根目录内，不能靠 ../ 或分类名跳出去；
 *   - 分类必须真实存在，目录不能是链接/目录联接；
 *   - WHALE_TEST_NO_SHELL=1 时只返回路径，不 spawn。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { startServer } = require('../server');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function fixture(t, stickersOn = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-open-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const dir = path.join(root, 'data', 'stickers');
  const put = (rel) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, GIF);
    return file;
  };
  put('傲娇/a.gif');
  put('开心/root.gif');
  fs.writeFileSync(path.join(root, 'data', 'sticker-categories.json'),
    JSON.stringify([{ label: '猫猫', chance: 0.25 }]), 'utf8');
  fs.mkdirSync(path.join(dir, '猫猫'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    watchConfig: false,
    features: { stickers: stickersOn },
    sticker: { dir: 'data/stickers' },
  }), 'utf8');
  return { root, dir, put };
}

async function live(t) {
  const { root, dir, put } = fixture(t);
  const inst = await startServer({
    root,
    env: { WHALE_LOG_FILE: '', WHALE_TEST_NO_SHELL: '1' },
    port: 0,
    openBrowser: false,
  });
  t.after(() => inst.close());
  const post = async (body) => {
    const res = await fetch(inst.url + '/api/stickers/open-folder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { root, dir, put, post };
}

test('空参 = 打开库根', async (t) => {
  const { dir, post } = await live(t);
  const res = await post({});
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, 'root');
  assert.equal(path.resolve(res.body.dir), path.resolve(dir));
});

test('带分类 = 打开该分类目录（中文标签，不是 key）', async (t) => {
  const { dir, post } = await live(t);
  const cute = await post({ emotion: 'cute' });
  assert.equal(cute.status, 200);
  assert.equal(cute.body.mode, 'folder');
  assert.equal(path.resolve(cute.body.dir), path.resolve(path.join(dir, '傲娇')));

  const custom = await post({ emotion: 'x:猫猫' });
  assert.equal(custom.status, 200);
  assert.equal(path.resolve(custom.body.dir), path.resolve(path.join(dir, '猫猫')));
});

test('带文件名 = 定位到那一张（explorer /select）', async (t) => {
  const { dir, post } = await live(t);
  const res = await post({ emotion: 'cute', name: '傲娇/a.gif' });
  assert.equal(res.status, 200);
  assert.equal(res.body.mode, 'select');
  assert.equal(path.resolve(res.body.dir), path.resolve(path.join(dir, '傲娇', 'a.gif')));
});

test('越界路径一律 404：../、绝对路径、不存在的分类', async (t) => {
  const { post } = await live(t);
  for (const body of [
    { emotion: 'cute', name: '../../Windows/System32/notepad.exe' },
    { emotion: 'cute', name: '..\\..\\Windows\\win.ini' },
    { emotion: 'cute', name: 'C:/Windows/win.ini' },
    { emotion: 'cute', name: '傲娇/../a.gif' },
    { emotion: 'x:不存在', name: 'a.gif' },
    { emotion: '../../Windows' },
    { emotion: 'constructor' },
    { emotion: '__proto__' },
  ]) {
    const res = await post(body);
    assert.equal(res.status, 404, JSON.stringify(body) + ' 必须被拒');
    assert.equal(res.body.ok, false);
  }
});

test('分类目录是目录联接时拒绝（不跟随出去）', async (t) => {
  const { dir, post } = await live(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-open-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(dir, '猫猫');
  fs.rmSync(target, { recursive: true, force: true });
  try { fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code)) { t.skip('无创建链接权限'); return; }
    throw err;
  }
  const res = await post({ emotion: 'x:猫猫' });
  assert.equal(res.status, 404, '目录联接不能被打开');
});

test('总闸关着时整条接口 404（不读盘、不 spawn）', async (t) => {
  const { root } = fixture(t, false);
  const inst = await startServer({
    root, env: { WHALE_LOG_FILE: '', WHALE_TEST_NO_SHELL: '1' }, port: 0, openBrowser: false,
  });
  t.after(() => inst.close());
  const res = await fetch(inst.url + '/api/stickers/open-folder', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 404);
});
