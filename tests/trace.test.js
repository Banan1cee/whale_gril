'use strict';

/**
 * 日志与判定链（trace）的回归：
 *   1. warn/error 必须带「哪个文件第几行」，不然报障时只能搜文案
 *   2. 判定链只记原因/状态，正文不许出现在 jsonl 里
 *   3. 原文副本要能自动过期（24 小时）
 *   4. Bot 真的把判定结果写进 trace（不是只写在源码里）
 *   5. 桥接的显式级别和窗口状态别被改回去
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogger } = require('../src/infra/logger');
const { createTrace } = require('../src/core/trace');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readAll(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, name.name);
    if (name.isDirectory()) out.push(...readAll(full));
    else out.push(fs.readFileSync(full, 'utf8'));
  }
  return out;
}

test('warn/error 行首带调用点（文件:行）', async () => {
  const dir = tmpDir('whale-log-');
  const file = path.join(dir, 'x.log');
  const logger = createLogger({ level: 'debug', fileLevel: 'debug', file });
  logger.warn('测试警告');
  logger.error('测试错误');
  // 文件流是异步的：等它落盘再读，别跟 writeStream 抢时间
  let text = '';
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (fs.existsSync(file)) { text = fs.readFileSync(file, 'utf8'); if (text.includes('测试错误')) break; }
  }
  logger.close();
  fs.rmSync(dir, { recursive: true, force: true });

  assert.match(text, /WARN\s+.*trace\.test\.js:\d+/, 'warn 要带调用点');
  assert.match(text, /ERROR\s+.*trace\.test\.js:\d+/, 'error 要带调用点');
  // info 不抓栈，保持安静（否则每行都多一次栈开销）
  assert.doesNotMatch(text, /INFO\s+.*trace\.test\.js/);
});

test('判定链只记原因和状态，不含聊天正文', () => {
  const dir = tmpDir('whale-trace-');
  const trace = createTrace({ dataDir: dir, raw: false });
  trace.record({
    msg: {
      platform: 'wechat', chatId: 'wxid_secret_chat', chatType: 'group',
      senderId: 'wxid_person', senderName: '阿螈', text: '鲸鲸你在吗，今天好累', atMe: true, msgId: 'm1',
    },
    decision: { action: 'ignore', reason: 'silent' },
    state: { silentUntil: Date.now() + 60000, replyTimes: [Date.now() - 1000] },
  });
  const all = readAll(dir).join('\n');
  fs.rmSync(dir, { recursive: true, force: true });

  assert.match(all, /"reason":"silent"/);
  assert.match(all, /"len":\d+/);
  assert.match(all, /"silent":\d+/);
  assert.doesNotMatch(all, /鲸鲸你在吗/, '正文绝不能进判定链');
  assert.doesNotMatch(all, /wxid_secret_chat/, '会话 id 要打码');
  assert.ok(!fs.existsSync(path.join(dir, 'trace', 'raw')), '没开原文就不该建 raw 目录');
});

test('原文副本会过期：超过 24 小时自动删掉', () => {
  const dir = tmpDir('whale-trace-raw-');
  const t0 = Date.now();
  let clock = t0;
  const trace = createTrace({ dataDir: dir, raw: true, now: () => clock });
  const msg = {
    platform: 'wechat', chatId: 'c1', chatType: 'group',
    senderId: 's1', senderName: '阿螈', text: '第一条', atMe: false, msgId: 'a',
  };
  const first = trace.record({ msg, decision: { action: 'ignore', reason: 'not_addressed' }, state: {} });
  const rawPath = path.join(dir, 'trace', 'raw', first.fp + '.json');
  assert.ok(fs.existsSync(rawPath), '开了原文就要落盘');
  assert.match(fs.readFileSync(rawPath, 'utf8'), /第一条/);

  // 把这份原文的修改时间往前拨两天，再写一条新的（同时触发清理）
  const old = new Date(t0 - 2 * 86400000);
  fs.utimesSync(rawPath, old, old);
  clock = t0 + 120000;                       // 超过 60 秒的节流窗口
  trace.record({
    msg: { ...msg, msgId: 'b', text: '第二条' },
    decision: { action: 'ignore', reason: 'not_addressed' },
    state: {},
  });
  const stillThere = fs.existsSync(rawPath);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(stillThere, false, '24 小时前的原文必须被清掉');
});

test('Bot 真把「为什么没回」写进 trace', async () => {
  const dir = tmpDir('whale-bot-trace-');
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.group.requireAt = true;
  const store = new Store({ file: path.join(dir, 'store.json'), limits: cfg.memory });
  const trace = createTrace({ dataDir: dir, raw: true });
  const bot = new Bot({
    config: cfg,
    store,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
    logger: null,
    trace,
    mockChunkDelayMs: 0,
  });
  // 群里没 @ 她 → 不该回，但要留下一条 ignore 的判定链
  const res = await bot.handle({
    platform: 'wechat', chatId: 'g1', chatType: 'group',
    senderId: 'u1', senderName: '阿螈', text: '今天天气不错', atMe: false, msgId: 'x1',
  });
  store.close();
  // 只看判定链本身；raw/ 里本来就是原文（那是刻意的，只是默认不进导出包）
  const traceDir = path.join(dir, 'trace');
  const all = fs.readdirSync(traceDir)
    .filter((n) => n.endsWith('.jsonl'))
    .map((n) => fs.readFileSync(path.join(traceDir, n), 'utf8'))
    .join('\n');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });

  assert.equal(res.action, 'ignore');
  assert.match(all, /"action":"ignore"/, '要记录「没回」');
  assert.match(all, /"reason":"[a-z_]+"/, '要记录原因');
  assert.doesNotMatch(all, /今天天气不错/, '判定链里不许出现正文');
});

test('桥接有显式级别，并且上报微信窗口状态', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'engine.py'), 'utf8');
  const logSrc = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge_log.py'), 'utf8');
  assert.match(logSrc, /def log_warn\(/, '桥接要有 log_warn');
  assert.match(logSrc, /def log_error\(/, '桥接要有 log_error');
  assert.match(src, /"window": wechat_window_state\(\)/, '心跳要上报窗口状态');
  assert.match(src, /def wechat_window_state\(/, '窗口状态得真去读，不能写死');
});
