'use strict';

/**
 * 全局回复频率：所有会话合计每分钟最多 30 条。
 * 单会话上限（group.maxRepliesPerMinute）防的是「一个群爆刷」，
 * 这条测的是「每个会话都没超、但加起来停不下来」的情况。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

const GLOBAL_CAP = 30;

function makeBot() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  // 单会话闸门开到最大，确保被拦的只能是全局闸门
  config.group.maxRepliesPerMinute = 30;
  config.group.requireAt = false;
  config.group.freeChatChance = 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-global-cap-'));
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

let seq = 0;
const groupMsg = (text, chatId) => ({
  platform: 'wechat',
  chatId,
  chatType: 'group',
  senderId: 'wxid_someone',
  senderName: '路人甲',
  text,
  atMe: false,
  msgId: 'g-' + (seq += 1),
});

test('全局每分钟 30 条：第 31 条被 global_minute_cap 拦住', async () => {
  const { bot, cleanup } = makeBot();
  try {
    let replied = 0;
    // 每条换一个会话，确保单会话闸门不会先命中
    for (let i = 0; i < GLOBAL_CAP; i += 1) {
      const r = await bot.decide(groupMsg('第 ' + i + ' 句话', 'grp_' + i));
      assert.equal(r.action, 'reply', '第 ' + (i + 1) + ' 条应该回：' + JSON.stringify(r).slice(0, 160));
      bot.finalize(r, '好');
      replied += 1;
    }
    assert.equal(replied, GLOBAL_CAP);

    const blocked = await bot.decide(groupMsg('再来一句', 'grp_extra'));
    assert.equal(blocked.action, 'ignore', '全局到 30 后第 31 条应被拦');
    assert.equal(blocked.reason, 'global_minute_cap');
  } finally {
    cleanup();
  }
});
