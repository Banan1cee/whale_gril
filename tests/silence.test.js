'use strict';

/**
 * 「让她滚就该群里静默，没人 @ 她别说话」的回归测试。
 *
 * 三个问题叠在一起：
 *   1. 「让她滚」是第三人称，dismiss 正则只认「你滚 / 滚」这种直接命令 → 根本没进静默。
 *   2. INSULT_RE 里就有「滚」，而且两处都是**裸匹配**（不管在说谁）：群里任何人抱怨
 *      「这天气真垃圾」「股票跌了滚蛋吧」，她都当成在骂自己，跳出来对喷 —— 也就是
 *      「没人 @ 她，她还在说话」。
 *   3. 静默期的优先级低于 masterAlwaysReply，主人说完「让她滚」，下一句又把她叫起来。
 *
 * 另外要保住一条底线：静默期内 @ 她仍然能唤醒，不能变成永久失联。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot(over = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.master = { names: ['主人'], wxids: ['wxid_master'] };
  cfg.admin = { spell: 'test-spell', minutes: 30, allowAll: false };
  Object.assign(cfg.group, over.group || {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-silence-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: cfg.memory });
  const llm = { isMock: true, model: 'mock', reload() {}, describe: () => ({}) };
  const bot = new Bot({ config: cfg, store, llm, logger: null, mockChunkDelayMs: 0 });
  return {
    bot,
    cleanup() {
      try { store.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const groupMsg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 'g1',
  chatType: 'group',
  senderId: 'u2',
  senderName: '阿螈',
  chatTitle: '深海鱼塘',
  text,
  ...extra,
});

test('「让她滚」这种第三人称也算赶她走，进静默', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 先让她进入接话状态
    await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true }));

    const r = await bot.handle(groupMsg('让她滚'));
    assert.equal(r.action, 'reply', '赶她走时要回一句再退场');
    assert.equal(r.reason, 'dismissed', '要识别成 dismissed，实际：' + r.reason);

    // 之后群里闲聊一律不理
    for (const line of ['今天中午吃啥', '不知道啊']) {
      const x = await bot.handle(groupMsg(line));
      assert.equal(x.action, 'ignore', '被赶走后不该再说话：' + line);
      assert.equal(x.reason, 'silent', '原因应该是静默，实际：' + x.reason);
    }
  } finally {
    cleanup();
  }
});

test('群里没人 @ 她、只是路人闲聊里带脏字，她不该跳出来', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 先让她说过话（进入接话窗口的是另一个人）
    await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true, senderId: 'u2' }));

    // 路人在群里闲聊，说的是别人/别的事，不是骂她
    const chatter = [
      { senderId: 'u3', senderName: '路人甲', text: '滚啊这天气' },
      { senderId: 'u4', senderName: '路人乙', text: '今天股票又跌了，滚蛋吧' },
      { senderId: 'u5', senderName: '路人丙', text: '刚才那个电影真垃圾' },
      { senderId: 'u6', senderName: '路人丁', text: '这破网速真没用' },
      { senderId: 'u7', senderName: '路人戊', text: '烦死了，闭嘴吧这破系统' },
    ];
    for (const m of chatter) {
      const x = await bot.handle(groupMsg(m.text, m));
      assert.equal(
        x.action,
        'ignore',
        '路人闲聊里的脏字不是在骂她，不该回：' + m.text + '（实际 ' + x.action + ' / ' + x.reason + '）'
      );
    }
  } finally {
    cleanup();
  }
});

test('真在骂她（点名 / @ 她）还是要回', async () => {
  const { bot, cleanup } = makeBot();
  try {
    // 点名她的：不管有没有 @ 都算冲她
    for (const line of ['鲸鲸你个智障', '机器人真垃圾']) {
      const x = await bot.handle(groupMsg(line));
      assert.equal(
        x.action,
        'reply',
        '点名骂她必须回（不能为了安静把该怼的也掐掉）：' + line + '（实际 ' + x.action + ' / ' + x.reason + '）'
      );
    }
    // 带 @ 的：哪怕只有「你」也知道在骂她
    const x = await bot.handle(groupMsg('你是不是傻逼', { atMe: true }));
    assert.equal(x.action, 'reply', '@ 她说「你是不是傻逼」必须回');
  } finally {
    cleanup();
  }
});

test('没有 @、也没点名，光一句「你是不是傻逼」不接（可能是在骂别人）', async () => {
  const { bot, cleanup } = makeBot();
  try {
    const x = await bot.handle(groupMsg('你是不是傻逼'));
    assert.equal(
      x.action,
      'ignore',
      '群里没 @ 没点名，这句可能是在骂别人，不该自己认领'
    );
  } finally {
    cleanup();
  }
});

test('静默期内 @ 她仍然能唤醒（不能永久失联）', async () => {
  const { bot, cleanup } = makeBot();
  try {
    await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true }));
    await bot.handle(groupMsg('让她滚'));

    // 静默中
    const quiet = await bot.handle(groupMsg('随便聊聊'));
    assert.equal(quiet.action, 'ignore');

    // @ 一下就得回来
    const back = await bot.handle(groupMsg('@鲸鲸 在吗', { atMe: true }));
    assert.equal(back.action, 'reply', '@ 她必须能唤醒，否则就是永久失联');
    assert.equal(back.reason, 'addressed');

    // 唤醒之后闲聊又能接（窗口重新打开）
    const after = await bot.handle(groupMsg('今天吃啥'));
    assert.equal(after.action, 'reply', '被唤醒后接话窗口要重新打开');
  } finally {
    cleanup();
  }
});

test('静默期优先级高于「主人说话就回」', () => {
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bot.js'), 'utf8');
  const silentIdx = botSrc.indexOf("reason: 'silent'");
  const masterIdx = botSrc.indexOf("reason: 'master'");
  assert.ok(silentIdx > 0 && masterIdx > 0, '两个分支都要在');
  assert.ok(
    silentIdx < masterIdx,
    '静默判断必须排在 masterAlwaysReply 之前，否则主人说完「让她滚」下一句又把她叫起来'
  );
});

test('「让他滚」（指别的男生）不该把她赶走', () => {
  const botSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'bot.js'), 'utf8');
  // 第三人称正则里不能出现单独一个「他」
  const m = botSrc.match(/\(让\|叫\|把\|喊\|请\)\(\?:([^)]*)\)/);
  assert.ok(m, '找得到第三人称 dismiss 正则');
  const targets = m[1].split('|');
  assert.ok(targets.includes('她'), '要认「让她滚」');
  assert.ok(!targets.includes('他'), '不能把「让他滚」也当成赶她走');
});
