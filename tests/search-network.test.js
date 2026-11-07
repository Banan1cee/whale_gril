'use strict';

// Real production functions; only the transport is replaced. No WeChat, real LLM, or network.
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const web = require('../src/adapters/websearch');
const { route } = require('../src/adapters/searchRouter');
const { DeepSeekClient, LlmError } = require('../src/llm/client');

function fakeHttps(t, handler) {
  const calls = [];
  const timers = new Set();
  const later = (fn, ms = 0) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  t.mock.method(https, 'get', (url, options, callback) => {
    const call = { url: String(url), options, destroyed: false };
    calls.push(call);
    const req = new EventEmitter();
    let res;
    let idleTimer;
    let idleMs;
    let idleCallback;
    const resetIdle = () => {
      clearTimeout(idleTimer);
      if (idleMs) idleTimer = later(idleCallback, idleMs);
    };
    req.setTimeout = (ms, cb) => { idleMs = ms; idleCallback = cb; resetIdle(); return req; };
    req.destroy = (err) => {
      call.destroyed = true;
      clearTimeout(idleTimer);
      if (res) res.destroy();
      if (err) queueMicrotask(() => req.emit('error', err));
    };
    later(() => {
      if (call.destroyed) return;
      const spec = handler(call, calls.length - 1) || {};
      if (spec.error) return req.emit('error', new Error(spec.error));
      if (spec.never) return;
      res = new EventEmitter();
      res.statusCode = spec.status || 200;
      res.headers = spec.headers || {};
      res.complete = false;
      res.destroyed = false;
      res.resume = () => res;
      res.destroy = () => { res.destroyed = true; res.emit('close'); };
      callback(res);
      if (spec.aborted) return later(() => res.emit('aborted'));
      if (spec.streamError) return later(() => res.emit('error', new Error('stream error')));
      if (spec.drip) {
        const drip = () => {
          if (res.destroyed) return;
          res.emit('data', Buffer.from(' '));
          resetIdle();
          later(drip, 5);
        };
        return drip();
      }
      later(() => {
        if (res.destroyed) return;
        res.emit('data', Buffer.from(spec.body || ''));
        res.complete = true;
        clearTimeout(idleTimer);
        res.emit('end');
        res.emit('close');
      }, spec.delay || 0);
    });
    return req;
  });
  return calls;
}

const bing = (...rows) => rows.map(([title, url, snippet = title]) =>
  `<li class="b_algo"><h2><a href="${url}">${title}</a></h2><p>${snippet}</p></li>`).join('');
const one = bing(['显卡行情 A', 'https://example.test/a']);

test('search trace reports source/filter evidence without query or body and cannot break results', async (t) => {
  fakeHttps(t, () => ({ body: bing(['显卡行情 A', 'https://example.test/a'], ['显卡行情 B', 'https://example.test/b']) }));
  const events = [];
  const results = await web.search('显卡行情', { trace: (stage, data) => events.push({ stage, ...data }) });
  assert.ok(results.length > 0);
  assert.ok(events.some(e => e.stage === 'filter' && e.parsed === 2));
  assert.ok(events.some(e => e.stage === 'result' && e.sources.includes('example.test')));
  assert.ok(!JSON.stringify(events).includes('显卡行情'));
  const again = await web.search('显卡行情', { trace: () => { throw new Error('broken logger'); } });
  assert.deepEqual(again, results);
});

test('search transport failure reports type/code/status instead of silently returning empty', async (t) => {
  fakeHttps(t, () => ({ error: 'private query detail' }));
  const events = [];
  assert.deepEqual(await web.search('显卡行情', { trace: (stage, data) => events.push({ stage, ...data }) }), []);
  assert.ok(events.some(e => e.stage === 'failed' && e.type === 'Error'));
  assert.ok(!JSON.stringify(events).includes('private'));
});

test('route input survives the real client payload contract (content, not text)', async () => {
  let payload;
  const client = Object.assign(Object.create(DeepSeekClient.prototype), { maxTokens: 700, temperature: 0.7, provider: 'test', logger: null });
  const result = await route({ complete: async (args) => {
    payload = client.buildPayload(args);
    return '{"need":true,"query":"iPhone 16 Pro 最新价格"}';
  } }, '这个多少钱', { history: ['刚发布的是 iPhone 16 Pro'] });
  assert.equal(result.need, true);
  assert.match(payload.messages.at(-1).content, /iPhone 16 Pro/);
  assert.match(payload.messages.at(-1).content, /这个多少钱/);
});

test('router deadline aborts complete instead of waiting indefinitely', async () => {
  let signal;
  const started = Date.now();
  const result = await route({ complete: (args) => new Promise((resolve, reject) => {
    signal = args.signal;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) }, '查一下显卡价格', { timeoutMs: 25 });
  assert.equal(result.failed, true);
  assert.equal(signal.aborted, true);
  assert.ok(Date.now() - started < 500);
});

test('real complete forwards abort signal and does not retry after cancellation', async () => {
  const client = Object.assign(Object.create(DeepSeekClient.prototype), { maxTokens: 700, temperature: 0.7, provider: 'test', logger: null });
  let opens = 0;
  client._open = async (payload, { signal }) => {
    opens++;
    assert.ok(signal);
    const res = new EventEmitter();
    res.statusCode = 200;
    res.destroy = () => { res.destroyed = true; };
    client.lastResponse = res;
    return { res };
  };
  const result = await route(client, '搜一下', { timeoutMs: 25 });
  assert.equal(result.failed, true);
  assert.equal(opens, 1);
  assert.equal(client.lastResponse.destroyed, true);
});

test('complete cancellation interrupts retry backoff', async () => {
  const client = Object.assign(Object.create(DeepSeekClient.prototype), { maxTokens: 700, temperature: 0.7, provider: 'test', logger: null });
  let opens = 0;
  client._open = async () => { opens++; throw new LlmError('offline', { code: 'network', retryable: true }); };
  const controller = new AbortController();
  const pending = client.complete({ turns: [], signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(opens, 1);
});

for (const sendHeaders of [false, true]) {
  test(`router timeout closes real loopback HTTP connection ${sendHeaders ? 'during body' : 'before headers'}`, async (t) => {
    let closedResolve;
    const closed = new Promise((resolve) => { closedResolve = resolve; });
    let requests = 0;
    const server = http.createServer((req, res) => {
      requests++;
      req.resume();
      res.on('close', closedResolve);
      if (sendHeaders) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"choices":['); // Intentionally incomplete local fixture, never a real LLM.
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    const client = Object.assign(Object.create(DeepSeekClient.prototype), {
      maxTokens: 700, temperature: 0.7, provider: 'test', logger: null,
      baseUrl: `http://127.0.0.1:${server.address().port}`, mock: false, needsKey: false,
      apiKey: '', timeoutMs: 1000, runtime: {},
    });
    assert.equal((await route(client, '查一下价格', { timeoutMs: 80 })).failed, true);
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('underlying connection was not closed')), 500);
      })]);
    } finally { clearTimeout(timer); }
    assert.equal(requests, 1, 'no retries may survive route cancellation');
  });
}

// 这些用例验证结果保留，不测耗时；并行 CI 的调度延迟不能抢走补搜预算。
// 超时与连接取消由下面的专用短时限用例约束。
const RETRY_FIXTURE_TIMEOUT_MS = 5000;

test('optional search retry failure preserves first successful result', async (t) => {
  const calls = fakeHttps(t, (_, i) => i === 0 ? { body: one } : { error: 'offline' });
  const results = await web.search('帮我查一下显卡行情', { timeoutMs: RETRY_FIXTURE_TIMEOUT_MS });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.test/a');
  assert.ok(calls.length >= 2);
});

test('failed initial search can recover through a normalized query', async (t) => {
  fakeHttps(t, (_, i) => i === 0 ? { error: 'offline' } : { body: one });
  assert.equal((await web.search('帮我查一下显卡行情', { timeoutMs: RETRY_FIXTURE_TIMEOUT_MS })).length, 1);
});

test('a single official supplement is retained after later empty attempts', async (t) => {
  fakeHttps(t, (call) => new URL(call.url).searchParams.get('q').startsWith('site:apple.com.cn')
    ? { body: bing(['iPhone 机型比较', 'https://www.apple.com.cn/iphone/compare/']) }
    : { body: '' });
  const results = await web.search('苹果最新的机器是什么', { timeoutMs: RETRY_FIXTURE_TIMEOUT_MS });
  assert.equal(results.length, 1);
  assert.match(results[0].url, /compare/);
});

test('failed optional official lookup cannot erase two valid first results', async (t) => {
  fakeHttps(t, (call) => new URL(call.url).searchParams.get('q').startsWith('site:apple.com.cn')
    ? { error: 'offline' }
    : { body: bing(['iPhone 产品 A', 'https://example.test/a'], ['iPhone 产品 B', 'https://example.test/b']) });
  const results = await web.search('苹果最新的机器是什么', { timeoutMs: RETRY_FIXTURE_TIMEOUT_MS });
  assert.equal(results.length, 2);
});

test('HTTP error pages are not accepted as search evidence', async (t) => {
  fakeHttps(t, () => ({ status: 503, body: one }));
  assert.deepEqual(await web.search('显卡行情', { timeoutMs: 100 }), []);
});

test('aborted and errored response streams resolve to safe empty results', async (t) => {
  fakeHttps(t, (_, i) => i % 2 ? { streamError: true } : { aborted: true });
  assert.deepEqual(await web.search('帮我查一下显卡行情', { timeoutMs: 100 }), []);
});

test('drip-fed response has an absolute deadline and destroys the request', async (t) => {
  const calls = fakeHttps(t, () => ({ drip: true }));
  const started = Date.now();
  assert.deepEqual(await web.search('显卡行情', { timeoutMs: 35 }), []);
  assert.ok(Date.now() - started < 500);
  assert.equal(calls.length, 1, 'no fresh full timeout for normalized retry');
  assert.equal(calls[0].destroyed, true);
});

test('redirect cycles are bounded and preserve required Weibo headers', async (t) => {
  const calls = fakeHttps(t, () => ({ status: 302, headers: { location: '/ajax/side/hotSearch' } }));
  // This case checks the redirect count. The next case checks the short deadline.
  // Leave enough wall-clock budget when the full suite runs concurrently in CI.
  assert.equal(await web.weiboHotText(10, 2000), '');
  assert.equal(calls.length, 6);
  for (const call of calls) assert.equal(call.options.headers.Referer, 'https://weibo.com/');
});

test('redirects share one wall-clock budget', async (t) => {
  const calls = fakeHttps(t, () => ({ status: 302, headers: { location: '/again' } }));
  assert.equal(await web.weiboHotText(10, 5), '');
  assert.ok(calls.length <= 6);
});

test('site constraints survive every normalized search attempt', async (t) => {
  const calls = fakeHttps(t, () => ({ body: '' }));
  await web.search('帮我查一下苹果最新的机器 site:bilibili.com', { timeoutMs: 200 });
  assert.ok(calls.length >= 2);
  for (const call of calls) {
    const q = new URL(call.url).searchParams.get('q');
    assert.match(q, /site:bilibili\.com/);
    assert.doesNotMatch(q, /site:apple\.com/);
  }
});

test('long queries cannot truncate away the requested platform', async (t) => {
  const calls = fakeHttps(t, () => ({ body: '' }));
  await web.search('超长作品名称'.repeat(30) + ' site:weibo.com', { timeoutMs: 200 });
  assert.ok(calls.length > 0);
  for (const call of calls) assert.match(new URL(call.url).searchParams.get('q'), /site:weibo\.com/);
});

test('named models survive cleaning and are never replaced by generic lineup queries', async (t) => {
  assert.match(web.cleanQuery('iPhone 16 Pro 最新型号多少钱'), /iPhone 16 Pro/);
  assert.match(web.cleanQuery('苹果 MacBook Pro M4 最新型号'), /MacBook Pro M4/);
  assert.match(web.cleanQuery('DeepSeek V3.2 最新价格'), /V3\.2/);
  assert.doesNotMatch(web.expandBrand('苹果 iPad 最新机型'), /iPhone/);
  const calls = fakeHttps(t, () => ({ body: '' }));
  await web.search('iPhone 16 Pro 最新型号多少钱', { timeoutMs: 200 });
  for (const call of calls) {
    const q = new URL(call.url).searchParams.get('q');
    assert.match(q.toLowerCase(), /iphone\s+16\s+pro/);
    assert.doesNotMatch(q, /site:apple\.com/);
  }
});

test('weather geocoding and forecast use one total deadline', async (t) => {
  const calls = fakeHttps(t, (call) => call.url.includes('geocoding-api')
    ? { delay: 60, body: JSON.stringify({ results: [{ name: '北京', latitude: 39.9, longitude: 116.4 }] }) }
    : { drip: true });
  const started = Date.now();
  assert.equal(await web.weatherText('北京', { timeoutMs: 300 }), '');
  assert.equal(calls.length, 2);
  const elapsed = Date.now() - started;
  // 要证明的是「两步共用一份预算」，不是「跑得快」：
  // 共用 → 约 300ms 收工；各等一个完整超时 → 600ms 起步。
  // 阈值取 500（离 600 有明显距离），给并行跑测试文件时卡顿的 CI 留余量。
  assert.ok(elapsed < 500, `共享预算失效：耗时 ${elapsed}ms（两步各等一个超时会是 600ms+）`);
});

const so = (title, url, snippet = title) => `<li class="res-list" data-result-type="normal"><h3 class="res-title"><a href="https://www.so.com/link?m=fixture" data-mdurl="${url}">${title}</a></h3><p class="res-desc">${snippet}</p></li>`;

test('360 解析真实地址、摘要和实体，丢弃广告、不透明跳转和危险链接', () => {
  const { parseSo360 } = require('../src/adapters/search/so360');
  const html = so('<em>显卡</em>报价', 'https://example.test/price?id=1&amp;utm_source=so', '5天前&nbsp;-&nbsp;显卡价格')
    + '<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=opaque">不透明</a></h3></li>'
    + '<li class="res-list"><h3 class="res-title"><a href="javascript:alert(1)">危险</a></h3></li>'
    + '<li class="advert"><h3 class="res-title"><a href="https://ad.test/">广告</a></h3></li>';
  assert.deepEqual(parseSo360(html), [{ title: '显卡报价', url: 'https://example.test/price?id=1', snippet: '5天前 - 显卡价格' }]);
});

test('360 验证码与明确无结果分开报告', async t => {
  const provider = require('../src/adapters/search/so360');
  fakeHttps(t, call => new URL(call.url).searchParams.get('q') === 'blocked'
    ? { body: '<html>安全验证 请输入验证码</html>' } : { body: '<html>没有找到相关结果</html>' });
  await assert.rejects(provider.search('blocked', { timeoutMs: 1000 }), { code: 'blocked' });
  assert.deepEqual(await provider.search('empty', { timeoutMs: 1000 }), []);
});

test('首源失败后备用源恢复，并保留尝试原因和来源时间', async t => {
  const calls = fakeHttps(t, call => call.url.includes('www.so.com')
    ? { body: so('显卡行情', 'https://example.test/new') }
    : { status: 503 });
  const value = await web.searchResult('显卡行情', { timeoutMs: 1000 });
  assert.equal(value.status, 'ok');
  assert.equal(value.items[0].provider, 'so360');
  assert.ok(Date.parse(value.items[0].fetchedAt));
  assert.equal(value.items[0].publishedAt, null);
  assert.ok(value.attempts.some(x => x.code === 'http_error' && x.status === 'failed' && x.error.status === 503));
  assert.ok(calls.some(x => x.url.includes('www.so.com')));
});

test('首源全部过期时继续备用检索，旧资料仅保留为诊断证据', async t => {
  fakeHttps(t, call => call.url.includes('www.so.com')
    ? { body: so('显卡今日报价', 'https://example.test/new', '刚刚 显卡报价') }
    : { body: bing(['显卡报价', 'https://example.test/old', '2010年3月4日 显卡报价']) });
  const value = await web.searchResult('今天显卡价格', { timeoutMs: 1000, maxAgeDays: 2 });
  assert.equal(value.status, 'ok');
  assert.deepEqual(value.items.map(x => x.url), ['https://example.test/new']);
  assert.equal(value.staleItems.length, 1);
});

test('所有源只有旧资料时返回 stale_only，不伪造成功', async t => {
  fakeHttps(t, call => call.url.includes('www.so.com') ? { body: '' }
    : { body: bing(['显卡报价', 'https://example.test/old', '2010年3月4日 显卡报价']) });
  const value = await web.searchResult('今天显卡价格', { timeoutMs: 1000, maxAgeDays: 2 });
  assert.equal(value.status, 'empty');
  assert.equal(value.reason, 'stale_only');
  assert.deepEqual(value.items, []);
});

test('实际返回域名也必须符合平台约束，备用源不能绕过', async t => {
  const calls = fakeHttps(t, call => call.url.includes('www.so.com')
    ? { body: so('三体动画', 'https://www.bilibili.com/video/test') }
    : { body: bing(['三体动画', 'https://other.test/video']) });
  const value = await web.searchResult('三体动画 site:bilibili.com', { timeoutMs: 1000 });
  assert.deepEqual(value.items.map(x => new URL(x.url).hostname), ['www.bilibili.com']);
  for (const call of calls) assert.match(new URL(call.url).searchParams.get('q'), /site:bilibili\.com/);
});

test('解析结构变化与空结果有不同状态，错误不泄露页面内容', async t => {
  const events = [];
  fakeHttps(t, () => ({ body: '<html>private-page-body changed markup</html>' }));
  const value = await web.searchResult('显卡行情', { timeoutMs: 1000, trace: (stage, data) => events.push({ stage, ...data }) });
  assert.equal(value.status, 'failed');
  assert.equal(value.reason, 'parse_error');
  assert.doesNotMatch(JSON.stringify(events), /private-page-body|显卡行情/);
});

test('传输调用者取消会销毁请求，零预算不会偷偷重置为八秒', async t => {
  const { getText } = require('../src/adapters/search/transport');
  const controller = new AbortController();
  const calls = fakeHttps(t, () => ({ never: true }));
  await assert.rejects(getText('https://example.test/', { timeoutMs: 0 }), { code: 'deadline_exceeded' });
  assert.equal(calls.length, 0);
  const pending = getText('https://example.test/', { signal: controller.signal, timeoutMs: 1000 });
  controller.abort();
  await assert.rejects(pending, { code: 'aborted' });
  assert.equal(calls[0].destroyed, true);
});

test('天气超时仍有预算走搜索回退，底层天气连接确实关闭', async t => {
  const { search } = require('../src/services/search');
  const calls = fakeHttps(t, call => call.url.includes('geocoding-api')
    ? { body: JSON.stringify({ results: [{ name: '测试城', latitude: 30, longitude: 120 }] }) }
    : call.url.includes('api.open-meteo') ? { drip: true }
      : { body: bing(['测试城明天天气', 'https://example.test/weather'], ['测试城天气预报', 'https://example.test/forecast']) });
  const value = await search({ text: '测试城明天天气', config: { timeoutMs: 700 },
    llm: { complete: async () => '{"need":true,"kind":"weather","query":"测试城 明天 天气","city":"测试城","timeRange":"tomorrow"}' } });
  assert.equal(value.status, 'ok');
  assert.equal(calls.find(x => new URL(x.url).hostname === 'api.open-meteo.com').destroyed, true);
  assert.ok(calls.some(x => x.url.includes('bing.com')));
  assert.ok(value.attempts.some(x => x.provider === 'open-meteo' && x.code === 'deadline_exceeded'));
});

test('热榜返回缺失结构不能伪装成没有热点，失败后可重查且成功缓存', async t => {
  let n = 0;
  const calls = fakeHttps(t, () => ++n === 1 ? { body: '{"unexpected":[]}' }
    : { body: '{"data":{"trending":{"list":[{"keyword":"测试热点"}]}}}' });
  const first = await web.hotlistResult('bilibili', { timeoutMs: 1000 });
  assert.equal(first.reason, 'parse_error');
  const good = await web.hotlistResult('bilibili', { timeoutMs: 1000 });
  const cached = await web.hotlistResult('bilibili', { timeoutMs: 1000 });
  assert.equal(good.status, 'ok');
  assert.equal(good.items[0].url, 'https://search.bilibili.com/all?keyword=' + encodeURIComponent('测试热点'));
  assert.deepEqual(cached.items, good.items);
  assert.equal(calls.length, 2);
});

test('Bing 跳转链接还原真实来源并去掉跟踪参数', () => {
  const target = 'https://example.test/article?utm_source=bing&id=1#section';
  const html = bing(['显卡行情', 'https://www.bing.com/ck/a?u=a1' + Buffer.from(target).toString('base64url')]);
  assert.equal(web.parseBing(html)[0].url, 'https://example.test/article?id=1');
});
