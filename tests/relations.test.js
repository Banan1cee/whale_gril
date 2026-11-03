'use strict';

/**
 * 群聊关系加载（A 提到 B）：关系边的抽取 / 合并 / 淘汰 / 隔离，以及提示词里的那一小块。
 *
 * 覆盖：
 *   1. 三种句式都能抽出关系；「我朋友说…」转述不误判；
 *   2. 同一 pair 重复写入合并，不产生重复条目；
 *   3. 上限 200，按 updatedAt 淘汰最旧的；
 *   4. 名字 → uid：唯一命中 / 多人同名取最近发言者 / 完全对不上不建边；
 *   5. 渲染块：有关系 = 关系 + 卡 + 最近发言；没关系 = 卡 + 最近发言；总量 ≤200 token；
 *   6. 跨群隔离：写别群的关系抛 MEMORY_CHAT_MISMATCH，读盘时不一致的条目被过滤；
 *   7. features.relations=false：buildContext 不含关系块；
 *   8. episode 抽取：a/b 不在 speakers 里就丢弃；
 *   9. 关系文本含敏感词时过 sanitizeForModel。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const relations = require('../src/memory/relations');
const extractor = require('../src/memory/extractor');
const { estimateBudgetTokens } = require('../src/memory/tokens');
const { Bot } = require('../src/pipeline/chat');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const features = require('../src/infra/features');

const GROUP = 'wechat:g:g1';

function makeStore(limits = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-rel-'));
  const store = new Store({ file: path.join(dir, 'data', 'store.json'), logger: null, limits });
  return {
    store,
    dir,
    cleanup() {
      try { store.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
    },
  };
}

function ensureGroup(store, key = GROUP) {
  return store.chatStore.ensureChat(key, { platform: 'wechat', chatType: 'group', title: '深海鱼塘' });
}

/** 走 Store.appendMessage：关系边即时写入也在这条路径上 */
function say(store, { key = GROUP, uid, name, text, msgId = '' }) {
  store.ensureSession(key, { platform: 'wechat', chatType: 'group', title: '深海鱼塘' });
  return store.appendMessage(key, { role: 'user', uid, name, text, msgId, ts: Date.now() });
}

function makeBot(configPatch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-rel-bot-'));
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  Object.assign(config.features, configPatch.features || {});
  const store = new Store({
    file: path.join(dir, 'data', 'store.json'),
    logger: null,
    limits: { relationsEnabled: config.features.relations !== false },
  });
  const bot = new Bot({
    config,
    store,
    logger: null,
    mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {} },
  });
  return {
    bot,
    store,
    config,
    cleanup() {
      try { store.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
    },
  };
}

const gm = (uid, name, text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1', chatType: 'group', senderId: uid, senderName: name, text, atMe: true, chatTitle: '深海鱼塘', ...extra,
});

/* ------------------------------ 1. 三种句式 ------------------------------ */

test('三种句式都能抽出关系，转述不误判', () => {
  const from = (text) => relations.fromMessage(text, { uid: 'u-a', name: '小海', msgId: 'm1' });

  const a = from('我和小明是同事');
  assert.equal(a.length, 1);
  assert.equal(a[0].bName, '小明');
  assert.equal(a[0].text, '同事');
  assert.equal(a[0].a, 'u-a');

  const b = from('小明是我朋友');
  assert.equal(b.length, 1);
  assert.equal(b[0].bName, '小明');
  assert.equal(b[0].text, '朋友');

  const c = from('我朋友叫小明');
  assert.equal(c.length, 1);
  assert.equal(c[0].bName, '小明');
  assert.equal(c[0].text, '朋友');

  // 转述：说的是「我朋友和他同事」，不是我和谁的关系
  assert.deepEqual(from('我朋友说小明是他同事'), []);
  assert.deepEqual(from('我朋友说今天很累'), []);
  assert.deepEqual(from('我同事在加班'), []);
  // 没有名字的描述句也不建边
  assert.deepEqual(from('我朋友都很好'), []);
});

test('规则即时写入：说话人提到本群的人，边落到 meta.relations', () => {
  const { store, cleanup } = makeStore();
  try {
    ensureGroup(store);
    say(store, { uid: 'u-ming', name: '小明', text: '今天加班好累' });
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是同事', msgId: 'wx-1' });

    const chat = store.chatStore.chats.get(GROUP);
    assert.equal(chat.meta.relations.length, 1);
    const edge = chat.meta.relations[0];
    assert.deepEqual([edge.a, edge.b].sort(), ['u-a', 'u-ming']);
    assert.equal(edge.text, '同事');
    assert.equal(edge.source.chatId, GROUP);
    assert.deepEqual(edge.source.messageIds, ['msg_2']);
  } finally {
    cleanup();
  }
});

/* ------------------------------ 2. 合并 ------------------------------ */

test('同一 pair 重复写入合并，不产生重复条目', () => {
  const list = [];
  const first = relations.upsert(list, {
    a: 'u-b', b: 'u-a', text: '同事', confidence: 0.7,
    source: { chatId: GROUP, messageIds: ['msg_1'] },
  }, { chatId: GROUP, now: 1000 });
  const second = relations.upsert(list, {
    a: 'u-a', b: 'u-b', text: '同事', confidence: 0.9,
    source: { chatId: GROUP, messageIds: ['msg_2'] },
  }, { chatId: GROUP, now: 2000 });

  assert.equal(list.length, 1, '同一个 pair 只能有一条边');
  assert.equal(first.id, second.id);
  assert.equal(second.updatedAt, 2000);
  assert.equal(second.confidence, 0.9);
  assert.deepEqual(second.source.messageIds, ['msg_1', 'msg_2']);
  // 字典序：a 永远排在 b 前面
  assert.ok(second.a < second.b);

  // Store 路径也一样：同一个人反复说同一段关系，不涨条数
  const { store, cleanup } = makeStore();
  try {
    ensureGroup(store);
    say(store, { uid: 'u-ming', name: '小明', text: '我在' });
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是同事' });
    say(store, { uid: 'u-a', name: '小海', text: '小明是我同事' });
    assert.equal(store.chatStore.chats.get(GROUP).meta.relations.length, 1);
  } finally {
    cleanup();
  }
});

/* ------------------------------ 3. 上限 200 ------------------------------ */

test('上限 200：淘汰 updatedAt 最旧的', () => {
  const list = [];
  for (let i = 0; i < 201; i += 1) {
    relations.upsert(list, {
      a: 'u-a', b: `u-${i}`, text: '同事',
      source: { chatId: GROUP, messageIds: [`m${i}`] },
    }, { chatId: GROUP, now: 1000 + i });
  }
  assert.equal(list.length, 200);
  assert.equal(relations.find(list, 'u-a', 'u-0'), null, '最久没更新的那条要被淘汰');
  assert.ok(relations.find(list, 'u-a', 'u-200'), '最新的一条必须还在');
});

/* ------------------------------ 4. 名字 → uid ------------------------------ */

test('名字 → uid：唯一命中', () => {
  const { store, cleanup } = makeStore();
  try {
    ensureGroup(store);
    say(store, { uid: 'u-ming', name: '小明', text: '我在' });
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是同事' });
    const edge = store.chatStore.chats.get(GROUP).meta.relations[0];
    assert.deepEqual([edge.a, edge.b].sort(), ['u-a', 'u-ming']);
  } finally {
    cleanup();
  }
});

test('名字 → uid：多人同名取最近发言者', () => {
  const { store, cleanup } = makeStore();
  try {
    ensureGroup(store);
    say(store, { uid: 'u-old', name: '小明', text: '我是旧小明' });
    say(store, { uid: 'u-new', name: '小明', text: '我是新小明' });
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是朋友' });

    const edge = store.chatStore.chats.get(GROUP).meta.relations[0];
    assert.equal(edge.b, 'u-new', '同名时取最近说话的那个');
  } finally {
    cleanup();
  }
});

test('名字 → uid：完全对不上就不建边、不建卡', () => {
  const { store, cleanup } = makeStore();
  try {
    const chat = ensureGroup(store);
    say(store, { uid: 'u-a', name: '小海', text: '我和外星人是同事' });

    assert.equal(chat.meta.relations.length, 0, '查不到 uid 不能编一条边');
    const names = [...chat.people.values()].map((c) => c.name);
    assert.ok(!names.includes('外星人'), '查不到 uid 不能建卡：' + names.join('、'));
    // fromMessage 仍然保留了 bName，方便以后按名字再解析
    const drafts = relations.fromMessage('我和外星人是同事', { uid: 'u-a', name: '小海' });
    assert.equal(drafts[0].bName, '外星人');
  } finally {
    cleanup();
  }
});

/* ------------------------------ 5. 渲染块 ------------------------------ */

test('渲染块：有关系时含关系 + 卡 + 最近发言，且 ≤200 token', () => {
  const { store, cleanup } = makeStore({ relationsEnabled: true });
  try {
    ensureGroup(store);
    say(store, { uid: 'u-ming', name: '小明', text: '我最近在学吉他' });
    say(store, { uid: 'u-ming', name: '小明', text: '周末去爬山了' });
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是同事' });
    // 给小明补两条卡上内容
    const chat = store.chatStore.chats.get(GROUP);
    const card = store.chatStore.getCard(chat, 'u-ming');
    card.traits.push({ id: 'tr_1', text: '爱笑', confidence: 0.9, evidence: ['msg_1'] });
    card.preferences.push({ id: 'pf_1', text: '喜欢猫', confidence: 0.9, source: 'msg_1' });
    store.chatStore.saveCard(chat, card);

    const ctx = store.buildContext({
      key: GROUP, uid: 'u-a', name: '小海', query: '小明最近咋样',
      mentionedNames: ['小明'], relationsEnabled: true,
    });
    assert.ok(ctx.relationsBlock.includes('你和小明的关系：同事'), ctx.relationsBlock);
    assert.ok(ctx.relationsBlock.includes('关于小明'), ctx.relationsBlock);
    assert.ok(ctx.relationsBlock.includes('小明最近说过'), ctx.relationsBlock);
    assert.ok(ctx.relationsBlock.includes('别复述这份记录'));
    assert.ok(estimateBudgetTokens(ctx.relationsBlock) <= relations.MAX_BLOCK_TOKENS,
      '关系块不能超过 200 token：' + estimateBudgetTokens(ctx.relationsBlock));
    assert.equal(ctx.mentions.length, 1);
    assert.equal(ctx.mentions[0].uid, 'u-ming');
  } finally {
    cleanup();
  }
});

test('渲染块：没关系边时只给卡 + 最近发言，不编关系', () => {
  const { store, cleanup } = makeStore({ relationsEnabled: true });
  try {
    ensureGroup(store);
    say(store, { uid: 'u-hong', name: '小红', text: '我在学画画' });
    say(store, { uid: 'u-a', name: '小海', text: '小红最近咋样' });
    const chat = store.chatStore.chats.get(GROUP);
    const card = store.chatStore.getCard(chat, 'u-hong');
    card.preferences.push({ id: 'pf_2', text: '喜欢画画', confidence: 0.9, source: 'msg_1' });
    store.chatStore.saveCard(chat, card);

    const ctx = store.buildContext({
      key: GROUP, uid: 'u-a', name: '小海', query: '小红最近咋样',
      mentionedNames: ['小红'], relationsEnabled: true,
    });
    assert.ok(!ctx.relationsBlock.includes('你和'), '没有边就不能编关系：' + ctx.relationsBlock);
    assert.ok(ctx.relationsBlock.includes('关于小红'));
    assert.ok(ctx.relationsBlock.includes('小红最近说过'));
    assert.ok(estimateBudgetTokens(ctx.relationsBlock) <= relations.MAX_BLOCK_TOKENS);
  } finally {
    cleanup();
  }
});

test('名字对不上任何人：整块不输出', () => {
  const { store, cleanup } = makeStore({ relationsEnabled: true });
  try {
    ensureGroup(store);
    say(store, { uid: 'u-a', name: '小海', text: '在吗' });
    const ctx = store.buildContext({
      key: GROUP, uid: 'u-a', name: '小海', query: '在吗',
      mentionedNames: ['根本不存在的人'], relationsEnabled: true,
    });
    assert.equal(ctx.relationsBlock, '');
    assert.equal(ctx.relationsTokens, 0);
  } finally {
    cleanup();
  }
});

test('多个被提到的人合并后仍守 200 token', () => {
  const { store, cleanup } = makeStore({ relationsEnabled: true });
  try {
    ensureGroup(store);
    const chat = store.chatStore.chats.get(GROUP);
    for (const [uid, name] of [['u-b1', '甲'], ['u-b2', '乙'], ['u-b3', '丙']]) {
      say(store, { uid, name, text: '我最近在忙一个很长很长的项目，每天都要加班到很晚才回家' });
      const card = store.chatStore.getCard(chat, uid);
      for (let i = 0; i < 6; i += 1) {
        card.preferences.push({ id: `pf_${uid}_${i}`, text: '偏好第' + i + '条'.repeat(4), confidence: 0.9, source: 'msg_1' });
      }
      store.chatStore.saveCard(chat, card);
    }
    const ctx = store.buildContext({
      key: GROUP, uid: 'u-a', name: '小海', query: '甲乙丙',
      mentionedNames: ['甲', '乙', '丙'], relationsEnabled: true,
    });
    assert.ok(ctx.relationsBlock.length > 0);
    assert.ok(estimateBudgetTokens(ctx.relationsBlock) <= relations.MAX_BLOCK_TOKENS,
      '合并块不能超过 200 token：' + estimateBudgetTokens(ctx.relationsBlock));
  } finally {
    cleanup();
  }
});

/* ------------------------------ 6. 跨群隔离 ------------------------------ */

test('跨群隔离：写别群的关系抛 MEMORY_CHAT_MISMATCH', () => {
  const list = [];
  assert.throws(
    () => relations.upsert(list, {
      a: 'u-a', b: 'u-b', text: '同事', source: { chatId: 'wechat:g:g2', messageIds: [] },
    }, { chatId: GROUP }),
    (err) => err && err.code === 'MEMORY_CHAT_MISMATCH',
  );
  assert.equal(list.length, 0, '抛错时不能留下半条边');
});

test('跨群隔离：读盘时别的群的边被过滤', () => {
  const { store, dir, cleanup } = makeStore();
  try {
    const chat = ensureGroup(store);
    store.flush();
    const metaFile = path.join(chat.dir, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.relations = [
      { id: 'rel_x', a: 'u-a', b: 'u-b', text: '同事', confidence: 0.8, source: { chatId: GROUP, messageIds: [] }, createdAt: 1, updatedAt: 1 },
      { id: 'rel_y', a: 'u-a', b: 'u-c', text: '朋友', confidence: 0.8, source: { chatId: 'wechat:g:g2', messageIds: [] }, createdAt: 1, updatedAt: 1 },
    ];
    fs.writeFileSync(metaFile, JSON.stringify(meta), 'utf8');
    store.reloadFromDisk();

    const loaded = store.chatStore.chats.get(GROUP);
    assert.equal(loaded.meta.relations.length, 1, '别的群写进来的边必须被丢掉');
    assert.equal(loaded.meta.relations[0].text, '同事');
    assert.ok(dir);
  } finally {
    cleanup();
  }
});

/* ------------------------------ 7. 开关 ------------------------------ */

test('features.relations=false：buildContext 不含关系块', () => {
  const { store, cleanup } = makeStore({ relationsEnabled: true });
  try {
    ensureGroup(store);
    say(store, { uid: 'u-ming', name: '小明', text: '我在' });
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是同事' });

    const on = store.buildContext({
      key: GROUP, uid: 'u-a', name: '小海', query: '小明',
      mentionedNames: ['小明'], relationsEnabled: true,
    });
    assert.ok(on.relationsBlock.includes('你和小明的关系'));

    const off = store.buildContext({
      key: GROUP, uid: 'u-a', name: '小海', query: '小明',
      mentionedNames: ['小明'], relationsEnabled: false,
    });
    assert.equal(off.relationsBlock, '', '开关关掉时不能注入关系块');
    assert.equal(off.relationsTokens, 0);
  } finally {
    cleanup();
  }
});

test('features.relations 注册在开关表里，默认开', () => {
  assert.ok(features.REGISTRY.some((f) => f.key === 'relations' && f.path === 'features.relations'));
  assert.equal(features.isOn(DEFAULT_CONFIG, 'relations'), true);
});

test('端到端：群里 A 提到 B，尾部真的注入关系块；关掉开关就不注入', async () => {
  const { bot, config, cleanup } = makeBot();
  try {
    await bot.decide(gm('u-ming', '小明', '我最近在学吉他'));
    const on = await bot.decide(gm('u-a', '小海', '我和小明是同事', { mentionedNames: ['小明'] }));
    const tailOn = [...(on.turns || []).map((t) => t.content), on.system || ''].join('\n');
    assert.ok(tailOn.includes('【这条消息提到的「小明】'), '尾部应该有关系块：' + tailOn.slice(-400));
    assert.ok(tailOn.includes('你和小明的关系：同事'));

    config.features.relations = false;
    const off = await bot.decide(gm('u-a', '小海', '小明最近咋样', { mentionedNames: ['小明'] }));
    const tailOff = [...(off.turns || []).map((t) => t.content), off.system || ''].join('\n');
    assert.ok(!tailOff.includes('【这条消息提到的「小明】'), '关掉开关后不能注入：' + tailOff.slice(-400));
  } finally {
    cleanup();
  }
});

/* ------------------------------ 8. episode 抽取 ------------------------------ */

test('episode 解析：relations 只接受 a/b 都在 speakers 里的', async () => {
  const messages = [
    { id: 'msg_1', seq: 1, role: 'user', uid: 'u-a', name: '小海', text: '我和小明是同事' },
    { id: 'msg_2', seq: 2, role: 'user', uid: 'u-b', name: '小明', text: '对' },
  ];
  const raw = JSON.stringify({
    summary: '小海说和小明是同事。',
    relations: [
      { a: 'u-a', b: 'u-b', text: '同事', confidence: 0.8 },
      { a: 'u-a', b: 'u-x', text: '朋友', confidence: 0.8 },
    ],
  });
  const parsed = extractor.parseEpisode(raw);
  assert.equal(parsed.relations.length, 2, 'parseEpisode 只做字段清洗');

  const llm = { isMock: false, complete: async () => raw };
  const res = await extractor.extractEpisode({
    messages, llm, speakers: [{ uid: 'u-a', name: '小海' }, { uid: 'u-b', name: '小明' }],
  });
  assert.equal(res.relations.length, 1, 'a/b 不在 speakers 里的边要丢掉');
  assert.equal(res.relations[0].b, 'u-b');
});

test('episode 关闭时把关系边写进 meta.relations', async () => {
  const { store, cleanup } = makeStore();
  try {
    ensureGroup(store);
    say(store, { uid: 'u-a', name: '小海', text: '我和小明是同事' });
    say(store, { uid: 'u-b', name: '小明', text: '对，我们在一个组' });
    const llm = {
      isMock: false,
      complete: async () => JSON.stringify({
        summary: '小海和小明确认是同事。',
        relations: [{ a: 'u-a', b: 'u-b', text: '同事', confidence: 0.85 }],
      }),
    };
    const result = await store.closeEpisode(GROUP, { llm, reason: 'manual' });
    assert.equal(result.closed, true);
    const chat = store.chatStore.chats.get(GROUP);
    assert.equal(chat.meta.relations.length, 1);
    assert.equal(chat.meta.relations[0].text, '同事');
    assert.equal(chat.meta.relations[0].source.chatId, GROUP);
  } finally {
    cleanup();
  }
});

/* ------------------------------ 9. 脱敏 ------------------------------ */

test('关系文本含敏感词时过 sanitizeForModel', () => {
  const list = [];
  const edge = relations.upsert(list, {
    a: 'u-a', b: 'u-b', text: '傻逼同事', confidence: 0.8,
    source: { chatId: GROUP, messageIds: ['m1'] },
  }, { chatId: GROUP, now: 1000 });
  const block = relations.renderMentionBlock({ name: '小明', edge });
  assert.ok(!block.includes('傻逼'), '提示词里不能出现原始敏感词：' + block);
  assert.ok(block.includes('***'));
});
