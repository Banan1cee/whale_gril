'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { search } = require('../src/services/search');
const { result, formatResult } = require('../src/core/search/result');
const { parseRoute, systemFor } = require('../src/adapters/searchRouter');
const { weatherSnippet } = require('../src/adapters/search/weather');

const evidence = provider => result([{ title: '测试资料', snippet: '可核实的事实', url: 'https://example.test/source',
  provider, fetchedAt: '2026-11-06T00:00:00Z', publishedAt: null }]);

function fixture(route = {}) {
  const calls = [];
  const deps = {
    route: async () => ({ need: true, query: '测试检索', fresh: 'normal', ...route }),
    providers: Object.fromEntries(['weatherResult', 'hotlistResult', 'searchResult'].map(method => [method, async (...args) => {
      calls.push({ method, args });
      return evidence(method);
    }])),
    places: { geocodeCity: async () => null, ipCity: async () => '' },
  };
  const run = (text, extra = {}) => search({ text, config: { semanticRoute: true, timeoutMs: 1000 }, ...extra }, deps);
  return { calls, deps, run };
}

test('路由完整意图直接驱动数据源，旧格式仍能回退规则', async () => {
  const parsed = parseRoute('{"need":true,"kind":"weather","query":"北京 降水","city":"北京","timeRange":"tomorrow"}');
  assert.equal(parsed.kind, 'weather');
  assert.equal(parsed.timeRange, 'tomorrow');
  assert.equal(parseRoute('{"need":true,"kind":"unknown","query":"x"}'), null);
  assert.equal(parseRoute('{"need":true,"query":"x","timeRange":"broken"}'), null);
  const f = fixture(parsed);
  const value = await f.run('明天出门需要带点什么');
  assert.equal(f.calls[0].method, 'weatherResult');
  assert.equal(value.status, 'ok');
  assert.match(value.text, /open|weatherResult/);
});

test('空气质量、台风、远期和指定日期不拿今明天气冒充答案', async () => {
  for (const text of ['北京空气质量', '北京台风路径', '北京后天天气', '北京周末天气', '北京2027年1月1日天气']) {
    const f = fixture({ kind: 'weather', city: '北京' });
    await f.run(text);
    assert.deepEqual(f.calls.map(x => x.method), ['searchResult'], text);
  }
});

test('模型明确要求普通检索时不再用关键词覆盖为热榜', async () => {
  const f = fixture({ kind: 'web', site: 'weibo', query: '微博 某事件 热搜 原因' });
  await f.run('微博某事件为什么上热搜');
  assert.equal(f.calls[0].method, 'searchResult');
  assert.match(f.calls[0].args[0], /site:weibo\.com$/);
});

test('路由失败时具体主题新闻仍查主题，不取全站榜单', async () => {
  const f = fixture({ need: false, failed: true });
  await f.run('今天小米汽车的新闻有哪些');
  assert.equal(f.calls[0].method, 'searchResult');
  assert.match(f.calls[0].args[0], /小米汽车/);
});

test('问题地点优先于默认城市，无法解析也不偷偷换成默认城市', async () => {
  const f = fixture({ kind: 'weather', query: '杭州 明天 天气' });
  const place = { name: '杭州', latitude: 30, longitude: 120, timezone: 'Asia/Shanghai' };
  f.deps.places.geocodeCity = async name => { assert.equal(name, '杭州'); return place; };
  await f.run('杭州明天会下雨吗', { config: { city: '上海' } });
  assert.equal(f.calls[0].args[0], '杭州');
  assert.equal(f.calls[0].args[1].place, place, '已解析地点不重复地理编码');
  f.calls.length = 0;
  f.deps.places.geocodeCity = async () => null;
  await f.run('杭州明天会下雨吗', { config: { city: '上海' } });
  assert.equal(f.calls[0].method, 'searchResult');
  assert.doesNotMatch(f.calls[0].args[0], /上海/);
});

test('省略地点时使用配置或 IP，天气失败保留明天需求', async () => {
  const f = fixture({ kind: 'weather', query: '明天 下雨' });
  f.deps.places.ipCity = async () => '杭州';
  f.deps.providers.weatherResult = async (city, opts) => {
    assert.equal(city, '杭州');
    assert.ok(opts.timeoutMs < 1000);
    return result([], { status: 'failed', reason: 'http_error', attempts: [{ provider: 'open-meteo', status: 'failed', statusCode: 503 }] });
  };
  const value = await f.run('明天会下雨吗');
  assert.equal(value.status, 'ok');
  assert.match(f.calls[0].args[0], /杭州.*明天/);
  assert.ok(value.attempts.some(x => x.provider === 'open-meteo' && x.status === 'failed'));
});

test('关闭联网不读取历史，空结果与异常有不同状态', async () => {
  const f = fixture();
  const off = await f.run('查一下价格', { config: { enabled: false }, history: () => { throw new Error('must not read'); } });
  assert.equal(off.status, 'skipped');
  assert.equal(f.calls.length, 0);
  f.deps.providers.searchResult = async () => result();
  assert.equal((await f.run('查一下价格')).status, 'empty');
  f.deps.providers.searchResult = async () => { throw new Error('query and private response'); };
  const logs = [];
  const failed = await f.run('查一下价格', { trace: (stage, data) => logs.push({ stage, ...data }) });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.text, '');
  assert.ok(logs.some(x => x.description?.includes('detail=network_error')));
  assert.doesNotMatch(JSON.stringify(logs), /private|查一下价格/);
});

test('调用者取消能打断路由，不触发后续检索', async () => {
  const controller = new AbortController();
  let routeSignal;
  const value = await search({ text: '查一下显卡价格', signal: controller.signal, llm: { complete: args => {
    routeSignal = args.signal;
    queueMicrotask(() => controller.abort());
    return new Promise(() => {});
  } }, config: { timeoutMs: 1000 } });
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, 'aborted');
  assert.equal(routeSignal.aborted, true);
});

test('总预算为零不启动任何路由或网络', async () => {
  const f = fixture();
  f.deps.route = async () => { throw new Error('must not route'); };
  const value = await f.run('查一下价格', { config: { timeoutMs: 0 } });
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, 'deadline_exceeded');
  assert.equal(f.calls.length, 0);
});

test('天气缺失温度不能只凭标题伪装成成功，缺失降水不能写成零', () => {
  const place = { timezone: 'Asia/Shanghai' };
  assert.equal(weatherSnippet(place, {}), '');
  const text = weatherSnippet(place, { current: { time: '2026-11-06T12:00', temperature_2m: 10 },
    daily: { time: ['2026-11-06'], temperature_2m_min: [5], temperature_2m_max: [15] } });
  assert.match(text, /2026-11-06/);
  assert.doesNotMatch(text, /undefined|null|降水概率 0%/);
});

test('格式化保留来源和获取时间，不把它们写成发布时间', () => {
  const value = evidence('bing');
  value.items[0].snippet = '长摘要'.repeat(1000);
  const text = formatResult(value, { maxChars: 300 });
  assert.ok(text.length <= 300);
  assert.match(text, /https:\/\/example\.test\/source/);
  assert.match(text, /发布时间未确认/);
  assert.match(text, /获取时间：2026-11-06/);
});

test('路由北京时间与机器本地时区无关', () => {
  assert.match(systemFor(new Date('2026-11-06T20:30:00Z')), /2026-11-07 周六 04:30（北京时间）/);
});

test('模型识别出的时间范围不会在改写查询后丢失', async () => {
  const f = fixture({ kind: 'web', timeRange: 'today', fresh: 'any', query: '发布会 新闻' });
  await f.run('今儿有什么发布会消息');
  assert.equal(f.calls[0].args[1].maxAgeDays, 2);
});
