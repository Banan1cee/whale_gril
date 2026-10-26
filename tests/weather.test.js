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
const bot = fs.readFileSync(path.join(root, 'src', 'bot.js'), 'utf8');
const persona = fs.readFileSync(path.join(root, 'src', 'persona.js'), 'utf8');
const websearch = fs.readFileSync(path.join(root, 'src', 'websearch.js'), 'utf8');
const config = require('../src/config');

test('搜到的资料真的挂到 msg 上（否则 persona 那段永远是空）', () => {
  // persona 读的是 msg.webText
  assert.match(persona, /msg\.webText/, 'persona 从 msg.webText 取资料');
  // bot 必须真的写回去
  assert.match(bot, /msg\.webText\s*=\s*webText/, 'bot 必须把 webText 挂到 msg 上');
  // 不能只是赋值给局部变量就完事
  const idx = bot.indexOf('msg.webText = webText');
  assert.ok(idx > 0, '找不到赋值语句');
  assert.ok(
    bot.indexOf('let webText') < idx,
    'webText 先声明、后挂到 msg 上'
  );
});

test('天气走专门的接口，不再只靠搜索引擎摘要', () => {
  assert.match(websearch, /open-meteo\.com/, '要接 open-meteo');
  assert.match(websearch, /async function weatherText/, '要有 weatherText');
  assert.match(websearch, /async function geocodeCity/, '要先地名转经纬度');
  assert.match(websearch, /temperature_2m/, '要取实际温度');
  assert.match(websearch, /apparent_temperature/, '要取体感温度');
  assert.match(websearch, /precipitation_probability_max/, '要取降水概率');
  // 天气代码要能翻成人话，不能把数字丢给模型
  assert.match(websearch, /function wmoText/, '要有天气代码翻译');
  assert.match(websearch, /雷阵雨/, '常见天气要能说清');
  // 导出了才能用
  assert.match(websearch, /weatherText,\s*\n?\s*wmoText/, 'weatherText 要导出');
});

test('bot 里天气优先走 weatherText，失败才退回搜索', () => {
  assert.match(bot, /websearch\.weatherText\(/, '要调用 weatherText');
  const wIdx = bot.indexOf('websearch.weatherText(');
  const sIdx = bot.indexOf('websearch.searchText(');
  assert.ok(wIdx > 0 && sIdx > wIdx, 'weatherText 要在 searchText 之前尝试');
  // 城市从话里认，认不出用配置
  assert.match(bot, /webCfg\.city/, '要读配置里的城市');
  assert.match(bot, /weatherCity/, '要有「这次查哪个城市」的变量');
  // 话里没说、配置也没填 → 按本机 IP 猜，别再搜到随机城市
  assert.match(bot, /websearch\.ipCity\(/, '要用 IP 定位兜底');
  assert.match(bot, /本机公网 IP/, '注释要说清为什么需要 IP 兜底');
});

test('联网有开关，配置项齐全', () => {
  const ds = config.DEFAULT_CONFIG.websearch;
  assert.ok(ds, 'DEFAULT_CONFIG 要有 websearch 段');
  assert.equal(ds.enabled, true, '默认开着');
  assert.equal(typeof ds.city, 'string', 'city 是字符串（留空也行）');
  assert.ok(Number(ds.timeoutMs) > 0, '要有超时');
  assert.match(bot, /webCfg\.enabled !== false/, 'bot 要尊重 enabled 开关');
  // 示例配置也要有，别让新用户漏掉
  const ex = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  assert.ok(ex.websearch, 'config.example.json 要有 websearch 段');
  assert.equal(typeof ex.websearch.city, 'string', '示例里要能看到 city 这一项');
});

test('天气代码翻译表覆盖主要天气', () => {
  const { wmoText } = require('../src/websearch');
  assert.equal(wmoText(0), '晴');
  assert.equal(wmoText(3), '阴');
  assert.equal(wmoText(61), '小雨');
  assert.equal(wmoText(71), '小雪');
  assert.equal(wmoText(95), '雷阵雨');
  assert.match(wmoText(12345), /12345/, '没见过的代码也要给个能看的说法');
});

test('没配城市时会按 IP 猜，且猜不到也不报错', () => {
  const { ipCity } = require('../src/websearch');
  assert.equal(typeof ipCity, 'function', 'ipCity 要导出');
  // 纯逻辑检查：即使网络不通也必须 resolve 成字符串，不能抛
  const p = ipCity(1500);
  assert.ok(p && typeof p.then === 'function', 'ipCity 返回 Promise');
  return p.then((c) => {
    assert.equal(typeof c, 'string', '拿不到也要返回空字符串，不能 undefined');
  });
});

/**
 * 3.4.8 线上事故：默认人设（没写 customPrompt）根本拿不到联网资料。
 * 3.4.6 把 webText 只塞进了「自定义人设」分支，配置里 customPrompt 是空的
 * （出厂就是空），于是日志「天气查询：北京」明明成功了，她照样回
 * 「我这边看不到天气啊，得你自己查查」。这条测试直接调 buildSystem 验行为，
 * 不再只拿正则看源码里有没有 msg.webText。
 */
test('默认人设也要把联网资料塞进提示词', () => {
  const persona = require('../src/persona');
  const { DEFAULT_CONFIG } = config;
  const cfg = { ...DEFAULT_CONFIG, persona: { ...DEFAULT_CONFIG.persona, customPrompt: '' } };
  const sys = persona.buildSystem({
    config: cfg,
    msg: {
      chatType: 'private',
      senderName: '主人',
      text: '北京的天气怎么样？',
      webText: '【北京 实时天气】\n现在 10.7°C（体感 10.3°C，阴）',
    },
    now: new Date('2026-10-26T02:05:00'),
  });
  assert.match(sys, /刚联网搜到的资料/, '要有资料块');
  assert.match(sys, /10\.7°C/, '资料原文要进提示词');
  assert.match(sys, /确实能联网/, '要明确告诉她能联网，别回「我连不了网」');
});
