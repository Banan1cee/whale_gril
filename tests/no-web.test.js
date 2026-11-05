'use strict';

/**
 * 门禁：网页界面已经删除，别让它从任何一条路悄悄长回来。
 *
 * 删 web/ 的时候最怕两种回归：
 *   1) 有人把静态文件服务重新接回 router —— 浏览器又能打开本机 8787 了；
 *   2) 有脚本/文档重新造出一个 web/ 目录并往里写文件，发布包里又混进站点资源。
 * 这两条都不会让任何功能报错，所以只能显式断言。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/infra/config');
const { startServer } = require('../server');

const root = path.resolve(__dirname, '..');

test('web/ 目录不存在', () => {
  assert.equal(fs.existsSync(path.join(root, 'web')), false, 'web/ 已被删除，不该再出现在仓库里');
  for (const rel of ['index.html', 'debug.html', 'persona.html', path.join('assets', 'app.js'), path.join('assets', 'style.css')]) {
    assert.equal(fs.existsSync(path.join(root, 'web', rel)), false, `web/${rel} 不该存在`);
  }
});

test('src/http/static.js 不存在（静态文件服务已下线）', () => {
  assert.equal(fs.existsSync(path.join(root, 'src', 'http', 'static.js')), false);
});

test('loadConfig 的 paths 里没有 webDir', () => {
  const cfg = loadConfig({ root, env: {} });
  assert.equal(Object.prototype.hasOwnProperty.call(cfg.paths, 'webDir'), false, 'paths.webDir 应随网页界面一起删除');
  // 其余路径不能受影响：启动器、桥接、备份都靠它们
  for (const key of ['root', 'dataDir', 'configFile', 'settingsFile', 'storeFile', 'logFile']) {
    assert.ok(cfg.paths[key], 'paths.' + key + ' 不该被误删');
  }
});

test('默认配置里没有 openBrowser（开关连带整条链路都删了）', () => {
  // 用空目录测「默认配置」，不受本机 config.json 影响：老安装里可能还留着这个键，
  // 它已经没有消费方了。这里断言的是「新装的用户不会再有这个开关」。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-no-open-browser-'));
  try {
    const cfg = loadConfig({ root: dir, env: {} });
    assert.equal('openBrowser' in cfg.server, false, 'server.openBrowser 应随网页界面一起删除');
    assert.equal(typeof cfg.server.port, 'number', 'server.port 不能被误删');
    assert.ok(cfg.server.host, 'server.host 不能被误删');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('示例配置里没有 openBrowser，也不提网页 / 浏览器', () => {
  // config.example.json 会被 ensureConfigFile 复制成用户的 config.json，
  // 里面留一句「启动时自动开浏览器」等于给新用户埋一个 404。
  const raw = fs.readFileSync(path.join(root, 'config.example.json'), 'utf8');
  assert.equal(raw.includes('openBrowser'), false, '示例配置不该再出现 openBrowser');
  assert.equal(raw.includes('网页'), false, '示例配置的注释不该再提「网页」');
  assert.equal(raw.includes('浏览器'), false, '示例配置的注释不该再提「浏览器」');
});

test('GET / 返回 404 JSON，不是 HTML', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-no-web-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, log: { level: 'error' } }));
  const inst = await startServer({ root: dir, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  t.after(async () => {
    try { await inst.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } catch { /* ignore */ }
  });

  for (const p of ['/', '/index.html', '/debug', '/assets/app.js']) {
    const res = await fetch(inst.url + p);
    assert.equal(res.status, 404, `${p} 应该 404`);
    assert.match(String(res.headers.get('content-type') || ''), /application\/json/, `${p} 要返回 JSON，不是 HTML`);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not found');
  }
});

test('API 还在：/api/status 与 /api/features 正常', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-no-web-api-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, log: { level: 'error' } }));
  const inst = await startServer({ root: dir, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  t.after(async () => {
    try { await inst.close(); } catch { /* ignore */ }
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } catch { /* ignore */ }
  });
  for (const p of ['/api/status', '/api/features']) {
    const res = await fetch(inst.url + p);
    assert.equal(res.status, 200, `${p} 必须还能用（启动器每一页都靠 API）`);
    assert.equal((await res.json()).ok, true);
  }
});
