'use strict';

/**
 * 「调试台一万个bug，调了没用还是默认」—— 系统排查后确认的两类真问题：
 *
 *   A. 桥接只在启动时读一次 config.json：wechat.* / share.enabled / care.enabled
 *      这些开关在 /debug 里改了完全没反应，只能重启桥接。
 *      → 现在桥接每 5 秒看一次 config.json 的修改时间，变了就热更新。
 *
 *   B. 两个开关在业务代码里根本没被读过，纯摆设：
 *      · group.requireAt（群里必须@她才接）—— 只有 config 和状态接口提到过；
 *      · group.maxRepliesPerHour（每小时上限）—— 同上。
 *      · share.sources（分享来源）—— 写什么都硬抓 B 站。
 *      → 现在三个都真的生效。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');
const debugPage = fs.readFileSync(path.join(root, 'web', 'debug.html'), 'utf8');

async function boot(configPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-debug-'));
  // 出厂 gateway.wechat.enabled 是 false（要用户自己开），测试里显式打开
  const base = {
    server: { port: 0, openBrowser: false },
    gateway: { wechat: { enabled: true, inboundToken: 'change-me-wechat' } },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ ...base, ...configPatch }));
  const instance = await startServer({ root: dir, env: {}, port: 0, openBrowser: false });
  return instance;
}

function patch(app, patchObj) {
  return fetch(app.url + '/api/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patch: patchObj }),
  }).then((r) => r.json());
}

/** 保存后配置要真的落地：config.json 有 250ms 的监视器，别假设 GET 立刻一致 */
async function waitConfig(app, key, want, ms = 3000) {
  const read = () => fetch(app.url + '/api/config').then((r) => r.json());
  let last = null;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const cfg = await read();
    last = key.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg.config);
    if (JSON.stringify(last) === JSON.stringify(want)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`配置 ${key} 没有落地：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(last)}`);
}

let seq = 0;
function groupMsg(app, chatId, text = '今天天气不错啊') {
  seq += 1;
  return fetch(app.url + '/webhook/wechat', {
    method: 'POST',
    // 出厂 inboundToken 是 change-me-wechat，不带就 403
    headers: { 'content-type': 'application/json', 'x-whale-bridge': '1', 'x-bot-token': 'change-me-wechat' },
    body: JSON.stringify({
      platform: 'wechat', type: 'group', chatId,
      sender: 'wxid_someone', senderName: '路人甲',
      text, atMe: false, msgId: 'g-' + seq + '-' + Date.now(),
    }),
  }).then((r) => r.json());
}

test('group.requireAt 真的管用：开=不@不回，关=不@也回', async () => {
  const app = await boot();
  try {
    await patch(app, { 'group.requireAt': true, 'group.freeChat': false, 'group.maxRepliesPerHour': 1000 });
    const ignored = await groupMsg(app, 'grp_require_on');
    assert.equal(ignored.action, 'ignore', '开着 requireAt 时，没 @ 她不该回');
    assert.equal(ignored.reason, 'not_addressed');

    await patch(app, { 'group.requireAt': false, 'group.freeChat': false, 'group.maxRepliesPerHour': 1000 });
    const replied = await groupMsg(app, 'grp_require_off');
    assert.equal(replied.action, 'reply', '关掉 requireAt 后，不 @ 也应该回：' + JSON.stringify(replied).slice(0, 120));
    assert.ok(String(replied.reply || '').length > 0, '要真的有一句回复');
  } finally {
    await app.close();
  }
});

test('group.maxRepliesPerHour 真的限流', async () => {
  const app = await boot();
  try {
    await patch(app, { 'group.requireAt': false, 'group.maxRepliesPerHour': 1 });
    // 先确认配置真的落地了，避免把「保存没生效」误判成「限流坏了」
    await waitConfig(app, 'group.requireAt', false);
    await waitConfig(app, 'group.maxRepliesPerHour', 1);

    const first = await groupMsg(app, 'grp_cap', '第一句话');
    assert.equal(first.action, 'reply', '第一条应该回，实际：' + JSON.stringify(first).slice(0, 200));
    const second = await groupMsg(app, 'grp_cap', '第二句话');
    assert.equal(second.action, 'ignore', '一小时只允许 1 条时，第二条应被拦：' + JSON.stringify(second).slice(0, 200));
    assert.equal(second.reason, 'hourly_cap');
  } finally {
    await app.close();
  }
});

test('share.sources 真的决定来源（填别的不会偷偷去抓 B 站）', async () => {
  const app = await boot();
  try {
    await patch(app, { 'share.sources': ['douyin'] });
    const out = await fetch(app.url + '/api/share?chat=grp_x').then((r) => r.json());
    assert.equal(out.ok, true);
    assert.equal(out.video, null, '没有可用来源时不该有视频');
    assert.equal(out.reason, 'no_source');
    assert.deepEqual(out.sources, ['douyin']);
  } finally {
    await app.close();
  }
});

test('桥接会热更新配置（调试台改完不用重启）', () => {
  assert.match(bridge, /def reload_config/, '要有热更新函数');
  assert.match(bridge, /def config_watch/, '要有盯 config.json 的线程');
  assert.match(bridge, /Thread\(target=config_watch/, '线程要真的启动');
  assert.match(bridge, /配置已热更新/, '要写日志，让人知道生效了');
  // 关键开关必须在热更新里被重新赋值（global 声明）
  const fn = bridge.slice(bridge.indexOf('def reload_config'));
  const body = fn.slice(0, fn.indexOf('\n# 系统 / 公众号'));
  for (const k of ['CARE_ENABLED', 'SHARE_ENABLED', 'GAME_TOKENS', 'KEYBOARD_FALLBACK', 'BACKGROUND_SEND']) {
    assert.match(body, new RegExp('global[^\\n]*' + k + '|' + k + ' = '), k + ' 要在热更新里刷新');
  }
  assert.match(body, /SYSTEM_SENDER_NAMES/, '忽略名单也要刷新');
});

test('调试台明确告诉用户「5 秒内自动生效」', () => {
  assert.match(debugPage, /5 秒内自动重读/, '页面上要写清楚，别让人以为要重启');
});
