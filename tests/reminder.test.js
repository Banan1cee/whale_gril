'use strict';

/**
 * 提醒：解析 → 落库 → 到点领取 → 回执（含 5 分钟重试一次）→ 过点不补发。
 * 现场要求：任何人都能设；必须准点；失败 5 分钟后重试一次；重启后过点的不许再发。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const reminder = require('../src/core/reminder');
const { ReminderService } = require('../src/services/reminderService');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG, loadConfig } = require('../src/infra/config');
const { startServer } = require('../server');

const NOW = new Date('2026-10-30T22:41:00');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reminder-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false } }));
  const config = loadConfig({ root: dir, env: {} });
  return { dir, config };
}

function serviceAt(config, clock) {
  return new ReminderService(config, { now: () => clock.ms });
}

/* ---------------- 解析 ---------------- */

test('「十点半提醒我开会」这类说法都能解析', () => {
  const cases = [
    ['十点半提醒我开会', '2026-10-31 10:30', '开会'],
    ['30分钟后提醒我收衣服', '2026-10-30 23:11', '收衣服'],
    ['明天早上8点提醒我带伞', '2026-10-31 08:00', '带伞'],
    ['晚上八点一刻提醒我吃药', '2026-10-31 20:15', '吃药'],
    ['20:15提醒我关火', '2026-10-31 20:15', '关火'],
    ['记得提醒我买米，明天三点', '2026-10-31 03:00', '买米'],
    ['后天下午2点提醒我交表', '2026-11-01 14:00', '交表'],
  ];
  for (const [text, expected, what] of cases) {
    const out = reminder.parseReminder(text, NOW);
    assert.ok(out, text + ' 应该被识别成提醒');
    const got = `${out.at.getFullYear()}-${String(out.at.getMonth() + 1).padStart(2, '0')}-${String(out.at.getDate()).padStart(2, '0')} ${String(out.at.getHours()).padStart(2, '0')}:${String(out.at.getMinutes()).padStart(2, '0')}`;
    assert.equal(got, expected, text);
    assert.equal(out.what, what, text + ' 的提醒内容');
  }
});

test('不是提醒的话不会被误判', () => {
  for (const text of [
    // 没有「什么事」只有「提醒我一下」，交给模型兜底/当普通聊天
    '提醒我喝水',
    '你觉得呢',
    '提醒你早点睡',
    '在吗',
    '今天好热',
    '帮我提醒大家开会',
    // 现场反馈：这类自言自语不能当成设提醒
    '我要上早八和明天还有早八，还有明天八点要开会',
    '我记得明天八点要开会',
    '他叫我明天八点开会',
    '到点记得吃饭',
  ]) {
    assert.equal(reminder.parseReminder(text, NOW), null, text);
  }
});

test('明确让她提醒时才认（提醒我 / 叫我 / 别忘）', () => {
  for (const text of ['明天八点提醒我要开会', '叫我六点半起床', '别忘了提醒我八点吃药']) {
    assert.ok(reminder.parseReminder(text, NOW), text + ' 应该被识别');
  }
});

test('回执里带时间和事情', () => {
  const out = reminder.parseReminder('明天八点提醒我带伞', NOW);
  const text = reminder.confirmText(out, { now: NOW });
  assert.match(text, /明天 08:00/);
  assert.match(text, /带伞/);
});

/* ---------------- 存储与状态机 ---------------- */

test('设提醒：过去的时刻直接拒绝，内容不能空', (t) => {
  const { config } = fixture(t);
  const svc = serviceAt(config, { ms: NOW.getTime() });
  assert.throws(() => svc.add({ wxid: 'wxid_a', text: '开会', at: NOW.getTime() - 1000 }), /已经过了/);
  assert.throws(() => svc.add({ wxid: 'wxid_a', text: '  ', at: NOW.getTime() + 60000 }), /没说提醒/);
});

test('到点能领取；失败 5 分钟后重试一次；再失败就结束', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  svc.add({ wxid: 'wxid_a', name: '阿螈', text: '开会', at: clock.ms + 1000 });

  clock.ms += 2000;
  const first = svc.due();
  assert.equal(first.length, 1);
  svc.ack(first[0].id, { ok: false, error: '微信忙' });
  assert.equal(svc.list()[0].status, 'retrying');

  assert.equal(svc.due().length, 0, '5 分钟内不该重试');
  clock.ms += 5 * 60 * 1000;
  const second = svc.due();
  assert.equal(second.length, 1, '5 分钟后应该能重试一次');
  svc.ack(second[0].id, { ok: false, error: '还是发不出去' });
  assert.equal(svc.list()[0].status, 'failed', '重试一次还失败就结束，不无限重试');
});

test('成功回执后不再是待发', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  svc.add({ wxid: 'wxid_a', text: '开会', at: clock.ms + 1000 });
  clock.ms += 2000;
  const due = svc.due();
  svc.ack(due[0].id, { ok: true });
  assert.equal(svc.list()[0].status, 'done');
  assert.equal(svc.nextDueAt(), 0);
});

test('重启扫描：过了提醒时间 + 5 分钟的一律标过期，不再补发', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  svc.add({ wxid: 'wxid_a', text: '早会', at: clock.ms + 1000 });
  svc.add({ wxid: 'wxid_b', text: '晚会', at: clock.ms + 5 * 60 * 60 * 1000 });

  // 模拟「关了 3 小时再开」：重新 new 一个（等于重启），再扫
  clock.ms += 3 * 60 * 60 * 1000;
  const again = serviceAt(config, clock);
  const swept = again.sweepStale();
  assert.equal(swept.expired, 1, '只该过期那一条已过点的');
  const byText = Object.fromEntries(again.list().map((x) => [x.text, x.status]));
  assert.equal(byText['早会'], 'expired');
  assert.equal(byText['晚会'], 'pending', '还没到点的那条要留着，不能一起作废');
  assert.equal(again.due().length, 0, '过期的不许再发');
});

test('还没到点的提醒重启后照样保留', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  svc.add({ wxid: 'wxid_a', text: '明天的会', at: clock.ms + 2 * 60 * 60 * 1000 });
  clock.ms += 1000;
  const again = serviceAt(config, clock);
  assert.equal(again.sweepStale().expired, 0);
  assert.equal(again.list()[0].status, 'pending');
});

test('取消提醒：取消后不再被领取', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  const item = svc.add({ wxid: 'wxid_a', text: '开会', at: clock.ms + 1000 });
  assert.equal(svc.cancel(item.id).ok, true);
  clock.ms += 2000;
  assert.equal(svc.due().length, 0);
});

test('同一会话最多 20 条未发，全局 500 条', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  for (let i = 0; i < 20; i += 1) svc.add({ wxid: 'wxid_a', text: `事${i}`, at: clock.ms + 60000 + i });
  assert.throws(() => svc.add({ wxid: 'wxid_a', text: '第21条', at: clock.ms + 60000 }), /太多/);
});

test('nextDueAt 用来让桥接睡到点（不是轮询）', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  svc.add({ wxid: 'wxid_a', text: '晚点', at: clock.ms + 10 * 60 * 1000 });
  svc.add({ wxid: 'wxid_b', text: '早一点', at: clock.ms + 5 * 60 * 1000 });
  assert.equal(svc.nextDueAt(), clock.ms + 5 * 60 * 1000);
});

/* ---------------- 规则（和主动搭话同语义、配置独立）---------------- */

test('提醒规则：每日次数用完就不再发（到点也不会补）', (t) => {
  const { config } = fixture(t);
  config.reminder = { ...config.reminder, maxPerDay: 1 };
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  // 两条都先设好（设的时候还没发过，额度够）
  svc.add({ wxid: 'wxid_a', text: '第一件', at: clock.ms + 1000 });
  svc.add({ wxid: 'wxid_b', text: '第二件', at: clock.ms + 1000 });
  clock.ms += 2000;
  const due = svc.due();
  assert.equal(due.length, 1, '当天只剩一次额度');
  svc.ack(due[0].id, { ok: true });
  clock.ms += 2000;
  assert.equal(svc.due().length, 0);
  const second = svc.list().find((x) => x.text === '第二件');
  assert.equal(second.status, 'expired');
  assert.match(second.error, /次数/);
  // 而且设下一条时会直接被拒
  assert.throws(() => svc.add({ wxid: 'wxid_c', text: '第三件', at: clock.ms + 5000 }), /次数/);
});

test('提醒规则：总开关关掉后，设不了；已有的到点也不发', (t) => {
  const { config } = fixture(t);
  const clock = { ms: NOW.getTime() };
  const svc = serviceAt(config, clock);
  svc.add({ wxid: 'wxid_a', text: '开会', at: clock.ms + 1000 });
  config.reminder.enabled = false;
  assert.throws(() => svc.add({ wxid: 'wxid_b', text: '第二件', at: clock.ms + 2000 }), /关着/);
  clock.ms += 2000;
  assert.equal(svc.due().length, 0);
  assert.equal(svc.list().find((x) => x.text === '开会').status, 'expired');
});

test('提醒规则：刚聊过先跳过（默认 0 = 不跳过）', (t) => {
  const { config } = fixture(t);
  config.reminder = { ...config.reminder, quietAfterMinutes: 10 };
  const clock = { ms: NOW.getTime() };
  const svc = new ReminderService(config, { now: () => clock.ms, lastActiveAt: () => clock.ms - 60 * 1000 });
  svc.add({ wxid: 'wxid_a', text: '开会', at: clock.ms + 1000 });
  clock.ms += 2000;
  assert.equal(svc.due().length, 0, '刚在聊 → 不打扰');
  assert.match(svc.list()[0].error, /刚聊过/);
});

test('提醒规则默认：不限次数、不限时间段（提醒是我定的准点，不做时间窗限制）', (t) => {
  const { config } = fixture(t);
  assert.equal('windows' in (config.reminder || {}), false, 'reminder 不该再有时间段配置');
  const rules = new ReminderService(config, { now: () => NOW.getTime() }).rules(NOW.getTime());
  assert.equal(rules.enabled, true);
  assert.equal(rules.dailyCap, 0);
  assert.equal(rules.quietAfterMinutes, 0);
  // 凌晨 3 点也能设 —— 以前会被时间段拒掉
  const svc = new ReminderService(config, { now: () => NOW.getTime() });
  const at = new Date(NOW.getTime());
  at.setDate(at.getDate() + 1);
  at.setHours(3, 0, 0, 0);
  assert.equal(svc.add({ wxid: 'wxid_a', text: '三点的事', at }).status, 'pending');
});

/* ---------------- 接入对话 ---------------- */

function makeBot(t, config, now = NOW) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reminder-bot-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(cfg, { paths: config.paths, root: config.root, persona: config.persona, care: config.care });
  const store = new Store({ file: path.join(dir, 'store.json') });
  t.after(() => store.close());
  const bot = new Bot({
    config: cfg,
    store,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null,
    now: () => now,
    mockChunkDelayMs: 0,
  });
  bot.reminders = new ReminderService(cfg, { now: () => now.getTime() });
  return { bot, cfg };
}

test('对话里说「十点半提醒我开会」会落库并回一句确认', async (t) => {
  const { config } = fixture(t);
  const { bot } = makeBot(t, config);
  const r = await bot.decide({
    platform: 'wechat', chatId: 'wxid_a', chatType: 'private', senderId: 'u1', senderName: '阿螈',
    text: '十点半提醒我开会',
  });
  assert.equal(r.action, 'reply');
  assert.match(r.canned, /10:30/);
  assert.match(r.canned, /开会/);
  const items = bot.reminders.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, 'pending');
  assert.equal(items[0].text, '开会');
});

test('群里没 @ 她也能设提醒（任何人都能设）', async (t) => {
  const { config } = fixture(t);
  const { bot } = makeBot(t, config);
  const r = await bot.decide({
    platform: 'wechat', chatId: '1@chatroom', chatType: 'group', senderId: 'u2', senderName: '路人',
    text: '明天八点提醒我带伞', chatTitle: '深海鱼塘',
  });
  assert.equal(r.reason, 'reminder_set');
  assert.equal(bot.reminders.list()[0].chatType, 'group');
});

test('「取消提醒」和「提醒列表」都能用', async (t) => {
  const { config } = fixture(t);
  const { bot } = makeBot(t, config);
  const msg = (text) => ({ platform: 'wechat', chatId: 'wxid_a', chatType: 'private', senderId: 'u1', senderName: '阿螈', text });
  await bot.decide(msg('十点半提醒我开会'));
  const list = await bot.decide(msg('提醒列表'));
  assert.match(list.canned, /开会/);
  const cancel = await bot.decide(msg('取消提醒'));
  assert.match(cancel.canned, /取消/);
  assert.equal(bot.reminders.pendingFor('wxid_a').length, 0);
});

test('普通聊天不会被提醒分支吃掉', async (t) => {
  const { config } = fixture(t);
  const { bot } = makeBot(t, config);
  const r = await bot.decide({
    platform: 'wechat', chatId: 'wxid_a', chatType: 'private', senderId: 'u1', senderName: '阿螈', text: '今天好热啊',
  });
  assert.notEqual(r.reason, 'reminder_set');
  assert.equal(bot.reminders.list().length, 0);
});

/* ---------------- HTTP ---------------- */

test('HTTP：列表 / 取消 / 桥接领取要 token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reminder-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    gateway: { wechat: { enabled: true, inboundToken: 'change-me-wechat' } },
  }));
  const app = await startServer({ root: dir, env: {}, port: 0, openBrowser: false });
  t.after(() => app.close());

  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(app.url + p, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.end();
  });
  const post = (p, payload, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request(app.url + p, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(payload || {}));
    req.end();
  });

  const list = await get('/api/reminders');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.items, []);
  assert.equal(list.body.rules.enabled, true, '列表要带规则，启动器「提醒」页据此回填');
  assert.equal('windows' in list.body.rules, false, '提醒不再有时间段规则');

  const denied = await get('/api/reminders/due');
  assert.equal(denied.status, 403, '没有桥接 token 不许领取');
  const allowed = await get('/api/reminders/due', { 'x-bot-token': 'change-me-wechat', 'x-whale-bridge': '1' });
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.items, []);
  assert.equal(typeof allowed.body.nextDueAt, 'number');

  const missing = await post('/api/reminders/cancel', { id: 'nope' });
  assert.equal(missing.status, 404);
});
