'use strict';

/**
 * 3.57「安全小修」那三条的回归测试 —— 当年改完只在 CHANGELOG 里写了，
 * 一行测试都没有，所以后来谁动 http 层都没人拦。
 *
 *   1) 静态文件防穿越：以前用 `filePath.startsWith(webDir)` 判断，
 *      兄弟目录 `web-evil/` 也满足前缀 → `/..%2fweb-evil%2fsecret.txt` 能读到库外文件。
 *      现在改成 `path.relative(webDir, filePath)`，跑出 webDir 一律 403。
 *   2) 每个响应都要挂安全头（nosniff / 禁止被 iframe 嵌套 / no-referrer / CSP）。
 *   3) token 比较走恒定时间（`crypto.timingSafeEqual`），别用 `===` 靠响应时间泄密；
 *      长度不同、非字符串、null 都不能抛异常。
 *
 * 这些是「架构一改就悄悄失效」的典型：它们都不影响正常功能，
 * 只在被人构造请求时才看得出来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');
const { safeEqual, remoteAuthorized } = require('../src/http/security');

const SECRET = 'PWNED-BY-TRAVERSAL';
const CONFIG_MARKER = 'TOP-SECRET-CONFIG-MARKER';

/** 起一个临时站点：<root>/web 是站点根，<root>/web-evil 是同前缀的兄弟目录 */
function makeSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-hardening-'));
  fs.mkdirSync(path.join(root, 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web-evil'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<h1>ok</h1>', 'utf8');
  fs.writeFileSync(path.join(root, 'web-evil', 'secret.txt'), SECRET, 'utf8');
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      server: { port: 0, openBrowser: false },
      watchConfig: false,
      log: { level: 'error' },
      note: CONFIG_MARKER,
    }),
    'utf8'
  );
  return root;
}

function portOf(inst) {
  return Number(new URL(inst.url).port);
}

/**
 * 原始 HTTP 请求：`fetch` 会在发出去之前把 `/../` 归一化掉，
 * 所以穿越必须绕开客户端自己拼路径。
 */
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: rawPath, method: 'GET', agent: false },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.setTimeout(5000, () => req.destroy(new Error('timeout: ' + rawPath)));
    req.on('error', reject);
    req.end();
  });
}

async function boot(t) {
  const root = makeSite();
  t.after(() => {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } catch { /* ignore */ }
  });
  const inst = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  t.after(async () => { try { await inst.close(); } catch { /* ignore */ } });
  return { inst, root, port: portOf(inst) };
}

/* ---------------- 静态文件防穿越 ---------------- */

test('静态文件：编码后的 ../ 穿到兄弟目录（web-evil）必须 403，且读不到内容', async (t) => {
  const { port } = await boot(t);
  // 服务端先按 URL 归一化、再 decodeURIComponent，所以 %2f 是真正能穿过归一化的那一种写法
  const res = await rawGet(port, '/..%2fweb-evil%2fsecret.txt');
  assert.equal(res.status, 403, '兄弟目录前缀 ≠ 站点目录，必须拒绝');
  assert.equal(res.body.includes(SECRET), false, '绝不能把站点目录外的文件读出来');
});

test('静态文件：编码后的 ../ 穿到 config.json 必须 403，配置内容不泄漏', async (t) => {
  const { port } = await boot(t);
  for (const rawPath of ['/..%2fconfig.json', '/..%2f..%2fconfig.json', '/%2e%2e%2fconfig.json']) {
    const res = await rawGet(port, rawPath);
    assert.equal(res.status, 403, `${rawPath} 应该被 403 挡掉（实际 ${res.status}）`);
    assert.equal(res.body.includes(CONFIG_MARKER), false, `${rawPath} 泄漏了配置文件内容`);
  }
});

test('静态文件：正常的页面照旧能取到（别把防穿越做成全站 404）', async (t) => {
  const { port } = await boot(t);
  const res = await rawGet(port, '/index.html');
  assert.equal(res.status, 200);
  assert.match(res.body, /ok/);
});

test('静态文件：绝对路径 / 盘符写法不会绕过站点根', async (t) => {
  const { port } = await boot(t);
  for (const rawPath of ['/C%3A%2FWindows%2Fwin.ini', '/%5C..%5Cconfig.json']) {
    const res = await rawGet(port, rawPath);
    assert.notEqual(res.status, 200, `${rawPath} 不该返回 200`);
    assert.equal(res.body.includes(CONFIG_MARKER), false);
  }
});

test('畸形 URL 不会把服务搞挂，下一个请求照样能用', async (t) => {
  const { port } = await boot(t);
  const bad = await rawGet(port, '/%E0%A4%A');
  assert.ok([400, 500].includes(bad.status), `畸形 URL 应该给出 4xx/5xx，实际 ${bad.status}`);
  const after = await rawGet(port, '/index.html');
  assert.equal(after.status, 200, '出过一次畸形请求之后，正常请求必须还能用');
});

/* ---------------- 安全响应头 ---------------- */

function assertSecurityHeaders(headers, where) {
  assert.equal(headers['x-content-type-options'], 'nosniff', `${where} 缺 nosniff`);
  assert.equal(headers['x-frame-options'], 'SAMEORIGIN', `${where} 缺 X-Frame-Options`);
  assert.equal(headers['referrer-policy'], 'no-referrer', `${where} 缺 Referrer-Policy`);
  const csp = String(headers['content-security-policy'] || '');
  assert.ok(csp.length > 0, `${where} 缺 CSP`);
  assert.match(csp, /default-src 'self'/, `${where} 的 CSP 必须默认只允许同源`);
  assert.match(csp, /object-src 'none'/, `${where} 的 CSP 必须禁掉 object`);
  assert.equal(/unsafe-eval/.test(csp), false, `${where} 的 CSP 不该放开 unsafe-eval`);
}

test('安全响应头：API 响应 / 静态页面 / 404 都要带上', async (t) => {
  const { inst, port } = await boot(t);

  const api = await fetch(`${inst.url}/api/status`);
  assert.equal(api.status, 200);
  assertSecurityHeaders(Object.fromEntries(api.headers), 'API 响应');

  const page = await rawGet(port, '/index.html');
  assertSecurityHeaders(page.headers, '静态页面');

  const missing = await rawGet(port, '/definitely-not-here.js');
  assert.equal(missing.status, 404);
  assertSecurityHeaders(missing.headers, '404 响应');
});

test('安全响应头：被拒绝的跨站写请求也要带（错误页不例外）', async (t) => {
  const { inst } = await boot(t);
  const res = await fetch(`${inst.url}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: '{"userName":"x"}',
  });
  assert.equal(res.status, 403);
  assertSecurityHeaders(Object.fromEntries(res.headers), '403 响应');
});

/* ---------------- 请求体上限（3.60 §4） ---------------- */

test('超大请求体收到 413，而不是连接被重置（readBody 不再 destroy）', async (t) => {
  const { inst } = await boot(t);
  // MAX_BODY 是 2MB，这里给 3MB。以前超限直接 req.destroy()，调用方拿到的是 ECONNRESET，
  // 用户界面上表现为「保存时页面转圈然后网络错误」，根本看不出是体积问题。
  const huge = JSON.stringify({ userName: 'x'.repeat(3 * 1024 * 1024) });
  const res = await fetch(`${inst.url}/api/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: huge,
  });
  assert.equal(res.status, 413, `超限应该回 413（实际 ${res.status}）`);
  const body = await res.json().catch(() => ({}));
  assert.equal(body.ok, false, '413 响应体要是 JSON，不能是空响应');
  assert.ok(String(body.error || '').length > 0, '413 要带上可读原因');
});

/* ---------------- token 恒定时间比较 ---------------- */

test('safeEqual：一致放行、不一致拒绝、长度不同也不抛', () => {
  assert.equal(safeEqual('change-me-wechat', 'change-me-wechat'), true);
  assert.equal(safeEqual('abc', 'abd'), false, '差一个字符就必须判不等');
  assert.equal(safeEqual('abc', 'abcd'), false, '长度不同要直接判不等（timingSafeEqual 会抛，必须提前挡）');
  assert.equal(safeEqual('', ''), true);
  assert.equal(safeEqual(null, ''), true, 'null 按空串处理，不能抛');
  assert.equal(safeEqual(undefined, 'x'), false);
  assert.equal(safeEqual(123, '123'), true, '数字按字符串比较');
  assert.equal(safeEqual('ABC', 'abc'), false, '不能大小写不敏感');
});

test('safeEqual：中文 / 多字节 token 按字节比，不会因为编码错位误判', () => {
  const token = '鲸鱼娘-令牌-🔑';
  assert.equal(safeEqual(token, token), true);
  assert.equal(safeEqual(token, token + ' '), false);
});

/* ---------------- 远程写操作鉴权 ---------------- */

function fakeReq({ remoteAddress = '192.168.1.9', token = '' } = {}) {
  return { socket: { remoteAddress }, headers: token ? { 'x-bot-token': token } : {} };
}

test('远程写：没开 allowRemote 一律拒（局域网裸奔那次的修复）', () => {
  const runtime = { config: { server: { allowRemote: false }, gateway: { wechat: { inboundToken: 'real-token' } } } };
  assert.equal(remoteAuthorized(fakeReq({ token: 'real-token' }), runtime), false);
});

test('远程写：开着 allowRemote 但 token 还是默认值，也必须拒', () => {
  for (const token of ['change-me-wechat', '', '   ']) {
    const runtime = { config: { server: { allowRemote: true }, gateway: { wechat: { inboundToken: token } } } };
    assert.equal(remoteAuthorized(fakeReq({ token: 'change-me-wechat' }), runtime), false, `默认/空 token（${JSON.stringify(token)}）不能算鉴权通过`);
  }
});

test('远程写：开了 allowRemote 且带对 token 才放行，错 token 拒绝', () => {
  const runtime = { config: { server: { allowRemote: true }, gateway: { wechat: { inboundToken: 'real-token' } } } };
  assert.equal(remoteAuthorized(fakeReq({ token: 'real-token' }), runtime), true);
  assert.equal(remoteAuthorized(fakeReq({ token: 'real-toke' }), runtime), false);
  assert.equal(remoteAuthorized(fakeReq({ token: 'real-token ' }), runtime), true, '两端都要 trim 后再比');
});
