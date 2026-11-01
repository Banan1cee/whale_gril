'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dns = require('node:dns');

const { extractUrls, parsePage, fetchUrl, describeLink, formatForPrompt, kindOf } = require('../src/adapters/links');

test('从聊天文字里提取链接，去掉句末标点、去重、最多两个', () => {
  assert.deepEqual(extractUrls('看看这个 https://v.douyin.com/abc123/ 好笑'), ['https://v.douyin.com/abc123/']);
  assert.deepEqual(extractUrls('https://example.com/a?x=1，真的'), ['https://example.com/a?x=1']);
  assert.deepEqual(extractUrls('https://example.com/a 和 https://example.com/a'), ['https://example.com/a']);
  assert.equal(extractUrls('a https://x.com/1 b https://y.com/2 c https://z.com/3').length, 2);
  assert.deepEqual(extractUrls('没有链接只有文字'), []);
  assert.deepEqual(extractUrls('ftp://example.com/x'), []);
});

test('识别链接类型（短视频 / 文章 / 普通网页）', () => {
  assert.equal(kindOf('https://v.douyin.com/abc/'), 'video');
  assert.equal(kindOf('https://www.bilibili.com/video/BV1xx'), 'video');
  assert.equal(kindOf('https://mp.weixin.qq.com/s/abc'), 'article');
  assert.equal(kindOf('https://example.com/a'), 'web');
});

test('parsePage 能解析 og 标题、描述和正文段落', () => {
  const html = `<html><head><title>普通标题</title>
    <meta property="og:title" content="OG 标题" />
    <meta name="description" content="这是页面描述" />
    </head><body>
    <p>第一段正文内容超过十二个字符了</p>
    <p>第二段正文内容也超过十二个字符</p>
    </body></html>`;
  const info = parsePage(html, 'https://mp.weixin.qq.com/s/abc');
  assert.equal(info.title, 'OG 标题');
  assert.match(info.description, /这是页面描述/);
  assert.match(info.article, /第一段正文/);
});

test('describeLink 能抓本地页面并返回标题描述', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><head><meta property="og:title" content="抖音视频标题"><meta property="og:description" content="视频文案在这里"></head></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  // 测试用的就是这个进程里的临时服务器，显式允许私网（线上默认不允许）
  const info = await describeLink(`http://127.0.0.1:${port}/v/123`, { allowPrivate: true });
  assert.equal(info.ok, true);
  assert.equal(info.title, '抖音视频标题');
  assert.match(info.description, /视频文案/);
  const text = formatForPrompt(info);
  assert.match(text, /链接标题/);
  await new Promise((r) => server.close(r));
});

test('链接打不开时返回可读结果，不抛异常', async () => {
  const info = await describeLink('http://127.0.0.1:1/nope', { timeoutMs: 1500, allowPrivate: true });
  assert.equal(info.ok, false);
  assert.ok(info.error);
  assert.match(formatForPrompt(info), /打不开/);
});

test('短视频平台的提示里会说明「只看到文案，没看画面」', () => {
  const text = formatForPrompt({ ok: true, url: 'https://v.douyin.com/x', kind: 'video', title: '猫猫', description: '一只猫' });
  assert.match(text, /没有真的看完视频/);
});

test('域名解析到内网/回环要拦下（SSRF），解析失败按网络错误返回', async (t) => {
  t.mock.method(dns, 'lookup', (host, cb) => cb(null, '10.1.2.3'));
  const blocked = await fetchUrl('http://public.example/', { timeoutMs: 500 });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'private_host');

  dns.lookup.mock.restore();
  t.mock.method(dns, 'lookup', (host, cb) => {
    const err = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    cb(err);
  });
  const failed = await fetchUrl('http://no-such-host.example/', { timeoutMs: 500 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'ENOTFOUND', '解析失败不能吞成 private_host');
});

test('allowPrivate 语义不变：显式放行时不做 DNS 拦截', async (t) => {
  const server = http.createServer((req, res) => { res.end('<title>ok</title>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const port = server.address().port;
  const info = await describeLink(`http://127.0.0.1:${port}/p`, { allowPrivate: true, timeoutMs: 1000 });
  assert.equal(info.ok, true);
  assert.equal(info.title, 'ok');
});

test('重定向链共用一个总预算，不会每跳重新计时', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    setTimeout(() => {
      if (req.url === '/0') { res.writeHead(302, { location: '/1' }); res.end(); return; }
      if (req.url === '/1') { res.writeHead(302, { location: '/2' }); res.end(); return; }
      if (req.url === '/2') { res.writeHead(302, { location: '/3' }); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>done</title>');
    }, 120);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const started = Date.now();
  // 4 跳 × 120ms = 480ms；总预算 200ms，旧实现每跳重新计时才会全部跑完
  const res = await fetchUrl(`http://127.0.0.1:${port}/0`, { timeoutMs: 200, allowPrivate: true });
  const elapsed = Date.now() - started;
  await new Promise((r) => server.close(r));
  assert.equal(res.ok, false);
  assert.equal(res.error, 'timeout');
  assert.ok(hits < 4, '不该把每一跳都跑满：实际请求了 ' + hits + ' 次');
  assert.ok(elapsed < 600, '总耗时应该接近总预算，实际 ' + elapsed + 'ms');
});
