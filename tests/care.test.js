'use strict';

/**
 * 主动搭话（care）：她自己来找你聊「在干啥 / 累不累」。
 *
 * 这组测试盯住三件事：
 *   1. 时间窗解析（含跨零点、边界、写错不炸）
 *   2. 频率闸门（多久一次 / 每天上限 / 关掉）
 *   3. 服务端两个接口 + 桥接定时器确实接上了
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const care = require('../src/care');
const { DEFAULT_CONFIG } = require('../src/config');
const { startServer } = require('../server');

const root = path.resolve(__dirname, '..');

test('时间段解析：正常、跨零点、写错', () => {
  assert.deepEqual(care.parseWindow('09:00-12:00'), { start: 540, end: 720, raw: '09:00-12:00' });
  const night = care.parseWindow('22:00-02:00');
  assert.equal(night.start, 1320);
  assert.equal(night.end, 120);
  assert.equal(care.parseWindow('abc'), null);
  assert.equal(care.parseWindow('09:70-10:00'), null);
  assert.equal(care.parseWindow(''), null);
  // 中文破折号 / 「到」也认
  assert.ok(care.parseWindow('09:00～12:00'));
  assert.ok(care.parseWindow('09:00到12:00'));
});

test('时间窗判断：左闭右开、跨零点、默认兜底', () => {
  const day = care.parseWindows(['09:00-12:00']);
  assert.equal(care.inWindows(540, day), true, '09:00 算在窗内');
  assert.equal(care.inWindows(719, day), true);
  assert.equal(care.inWindows(720, day), false, '12:00 已经出窗（右开）');
  assert.equal(care.inWindows(480, day), false);

  const night = care.parseWindows(['22:00-02:00']);
  assert.equal(care.inWindows(23 * 60, night), true);
  assert.equal(care.inWindows(60, night), true, '凌晨 1 点也算在窗内');
  assert.equal(care.inWindows(12 * 60, night), false);

  // 没配时间窗 → 用默认 09:00-23:00
  assert.equal(care.inWindows(10 * 60, []), true);
  assert.equal(care.inWindows(3 * 60, []), false);
});

test('配置缺省值：没写 care 段也能正常工作', () => {
  const c = care.normalizeCare({});
  assert.equal(c.enabled, true);
  assert.equal(c.everyMinutes, 90);
  assert.equal(c.jitterMinutes, 25);
  assert.equal(c.maxPerDay, 6);
  assert.deepEqual(c.windows, [], '没配时间窗时留空，由 careDue 兜底成 09:00-23:00');
  const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
  assert.equal(care.careDue({}, { now }).due, true, '缺省配置下上午 10 点可以搭话');
  // 乱填的值要能兜住
  const bad = care.normalizeCare({ care: { everyMinutes: -5, jitterMinutes: -1, maxPerDay: 'x', windows: ['乱写'] } });
  assert.equal(bad.everyMinutes, 90);
  assert.equal(bad.jitterMinutes, 25);
  assert.deepEqual(bad.windows, [], '写错的时间段直接忽略，不炸');
});

test('闸门：关掉 / 不在时间窗 / 刚发过 / 到点', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const cfg = { care: { enabled: true, windows: ['00:00-24:00'], everyMinutes: 60, jitterMinutes: 0, maxPerDay: 3 } };

  assert.equal(care.careDue({ care: { enabled: false } }, { now }).reason, 'disabled');
  assert.equal(care.careDue({ care: { enabled: true, windows: ['14:00-18:00'] } }, { now }).reason, 'out_of_window');
  assert.equal(care.careDue(cfg, { lastSentTs: now - 30 * 60000, now }).reason, 'too_soon');
  assert.equal(care.careDue(cfg, { lastSentTs: now - 61 * 60000, now }).due, true);
  assert.equal(care.careDue(cfg, { lastSentTs: 0, now }).due, true, '从没发过就立刻可以发');
  assert.equal(care.careDue(cfg, { lastSentTs: now - 999 * 60000, sentToday: 3, now }).reason, 'daily_cap');
});

test('每日上限 0 = 不限', () => {
  const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const cfg = { care: { enabled: true, windows: ['00:00-24:00'], everyMinutes: 60, jitterMinutes: 0, maxPerDay: 0 } };
  assert.equal(care.careDue(cfg, { lastSentTs: now - 999 * 60000, sentToday: 99, now }).due, true);
});

test('抖动是稳定的：同一时刻反复算，结果一致（不会临界点反复横跳）', () => {
  const a = care.stableJitter(1792858125000, 25);
  const b = care.stableJitter(1792858125000, 25);
  assert.equal(a, b);
  assert.ok(a >= -25 && a <= 25, '抖动要在 ±jitter 之内：' + a);
  assert.equal(care.stableJitter(1792858125000, 0), 0);
});

test('抖动不能盖过用户设的间隔（改成 1 分钟就得等 1 分钟左右）', () => {
  // 曾经的问题：everyMinutes=1 + jitterMinutes=25 → 实际要等 22 分钟，用户以为设置没生效
  const now = new Date(2026, 0, 1, 10, 0, 0).getTime();
  const cfg = { care: { enabled: true, windows: ['00:00-24:00'], everyMinutes: 1, jitterMinutes: 25, maxPerDay: 0 } };
  for (const last of [now - 60000, now - 555500, now - 123456789, 0]) {
    const d = care.careDue(cfg, { lastSentTs: last, sentToday: 0, now });
    assert.ok(d.gapMinutes >= 1 && d.gapMinutes <= 2, '1 分钟的间隔不该被抖动放大到 ' + d.gapMinutes);
  }
  // 间隔大时抖动仍然生效（打散节奏），但不超过一半
  const big = { care: { enabled: true, windows: ['00:00-24:00'], everyMinutes: 90, jitterMinutes: 25, maxPerDay: 0 } };
  const g = care.careDue(big, { lastSentTs: now - 999 * 60000, now }).gapMinutes;
  assert.ok(g >= 65 && g <= 115, '90 分钟 + ±25 抖动应在 65~115：' + g);
});

test('台词与清理：模板不为空、模型输出去掉引号和多余行', () => {
  assert.ok(care.CARE_TEMPLATES.length >= 5);
  for (const t of care.CARE_TEMPLATES) assert.ok(t.length >= 3 && t.length <= 20, '台词长度不合适：' + t);
  assert.equal(care.pickTemplate(() => 0), care.CARE_TEMPLATES[0]);
  assert.equal(care.cleanCareText('“在干啥呢”\n多余的话'), '在干啥呢');
  assert.equal(care.cleanCareText('  \n  忙完了没，累不累~ '), '忙完了没，累不累');
});

test('提示词带上时间和称呼，且明确禁止暴露 AI 身份', () => {
  const { system, user } = care.buildCarePrompt({
    persona: { name: '鲸鲸', ownerName: '主人' },
    recent: ['对方：今天加班'],
    name: '阿螈',
    hour: 22,
  });
  assert.match(system, /在干啥|累不累/, '要说明目的是关心对方');
  assert.match(system, /AI|模型/, '要明确禁止暴露 AI 身份');
  assert.match(system, /晚上/, '22 点要按晚上处理');
  assert.match(user, /今天加班/, '要带上最近的聊天上下文');
});

/* ---------------- 服务端 + 桥接接线 ---------------- */

async function boot(configPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-care-'));
  const cfg = { server: { port: 0, openBrowser: false }, ...configPatch };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  const instance = await startServer({ root: dir, env: {}, port: 0, openBrowser: false });
  return instance;
}

test('接口 /api/care/due 会说清为什么不该发', async () => {
  const app = await boot();
  try {
    const res = await fetch(app.url + '/api/care/due?last=0&sentToday=0');
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(typeof data.due, 'boolean');
    assert.ok(data.reason, '必须给出原因，方便桥接日志排查');
  } finally {
    await app.close();
  }
});

test('端到端闸门：时间窗全开时，到点该发、刚发过不该发', async () => {
  const app = await boot({
    care: { enabled: true, windows: ['00:00-24:00'], everyMinutes: 30, jitterMinutes: 0, maxPerDay: 5 },
  });
  try {
    // 从没发过 → 该发
    let d = await (await fetch(app.url + '/api/care/due?last=0&sentToday=0')).json();
    assert.equal(d.due, true, '时间窗全开 + 从没发过，应当可以发：' + JSON.stringify(d));

    // 刚发完（现在）→ 不该发，并告诉还要等多久
    const nowMs = Date.now();
    d = await (await fetch(app.url + `/api/care/due?last=${nowMs}&sentToday=1`)).json();
    assert.equal(d.due, false);
    assert.equal(d.reason, 'too_soon');
    assert.ok(d.waitMinutes >= 1, '要说清还要等几分钟');

    // 31 分钟前发过 → 该发
    d = await (await fetch(app.url + `/api/care/due?last=${nowMs - 31 * 60000}&sentToday=1`)).json();
    assert.equal(d.due, true, '过了间隔就该再发：' + JSON.stringify(d));

    // 今天已到上限 → 不该发
    d = await (await fetch(app.url + `/api/care/due?last=${nowMs - 99 * 60000}&sentToday=5`)).json();
    assert.equal(d.reason, 'daily_cap');
  } finally {
    await app.close();
  }
});

test('调试台保存 care 设置后，闸门立刻按新设置算', async () => {
  const app = await boot();
  try {
    // 一开始用默认配置（当前这个点大概不在窗内，先不假设）
    const before = await (await fetch(app.url + '/api/care/due?last=0&sentToday=0')).json();
    assert.ok(before.reason);

    // 模拟调试台提交：全开时间窗 + 1 分钟一次
    const save = await fetch(app.url + '/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ patch: { 'care.windows': ['00:00-24:00'], 'care.everyMinutes': 1, 'care.maxPerDay': 5 } }),
    });
    const saved = await save.json();
    assert.equal(saved.ok, true, '保存失败：' + JSON.stringify(saved));
    assert.ok(Array.isArray(saved.config.care.windows), '返回里要带上新的 care 配置');

    const after = await (await fetch(app.url + '/api/care/due?last=0&sentToday=0')).json();
    assert.equal(after.due, true, '改成全开后就该能发：' + JSON.stringify(after));
    assert.equal(after.gapMinutes, 1, '频率改成 1 分钟要生效');
  } finally {
    await app.close();
  }
});

test('接口 /api/care 能产出一句关心的话', async () => {
  const app = await boot();
  try {
    const res = await fetch(app.url + '/api/care?chat=wxid_test');
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(String(data.text).length >= 3, '内容不能是空的');
    assert.ok(String(data.text).length <= 40);
  } finally {
    await app.close();
  }
});

test('默认配置里有 care 段，且调试台能编辑时间窗与频率', () => {
  assert.ok(DEFAULT_CONFIG.care, 'DEFAULT_CONFIG 缺 care');
  assert.ok(Array.isArray(DEFAULT_CONFIG.care.windows));
  const html = fs.readFileSync(path.join(root, 'web', 'debug.html'), 'utf8');
  for (const key of ['care.enabled', 'care.windows', 'care.everyMinutes', 'care.jitterMinutes', 'care.maxPerDay', 'care.quietAfterMinutes']) {
    assert.ok(html.includes("'" + key + "'"), '调试台缺少字段 ' + key);
  }
  assert.match(html, /care: '主动找你聊天/, '调试台要有分组标题');
  assert.match(html, /'share', 'care'/, 'care 要排在 share 后面');
});

test('桥接里接了定时器，且判断交给服务端', () => {
  const py = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');
  assert.match(py, /def care_watch/);
  assert.match(py, /Thread\(target=care_watch/);
  assert.match(py, /\/api\/care\/due/, '该不该发要问服务端（时间窗在 care.js 里算）');
  assert.match(py, /\/api\/care"/, '内容要问服务端生成');
  assert.match(py, /CARE_QUIET_MIN/, '要有「刚聊过就别打扰」的静默期');
  assert.match(py, /care-state\.json/, '要记上次发的时间');
});
