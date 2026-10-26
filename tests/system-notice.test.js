'use strict';

/**
 * 系统通知保护：不能跟「微信团队」这类系统号吵起来，也不能被通知刷屏刷爆。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sys-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config,
    store,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null,
    mockChunkDelayMs: 0,
  });
  return {
    bot,
    config,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const private_ = (text, extra = {}) => ({
  platform: 'wechat',
  chatId: 'wxid_weixinteam',
  chatType: 'private',
  senderId: 'wxid_weixinteam',
  senderName: '微信团队',
  text,
  ...extra,
});

test('微信团队的私聊推送不回复', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(private_('如果遇到问题，可<a href="weixin://dl/feedback">轻触反馈</a>'));
  assert.equal(r.action, 'ignore');
  assert.equal(r.reason, 'system_notice');
  cleanup();
});

test('任何带 weixin:// 或 HTML 链接的推送都不回复', async () => {
  const { bot, cleanup } = makeBot();
  const a = await bot.decide(private_('点这里 <a href="https://example.com">登录</a>', { senderName: '路人' }));
  assert.equal(a.reason, 'system_notice');
  const b = await bot.decide(private_('打开 weixin://dl/feedback', { senderName: '路人' }));
  assert.equal(b.reason, 'system_notice');
  cleanup();
});

test('普通人私聊照常回复，不受系统号规则影响', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(private_('在吗', { chatId: 'u-friend', senderId: 'wxid_friend', senderName: '老王' }));
  assert.equal(r.action, 'reply');
  cleanup();
});

test('可以自定义要忽略的系统号名字', async () => {
  const { bot, config, cleanup } = makeBot();
  config.wechat = { ...(config.wechat || {}), ignoreSenders: ['某通知号'] };
  const r = await bot.decide(private_('你中奖了', { senderName: '某通知号', senderId: 'wxid_x' }));
  assert.equal(r.reason, 'system_notice');
  cleanup();
});

test('同一会话一分钟回太多条会暂停，避免刷屏死循环', async () => {
  const { bot, cleanup } = makeBot();
  let limited = null;
  for (let i = 0; i < 14; i += 1) {
    const r = await bot.decide(private_('第' + i + '句话', { chatId: 'u-fast', senderId: 'wxid_fast', senderName: '话痨' }));
    if (r.action === 'reply') {
      bot.finalize(r, '好');
    } else if (r.reason === 'burst_limit') {
      limited = r;
      break;
    }
  }
  assert.ok(limited, '应该触发 burst_limit');
  cleanup();
});
