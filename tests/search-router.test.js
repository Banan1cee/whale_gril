'use strict';
/**
 * 检索路由（模型判断要不要联网）的纯函数回归。
 * 不打网络：只验证「模型输出 → 结构化判断」的解析与容错。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoute } = require('../src/searchRouter');

test('解析 need=false：闲聊不该联网', () => {
  assert.deepEqual(parseRoute('{"need":false}'), { need: false, query: '', site: '' });
});

test('解析 need=true 并保留检索词与站点', () => {
  assert.deepEqual(parseRoute('{"need":true,"query":"B站热搜","site":"bilibili"}'),
    { need: true, query: 'B站热搜', site: 'bilibili' });
});

test('容忍代码块围栏与前后废话', () => {
  const raw = '好的，判断如下：\n```json\n{"need": true, "query": "显卡 最新价格"}\n```\n以上。';
  assert.deepEqual(parseRoute(raw), { need: true, query: '显卡 最新价格', site: '' });
});

test('非法站点被丢弃，未知站点不影响联网', () => {
  assert.deepEqual(parseRoute('{"need":true,"query":"微博热搜","site":"zhihu"}'),
    { need: true, query: '微博热搜', site: '' });
});

test('need=true 但没给检索词 → 返回 null（交给关键词兜底）', () => {
  assert.equal(parseRoute('{"need":true}'), null);
  assert.equal(parseRoute('{"need":true,"query":"   "}'), null);
});

test('乱七八糟的输出不会让程序崩', () => {
  for (const raw of ['', '   ', '不用查', 'null', '{']) {
    assert.equal(parseRoute(raw), null, JSON.stringify(raw));
  }
  // 「不是明确的 true」一律当作不需要联网，不会误触发搜索
  assert.deepEqual(parseRoute('{"need":"maybe"}'), { need: false, query: '', site: '' });
});

test('路由失败时返回 failed，调用方回退关键词', async () => {
  const { route } = require('../src/searchRouter');
  const broken = { complete: async () => { throw new Error('network down'); } };
  assert.deepEqual(await route(broken, 'B站热搜'), { need: false, query: '', site: '', failed: true });
  const noisy = { complete: async () => '我不知道' };
  assert.deepEqual(await route(noisy, 'B站热搜'), { need: false, query: '', site: '', failed: true });
  assert.deepEqual(await route(null, 'B站热搜'), { need: false, query: '', site: '', failed: true });
});
