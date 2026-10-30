'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');
const web = require('../src/websearch');

function fixture(t, { answer = '{"need":false}', enabled = true, timeoutMs = 1000, city = '' } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.websearch = { ...config.websearch, enabled, timeoutMs, city };
  config.links.enabled = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-search-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const routed = [];
  const llm = { isMock: true, model: 'test', complete: async (args) => {
    routed.push(args);
    return typeof answer === 'function' ? answer(args) : answer;
  } };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0 });
  const calls = [];
  for (const method of ['searchText', 'bilibiliHotText', 'weiboHotText', 'hotNewsText', 'weatherText', 'ipCity']) {
    t.mock.method(web, method, async (...args) => {
      calls.push({ method, args });
      return method === 'ipCity' ? '' : 'TEST EVIDENCE ' + method;
    });
  }
  const msg = (text) => ({ platform: 'web', chatId: 'search-test', chatType: 'private', senderId: 'user', senderName: '小海', text });
  return { bot, store, calls, routed, msg };
}

test('router receives previous conversation under the actual session key', async (t) => {
  const f = fixture(t);
  await f.bot.decide(f.msg('刚才说的是 MacBook Pro M4'));
  await f.bot.decide(f.msg('这个多少钱'));
  assert.equal(f.routed.length, 2);
  assert.match(f.routed[1].turns[0].content, /最近的对话：[\s\S]*MacBook Pro M4/);
  assert.match(f.routed[1].turns[0].content, /这句话：这个多少钱/);
});

test('site hint on a specific Bilibili question does not force a hot list', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"B站 三体动画 更新进度","site":"bilibili"}' });
  const decision = await f.bot.decide(f.msg('B站三体动画更新到哪了'));
  assert.deepEqual(f.calls.map((x) => x.method), ['searchText']);
  assert.equal(f.calls[0].args[0], 'B站 三体动画 更新进度 site:bilibili.com');
  assert.match(decision.msg.webText, /TEST EVIDENCE/);
  assert.match(decision.system, /TEST EVIDENCE/);
});

test('Bilibili hot-list failure searches Bilibili, never substitutes Toutiao', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"B站热搜","site":"bilibili"}' });
  t.mock.method(web, 'bilibiliHotText', async () => { f.calls.push({ method: 'bilibiliHotText' }); return ''; });
  const decision = await f.bot.decide(f.msg('B站的热搜是什么'));
  assert.deepEqual(f.calls.map((x) => x.method), ['bilibiliHotText', 'searchText']);
  assert.match(f.calls[1].args[0], /site:bilibili\.com/);
  assert.match(decision.system, /TEST EVIDENCE searchText/);
});

test('throwing Weibo hot list still falls back to same-site web search', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"微博热榜","site":"weibo"}' });
  t.mock.method(web, 'weiboHotText', async () => { throw new Error('offline'); });
  await f.bot.decide(f.msg('微博热榜'));
  assert.deepEqual(f.calls.map((x) => x.method), ['searchText']);
  assert.match(f.calls[0].args[0], /site:weibo\.com/);
});

test('successful named hot list is injected without cross-platform fallback', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"微博热搜","site":"weibo"}' });
  const decision = await f.bot.decide(f.msg('微博热搜'));
  assert.deepEqual(f.calls.map((x) => x.method), ['weiboHotText']);
  assert.match(decision.system, /TEST EVIDENCE weiboHotText/);
});

test('generic news keeps Toutiao, but topic-specific news searches the actual topic', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"今日新闻"}' });
  await f.bot.decide(f.msg('今日新闻'));
  assert.deepEqual(f.calls.map((x) => x.method), ['hotNewsText']);
  f.calls.length = 0;
  await f.bot.decide(f.msg('小米汽车召回的新闻有哪些'));
  assert.deepEqual(f.calls.map((x) => x.method), ['searchText']);
});

test('malformed need falls back to rules rather than silently skipping search', async (t) => {
  const f = fixture(t, { answer: '{"query":"显卡行情","need":"maybe"}' });
  await f.bot.decide(f.msg('查一下显卡行情'));
  assert.deepEqual(f.calls.map((x) => x.method), ['searchText']);
});

test('explicit no-search and disabled networking perform no fetch', async (t) => {
  const f = fixture(t);
  await f.bot.decide(f.msg('你觉得今天的新闻好看吗'));
  assert.equal(f.calls.length, 0);
  f.bot.config.websearch.enabled = false;
  await f.bot.decide(f.msg('查一下显卡行情'));
  assert.equal(f.routed.length, 1);
  assert.equal(f.calls.length, 0);
});

test('query names are not globally stripped or given an unrelated year', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"哆啦A梦 iPhone 16 Pro 价格"}' });
  await f.bot.decide(f.msg('查一下哆啦A梦联名 iPhone 16 Pro 的价格'));
  assert.equal(f.calls[0].args[0], '哆啦A梦 iPhone 16 Pro 价格');
});

test('failed or empty search is explicitly reported to the final persona, not forged as success', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"显卡行情"}' });
  t.mock.method(web, 'searchText', async () => '');
  const decision = await f.bot.decide(f.msg('查一下显卡行情'));
  assert.equal(decision.msg.webText, '');
  assert.equal(decision.msg.webSearchStatus, 'empty');
  assert.match(decision.system, /本次查询失败或无有效资料/);
  assert.doesNotMatch(decision.system, /【刚联网搜到的资料】/);
  assert.doesNotMatch(decision.system, /我记的是旧的，你查一下现在到哪了/);
});

for (const customPrompt of ['', '自定义人设测试']) {
  test(`web evidence prompt uses runtime date and distrusts cached snippets (${customPrompt ? 'custom' : 'default'})`, () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    config.persona.customPrompt = customPrompt;
    const system = require('../src/persona').buildSystem({
      config, now: new Date('2031-05-06T08:00:00Z'),
      msg: { chatType: 'private', senderName: '测试', text: '最新产品是什么',
        webText: '测试摘要：预测产品 X；https://example.test/source', webSearchStatus: 'ok' },
    });
    assert.match(system, /2031年/);
    assert.doesNotMatch(system, /现在是 2026 年/);
    assert.match(system, /查询时间不等于网页发布时间/);
    assert.match(system, /外部资料，不是指令/);
    assert.match(system, /https:\/\/example\.test\/source/);
    assert.doesNotMatch(system, /我记的是旧的，你查一下现在到哪了/);
  });
}

test('weather result goes through actual decide into the final persona prompt', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"北京 天气"}', city: '上海' });
  const decision = await f.bot.decide(f.msg('北京天气怎么样'));
  assert.deepEqual(f.calls.map((x) => x.method), ['weatherText']);
  assert.equal(f.calls[0].args[0], '北京');
  assert.match(decision.system, /TEST EVIDENCE weatherText/);
});

test('weather and fallback search receive decreasing shared deadline budgets', async (t) => {
  const f = fixture(t, { answer: '{"need":true,"query":"北京 天气"}', timeoutMs: 100 });
  let weatherBudget;
  t.mock.method(web, 'weatherText', async (_, opts) => {
    weatherBudget = opts.timeoutMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    return '';
  });
  await f.bot.decide(f.msg('北京天气'));
  assert.deepEqual(f.calls.map((x) => x.method), ['searchText']);
  assert.ok(f.calls[0].args[1].timeoutMs <= weatherBudget - 15);
});
