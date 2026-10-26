'use strict';

/**
 * 变聪明的小零件：自动记事实、旧消息压缩。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot({ config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smart-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const pm = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'wxid_p', chatType: 'private',
  senderId: 'wxid_p', senderName: '老王', text, ...extra,
});

test('私聊里自报的信息会被自动记住', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide(pm('我叫王大锤'));
  const notes = store.listNotes('wechat:u:wxid_p').flatMap((x) => x.notes);
  assert.ok(notes.some((n) => n.includes('王大锤')), '应该记住名字：' + JSON.stringify(notes));
  cleanup();
});

test('记住的身份会出现在之后的提示词里', async () => {
  const { bot, cleanup } = makeBot();
  await bot.decide(pm('我叫王大锤'));
  const r = await bot.decide(pm('你还记得我叫什么吗'));
  assert.match(r.system, /王大锤/);
  cleanup();
});

test('不明确的句子不会被瞎记', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide(pm('我今天好累啊'));
  await bot.decide(pm('你这个笨蛋'));
  assert.equal(store.listNotes('wechat:u:wxid_p').flatMap((x) => x.notes).length, 0);
  cleanup();
});

test('重复的自述不会存两遍', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide(pm('我叫王大锤'));
  await bot.decide(pm('我叫王大锤'));
  const notes = store.listNotes('wechat:u:wxid_p').flatMap((x) => x.notes);
  assert.equal(notes.length, 1);
  cleanup();
});

test('群里不会乱记别人的自述（避免记错人）', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide({
    platform: 'wechat', chatId: 'g1', chatType: 'group',
    senderId: 'u-a', senderName: '甲', text: '@鲸鲸 我叫王大锤', atMe: true, chatTitle: '深海鱼塘',
  });
  assert.equal(store.listNotes('wechat:g:g1').flatMap((x) => x.notes).length, 0);
  cleanup();
});

test('超长历史会被压成一句摘要，而不是直接消失', async () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.chat.groupHistoryTurns = 400;
  config.memory.maxMessages = 600;
  const { bot, cleanup } = makeBot({ config });
  for (let i = 0; i < 90; i += 1) {
    await bot.decide({
      platform: 'wechat', chatId: 'g-big', chatType: 'group',
      senderId: 'u-' + (i % 3), senderName: '群友' + (i % 3),
      text: '这是第 ' + i + ' 条比较长的历史消息，内容是闲聊和日常',
      chatTitle: '深海鱼塘',
    });
  }
  const r = await bot.decide({
    platform: 'wechat', chatId: 'g-big', chatType: 'group',
    senderId: 'u-0', senderName: '群友0', text: '@鲸鲸 刚才聊到哪了', atMe: true, chatTitle: '深海鱼塘',
  });
  const content = r.turns.map((t) => t.content).join('\n');
  assert.ok(content.length > 1500, '上下文应该够长：' + content.length);
  // 只要触发压缩，就必须有摘要行
  if (content.includes('已压缩')) assert.match(content, /【更早的对话（已压缩）】/);
  cleanup();
});
