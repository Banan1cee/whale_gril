'use strict';

/**
 * 日志要能回答「为什么失败」，不能只有一句「抽取失败」。
 *
 * 背景：很多失败分支以前写 `'xxx 失败：' + err.message`，而 LlmError 的 message 是
 * 给用户看的话术（「空泡泡」），真正的 code/status/detail 全丢了。
 * 这里钉住 describeError 的字段，以及记忆抽取 / 生成回复两条真实链路的日志内容。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { describeError } = require('../src/infra/errors');
const { LlmError, FRIENDLY } = require('../src/llm/client');
const { extractEpisode } = require('../src/memory/extractor');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

/* ───────────────────────── describeError 本身 ───────────────────────── */

test('LlmError：输出 code/status/detail，绝不输出「空泡泡」话术', () => {
  const err = new LlmError(FRIENDLY.empty, {
    code: 'empty',
    status: 429,
    retryable: true,
    detail: '空响应（finish=length usage=3200/700 reasoning_tokens=700）',
  });
  const line = describeError(err);
  assert.match(line, /type=LlmError/);
  assert.match(line, /code=empty/);
  assert.match(line, /status=429/);
  assert.match(line, /retryable/);
  assert.match(line, /finish=length/, line);
  assert.match(line, /reasoning_tokens=700/, line);
  assert.ok(!line.includes('空泡泡'), '不能把用户话术当日志：' + line);
});

test('LlmError 没有 detail：写 detail=(无)，不退回话术', () => {
  const line = describeError(new LlmError(FRIENDLY.empty, { code: 'empty' }));
  assert.match(line, /code=empty/);
  assert.match(line, /detail=\(无\)/);
  assert.ok(!line.includes('空泡泡'), line);
});

test('普通 Error：带 code 和原始 msg（文件系统错误就靠这个）', () => {
  const err = Object.assign(new Error('EPERM: operation not permitted, open data/store.json'), { code: 'EPERM' });
  const line = describeError(err);
  assert.match(line, /type=Error/);
  assert.match(line, /code=EPERM/);
  assert.match(line, /msg=EPERM: operation not permitted/);
});

test('非对象 / 超长 detail 也能安全压成一行', () => {
  assert.match(describeError('boom'), /msg=boom/);
  assert.match(describeError(null), /无错误对象/);
  const long = describeError(new LlmError('x', { detail: 'a'.repeat(500) }), { maxDetail: 20 });
  assert.ok(long.length < 120, '要截断：' + long.length);
  assert.match(long, /…$/);
  // 换行必须被压成空格，别把一条日志撑成多行
  assert.ok(!/\n/.test(describeError(new Error('a\nb'))));
});

/* ───────────────────────── 抽取链路 ───────────────────────── */

const messages = [
  { role: 'user', uid: 'u1', name: '小海', text: '最近在换工作，压力挺大', id: 'msg_1' },
];
const speakers = [{ uid: 'u1', name: '小海' }];

function makeLogger() {
  const logs = [];
  const push = (level) => (m) => logs.push([level, String(m)]);
  return {
    logs,
    logger: { warn: push('warn'), error: push('error'), info: push('info'), debug: () => {} },
  };
}

test('episode 抽取失败：日志带 provider/model + code/status/detail', async () => {
  const { logs, logger } = makeLogger();
  const llm = {
    isMock: false,
    provider: 'deepseek',
    model: 'deepseek-flash',
    async complete() {
      throw new LlmError(FRIENDLY.timeout, {
        code: 'timeout',
        status: 0,
        detail: 'request timeout after 45000ms',
      });
    },
  };
  const out = await extractEpisode({ messages, llm, speakers, logger });
  assert.equal(out.fallback, true);
  const line = logs.map(([, m]) => m).join('\n');
  assert.match(line, /episode 抽取失败/);
  assert.match(line, /\[deepseek\|deepseek-flash\]/, '要知道是哪个模型：' + line);
  assert.match(line, /code=timeout/, line);
  assert.match(line, /request timeout/, line);
  assert.ok(!line.includes('潜得太深'), '不能用给用户看的话术：' + line);
});

test('episode 抽取失败（普通 Error）：日志带原始 message', async () => {
  const { logs, logger } = makeLogger();
  const llm = {
    isMock: false,
    async complete() {
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    },
  };
  await extractEpisode({ messages, llm, speakers, logger });
  const line = logs.map(([, m]) => m).join('\n');
  assert.match(line, /code=ECONNRESET/);
  assert.match(line, /msg=socket hang up/);
});

test('返回不是 JSON：日志带长度和花括号配对数，而不是只说「疑似截断」', async () => {
  const { logs, logger } = makeLogger();
  const llm = { isMock: false, async complete() { return '{"summary":"在聊换工作"'; } };
  await extractEpisode({ messages, llm, speakers, logger });
  const line = logs.map(([, m]) => m).join('\n');
  assert.match(line, /不是可解析 JSON/);
  assert.match(line, /长度 \d+/, line);
  assert.match(line, /\{×1/, '要知道花括号数量：' + line);
  assert.match(line, /\}×0/, line);
  assert.match(line, /没有成对花括号/, line);
});

/* ───────────────────────── 生成回复链路 ───────────────────────── */

function makeBot() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: [], wxids: [] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-errlog-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const { logs, logger } = makeLogger();
  const llm = {
    isMock: false,
    provider: 'deepseek',
    model: 'deepseek-flash',
    reload() {},
    async complete() {
      throw new LlmError(FRIENDLY.empty, {
        code: 'empty',
        detail: '空响应（finish=length usage=3200/700 reasoning_tokens=700）',
      });
    },
  };
  const bot = new Bot({ config, store, llm, logger, mockChunkDelayMs: 0 });
  return {
    bot,
    logs,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

test('生成回复失败：日志带模型 + code/detail，不再只有一句「生成回复失败」', async () => {
  const { bot, logs, cleanup } = makeBot();
  try {
    const res = await bot.handle({
      platform: 'web', chatId: 's1', chatType: 'private', senderId: 'u1', senderName: '小海', text: '在吗',
    });
    assert.equal(res.action, 'reply');
    const line = logs.filter(([lv]) => lv === 'error').map(([, m]) => m).join('\n');
    assert.match(line, /生成回复失败/);
    assert.match(line, /\[deepseek\|deepseek-flash\]/, '要带模型：' + line);
    assert.match(line, /code=empty/, line);
    assert.match(line, /finish=length/, '要带空响应证据：' + line);
    assert.ok(!line.includes('空泡泡'), '日志里不能只有话术：' + line);
  } finally {
    cleanup();
  }
});
