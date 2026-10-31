'use strict';

/**
 * 3.4.2「每小时回复上限偶发漏拦」的回归测试。
 *
 * 现场：并发下 `state.replyTimes` 会随会话状态重建丢掉条目（实测约 1/4 概率），
 * 于是「已经回够一个小时上限了」这件事看不出来，她继续回。
 *
 * 修法是三层兜底，缺一层就会漏：
 *   1. 内存里的 replyTimes 数一遍；
 *   2. 存储里真正落盘的助手消息数一遍（权威来源）；
 *   3. 都读不到时，至少看 lastReplyAt 是不是在一小时内（算 1 条）。
 *
 * 只测第 1 层等于没测 —— 丢的正是那一层。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { computeTrigger } = require('../src/core/trigger');

const NOW = new Date('2026-10-31T10:00:00+08:00').getTime();
const MIN = 60 * 1000;

function bot({ cap = 3, rows = [], throws = false, rng = () => 0.99 } = {}) {
  return {
    config: {
      group: {
        requireAt: true,
        freeChat: false,
        freeChatChance: 0,
        cooldownSec: 0,
        maxRepliesPerHour: cap,
        masterAlwaysReply: true,
        engagedMinutes: 6,
      },
    },
    store: {
      messages: () => {
        if (throws) throw new Error('store 读不到');
        return rows;
      },
    },
    rng,
  };
}

function args(state = {}) {
  return {
    msg: { senderId: 'u1', isGroup: true },
    atMe: false,
    clean: { text: '今天好热' },
    isGroup: true,
    state,
    nowMs: NOW,
    isMaster: false,
    key: 'g1',
  };
}

test('replyTimes 被重建清空，但存储里有落盘回复 → 照样按上限拦', () => {
  const rows = [1, 2, 3].map((i) => ({ role: 'assistant', ts: NOW - i * MIN }));
  const out = computeTrigger(bot({ cap: 3, rows }), args({ replyTimes: [] }));
  assert.equal(out.wake, false, '内存丢了条目不代表没回过');
  assert.equal(out.reason, 'hourly_cap');
});

test('存储也读不到时，lastReplyAt 在一小时内至少算 1 条', () => {
  const out = computeTrigger(
    bot({ cap: 1, throws: true }),
    args({ replyTimes: [], lastReplyAt: NOW - 10 * MIN })
  );
  assert.equal(out.wake, false);
  assert.equal(out.reason, 'hourly_cap');
});

test('一小时以前的落盘回复不算数（别把上限做成永久静音）', () => {
  const rows = [1, 2, 3].map((i) => ({ role: 'assistant', ts: NOW - (61 + i) * MIN }));
  const out = computeTrigger(bot({ cap: 3, rows }), args({ replyTimes: [] }));
  assert.notEqual(out.reason, 'hourly_cap', '过了一小时的回复不能继续占额度');
});

test('只数助手消息：用户消息再多也不会把自己挤到上限', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ role: 'user', ts: NOW - i * MIN }));
  const out = computeTrigger(bot({ cap: 2, rows }), args({ replyTimes: [] }));
  assert.notEqual(out.reason, 'hourly_cap');
});

test('cap = 0 表示不限流（别把「关掉上限」做成一条都不回）', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', ts: NOW - i * MIN }));
  const out = computeTrigger(bot({ cap: 0, rows }), args({ replyTimes: [] }));
  assert.notEqual(out.reason, 'hourly_cap');
});

test('内存里的 replyTimes 够数时照旧拦（原有通道不能丢）', () => {
  const out = computeTrigger(bot({ cap: 2, rows: [] }), args({ replyTimes: [NOW - MIN, NOW - 2 * MIN] }));
  assert.equal(out.reason, 'hourly_cap');
});

test('folder：被 @ 到永远回，不受每小时上限影响（上限只拦「没人叫时的插话」）', () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ role: 'assistant', ts: NOW - i * MIN }));
  const out = computeTrigger(bot({ cap: 1, rows }), Object.assign(args({ replyTimes: [] }), { atMe: true }));
  assert.equal(out.wake, true);
  assert.equal(out.reason, 'addressed');
});
