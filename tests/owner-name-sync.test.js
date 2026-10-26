'use strict';

/**
 * 称呼的两个入口必须写同一份数据：
 * A. 网页「⚙️ 设置」里的「怎么称呼你」
 * B. 调试台的 config.json `persona.ownerName`
 * 以前两边各存各的，网页改了调试台还是旧的，私聊也还是叫「主人」。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

async function boot(configPatch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-name-'));
  const cfg = {
    server: { port: 0, openBrowser: false },
    ...configPatch,
    persona: {
      master: { names: ['Master'], wxids: ['wxid_test_master'] },
      ...((configPatch && configPatch.persona) || {}),
    },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
  const instance = await startServer({ root, env: {}, port: 0, openBrowser: false });
  return { ...instance, root, configFile: path.join(root, 'config.json') };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

test('网页设置改称呼，config.json 里也同步写进去', async () => {
  const inst = await boot();
  const url = `${inst.url}/api/settings`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userName: '爸爸' }),
  });
  assert.equal(res.status, 200, '保存设置应该成功');
  const saved = readJson(inst.configFile);
  assert.equal(saved.persona.ownerName, '爸爸', 'config.json 里要能看到新称呼');
  assert.equal(inst.runtime.config.persona.ownerName, '爸爸', '内存里也要立刻生效，不用重启');
  await inst.close();
});

test('调试台改 persona.ownerName，网页设置读到的也是同一个值', async () => {
  const inst = await boot();
  const base = inst.url;
  const res = await fetch(`${base}/api/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: { 'persona.ownerName': '妈妈' } }),
  });
  assert.equal(res.status, 200);
  const state = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(state.userName, '妈妈', '网页设置里也要显示调试台改的值');
  await inst.close();
});

test('老数据迁移：只有 settings.userName 时，启动后写进 config.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-name-old-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ server: { port: 0, openBrowser: false }, persona: { master: { names: ['Master'], wxids: ['wxid_test_master'] } } })
  );
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify({ userName: '爸爸' }));
  const inst = await startServer({ root, env: {}, port: 0, openBrowser: false });
  assert.equal(inst.runtime.config.persona.ownerName, '爸爸', '启动时要把老设置搬过来');
  const saved = readJson(path.join(root, 'config.json'));
  assert.equal(saved.persona.ownerName, '爸爸', '并且落盘，调试台一眼能看到');
  await inst.close();
});
