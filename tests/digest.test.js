'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { DEFAULT_CONFIG } = require('../src/infra/config');
const features = require('../src/infra/features');
const { DigestService, buildDigest } = require('../src/services/digestService');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { createRuntime, createHandler } = require('../server');
const clone = () => JSON.parse(JSON.stringify(DEFAULT_CONFIG));
const msg = (text = '周末去哪') => ({ platform: 'wechat', chatType: 'group', chatId: 'test-group',
  senderId: 'wxid_other', senderName: '甲', text, msgId: text });

test('汇总唯一总开关为 digest.enabled，默认关闭', () => {
  const cfg = clone();
  assert.equal(features.isOn(cfg, 'digest'), false);
  assert.equal(cfg.digest.everyMinutes, 30);
  assert.equal(features.REGISTRY.find((f) => f.key === 'digest').path, 'digest.enabled');
  cfg.features.digest = true;
  assert.equal(features.isOn(cfg, 'digest'), false, '旧残留的 features.digest 不能打开功能');
  cfg.digest.enabled = true;
  assert.equal(features.isOn(cfg, 'digest'), true);
});

test('关闭时不采集，关闭再打开不回放旧消息，旧代任务失效', () => {
  const cfg = clone(); let now = 1000;
  const service = new DigestService(cfg, { now: () => now });
  assert.equal(service.collect(msg()), false);
  assert.equal(service.read().status, 404);
  cfg.digest.enabled = true; service.reconcile();
  const generation = service.generation;
  assert.equal(service.collect(msg()), true);
  now++;
  assert.equal(service.read().body.count, 1);
  cfg.digest.enabled = false; service.reconcile();
  assert.deepEqual(service.entries, []);
  cfg.digest.enabled = true; service.reconcile();
  assert.equal(service.read().body.count, 0);
  assert.equal(service.read({ generation, check: true }).status, 409);
});

test('时间窗口 (since,until] 不吞掉 HTTP/发送期间及同毫秒的新消息', () => {
  const cfg = clone(); cfg.digest.enabled = true; let now = 1000;
  const service = new DigestService(cfg, { now: () => now });
  service.collect(msg('first'));
  // 此毫秒仍开放；本次读不能越过它，后面同毫秒到达的消息要下一次一起发。
  assert.equal(service.read().body.count, 0);
  service.collect(msg('same-ms'));
  now = 1001;
  const batch = service.read();
  assert.equal(batch.body.count, 2);
  assert.equal(batch.body.until, 1000);
  service.collect(msg('during-send'));
  now = 1002;
  const next = service.read({ since: batch.body.until });
  assert.equal(next.body.count, 1);
  assert.match(next.body.text, /during-send/);
  assert.equal(service.read({ since: 'NaN' }).status, 400);
});

test('汇总只收未接话的微信消息，不收已回复、主人、重复、系统通知或网页消息', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-digest-bot-'));
  const config = clone(); config.digest.enabled = true;
  config.links.enabled = false; config.websearch.enabled = false;
  config.persona.master.wxids = ['wxid_master']; config.persona.master.names = [];
  config.group.requireAt = true; config.group.freeChat = false;
  const store = new Store({ file: path.join(dir, 'store.json') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  let now = 2000;
  const bot = new Bot({ config, store, llm: { isMock: true }, now: () => new Date(now), rng: () => .99 });
  await bot.decide(msg('未被叫到'));
  await bot.decide(msg('未被叫到')); // duplicate
  await bot.decide({ ...msg('收到'), atMe: true });
  await bot.decide({ ...msg('主人'), senderId: 'wxid_master' });
  await bot.decide({ ...msg('系统'), senderName: '微信团队' });
  await bot.decide({ ...msg('网页'), platform: 'web' });
  now++;
  const body = bot.digestService.read().body;
  assert.equal(body.count, 1);
  assert.match(body.text, /未被叫到/);
  assert.equal(store.digest.length, 0, '不再向持久化旧汇总区写入');
  config.digest.enabled = false;
  await bot.decide(msg('关后收到'));
  assert.equal(bot.digestService.entries.length, 0);
});

test('打开期间前后跨代的在途消息不能偷渡进新汇总', async () => {
  const config = clone();
  const bot = new Bot({ config, store: {}, llm: {}, now: () => new Date(3000) });
  let finish;
  bot._decide = () => new Promise((resolve) => { finish = resolve; });
  const pending = bot.decide(msg('关闭时已收到'));
  config.digest.enabled = true; bot.digestService.reconcile();
  finish({ action: 'ignore', reason: 'not_addressed', msg: msg('关闭时已收到') });
  await pending;
  assert.equal(bot.digestService.entries.length, 0);
  const other = bot.decide(msg('旧代在途'));
  config.digest.enabled = false; bot.digestService.reconcile();
  config.digest.enabled = true; bot.digestService.reconcile();
  finish({ action: 'ignore', reason: 'not_addressed', msg: msg('旧代在途') });
  await other;
  assert.equal(bot.digestService.entries.length, 0);
});

test('旧游戏/回来命令和群成员排行已无硬编码分支或磁盘副作用', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-removed-bot-'));
  const config = clone(); config.paths = { dataDir: dir }; config.links.enabled = false;
  config.websearch.enabled = false; config.persona.master.wxids = ['wxid_master'];
  const store = new Store({ file: path.join(dir, 'store.json') });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const bot = new Bot({ config, store, llm: { isMock: true }, rng: () => .99 });
  for (const text of ['我去玩了', '我去打游戏了', '我回来了', '群里都有谁', '谁最活跃']) {
    const out = await bot.decide({ ...msg(text), senderId: 'wxid_master', atMe: true });
    assert.notEqual(out.commandType, 'away'); assert.notEqual(out.commandType, 'away_back');
    assert.notEqual(out.reason, 'member_list');
  }
  assert.equal(fs.existsSync(path.join(dir, 'away.json')), false);
});

test('超过单次上限时游标只推到真正发出的最后一条，剩余留到下一轮', () => {
  const cfg = clone();
  cfg.digest.enabled = true;
  cfg.digest.maxItems = 3;
  let now = 5000;
  const service = new DigestService(cfg, { now: () => now });
  for (let i = 0; i < 5; i += 1) { now += 1; service.collect(msg('m' + i)); }
  now += 1;
  const first = service.read().body;
  assert.equal(first.count, 3);
  assert.match(first.text, /还有 2 条放不下，留到下一次/);
  assert.ok(first.until < now, '游标不能越过没发出去的消息');
  const second = service.read({ since: first.until }).body;
  assert.equal(second.count, 2);
  assert.match(second.text, /m3/);
  assert.match(second.text, /m4/);
  assert.equal(second.count, 2, '上一轮发出的消息不能被重复带来');
});

test('汇总文本有长度上限和明确截断提示，不谎报完整记录', () => {
  const items = Array.from({ length: 120 }, (_, i) => ({ chatType: 'group', chat: '群' + i,
    sender: '甲', text: 'x'.repeat(300) }));
  const out = buildDigest(items, true);
  assert.ok(out.text.length < 4000);
  assert.match(out.text, /部分消息未展示/);
});

test('真实HTTP：开关、频率校验、旧代拒绝、关闭404，不读取持久化旧汇总', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-digest-http-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ watchConfig: false,
    features: { mediaCleanup: false, memorySnapshot: false }, websearch: { enabled: false } }));
  const rt = createRuntime({ root, env: { WHALE_LOG_FILE: '' }, loggerLevel: 'error' });
  const server = http.createServer(createHandler(rt));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise((r) => server.close(r)); rt.store.close();
    rt.configWatcher?.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, data) => fetch(base + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/digest')).status, 404);
  for (const interval of [-1, 0, .1, 'oops', 1441]) {
    assert.equal((await post('/api/config', { patch: { 'digest.everyMinutes': interval } })).status, 400);
  }
  assert.equal((await post('/api/features', { key: 'digest', value: true })).status, 200);
  const generation = rt.bot.digestService.generation;
  const on = await fetch(base + '/api/digest?check=1&generation=' + generation);
  assert.equal(on.status, 200);
  assert.equal((await on.json()).enabled, true);
  assert.equal((await post('/api/config', { patch: { 'digest.everyMinutes': 12 } })).status, 200);
  assert.equal(rt.config.digest.everyMinutes, 12);
  rt.store.listDigest = () => { throw Error('must not read old data'); };
  assert.equal((await fetch(base + '/api/digest')).status, 200);
  await post('/api/features', { key: 'digest', value: false });
  assert.equal((await fetch(base + '/api/digest')).status, 404);
  await post('/api/features', { key: 'digest', value: true });
  assert.equal((await fetch(base + '/api/digest?check=1&generation=' + generation)).status, 409);
});
