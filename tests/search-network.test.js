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

test('optional search retry failure preserves first successful result', async (t) => {
  const calls = fakeHttps(t, (_, i) => i === 0 ? { body: one } : { error: 'offline' });
  const results = await web.search('帮我查一下显卡行情', { timeoutMs: 200 });
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://example.test/a');
  assert.ok(calls.length >= 2);
});

test('failed initial search can recover through a normalized query', async (t) => {
  fakeHttps(t, (_, i) => i === 0 ? { error: 'offline' } : { body: one });
  assert.equal((await web.search('帮我查一下显卡行情', { timeoutMs: 200 })).length, 1);
});

test('a single official supplement is retained after later empty attempts', async (t) => {
  fakeHttps(t, (call) => new URL(call.url).searchParams.get('q').startsWith('site:apple.com.cn')
    ? { body: bing(['iPhone 机型比较', 'https://www.apple.com.cn/iphone/compare/']) }
    : { body: '' });
  const results = await web.search('苹果最新的机器是什么', { timeoutMs: 200 });
  assert.equal(results.length, 1);
  assert.match(results[0].url, /compare/);
});

test('failed optional official lookup cannot erase two valid first results', async (t) => {
  fakeHttps(t, (call) => new URL(call.url).searchParams.get('q').startsWith('site:apple.com.cn')
    ? { error: 'offline' }
    : { body: bing(['iPhone 产品 A', 'https://example.test/a'], ['iPhone 产品 B', 'https://example.test/b']) });
  const results = await web.search('苹果最新的机器是什么', { timeoutMs: 200 });
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
  assert.equal(await web.weiboHotText(10, 200), '');
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
