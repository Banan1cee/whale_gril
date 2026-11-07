'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('../src/adapters/search/cache');

test('相同请求合并，一位取消不影响其他等待者，命中缓存保持原获取时间', async () => {
  const cache = createCache();
  const controller = new AbortController();
  let opens = 0, release, sharedSignal;
  const load = opts => { opens++; sharedSignal = opts.signal; return new Promise(resolve => { release = resolve; }); };
  const a = cache.get('榜单', load, { ttlMs: 1000, signal: controller.signal });
  const b = cache.get('榜单', load, { ttlMs: 1000 });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(a, { code: 'aborted' });
  assert.equal(sharedSignal.aborted, false);
  release([{ title: '资料', fetchedAt: '2026-11-06T00:00:00Z' }]);
  const value = await b;
  value[0].title = '被调用者修改';
  const cached = await cache.get('榜单', load, { ttlMs: 1000 });
  assert.equal(opens, 1);
  assert.equal(cached[0].title, '资料');
  assert.equal(cached[0].fetchedAt, '2026-11-06T00:00:00Z');
});

test('最后一位等待者取消会中止底层任务，后来的请求可以重新发起', async () => {
  const cache = createCache();
  const controller = new AbortController();
  let sharedSignal;
  const first = cache.get('geo', opts => new Promise((resolve, reject) => {
    sharedSignal = opts.signal;
    opts.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }), { signal: controller.signal, ttlMs: 1000 });
  await Promise.resolve();
  controller.abort();
  await assert.rejects(first, { code: 'aborted' });
  assert.equal(sharedSignal.aborted, true);
  assert.equal(await cache.get('geo', async () => '杭州', { ttlMs: 1000 }), '杭州');
});

test('等待者超时独立，短预算不能缩短另一位的预算', async () => {
  const cache = createCache();
  let release, signal;
  const load = opts => { signal = opts.signal; return new Promise(resolve => { release = resolve; }); };
  const short = cache.get('same', load, { timeoutMs: 10, ttlMs: 1000 });
  const long = cache.get('same', load, { timeoutMs: 1000, ttlMs: 1000 });
  await assert.rejects(short, { code: 'deadline_exceeded' });
  assert.equal(signal.aborted, false);
  release('ok');
  assert.equal(await long, 'ok');
});

test('失败和空结果不缓存，TTL 到期重新读取，容量有上限', async () => {
  let now = 100, calls = 0;
  const cache = createCache({ now: () => now, maxEntries: 2 });
  const load = async () => { calls++; return { n: calls }; };
  await assert.rejects(cache.get('x', async () => { throw new Error('offline'); }, { ttlMs: 10 }));
  assert.equal(await cache.get('x', async () => null, { ttlMs: 10 }), null);
  assert.deepEqual(await cache.get('x', load, { ttlMs: 10 }), { n: 1 });
  now += 11;
  assert.deepEqual(await cache.get('x', load, { ttlMs: 10 }), { n: 2 });
  await cache.get('y', load, { ttlMs: 10 });
  await cache.get('z', load, { ttlMs: 10 });
  assert.deepEqual(await cache.get('x', load, { ttlMs: 10 }), { n: 5 });
});
