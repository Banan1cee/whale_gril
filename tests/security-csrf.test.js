'use strict';

/**
 * 本地控制台的 CSRF 防护。
 *
 * 实测过的漏洞：任何网页都能向 127.0.0.1:8787 POST（哪怕用 text/plain，
 * 浏览器不会预检），于是「打开一个恶意页面」就能改她的设置 / 称呼 / 模型地址。
 * 现在：跨站写请求一律 403；同源写操作必须是 application/json；非浏览器客户端（桥接）不受影响。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-csrf-'));
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false, log: { level: 'error' } })
  );
  const inst = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  return { inst, root };
}

const post = (url, { origin, type = 'application/json', body = '{"userName":"后台被人改了"}' } = {}) => {
  const headers = { 'content-type': type };
  if (origin) headers.origin = origin;
  return fetch(url, { method: 'POST', headers, body });
};

test('跨站请求（Origin 是别人的站）必须 403', async () => {
  const { inst, root } = await boot();
  try {
    for (const origin of ['https://evil.example', 'http://192.168.1.9:8787', 'https://github.com']) {
      const res = await post(`${inst.url}/api/settings`, { origin });
      assert.equal(res.status, 403, `来自 ${origin} 的写请求应该被拒`);
    }
    // 设置没被改
    const settings = await (await fetch(`${inst.url}/api/settings`)).json();
    assert.notEqual(settings.userName, '后台被人改了', '跨站请求不能真的改到设置');
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('同源页面的正常保存要放行', async () => {
  const { inst, root } = await boot();
  try {
    const res = await post(`${inst.url}/api/settings`, { origin: `http://127.0.0.1:${inst.port}` });
    assert.equal(res.status, 200);
    const settings = await (await fetch(`${inst.url}/api/settings`)).json();
    assert.equal(settings.userName, '后台被人改了');
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('同源但用 text/plain 提交要 415（挡住表单式 CSRF）', async () => {
  const { inst, root } = await boot();
  try {
    const res = await post(`${inst.url}/api/settings`, {
      origin: `http://127.0.0.1:${inst.port}`,
      type: 'text/plain',
    });
    assert.equal(res.status, 415);
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('不带 Origin 的客户端（微信桥接 / curl）不受影响', async () => {
  const { inst, root } = await boot();
  try {
    const res = await post(`${inst.url}/api/settings`, {});
    assert.equal(res.status, 200, '桥接和命令行没有 Origin，不能被误伤');
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('只读接口不受 CSRF 闸影响', async () => {
  const { inst, root } = await boot();
  try {
    const res = await fetch(`${inst.url}/api/status`, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 200, 'GET 不该被拦（浏览器也读不到内容，因为没有 CORS 头）');
  } finally {
    await inst.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

const links = require('../src/adapters/links');

test('群友发的本机/内网链接不读（SSRF）', () => {
  for (const host of ['127.0.0.1', 'localhost', '192.168.1.1', '10.1.2.3', '172.20.0.9', '169.254.169.254', '::1']) {
    assert.equal(links.isPrivateHost(host), true, host + ' 应该被挡住');
  }
  for (const host of ['example.com', 'www.bilibili.com', '8.8.8.8']) {
    assert.equal(links.isPrivateHost(host), false, host + ' 是公网，应该放行');
  }
});

test('读本机控制台链接会被拒绝（不是抓回来喂给模型）', async () => {
  const r = await links.describeLink('http://127.0.0.1:8787/api/memory/export');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'private_host');
});
