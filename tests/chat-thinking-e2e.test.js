'use strict';

/**
 * 端到端「造数据」回归（不需要真实群聊/真实 Key）：
 *
 *   1) 用脚本化的假 HTTP 服务 + 真 DeepSeekClient + 真 Store，模拟一次
 *      「思考模型把 max_tokens 吃光」的 episode 抽取，验证会自动切关思考档、
 *      拿到可解析 JSON，而且日志里不再只有「空泡泡」；
 *   2) 造 20 条群聊消息，让模型分别返回内联思考、<thinking>、DeepSeek 结束符、
 *      content 数组等脏格式，验证发出去的正文里没有 think / 思考过程 / [object Object]；
 *   3) 单轮输入超硬上限时，先丢记忆块重算预算，而不是直接不回话。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const { DeepSeekClient } = require('../src/llm/client');
const memoryBudget = require('../src/memory/budget');
const personCard = require('../src/memory/personCard');

function makeConfig(overrides = {}) {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (overrides.group) Object.assign(cfg.group, overrides.group);
  if (overrides.chat) Object.assign(cfg.chat, overrides.chat);
  cfg.persona.master = { names: [], wxids: [] };
  return cfg;
}

function makeLogger() {
  const logs = [];
  const push = (level) => (m) => logs.push([level, String(m)]);
  return {
    logs,
    logger: { error: push('error'), warn: push('warn'), info: push('info'), debug: () => {} },
  };
}

/** 脚本化假服务：按请求顺序返回预设 JSON，并记录每次请求体 */
function startScripted(responses) {
  const bodies = [];
  let idx = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        bodies.push(JSON.parse(raw));
      } catch {
        bodies.push({});
      }
      const payload = responses[Math.min(idx, responses.length - 1)] || { choices: [{ message: { content: '咕噜' } }] };
      idx += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        bodies,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeBot({ config, llm, logger, dir }) {
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory, logger });
  const bot = new Bot({ config, store, llm, logger, mockChunkDelayMs: 0 });
  return { bot, store };
}

const groupMsg = (text, i) => ({
  platform: 'web',
  chatId: 'g1',
  chatType: 'group',
  senderId: 'u2',
  senderName: '阿螈',
  chatTitle: '深海鱼塘',
  text,
  atMe: true,
  msgId: `m${i}`,
});

const emptyThinking = {
  choices: [{ message: { content: '' }, finish_reason: 'length' }],
  usage: { prompt_tokens: 3200, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 700 } },
};

const reply = (content, extra = {}) => ({ choices: [{ message: { content }, finish_reason: 'stop' }], ...extra });

/* ────────────────────────────── 1) episode 端到端 ────────────────────────────── */

test('episode 抽取：思考吃满 → 自动切关思考档，模型事件真的写进卡', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-e2e-ep-'));
  const { logs, logger } = makeLogger();
  const episodeJson = JSON.stringify({
    summary: '小海在聊换工作，压力挺大，想换个环境。',
    facts: [{ uid: 'u1', text: '最近在换工作', confidence: 0.8 }],
    traits: [],
    events: [{
      uid: 'u1',
      title: '换工作',
      summary: '小海说最近在换工作，压力挺大，想换个环境，还没想好去哪。',
      keywords: ['换工作', '压力'],
      importance: 0.7,
      confidence: 0.8,
    }],
    threads: [{ uid: 'u1', text: '还没想好换到哪' }],
    relations: [],
  });
  // 第一次：思考吃满（空内容 + finish=length + reasoning=700）；第二次：正常 JSON
  const fake = await startScripted([emptyThinking, reply(episodeJson)]);
  const cfg = makeConfig();
  Object.assign(cfg.deepseek, {
    apiKey: 'sk-test-1234567890',
    baseUrl: fake.url,
    model: 'deepseek-flash',
    maxTokens: 700,
    thinking: false,
  });
  Object.assign(cfg, { provider: 'deepseek', paths: { dataDir: dir, settingsFile: path.join(dir, 'settings.json') }, env: {} });
  const client = new DeepSeekClient({ config: cfg, logger });
  const { store } = makeBot({ config: cfg, llm: client, logger, dir });

  try {
    const key = 'web:g:g1';
    const now = Date.now();
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '最近在换工作，压力挺大，想换个环境', ts: now - 4000 });
    store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '慢慢来，别把自己逼太紧', ts: now - 3000 });
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '还没想好换到哪', ts: now - 2000 });
    await store.drain();

    const closed = await store.closeEpisode(key, { llm: client, now, reason: 'manual' });
    assert.equal(closed.closed, true);

    // 第二次请求必须已经切到「关思考」档
    assert.ok(fake.bodies.length >= 2, '必须重试一次');
    assert.deepEqual(fake.bodies[1].thinking, { type: 'disabled' }, '第二次要发关思考参数');
    assert.equal('reasoning_effort' in fake.bodies[1], false);

    // 写进卡的是模型抽的事件（规则兜底不会产生 events）
    const chat = store.chatStore.chats.get(key);
    const card = store.chatStore.getCard(chat, 'u1');
    const events = personCard.activeEvents(card);
    assert.ok(events.some((e) => e.title === '换工作'), '模型的事件要落卡：' + JSON.stringify(events.map((e) => e.title)));

    // 日志：有原因、没有「空泡泡」
    const warnText = logs.filter(([lv]) => lv === 'warn').map(([, m]) => m).join('\n');
    assert.ok(warnText.includes('思考吃满'), '要有思考吃满的 warn：' + warnText);
    assert.ok(!warnText.includes('空泡泡'), '不能再出现「空泡泡」：' + warnText);
    assert.ok(!warnText.includes('episode 抽取失败'), '这条路应该成功：' + warnText);
  } finally {
    store.close();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

/* ─────────────────────── 2) 20 条群聊抽样：正文必须干净 ─────────────────────── */

test('群聊抽样 20 条：正文不含 think / 思考过程 / [object Object]', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-e2e-g-'));
  const { logs, logger } = makeLogger();

  // 20 条彼此不同的回复（避免被「复读检测」替换成兜底台词），覆盖各种「思考混进正文」的脏格式
  const answers = [
    'Thinking: 先想想她在问什么\n\n早点睡吧，别熬太晚',
    '<thinking>这段是思考，不该出现</thinking>多喝点热水，缓一缓',
    '想想怎么答<｜end▁of▁thinking｜>周末出去走走会好一些',
    [{ type: 'text', text: '别太拼了，' }, { type: 'text', text: '身体要紧' }],
    '吃顿好的犒劳自己',
    '听点歌放松一下吧',
    '散散步吹吹风就舒服了',
    '中午补个觉试试',
    '晒晒太阳心情会好',
    '找人聊聊别闷着',
    '把烦心事写下来',
    '深呼吸几次会平静些',
    '洗个热水澡早点躺下',
    '泡杯茶歇一会儿',
    '起来拉伸一下',
    '关掉手机发会儿呆',
    '看看窗外发发呆',
    '早点回家休息',
    '吃点水果补补维生素',
    '明天再说也不迟',
  ];

  const fake = await startScripted(answers.map((content) => reply(content)));
  const cfg = makeConfig({ group: { cooldownSec: 0, maxRepliesPerMinute: 30, freeChat: false } });
  Object.assign(cfg.deepseek, {
    apiKey: 'sk-test-1234567890',
    baseUrl: fake.url,
    model: 'deepseek-flash',
    maxTokens: 700,
    thinking: false,
  });
  Object.assign(cfg, { provider: 'deepseek', paths: { dataDir: dir, settingsFile: path.join(dir, 'settings.json') }, env: {} });
  const client = new DeepSeekClient({ config: cfg, logger });
  const { bot, store } = makeBot({ config: cfg, llm: client, logger, dir });

  try {
    const replies = [];
    for (let i = 1; i <= 20; i += 1) {
      const res = await bot.handle(groupMsg(`@鲸鲸 第${i}条：今天有点累，随便聊聊`, i));
      if (res && res.action === 'reply') replies.push(...(res.bubbles || [res.reply]));
    }

    assert.ok(replies.length >= 15, '20 条里至少要有 15 条真的回出来，实际 ' + replies.length);
    const joined = replies.join('\n');
    assert.doesNotMatch(joined, /think/i, '正文里混进了 think：' + joined);
    assert.doesNotMatch(joined, /思考过程/, '正文里混进了思考过程：' + joined);
    assert.doesNotMatch(joined, /\[object Object\]/, '正文里混进了 [object Object]：' + joined);
    assert.doesNotMatch(joined, /<｜end▁of▁thinking｜>/, '思考结束符漏进了正文：' + joined);
    // 数组 content 那种要拼对
    assert.ok(replies.some((t) => t.includes('身体要紧')), 'content 数组要按 text 拼接：' + joined);
  } finally {
    store.close();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

/* ────────────────── 3) 单轮输入超硬上限：先丢记忆块，再决定拒 ────────────────── */

test('单轮输入超硬上限：丢掉记忆块/关系块重算后继续回复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-e2e-budget-'));
  const { logs, logger } = makeLogger();
  const cfg = makeConfig();
  const captured = { turns: null };
  const llm = {
    isMock: false,
    model: 'deepseek-chat',
    reload() {},
    async complete({ turns }) {
      captured.turns = turns;
      return '收到啦，我在的';
    },
  };
  const { bot, store } = makeBot({ config: cfg, llm, logger, dir });
  const originalAssert = memoryBudget.assertWithinHardLimit;
  let first = true;
  // 造「第一次超硬上限、丢掉记忆后就好了」：只拦第一次
  memoryBudget.assertWithinHardLimit = (budget) => {
    if (first) {
      first = false;
      const err = new Error('单轮输入超过硬上限');
      err.budget = budget;
      throw err;
    }
    return budget;
  };

  try {
    const key = 'web:u:s1';
    store.appendMessage(key, { role: 'user', name: '小海', uid: 'u1', text: '我叫小海，我喜欢猫', ts: Date.now() - 1000 });
    store.appendMessage(key, { role: 'assistant', name: '鲸鲸', text: '猫好呀', ts: Date.now() - 500 });

    const res = await bot.handle({
      platform: 'web', chatId: 's1', chatType: 'private', senderId: 'u1', senderName: '小海', text: '还记得我吗',
    });

    assert.equal(res.action, 'reply', '不能因为超预算直接不回话');
    assert.ok(res.bubbles && res.bubbles.length >= 1);
    // 最终发出去的 turns 里不该再有记忆块/人物卡段
    const sent = (captured.turns || []).map((t) => t.content || '').join('\n');
    assert.ok(!sent.includes('【这个聊天里的 TA】'), '记忆块应当被丢掉：' + sent.slice(0, 300));
    assert.ok(!sent.includes('【相关事件·索引】'), '事件块应当被丢掉');
    // 原文还在（丢的是记忆块，不是整段历史）
    assert.ok(sent.includes('我叫小海'), 'recent 原文要保留');
    assert.ok(
      logs.some(([lv, m]) => lv === 'warn' && m.includes('已丢掉记忆块')),
      '要留下兜底日志'
    );
  } finally {
    memoryBudget.assertWithinHardLimit = originalAssert;
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});
