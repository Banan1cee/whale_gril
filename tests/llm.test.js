'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { DeepSeekClient, LlmError, parseSseLines } = require('../src/llm');

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

function makeClient(url, { apiKey = 'sk-test-1234567890' } = {}) {
  return new DeepSeekClient({
    logger: null,
    config: {
      deepseek: {
        apiKey,
        baseUrl: url,
        model: 'deepseek-chat',
        temperature: 1.2,
        maxTokens: 200,
        timeoutMs: 5000,
      },
      paths: { settingsFile: path.join(os.tmpdir(), 'whale-settings-none-' + Math.random() + '.json') },
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
