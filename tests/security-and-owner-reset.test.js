'use strict';

/**
 * 两个安全/一致性回归：
 * A. 控制台默认只许本机访问；`server.host=0.0.0.0` 不该把改配置的接口暴露出去。
 * B. 称呼迁移只做一次：把称呼改回「主人」或清空后，重启不该被老设置盖回来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

async function boot(cfgPatch = {}, settings = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sec-'));
  const cfg = {
    server: { port: 0, openBrowser: false },
    ...cfgPatch,
    persona: { master: { names: ['Master'], wxids: ['wxid_test_master'] }, ...((cfgPatch && cfgPatch.persona) || {}) },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
  if (settings) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify(settings));
  }
  const inst = await startServer({ root, env: {}, port: 0, openBrowser: false });
  return { ...inst, root, configFile: path.join(root, 'config.json') };
}

test('server.host=0.0.0.0 会被强制改回回环地址', async () => {
  const inst = await boot({ server: { port: 0, openBrowser: false, host: '0.0.0.0' } });
  assert.equal(inst.host, '127.0.0.1', '没开 allowRemote 时不该对外监听');
  assert.match(inst.url, /^http:\/\/127\.0\.0\.1:/);
  await inst.close();
});

test('显式 allowRemote 时才允许非回环监听', async () => {
  const inst = await boot({ server: { port: 0, openBrowser: false, host: '0.0.0.0', allowRemote: true } });
  assert.equal(inst.host, '0.0.0.0');
  await inst.close();
});

test('本机 POST /api/settings 照常可用', async () => {
  const inst = await boot();
  const res = await fetch(`${inst.url}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: '爸爸' }),
  });
  assert.equal(res.status, 200);
  await inst.close();
});

test('称呼迁移只做一次：迁移后 settings.userName 被清掉', async () => {
  const inst = await boot({}, { userName: '爸爸' });
  assert.equal(inst.runtime.config.persona.ownerName, '爸爸');
  const settings = readJson(path.join(inst.root, 'data', 'settings.json'));
  assert.equal(settings.userName || '', '', '迁移完要把老字段清掉，否则以后重启又被盖回去');
  await inst.close();
});

test('清空称呼 = 恢复默认，不是「不改」', async () => {
  const inst = await boot({ persona: { ownerName: '爸爸', master: { names: ['Master'], wxids: ['wxid_test_master'] } } });
  const res = await fetch(`${inst.url}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: '' }),
  });
  assert.equal(res.status, 200);
  assert.equal(readJson(inst.configFile).persona.ownerName, '主人', '清空后应该回到默认称呼');
  await inst.close();
});
