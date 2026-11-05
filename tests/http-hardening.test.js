'use strict';

/**
 * 3.57「安全小修」那三条的回归测试 —— 当年改完只在 CHANGELOG 里写了，
 * 一行测试都没有，所以后来谁动 http 层都没人拦。
 *
 *   1) 每个响应都要挂安全头（nosniff / 禁止被 iframe 嵌套 / no-referrer / CSP）。
 *   2) 跨站写请求一律拒绝（CSRF 闸），远程访问必须带 token。
 *   3) token 比较走恒定时间（`crypto.timingSafeEqual`），别用 `===` 靠响应时间泄密；
 *      长度不同、非字符串、null 都不能抛异常。
 *
 * 静态文件那一组（web/ 目录防穿越）随网页界面一起删除了 —— 现在根路径一律 404 JSON。
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

/** 起一个临时站点（没有 web/ 目录：内核已经不提供静态文件） */
function makeSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-hardening-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false, log: { level: 'error' } }),
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

/* ---------------- 畸形请求不拖垮服务 ---------------- */

test('畸形 URL 不会把服务搞挂，下一个请求照样能用', async (t) => {
  const { port } = await boot(t);
  const bad = await rawGet(port, '/%E0%A4%A');
  assert.ok([400, 500].includes(bad.status), `畸形 URL 应该给出 4xx/5xx，实际 ${bad.status}`);
  const after = await rawGet(port, '/api/status');
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

test('安全响应头：API 响应 / 根路径 404 / 未知路径 404 都要带上', async (t) => {
  const { inst, port } = await boot(t);

  const api = await fetch(`${inst.url}/api/status`);
  assert.equal(api.status, 200);
  assertSecurityHeaders(Object.fromEntries(api.headers), 'API 响应');

  const rootPath = await rawGet(port, '/');
  assert.equal(rootPath.status, 404);
  assertSecurityHeaders(rootPath.headers, '根路径 404');

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
