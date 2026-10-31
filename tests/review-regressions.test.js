'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { checkRequest } = require('../src/http/security');
const { loadConfig, resolveRuntime, saveSettings } = require('../src/infra/config');

test('远程读取记忆和密钥必须鉴权，本机读取不受影响', () => {
  const runtime = { config: { server: { allowRemote: true }, gateway: { wechat: { inboundToken: 'test-private-token' } } }, logger: { warn() {} } };
  for (const pathname of ['/api/memory/export?secrets=1', '/api/settings', '/api/debug/sessions']) {
    const request = { socket: { remoteAddress: '192.168.1.9' }, headers: {} };
    assert.equal(checkRequest(runtime, request, { pathname, method: 'GET' }).status, 403);
    request.headers['x-bot-token'] = 'test-private-token';
    assert.equal(checkRequest(runtime, request, { pathname, method: 'GET' }), null);
    request.socket.remoteAddress = '127.0.0.1';
    request.headers = {};
    assert.equal(checkRequest(runtime, request, { pathname, method: 'GET' }), null);
  }
});

test('切换服务不回退旧配置密钥，切回后保留原凭据，清空后不复活', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-keys-fix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ provider: 'deepseek', deepseek: { apiKey: 'sk-original-deepseek' } }));
  const cfg = loadConfig({ root, env: {} });
  assert.equal(resolveRuntime(cfg).apiKey, 'sk-original-deepseek');
  saveSettings(cfg, { provider: 'zhipu' });
  assert.equal(resolveRuntime(cfg).apiKey, '');
  saveSettings(cfg, { provider: 'deepseek' });
  assert.equal(resolveRuntime(cfg).apiKey, 'sk-original-deepseek');
  saveSettings(cfg, { apiKey: '' });
  assert.equal(resolveRuntime(cfg).apiKey, '');
});

test('启动器管道正常关闭内核并保存刚收到的会话', { timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-shutdown-fix-'));
  const source = path.resolve(__dirname, '..');
  for (const name of ['src', 'resources', 'personas', 'server.js', 'package.json'])
    fs.cpSync(path.join(source, name), path.join(root, name), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false, deepseek: { mock: true }, gateway: { wechat: { enabled: true, inboundToken: 'regression-bridge-token' } } }));
  const child = spawn(process.execPath, ['server.js', '--port=0', '--no-browser'], {
    cwd: root, env: { ...process.env, WHALE_CONTROL_STDIN: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  child.stdout.on('data', b => { output += b; });
  child.stderr.on('data', b => { output += b; });
  t.after(() => { if (child.exitCode === null) child.kill(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); });
  const portFile = path.join(root, 'data', 'server-port.txt');
  for (let i = 0; i < 150 && !fs.existsSync(portFile); i++) {
    assert.equal(child.exitCode, null, output);
    await new Promise(r => setTimeout(r, 30));
  }
  assert.ok(fs.existsSync(portFile), output);
  const port = fs.readFileSync(portFile, 'utf8').trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bot-token': 'regression-bridge-token' }, body: JSON.stringify({ text: '你好', sessionId: 'shutdown-regression' }) });
  assert.equal(response.status, 200);
  await response.text();
  const exited = once(child, 'exit');
  child.stdin.end('shutdown\n');
  const [code] = await exited;
  assert.equal(code, 0, output);
  const { Store } = require('../src/memory/store');
  const reopened = new Store({ file: path.join(root, 'data', 'store.json') });
  try { assert.ok(reopened.messages('web:u:shutdown-regression:private', 20).some(m => m.text === '你好')); }
  finally { reopened.close(); }
});
