'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { extractUrls, parsePage, describeLink, formatForPrompt, kindOf } = require('../src/links');

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
  const info = await describeLink(`http://127.0.0.1:${port}/v/123`);
  assert.equal(info.ok, true);
  assert.equal(info.title, '抖音视频标题');
  assert.match(info.description, /视频文案/);
  const text = formatForPrompt(info);
  assert.match(text, /链接标题/);
  await new Promise((r) => server.close(r));
});

test('链接打不开时返回可读结果，不抛异常', async () => {
  const info = await describeLink('http://127.0.0.1:1/nope', { timeoutMs: 1500 });
  assert.equal(info.ok, false);
  assert.ok(info.error);
  assert.match(formatForPrompt(info), /打不开/);
});

test('短视频平台的提示里会说明「只看到文案，没看画面」', () => {
  const text = formatForPrompt({ ok: true, url: 'https://v.douyin.com/x', kind: 'video', title: '猫猫', description: '一只猫' });
  assert.match(text, /没有真的看完视频/);
});
