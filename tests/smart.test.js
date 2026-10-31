'use strict';

/**
 * 变聪明的小零件：自动记事实、旧消息压缩。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function makeBot({ config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smart-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
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
  const prompt = [r.system, ...(r.turns || []).map((t) => t.content)].join('\n');
  assert.match(prompt, /王大锤/);
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

test('群里只记当前说话人的自述（记在群卡，不串私聊）', async () => {
  const { bot, store, cleanup } = makeBot();
  await bot.decide({
    platform: 'wechat', chatId: 'g1', chatType: 'group',
    senderId: 'u-a', senderName: '甲', text: '@鲸鲸 我叫王大锤', atMe: true, chatTitle: '深海鱼塘',
  });
  const groupNotes = store.listNotes('wechat:g:g1').flatMap((x) => x.notes);
  assert.ok(groupNotes.some((n) => n.includes('王大锤')), '群卡要记当前说话人的自述');
  assert.equal(store.listNotes('wechat:u:g1').flatMap((x) => x.notes).length, 0, '不能写进同名私聊');
  cleanup();
});

test('长时间聊天：旧原文不丢在磁盘，prompt 用摘要接住', async () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.chat.groupHistoryTurns = 400;
  const { bot, store, cleanup } = makeBot({ config });
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
  assert.ok(content.length > 0);
  // 原文一条不少：压缩只影响 prompt，不动 messages.jsonl
  assert.equal(store.messages('wechat:g:g-big', 500).length, 91);
  // 被 episode 关掉的旧段，用摘要/事件接住，而不是凭空消失
  assert.ok(/【这段之前聊过】|【相关事件】/.test(content), '应有摘要或事件块：' + content.slice(0, 200));
  cleanup();
});
