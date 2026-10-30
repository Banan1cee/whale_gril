'use strict';

// 动作账本：模型看不见自己的副作用，这里保证「做过什么」能被下一轮读回去。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Store } = require('../src/memory/store');
const { Bot } = require('../src/pipeline/chat');
const { buildSystem } = require('../src/persona');
const { DEFAULT_CONFIG, loadConfig } = require('../src/infra/config');
const events = require('../src/core/events');
const { StickerService } = require('../src/services/stickerService');
const stickers = require('../src/adapters/stickers');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  return dir;
}

function makeStore(t) {
  const dir = tmpDir(t, 'whale-events-');
  const store = new Store({ file: path.join(dir, 'store.json') });
  t.after(() => store.close());
  return store;
}

function makeConfig() {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.persona.master = { names: ['Master'], wxids: ['wxid_test_master'] };
  cfg.features.stickers = true;
  return cfg;
}

function makeBot(t, { linkReader = null } = {}) {
  const config = makeConfig();
  const store = makeStore(t);
  const bot = new Bot({
    config,
    store,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null,
    mockChunkDelayMs: 0,
    linkReader,
  });
  return { bot, store, config };
}

const privateMsg = (text, extra = {}) => ({
  platform: 'web',
  chatId: 's1',
  chatType: 'private',
  senderId: 'u1',
  senderName: '小海',
  text,
  ...extra,
});

test('事件类型和内容都要合格，不合格的直接丢掉', () => {
  assert.equal(events.clampEvent(null), null);
  assert.equal(events.clampEvent({ type: 'nope', detail: 'x' }), null);
  assert.equal(events.clampEvent({ type: 'sticker', detail: '   ' }), null);
  const ok = events.clampEvent({ type: 'sticker', detail: '开心/wave.gif', status: 'weird', ts: 1000 });
  assert.deepEqual(ok, { ts: 1000, type: 'sticker', detail: '开心/wave.gif', status: 'ok' });
});

test('账本挂在会话上，不进聊天记录、有上限', (t) => {
  const store = makeStore(t);
  store.ensureSession('web:u:s1');
  store.appendMessage('web:u:s1', { role: 'user', name: '小海', text: '在吗' });
  for (let i = 0; i < 80; i += 1) {
    store.appendEvent('web:u:s1', { type: 'web', detail: `查询${i}`, status: 'ok' });
  }
  // 连续 5 秒内完全相同的记录会合并，这里每次 detail 都不同，所以是 80 条，被压到 60
  const all = store.events('web:u:s1', 500);
  assert.equal(all.length, 60);
  assert.equal(store.messages('web:u:s1').length, 1, '动作不能污染聊天记录');
  assert.equal(store.messages('web:u:s1')[0].text, '在吗');
});

test('回执改写同一条记录，不重复记账', (t) => {
  const store = makeStore(t);
  store.ensureSession('wechat:u:123');
  const entry = store.appendEvent('wechat:u:123', { type: 'sticker', detail: '开心/wave.gif', status: 'queued' });
  assert.ok(entry);
  const updated = store.updateEvent('wechat:u:123', entry.ts, { status: 'confirmed' });
  assert.equal(updated.status, 'confirmed');
  assert.equal(store.events('wechat:u:123').length, 1);
  assert.equal(store.updateEvent('wechat:u:123', 1, { status: 'failed' }), null, '找不到就别乱造一条');
});

test('提示词里如实写出做过什么，并说明没回执不许编', () => {
  const block = events.formatBlock([
    { ts: new Date('2026-01-01T10:02:00Z').getTime(), type: 'sticker', detail: '开心/wave.gif', status: 'confirmed' },
    { ts: new Date('2026-01-01T10:03:00Z').getTime(), type: 'sticker', detail: '无语/sad.gif', status: 'failed' },
  ]);
  assert.match(block, /【最近做过的事/);
  assert.match(block, /表情包「开心\/wave\.gif」—— 桥接确认发出/);
  assert.match(block, /表情包「无语\/sad\.gif」—— 失败/);
  assert.match(block, /不要编造送达/);
  assert.equal(events.formatBlock([]), '');
  assert.equal(events.formatBlock(null), '');
});

test('没有记录时提示词里不出现这一节', () => {
  const config = makeConfig();
  const base = buildSystem({ config, msg: { platform: 'web', chatType: 'private', text: '在吗' } });
  assert.doesNotMatch(base, /【最近做过的事/);
  const withEvents = buildSystem({
    config,
    msg: { platform: 'web', chatType: 'private', text: '在吗' },
    events: [{ ts: Date.now(), type: 'sticker', detail: '开心/wave.gif', status: 'confirmed' }],
  });
  assert.match(withEvents, /【最近做过的事/);
  assert.match(withEvents, /开心\/wave\.gif/);
});

test('自定义人设也要看得见自己做过的动作', () => {
  const config = makeConfig();
  config.persona.customPrompt = '你是审计测试角色，保持原有身份。';
  const prompt = buildSystem({
    config,
    msg: { platform: 'wechat', chatType: 'private', text: '发个图' },
    events: [{ ts: Date.now(), type: 'sticker', detail: '炸毛/wave.gif', status: 'unconfirmed' }],
  });
  assert.ok(prompt.startsWith('你是审计测试角色'));
  assert.match(prompt, /【最近做过的事/);
  assert.match(prompt, /桥接没回执/);
});

test('读过链接会记账，失败也如实记', async (t) => {
  const okBot = makeBot(t, {
    linkReader: async () => ({ ok: true, title: '一篇文章的标题', site: 'example' }),
  });
  await okBot.bot.handle(privateMsg('看看这个 https://example.com/a'));
  const okEvents = okBot.store.events('web:u:s1');
  const link = okEvents.find((e) => e.type === 'link');
  assert.ok(link, '读链接必须留下一条记录');
  assert.equal(link.status, 'ok');
  assert.match(link.detail, /一篇文章的标题/);

  const badBot = makeBot(t, {
    linkReader: async () => ({ ok: false, error: 'boom' }),
  });
  await badBot.bot.handle(privateMsg('看看这个 https://example.com/b'));
  const bad = badBot.store.events('web:u:s1').find((e) => e.type === 'link');
  assert.ok(bad);
  assert.equal(bad.status, 'failed');
});

test('表情包从排队到确认只留一行，并写进同一个会话', (t) => {
  const root = tmpDir(t, 'whale-sticker-events-');
  const config = loadConfig({ root, env: {} });
  config.root = root;
  config.features.stickers = true;
  config.sticker.chances = { cute: 1, angry: 1, other: 1 };
  stickers.upload(config, root, 'other', [{ name: '动画.gif', data: GIF.toString('base64') }]);

  const store = makeStore(t);
  const service = new StickerService(config, { store, rng: () => 0.5 });
  const msg = { platform: 'wechat', chatId: 'wxid_chat', chatType: 'private', chatTitle: '阿螈' };
  const job = service.plan(msg, '哈哈哈');
  assert.ok(job, '有图、概率满、没在飞的任务，应该能挑到一张');
  const key = 'wechat:u:wxid_chat';
  assert.equal(store.events(key).length, 1);
  assert.equal(store.events(key)[0].status, 'queued');

  service.claim(job.id);
  service.ack(job.id, 'confirmed');
  const list = store.events(key);
  assert.equal(list.length, 1, '回执改写排队那条，不新增');
  assert.equal(list[0].status, 'confirmed');
  assert.match(list[0].detail, /动画.*\.gif/);
});
