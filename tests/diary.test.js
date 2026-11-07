'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiaryService, dayKey } = require('../src/services/diary');
const { loadConfig } = require('../src/infra/config');
const { applyConfigPatch } = require('../src/infra/configPatch');
const register = require('../src/http/routes/diary');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-diary-'));
  let now = new Date(2026, 10, 6, 22, 59).getTime();
  const calls = [], logs = [];
  const config = { paths: { dataDir: dir }, diary: { enabled: false, time: '23:00' }, persona: { name: '测试角色', customPrompt: '温柔的语气' } };
  const store = { sessions: new Map([['test-chat', { messages: [
    { role: 'user', text: '昨天的秘密', ts: now - 86400000 },
    { role: 'user', name: '测试好友', text: '今天读完一本书', ts: now - 60000 },
    { role: 'assistant', text: '真不错', ts: now },
    { role: 'user', text: '未来不应该出现', ts: now + 86400000 },
  ] }]]) };
  const llm = { isMock: false, complete: async (input) => { calls.push(input); return '## 今天\n\n和朋友聊了读书的事，很开心。'; } };
  const logger = { info: (s) => logs.push(s), warn: (s) => logs.push(s) };
  const make = () => new DiaryService(config, { store, llm, logger, now: () => now });
  const service = make();
  t.after(() => { service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, config, store, llm, calls, logs, service, make, setNow: (v) => { now = v; }, advance: (v) => { now += v; } };
}

test('日记：默认关闭；按本地时间生成，重启去重，第二天独立文件', async (t) => {
  const f = fixture(t);
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  f.config.diary.enabled = true;
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  f.advance(60000);
  await f.service.tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.service.status().status, 'done');
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-06.md')));
  const restarted = f.make();
  await restarted.tick();
  await restarted.generate();
  assert.equal(f.calls.length, 1);
  f.advance(86400000);
  await restarted.tick();
  assert.equal(f.calls.length, 2);
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-07.md')));
  restarted.stop();
});

test('日记：手动每天仅一篇，使用月日文件名，只取当天并沿用人设', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  const first = f.service.status().file;
  await f.service.generate();
  const second = f.service.status().file;
  assert.equal(first, '2026/11-06.md');
  assert.equal(first, second);
  assert.equal(f.calls.length, 1);
  assert.ok(first.endsWith('.md') && second.endsWith('.md'));
  assert.match(fs.readFileSync(path.join(f.dir, 'diary', first), 'utf8'), /^# 2026-11-06 日记/);
  const prompt = f.calls[0];
  assert.match(prompt.system, /测试角色/);
  assert.match(prompt.system, /温柔的语气/);
  assert.match(prompt.turns[0].content, /今天读完一本书/);
  assert.doesNotMatch(prompt.turns[0].content, /昨天的秘密|未来不应该出现|test-chat/);
  assert.doesNotMatch(f.logs.join('\n'), /今天读完一本书|和朋友聊了读书/);
});

test('日记：已有旧格式当天日记时，手动和自动都跳过', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'diary'));
  const legacy = '2026-11-06-120000-abcd1234.md';
  fs.writeFileSync(path.join(f.dir, 'diary', legacy), '旧日记');
  await f.service.generate();
  f.config.diary.enabled = true;
  f.advance(60000);
  await f.service.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.service.status().file, legacy);
  assert.equal(fs.readFileSync(path.join(f.dir, 'diary', legacy), 'utf8'), '旧日记');
});

test('日记：模型生成期间出现当天文件也不覆盖', async (t) => {
  const f = fixture(t);
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const pending = f.service.generate();
  const dir = path.join(f.dir, 'diary', '2026');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '11-06.md'), '先完成的日记');
  release('后完成的日记');
  await pending;
  assert.equal(fs.readFileSync(path.join(dir, '11-06.md'), 'utf8'), '先完成的日记');
  assert.deepEqual(fs.readdirSync(dir), ['11-06.md']);
});

test('日记：手动生成后自动与重启均不重复，跨年同月日不冲突', async (t) => {
  const f = fixture(t);
  await f.service.generate();
  f.config.diary.enabled = true;
  f.advance(60000);
  await f.service.tick();
  const restarted = f.make();
  await restarted.generate();
  assert.equal(f.calls.length, 1);
  const nextYear = new Date(2027, 10, 6, 23, 0).getTime();
  f.setNow(nextYear);
  f.store.sessions.get('test-chat').messages.push({ role: 'user', text: '明年的今天', ts: nextYear });
  await restarted.tick();
  assert.equal(f.calls.length, 2);
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2026', '11-06.md')));
  assert.ok(fs.existsSync(path.join(f.dir, 'diary', '2027', '11-06.md')));
  restarted.stop();
});

test('日记：空日/演示模型不伪造文档，输入预算有界', async (t) => {
  const f = fixture(t);
  const messages = f.store.sessions.get('test-chat').messages;
  f.store.sessions.clear();
  await f.service.generate();
  assert.equal(f.service.status().status, 'empty');
  assert.equal(f.calls.length, 0);
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary')));
  f.store.sessions.set('test-chat', { messages });
  f.llm.isMock = true;
  await f.service.generate();
  assert.equal(f.service.status().status, 'failed');
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary')));
  f.llm.isMock = false;
  for (let i = 0; i < 1000; i++) messages.push({ role: 'user', text: '长'.repeat(2000), ts: messages[1].ts });
  await f.service.generate();
  assert.ok(f.calls[0].turns[0].content.length < 25000);
});

test('日记：并发请求合并，失败不记成功且五分钟后可重试', async (t) => {
  const f = fixture(t);
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const a = f.service.generate();
  assert.equal(f.service.status().status, 'running');
  assert.equal(f.service.generate(), a);
  release('日记正文');
  await a;
  assert.equal(fs.readdirSync(path.join(f.dir, 'diary')).length, 1);
  // 次日测试失败重试，避免第一篇日记按每日去重规则拦截。
  f.advance(86400000);
  f.config.diary.enabled = true;
  f.advance(60000);
  let calls = 0;
  f.llm.complete = async () => { calls++; throw Object.assign(new Error('模型超时'), { code: 'ETIMEDOUT' }); };
  await f.service.tick();
  assert.equal(f.service.status().status, 'failed');
  assert.ok(!fs.existsSync(path.join(f.dir, 'diary', '2026', '11-07.md')));
  await f.service.tick();
  assert.equal(calls, 1);
  f.advance(5 * 60000);
  f.llm.complete = async () => { calls++; return '重试后的日记'; };
  await f.service.tick();
  assert.equal(calls, 2);
  assert.equal(f.service.status().status, 'done');
  assert.match(f.logs.join('\n'), /type=Error code=ETIMEDOUT/);
});

test('日记：停止后不落盘；跨午夜仍归属于请求时日期', async (t) => {
  const f = fixture(t);
  let release;
  f.setNow(new Date(2026, 10, 6, 23, 59).getTime());
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const pending = f.service.generate();
  f.advance(120000);
  release('午夜生成');
  await pending;
  assert.equal(f.service.status().file, '2026/11-06.md');
  f.store.sessions.get('test-chat').messages.push({ role: 'user', text: '新的一天', ts: new Date(2026, 10, 7, 0, 0).getTime() });
  const stopped = f.service.generate();
  f.service.stop();
  release('不应写入');
  await stopped;
  assert.equal(fs.readdirSync(path.join(f.dir, 'diary', '2026')).length, 1);
  assert.equal(dayKey(new Date(2026, 0, 2)), '2026-01-02');
});

test('日记配置：旧配置默认关闭，时间严格校验，保存后重载保留', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, 'config.json'), '{}');
  const runtime = { config: loadConfig({ root: f.dir, env: {} }), logger: { info() {} }, llm: { reload() {} } };
  assert.deepEqual(runtime.config.diary, { enabled: false, time: '23:00' });
  for (const time of ['24:00', '12:60', '8:00', '', '23:00\n']) {
    assert.throws(() => applyConfigPatch(runtime, { 'diary.time': time }), { statusCode: 400 });
  }
  applyConfigPatch(runtime, { 'diary.enabled': true, 'diary.time': '00:15' });
  assert.deepEqual(loadConfig({ root: f.dir, env: {} }).diary, { enabled: true, time: '00:15' });
});

test('日记接口：仅本机可读写，后台生成立即返回且不会重复启动', async (t) => {
  const f = fixture(t);
  const routes = {};
  register({ get: (p, fn) => { routes[p] = fn; }, post: (p, fn) => { routes[p] = fn; } });
  const runtime = { diary: f.service };
  for (const fn of Object.values(routes)) {
    assert.throws(() => fn(runtime, { socket: { remoteAddress: '192.0.2.1' } }), { statusCode: 403 });
  }
  let release;
  f.llm.complete = () => new Promise((resolve) => { release = resolve; });
  const res = { writeHead(code) { this.code = code; }, end(body) { this.body = JSON.parse(body); } };
  const req = { socket: { remoteAddress: '127.0.0.1' } };
  routes['/api/diary/generate'](runtime, req, res);
  assert.equal(res.code, 202);
  assert.equal(res.body.status, 'running');
  const pending = f.service.pending;
  routes['/api/diary/generate'](runtime, req, res);
  assert.equal(f.service.pending, pending);
  release('测试正文');
  await pending;
  routes['/api/diary'](runtime, req, res);
  assert.equal(res.body.status, 'done');
});
