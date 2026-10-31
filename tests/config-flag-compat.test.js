'use strict';

/**
 * 老配置里的「字符串布尔」兼容 —— 3.55.0 修过一次，4.0 模块化重构时又退回去一半。
 *
 * 现场：config.json 是手改的 / 老版本写出来的，里面是 `"false"` 而不是 `false`。
 * 这在仓库里是**明文承诺合法**的（configSchema 有「字符串形式的布尔老配置仍然算合法」），
 * 所以每个读开关的地方都必须按「字符串也认」来读，不能直接 `Boolean(v)` 或 `=== false`：
 *
 *   Boolean("false") === true        ← 用户明明关了，功能自己又开了
 *   "false" === false   === false    ← 用户明明关了开关，仍然按「开」的分支走
 *
 * 已经踩过的三次：主动搭话照样发、群里照样插话、主人说话照样无条件回。
 * 这一组用例把「读开关」这件事钉在 config 层，谁再直接读布尔就红。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const care = require('../src/services/care');
const { computeTrigger } = require('../src/core/trigger');
const { ReminderService, normalizeRules } = require('../src/services/reminderService');
const { validate } = require('../src/infra/configSchema');

const NOW = new Date('2026-10-31T10:00:00+08:00').getTime();

/* ---------------- 主动搭话 care.enabled ---------------- */

test('care.enabled 写成字符串 "false" 必须真的关掉（Boolean("false") 的老坑）', () => {
  for (const off of ['false', '0', 'no', 'off', '关', 'FALSE', ' false ']) {
    const out = care.careDue({ care: { enabled: off } }, { lastSentTs: 0, sentToday: 0, now: NOW });
    assert.equal(out.due, false, `care.enabled=${JSON.stringify(off)} 应该当关处理`);
    assert.equal(out.reason, 'disabled');
  }
});

test('care.enabled 写成字符串 "true" / 数字 1 / "开" 仍然算开（别把兼容改坏）', () => {
  for (const on of ['true', '1', 'yes', '开', true, 1]) {
    const out = care.careDue({ care: { enabled: on, everyMinutes: 1 } }, { lastSentTs: 0, sentToday: 0, now: NOW });
    assert.equal(out.due, true, `care.enabled=${JSON.stringify(on)} 应该当开处理`);
  }
});

test('care 段没写 enabled 时仍然是开（默认值不能被兼容逻辑带偏）', () => {
  const out = care.careDue({ care: { everyMinutes: 1 } }, { lastSentTs: 0, sentToday: 0, now: NOW });
  assert.equal(out.due, true);
});

/* ---------------- 提醒 reminder.enabled ---------------- */

function reminderFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-flag-'));
  return { dir, config: { reminder: {}, paths: { dataDir: dir } } };
}

test('reminder.enabled 写成字符串 "false" 时，设提醒必须被拒（403）', () => {
  const { dir, config } = reminderFixture();
  try {
    config.reminder = { enabled: 'false' };
    assert.equal(normalizeRules(config).enabled, false);
    const svc = new ReminderService(config, { now: () => NOW });
    assert.throws(
      () => svc.add({ wxid: 'wxid_a', text: '开会', at: NOW + 60 * 60 * 1000 }),
      (err) => err.statusCode === 403,
      '关着的提醒功能不该还能设'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('reminder.enabled 写成字符串 "true" 时照常能设（默认开也要认字符串）', () => {
  const { dir, config } = reminderFixture();
  try {
    config.reminder = { enabled: 'true' };
    const svc = new ReminderService(config, { now: () => NOW });
    const item = svc.add({ wxid: 'wxid_a', text: '开会', at: NOW + 60 * 1000 });
    assert.equal(item.status, 'pending');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

/* ---------------- 群聊触发：requireAt / freeChat / masterAlwaysReply ---------------- */

function bot(group, { rng = () => 0, rows = [] } = {}) {
  return {
    config: {
      group: Object.assign(
        { requireAt: true, freeChat: false, freeChatChance: 0.6, cooldownSec: 0, maxRepliesPerHour: 0, masterAlwaysReply: true },
        group
      ),
    },
    store: { messages: () => rows },
    rng,
  };
}

function groupArgs(extra = {}) {
  return Object.assign(
    {
      msg: { senderId: 'u1', isGroup: true },
      atMe: false,
      clean: { text: '今天好热' },
      isGroup: true,
      state: {},
      nowMs: NOW,
      isMaster: false,
      key: 'g1',
    },
    extra
  );
}

test('group.freeChat 写成字符串 "false" 时不许插话', () => {
  const out = computeTrigger(bot({ requireAt: true, freeChat: 'false' }), groupArgs());
  assert.equal(out.wake, false, '关掉的「自己插话」不该按字符串真值放行');
  assert.equal(out.reason, 'not_addressed');
});

test('group.requireAt 写成字符串 "false" 时，不 @ 也要按概率接话', () => {
  // 以前 `g.requireAt === false` 判不出来，于是掉进「必须 @ 才回」，概率设置形同虚设
  const out = computeTrigger(bot({ requireAt: 'false', freeChat: false, freeChatChance: 1 }), groupArgs());
  assert.equal(out.wake, true);
  assert.equal(out.reason, 'free_chat');
});

test('group.masterAlwaysReply 写成字符串 "false" 时，主人也不再无条件触发', () => {
  const out = computeTrigger(
    bot({ masterAlwaysReply: 'false', requireAt: true, freeChat: false }),
    groupArgs({ isMaster: true })
  );
  assert.notEqual(out.reason, 'master', '关掉的开关不能因为类型是字符串就继续生效');
  assert.equal(out.wake, false);
});

test('group.masterAlwaysReply 写 "true" / 不写时，主人说话仍然无条件回', () => {
  for (const v of ['true', true, undefined]) {
    const group = { requireAt: true, freeChat: false };
    if (v !== undefined) group.masterAlwaysReply = v;
    const out = computeTrigger(bot(group), groupArgs({ isMaster: true }));
    assert.equal(out.reason, 'master', `masterAlwaysReply=${JSON.stringify(v)} 应该走 master 分支`);
  }
});

/* ---------------- 兼容契约本身 ---------------- */

test('configSchema 仍然把字符串布尔判为合法（兼容承诺不能被悄悄收紧）', () => {
  const cfg = {
    group: { requireAt: 'false', freeChat: 'true', masterAlwaysReply: 'false' },
    care: { enabled: 'false' },
    reminder: { enabled: 'false' },
  };
  const errors = validate(cfg) || [];
  const flagErrors = errors.filter((e) => /group\.|care\.|reminder\./.test(String(e && (e.path || e.field || e.message))));
  assert.deepEqual(flagErrors, [], '字符串布尔是合法老配置，不该报校验错误');
});
