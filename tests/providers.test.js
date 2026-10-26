'use strict';

/**
 * 多模型服务测试：预设解析、本地免 Key、请求头、连接测试。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, resolveRuntime, isLocalUrl, PROVIDERS } = require('../src/config');
const { DeepSeekClient } = require('../src/llm');

function tempRoot(configPatch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-provider-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configPatch));
  return root;
}

function clientFor(root) {
  const config = loadConfig({ root, env: {} });
  return new DeepSeekClient({ config, logger: null });
}

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

test('预设列表齐全，本地免 Key 规则清晰', () => {
  for (const key of ['deepseek', 'zhipu', 'siliconflow', 'qwen', 'ollama', 'custom']) {
    assert.ok(PROVIDERS[key], '缺少预设 ' + key);
    assert.ok(PROVIDERS[key].label);
  }
  assert.equal(PROVIDERS.ollama.needsKey, false);
  assert.equal(PROVIDERS.zhipu.needsKey, true);
});

test('isLocalUrl 能识别本机 / 内网地址', () => {
  assert.equal(isLocalUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLocalUrl('http://localhost:1234/v1'), true);
  assert.equal(isLocalUrl('http://192.168.1.8:8080/v1'), true);
  assert.equal(isLocalUrl('https://api.deepseek.com'), false);
  assert.equal(isLocalUrl(''), false);
});

test('智谱预设：地址和默认模型正确，没 Key 时是演示模式', () => {
  const root = tempRoot({ provider: 'zhipu' });
  const cfg = loadConfig({ root, env: {} });
  const rt = resolveRuntime(cfg);
  assert.equal(rt.provider, 'zhipu');
  assert.equal(rt.baseUrl, 'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(rt.model, 'glm-4-flash');
  assert.equal(rt.needsKey, true);
  assert.equal(rt.mock, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Ollama 预设：不需要 Key，也不算演示模式', () => {
  const root = tempRoot({ provider: 'ollama' });
  const client = clientFor(root);
  assert.equal(client.provider, 'ollama');
  assert.equal(client.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.equal(client.model, 'qwen2.5:7b');
  assert.equal(client.needsKey, false);
  assert.equal(client.isMock, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Ollama 请求不带 Authorization，能正常拿到回复', async () => {
  let seenHeaders = null;
  let seenBody = null;
  const fake = await startFake((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seenHeaders = req.headers;
      seenBody = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '咕噜~' } }] }));
    });
  });
  // 用 settings.json 把地址指向假服务（模拟真实的 Ollama 端口）
  const root = tempRoot({ provider: 'ollama' });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'data', 'settings.json'),
    JSON.stringify({ provider: 'ollama', baseUrl: fake.url, model: 'qwen2.5:7b' })
  );
  const client = clientFor(root);
  assert.equal(client.isMock, false);
  const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  assert.equal(text, '咕噜~');
  assert.equal(seenHeaders.authorization, undefined);
  assert.equal(seenBody.model, 'qwen2.5:7b');
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('自定义服务指向本机地址时自动免 Key', () => {
  const root = tempRoot({
    provider: 'custom',
    llm: { baseUrl: 'http://127.0.0.1:8080/v1', model: 'my-model' },
  });
  const rt = resolveRuntime(loadConfig({ root, env: {} }));
  assert.equal(rt.needsKey, false);
  assert.equal(rt.mock, false);
  assert.equal(rt.model, 'my-model');
  fs.rmSync(root, { recursive: true, force: true });
});

test('连接测试：演示模式返回友好提示而不是抛错', async () => {
  const root = tempRoot({ provider: 'deepseek' });
  const client = clientFor(root);
  const probe = await client.probe();
  assert.equal(probe.ok, false);
  assert.match(probe.message, /钥匙|Key/i);
  assert.equal(probe.provider, 'deepseek');
  fs.rmSync(root, { recursive: true, force: true });
});

test('连接测试：能连上时返回样例回复和耗时', async () => {
  const fake = await startFake((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '咕噜' } }] }));
    });
  });
  const root = tempRoot({
    provider: 'custom',
    llm: { baseUrl: fake.url, model: 'test-model', apiKey: 'test-key-123456' },
  });
  const client = clientFor(root);
  const probe = await client.probe();
  assert.equal(probe.ok, true);
  assert.equal(probe.sample, '咕噜');
  assert.ok(probe.ms >= 0);
  await fake.close();
  fs.rmSync(root, { recursive: true, force: true });
});
test('主服务商 Key 失效时，自动切到存过 Key 的备用服务商', () => {
  const { loadSettings, saveSettings } = require('../src/config');
  const root = tempRoot();
  // 注意：loadConfig 收的是 { root, env }，以前这里写成 loadConfig(root, {})，
  // 结果 root 落到真实项目目录，跑一次测试就把用户的 data/settings.json 覆盖成 sk-dead
  const config = loadConfig({ root, env: {} });
  saveSettings(config, { provider: 'deepseek', apiKey: 'sk-dead', model: 'deepseek-chat', keys: { deepseek: 'sk-dead', zhipu: 'zk-alive' } });
  const llm = new DeepSeekClient({ config, logger: null });
  assert.equal(llm.provider, 'deepseek');
  const switched = llm.switchFallback();
  assert.ok(switched, '应该切到备用');
  assert.equal(llm.provider, 'zhipu');
  assert.ok(llm.apiKey, '切过去之后要有能用的 Key');
  assert.equal(loadSettings(config).provider, 'zhipu');
  // 再切一次不该原地打转
  assert.equal(llm.switchFallback().to, 'deepseek');
});
/* ---------------- 千问（DashScope）预设 & 报错文案 ---------------- */

test('千问默认模型是能用的 qwen-flash，且默认值在候选列表里', () => {
  const q = PROVIDERS.qwen;
  assert.equal(q.model, 'qwen-flash', 'qwen-turbo 免费额度常被耗尽，默认别用它');
  assert.ok(q.models.includes(q.model), '默认模型必须在候选列表里');
  assert.match(q.baseUrl, /compatible-mode\/v1$/, '要走 OpenAI 兼容模式');
  for (const bad of ['qwen-max-latest', 'qwen3-max']) {
    assert.ok(!q.models.includes(bad), bad + ' 在这个账号上是 404，别放进候选');
  }
  assert.match(q.hint, /429/, '提示里要说清 429 是额度问题');
});

test('429 / 模型 404 的提示要能指导用户', () => {
  const { friendlyForStatus } = require('../src/llm');
  const rl = friendlyForStatus(429, 'HTTP 429: You have exceeded your current request limit.');
  assert.match(rl, /额度|频率/);
  assert.match(rl, /qwen-flash|qwen-plus/, '要给出可直接替换的模型名');
  const nf = friendlyForStatus(404, '{"error":{"message":"Model not found"}}');
  assert.match(nf, /模型名/);
  const nfPlain = friendlyForStatus(404, 'Not Found');
  assert.equal(nfPlain, friendlyForStatus(500, ''), '不是模型问题的 404 仍走默认文案');
});
