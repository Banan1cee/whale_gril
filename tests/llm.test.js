'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { DeepSeekClient, LlmError, parseSseLines } = require('../src/llm/client');

function startFake(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function makeClient(url, {
  apiKey = 'sk-test-1234567890',
  model = 'deepseek-chat',
  maxTokens = 200,
  thinking = false,
  chatThinkingTokens = 2000,
  thinkingMaxTokens = 5000,
  dataDir = null,
} = {}) {
  const paths = { settingsFile: path.join(os.tmpdir(), 'whale-settings-none-' + Math.random() + '.json') };
  if (dataDir) paths.dataDir = dataDir;
  return new DeepSeekClient({
    logger: null,
    config: {
      deepseek: {
        apiKey,
        baseUrl: url,
        model,
        temperature: 1.2,
        maxTokens,
        timeoutMs: 5000,
        thinking,
        chatThinkingTokens,
        thinkingMaxTokens,
      },
      provider: 'deepseek',
      paths,
      env: {},
      persona: { name: '鲸鲸' },
    },
  });
}

test('非流式请求能拿到回复文本', async () => {
  let seen = null;
  const fake = await startFake((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '咕噜~ 收到啦' } }] }));
    });
  });
  const client = makeClient(fake.url);
  const text = await client.complete({
    system: '你是鲸鲸',
    turns: [{ role: 'user', content: '在吗' }],
  });
  assert.equal(text, '咕噜~ 收到啦');
  assert.equal(seen.model, 'deepseek-chat');
  assert.equal(seen.messages[0].role, 'system');
  assert.equal(seen.messages[1].content, '在吗');
  assert.equal(seen.stream, false);
  await fake.close();
});

test('流式请求能拼出完整回复', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"咕"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"噜"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"~"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const client = makeClient(fake.url);
  const parts = [];
  for await (const piece of client.stream({ system: 's', turns: [{ role: 'user', content: 'hi' }] })) {
    parts.push(piece);
  }
  assert.equal(parts.join(''), '咕噜~');
  await fake.close();
});

test('API Key 错误会变成鲸鱼娘口吻的提示', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
    });
  });
  const client = makeClient(fake.url, { apiKey: 'sk-bad' });
  await assert.rejects(
    () => client.complete({ system: 's', turns: [{ role: 'user', content: 'hi' }] }),
    (err) => {
      assert.ok(err instanceof LlmError);
      assert.equal(err.status, 401);
      assert.match(err.userMessage, /钥匙|Key/i);
      return true;
    }
  );
  await fake.close();
});

test('没填 Key 时是演示模式，不会发请求', () => {
  const client = makeClient('https://api.deepseek.com', { apiKey: '' });
  assert.equal(client.isMock, true);
  assert.equal(client.describe().mock, true);
  assert.equal(client.describe().keyMasked, '');
});

test('本地地址不需要 Key，不算演示模式', () => {
  const client = makeClient('http://127.0.0.1:11434/v1', { apiKey: '' });
  assert.equal(client.needsKey, false);
  assert.equal(client.isMock, false);
});

test('SSE 解析兼容多行 data 和 CRLF', () => {
  const buffer = 'data: {"a":1}\r\n\r\ndata: {"b":2}\r\n\r\n';
  assert.deepEqual(parseSseLines(buffer), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(parseSseLines('data: [DONE]\n\n'), ['[DONE]']);
});

test('payload 会带上温度、max_tokens 和系统提示', () => {
  const client = makeClient('http://127.0.0.1:1');
  const payload = client.buildPayload({ system: 'sys', turns: [{ role: 'user', content: 'hi' }] });
  assert.equal(payload.messages[0].content, 'sys');
  assert.equal(payload.temperature, 1.2);
  assert.equal(payload.max_tokens, 200);
  assert.equal(client.endpoint(), 'http://127.0.0.1:1/chat/completions');
});

// ── 空响应：以前只报一句「空泡泡」，查不出原因 ──────────────────────────
// 现场（2026-11-04 00:30）：同一条日志里 memory/extractor 和 pipeline 都拿到
// 「咕噜…这次只吐出了个空泡泡」，两条独立的提示词都空 → 不是记忆坏了，是模型返回了空内容。

test('空响应会换保守参数重试一次，第二次有字就用第二次的', async () => {
  let calls = 0;
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (calls === 1) {
        res.end(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 0 } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '咕噜，我在' }, finish_reason: 'stop' }] }));
      }
    });
  });
  const client = makeClient(fake.url);
  const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  assert.equal(text, '咕噜，我在');
  assert.equal(calls, 2, '空响应应当重试一次');
  await fake.close();
});

test('两次都空：抛 LlmError，detail 里带 finish/usage 证据', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '' }, finish_reason: 'length' }],
        usage: { prompt_tokens: 3200, completion_tokens: 700 },
      }));
    });
  });
  const client = makeClient(fake.url);
  let err = null;
  try {
    await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LlmError);
  assert.equal(err.code, 'empty');
  assert.equal(err.userMessage.includes('空泡泡'), true);
  assert.ok(err.detail.includes('finish=length'), 'detail 要能看出是预算打满：' + err.detail);
  assert.ok(err.detail.includes('usage=3200/700'), 'detail 要带 usage：' + err.detail);
  await fake.close();
});

test('HTTP 200 但带错误体：报 api_error 而不是「空泡泡」', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limit reached for requests', code: 429 } }));
    });
  });
  const client = makeClient(fake.url);
  let err = null;
  try {
    await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LlmError);
  assert.equal(err.code, 'api_error');
  assert.ok(err.detail.includes('HTTP 200 但带错误体'), err.detail);
  assert.ok(err.detail.includes('Rate limit'), err.detail);
  await fake.close();
});

test('流式一个字都没吐：detail 带 finish_reason', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const client = makeClient(fake.url);
  let err = null;
  try {
    for await (const _ of client.stream({ system: 's', turns: [{ role: 'user', content: 'hi' }] })) { /* 不该有内容 */ }
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LlmError);
  assert.equal(err.code, 'empty');
  assert.ok(err.detail.includes('finish=length'), err.detail);
  await fake.close();
});

/* ── 思考参数与预算：同一句「关掉思考」在 11 个模型上写法不同（2026-11-04 实测） ── */

function payloadOf(client, extra = {}) {
  return client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }], ...extra });
}

test('关思考：deepseek 默认发 thinking:{type:disabled}，max_tokens=700', () => {
  const client = makeClient('http://127.0.0.1:1', { maxTokens: 700 });
  const payload = payloadOf(client);
  assert.deepEqual(payload.thinking, { type: 'disabled' });
  assert.equal(payload.max_tokens, 700, '关思考只给 700，思考 token 会计入 max_tokens');
});

test('开思考：reasoning_effort=low，聊天预算抬到 2000', () => {
  const client = makeClient('http://127.0.0.1:1', { maxTokens: 700, thinking: true });
  const payload = payloadOf(client);
  assert.equal(payload.reasoning_effort, 'low');
  assert.equal(payload.max_tokens, 2000);
  assert.equal('thinking' in payload, false, 'deepseek 开思考不用 thinking 对象');
});

test('gpt-5：用 max_completion_tokens、不带 temperature', () => {
  const client = makeClient('http://127.0.0.1:1', { model: 'gpt-5-mini', maxTokens: 700 });
  const payload = payloadOf(client);
  assert.equal('max_tokens' in payload, false);
  assert.equal(payload.max_completion_tokens, 5000, '关不干净 → 按 thinkingMaxTokens 给');
  assert.equal('temperature' in payload, false, 'OpenAI 推理模型不认 temperature');
  assert.equal(payload.reasoning_effort, 'minimal', 'gpt-5 没有 none，只能 minimal');
});

test('claude：开思考用 thinking.budget_tokens=1024', () => {
  const client = makeClient('http://127.0.0.1:1', { model: 'claude-sonnet-4', maxTokens: 700, thinking: true });
  const payload = payloadOf(client);
  assert.equal(payload.thinking.type, 'enabled');
  assert.equal(payload.thinking.budget_tokens, 1024);
});

test('各家关思考写法：hy / glm-5.3 / minimax / step 各按实测来', () => {
  const hy = payloadOf(makeClient('http://127.0.0.1:1', { model: 'hy4-preview', maxTokens: 700 }));
  assert.equal(hy.reasoning_effort, 'none');
  assert.equal('thinking' in hy, false);

  const glm = payloadOf(makeClient('http://127.0.0.1:1', { model: 'glm-5.3', maxTokens: 700 }));
  assert.equal(glm.reasoning_effort, 'low', 'glm-5.3 是 thinking-only，只能降到 low');

  const mini = payloadOf(makeClient('http://127.0.0.1:1', { model: 'minimax-m3.1-flash', maxTokens: 700 }));
  assert.equal(mini.enable_thinking, false);

  const step = payloadOf(makeClient('http://127.0.0.1:1', { model: 'step-5-preview', maxTokens: 700 }));
  for (const key of ['thinking', 'reasoning_effort', 'enable_thinking', 'thinking_budget']) {
    assert.equal(key in step, false, 'step 本来不思考，别发 ' + key);
  }
});

test('400（错误里含 thinking）：自动降级一档并写入 caps 缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-caps-'));
  let calls = 0;
  const bodies = [];
  const fake = await startFake((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls += 1;
      bodies.push(JSON.parse(body));
      res.writeHead(calls === 1 ? 400 : 200, { 'content-type': 'application/json' });
      if (calls === 1) {
        res.end(JSON.stringify({ error: { message: 'unsupported_parameter: thinking is not supported' } }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '咕噜，我在' }, finish_reason: 'stop' }] }));
      }
    });
  });
  try {
    const client = makeClient(fake.url, { maxTokens: 700, dataDir: dir });
    const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
    assert.equal(text, '咕噜，我在');
    assert.equal(calls, 2, '参数被拒只降级一次');
    assert.deepEqual(bodies[0].thinking, { type: 'disabled' });
    assert.equal('thinking' in bodies[1], false, '降级到「丢参数」');
    const caps = JSON.parse(fs.readFileSync(path.join(dir, 'thinking-caps.json'), 'utf8'));
    const entry = caps['deepseek|deepseek-chat'];
    assert.ok(entry, '要写入 caps 缓存：' + JSON.stringify(caps));
    assert.deepEqual(entry.off, {}, '记住这个模型不吃 thinking 参数');
  } finally {
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('空响应 + reasoning_tokens：第二次请求切到关思考档', async () => {
  let calls = 0;
  const bodies = [];
  const fake = await startFake((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls += 1;
      bodies.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      if (calls === 1) {
        res.end(JSON.stringify({
          choices: [{ message: { content: '' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 3200, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 700 } },
        }));
      } else {
        res.end(JSON.stringify({ choices: [{ message: { content: '咕噜，想好了' }, finish_reason: 'stop' }] }));
      }
    });
  });
  try {
    const client = makeClient(fake.url, { maxTokens: 700, thinking: true });
    const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
    assert.equal(text, '咕噜，想好了');
    assert.equal(calls, 2);
    assert.equal(bodies[0].reasoning_effort, 'low', '第一次按开思考发');
    assert.deepEqual(bodies[1].thinking, { type: 'disabled' }, '第二次必须切到关思考');
    assert.equal('reasoning_effort' in bodies[1], false);
  } finally {
    await fake.close();
  }
});

test('allowOverflow：后台抽取传 1200，不被 700 夹取', async () => {
  const client = makeClient('http://127.0.0.1:1', { maxTokens: 700 });
  const payload = payloadOf(client, { maxTokens: 1200, allowOverflow: true, thinking: false });
  assert.equal(payload.max_tokens, 1200);
  assert.equal('reasoning_effort' in payload, false, '抽取仍然关思考');
  assert.equal('allowOverflow' in payload, false, 'allowOverflow 只是本地预算开关，不能发给接口');
});

/* ── 思考内容隔离：reasoning 只诊断，永远不能当答案发出去 ── */

test('content 里内联的 thinking 会被剥掉', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: ' thinking先想想她要问什么<｜end▁of▁thinking｜>咕噜，在的' }, finish_reason: 'stop' }],
      }));
    });
  });
  const client = makeClient(fake.url);
  const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  assert.equal(text, '咕噜，在的');
  assert.ok(!text.includes('think'), text);
  await fake.close();
});

test('content 是数组时按 text 段拼接，不出现 [object Object]', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: [
              { type: 'text', text: '咕' },
              { type: 'image_url', image_url: { url: 'http://x/y.png' } },
              { type: 'text', text: '噜' },
            ],
          },
          finish_reason: 'stop',
        }],
      }));
    });
  });
  const client = makeClient(fake.url);
  const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  assert.equal(text, '咕噜');
  assert.ok(!text.includes('[object Object]'));
  await fake.close();
});

test('只有 reasoning 没有 content：抛 empty，不把思考当答案', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: '我想了很久要不要回答' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      }));
    });
  });
  const client = makeClient(fake.url);
  let err = null;
  try {
    await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof LlmError);
  assert.equal(err.code, 'empty');
  assert.match(err.detail, /reasoning=\d+字/, 'detail 要带思考长度：' + err.detail);
  await fake.close();
});
