'use strict';
/**
 * 检索路由（模型判断要不要联网）的纯函数回归。
 * 不打网络：只验证「模型输出 → 结构化判断」的解析与容错。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoute, route, systemFor } = require('../src/adapters/searchRouter');

test('路由提示词带上真实日期：判「今天/最新」不能靠训练数据', () => {
  const system = systemFor(new Date('2026-11-03T09:05:00+08:00'));
  assert.match(system, /现在是 2026-11-03 周二 09:05（北京时间）/);
  assert.match(system, /以这个时间为基准/);
});

test('route 把当前时间传给模型（可注入 now，便于测试）', async () => {
  let seen = '';
  const llm = {
    complete: async ({ system }) => {
      seen = system;
      return '{"need":false}';
    },
  };
  await route(llm, '今天有什么新闻', { now: new Date('2026-11-03T10:30:00+08:00') });
  assert.match(seen, /2026-11-03 周二 10:30/);
});

test('解析 need=false：闲聊不该联网', () => {
  assert.deepEqual(parseRoute('{"need":false}'), { need: false, query: '', site: '', city: '', fresh: 'normal' });
});

test('解析 need=true 并保留检索词与站点', () => {
  assert.deepEqual(parseRoute('{"need":true,"query":"B站热搜","site":"bilibili"}'),
    { need: true, query: 'B站热搜', site: 'bilibili', city: '', fresh: 'normal' });
});

test('容忍代码块围栏与前后废话', () => {
  const raw = '好的，判断如下：\n```json\n{"need": true, "query": "显卡 最新价格"}\n```\n以上。';
  assert.deepEqual(parseRoute(raw), { need: true, query: '显卡 最新价格', site: '', city: '', fresh: 'normal' });
});

test('非法站点被丢弃，未知站点不影响联网', () => {
  assert.deepEqual(parseRoute('{"need":true,"query":"微博热搜","site":"zhihu"}'),
    { need: true, query: '微博热搜', site: '', city: '', fresh: 'normal' });
});

test('地名原文抄进 city，保留用户写法', () => {
  assert.equal(parseRoute('{"need":true,"query":"上海 天气","city":"上海"}').city, '上海');
  assert.equal(parseRoute('{"need":true,"query":"New York weather","city":"New York"}').city, 'New York');
  assert.equal(parseRoute('{"need":true,"query":"天气"}').city, '');
  const long = parseRoute('{"need":true,"query":"x","city":"' + 'a'.repeat(60) + '"}');
  assert.equal(long.city.length, 40, 'city 最多 40 字');
});

test('fresh 三档；缺省/乱写按 normal', () => {
  assert.equal(parseRoute('{"need":true,"query":"x","fresh":"strict"}').fresh, 'strict');
  assert.equal(parseRoute('{"need":true,"query":"x","fresh":"any"}').fresh, 'any');
  assert.equal(parseRoute('{"need":true,"query":"x","fresh":"normal"}').fresh, 'normal');
  assert.equal(parseRoute('{"need":true,"query":"x"}').fresh, 'normal');
  assert.equal(parseRoute('{"need":true,"query":"x","fresh":"forever"}').fresh, 'normal');
});

test('need=true 但没给检索词 → 返回 null（交给关键词兜底）', () => {
  assert.equal(parseRoute('{"need":true}'), null);
  assert.equal(parseRoute('{"need":true,"query":"   "}'), null);
});

test('乱七八糟的输出不会让程序崩', () => {
  for (const raw of ['', '   ', '不用查', 'null', '{']) {
    assert.equal(parseRoute(raw), null, JSON.stringify(raw));
  }
  // 损坏的判断不是明确的 false，必须交给关键词兜底。
  for (const raw of ['{}', '{"need":"maybe"}', '{"need":null}', '{"need":0}', '{"need":true,"query":{}}']) {
    assert.equal(parseRoute(raw), null, raw);
  }
  assert.deepEqual(parseRoute('{"need":"false"}'), { need: false, query: '', site: '', city: '', fresh: 'normal' });
});

test('路由失败时返回 failed，调用方回退关键词', async () => {
  const { route } = require('../src/adapters/searchRouter');
  const broken = { complete: async () => { throw new Error('network down'); } };
  assert.deepEqual(await route(broken, 'B站热搜'), { need: false, query: '', site: '', city: '', fresh: 'normal', failed: true });
  const noisy = { complete: async () => '我不知道' };
  assert.deepEqual(await route(noisy, 'B站热搜'), { need: false, query: '', site: '', city: '', fresh: 'normal', failed: true });
  assert.deepEqual(await route(null, 'B站热搜'), { need: false, query: '', site: '', city: '', fresh: 'normal', failed: true });
});
