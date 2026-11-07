'use strict';

/**
 * 「问她天气她不知道」的回归测试。
 *
 * 两个独立的问题叠在一起：
 *   1. 搜到的东西没送进提示词 —— bot.js 里 webText 只赋给局部变量、写了个日志就完事，
 *      msg 上从没挂过它，而 persona.buildSystem 读的是 msg.webText。于是
 *      「【刚联网搜到的资料】」永远是空，搜索白跑。
 *   2. 就算送进去了，天气靠 Bing 摘要也答不准 —— 经常只有「多云」没有温度，
 *      还容易串到别的城市。现在天气走 open-meteo（免费、无 key、中文地名）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const config = require('../src/infra/config');

// 资料注入、天气优先和回退通过 search-bot.test.js 的真实 decide 路径验证，
// 不再绑定聊天模块内部变量名，避免拆服务后测试只验证代码长什么样。

test('联网有开关，配置项齐全', () => {
  const ds = config.DEFAULT_CONFIG.websearch;
  assert.ok(ds, 'DEFAULT_CONFIG 要有 websearch 段');
  assert.equal(ds.enabled, true, '默认开着');
  assert.equal(typeof ds.city, 'string', 'city 是字符串（留空也行）');
  assert.ok(Number(ds.timeoutMs) > 0, '要有超时');
  // 示例配置也要有，别让新用户漏掉
  const ex = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  assert.ok(ex.websearch, 'config.example.json 要有 websearch 段');
  assert.equal(typeof ex.websearch.city, 'string', '示例里要能看到 city 这一项');
});

test('天气代码翻译表覆盖主要天气', () => {
  const { wmoText } = require('../src/adapters/websearch');
  assert.equal(wmoText(0), '晴');
  assert.equal(wmoText(3), '阴');
  assert.equal(wmoText(61), '小雨');
  assert.equal(wmoText(71), '小雪');
  assert.equal(wmoText(95), '雷阵雨');
  assert.match(wmoText(12345), /12345/, '没见过的代码也要给个能看的说法');
});

test('没配城市时按 IP 猜，失败可恢复且成功缓存（离线 transport fixture）', async (t) => {
  const { ipCity } = require('../src/adapters/websearch');
  const { EventEmitter } = require('node:events');
  const https = require('node:https');
  let requests = 0;
  t.mock.method(https, 'get', (url, opts, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    const attempt = ++requests;
    queueMicrotask(() => {
      if (attempt === 1) return req.emit('error', new Error('offline fixture'));
      const res = new EventEmitter();
      Object.assign(res, { statusCode: 200, headers: {}, complete: true });
      callback(res);
      res.emit('data', Buffer.from('{"city":"Beijing"}'));
      res.emit('end');
    });
    return req;
  });
  assert.equal(await ipCity(100), '');
  assert.equal(await ipCity(100), 'Beijing');
  assert.equal(await ipCity(100), 'Beijing');
  assert.equal(requests, 2, '成功结果缓存，失败不缓存');
});

/**
 * 3.4.8 线上事故：默认人设（没写 customPrompt）根本拿不到联网资料。
 * 3.4.6 把 webText 只塞进了「自定义人设」分支，配置里 customPrompt 是空的
 * （出厂就是空），于是日志「天气查询：北京」明明成功了，她照样回
 * 「我这边看不到天气啊，得你自己查查」。这条测试直接调 buildSystem 验行为，
 * 不再只拿正则看源码里有没有 msg.webText。
 */
test('默认人设也要把联网资料塞进提示词', () => {
  const { assemblePrompt } = require('./support/prompt');
  const { DEFAULT_CONFIG } = config;
  const cfg = { ...DEFAULT_CONFIG, persona: { ...DEFAULT_CONFIG.persona, customPrompt: '' } };
  // 联网资料是每轮会变的内容，现在挂在尾部：断言拼装后的全文
  const sys = assemblePrompt({
    config: cfg,
    msg: {
      chatType: 'private',
      senderName: '主人',
      text: '北京的天气怎么样？',
      webText: '【北京 实时天气】\n现在 10.7°C（体感 10.3°C，阴）',
    },
    now: new Date('2026-10-26T02:05:00'),
  }).prompt;
  assert.match(sys, /刚联网搜到的资料/, '要有资料块');
  assert.match(sys, /10\.7°C/, '资料原文要进提示词');
  assert.match(sys, /确实能联网/, '要明确告诉她能联网，别回「我连不了网」');
});
