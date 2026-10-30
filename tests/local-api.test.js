'use strict';

/**
 * 本地 API 接入（Ollama / LM Studio / vLLM / 自建 OpenAI 兼容服务）回归。
 *
 * 用户反馈：「本地 api 有问题，接不进去」。
 * 复现路径：新装 → 设置里选「本地 Ollama」（或自定义 + 127.0.0.1）→ 保存 → 测试连接。
 * 因为新装的「演示模式」开关默认是勾着的，而网页每次保存都会把开关状态一起提交，
 * 服务端又用 body.mock 覆盖了「免 Key 服务自动关演示模式」的判断，结果：
 *   · settings.json 里 mock 一直是 true
 *   · llm.isMock 一直为真 → _open() 直接抛 nokey，一次请求都没发到本地服务
 *   · 测试连接还提示「还没拿到 API Key」——可本地服务根本不需要 Key
 * 另外两处顺带修掉：地址少写 http:// 直接报错、Ollama 根地址少 /v1 时 404。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, resolveRuntime, isLocalUrl, normalizeBaseUrl } = require('../src/infra/config');
const { DeepSeekClient } = require('../src/llm/client');
const { startServer } = require('../server');

/** 假的本地 OpenAI 兼容服务；strict = 只认 /v1/chat/completions（和真 Ollama 一样） */
async function startFakeModel({ strict = true } = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push(req.url);
      const ok = strict ? /\/v1\/chat\/completions$/.test(req.url) : /\/chat\/completions$/.test(req.url);
      if (!ok) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: '404 page not found' } }));
      }
      let payload = {};
      try { payload = JSON.parse(body); } catch { /* ignore */ }
      if (payload.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '咕噜' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '咕噜' }, finish_reason: 'stop' }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    port: server.address().port,
    hits,
    close: () => new Promise((r) => server.close(r)),
  };
}

function tempRoot({ config = {}, settings = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-local-'));
  // watchConfig:false —— 测试结束会删临时目录，watcher 还活着会报 EPERM/ENOENT
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ watchConfig: false, ...config }));
  if (settings) {
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'settings.json'), JSON.stringify(settings));
  }
  return root;
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
}

async function bootServer(root) {
  return startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, host: '127.0.0.1', openBrowser: false });
}

/* ---------------- 地址识别 ---------------- */

test('isLocalUrl：本机 / 内网 / Docker 宿主机都算，公网不算', () => {
  for (const u of [
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://0.0.0.0:8080',
    'http://[::1]:11434/v1',
    'http://192.168.1.8:8080/v1',
    'http://10.0.0.5:8080/v1',
    'http://172.20.0.3:8080/v1',
    'http://host.docker.internal:1234/v1',
    'http://mybox.local:1234/v1',
  ]) {
    assert.equal(isLocalUrl(u), true, u + ' 应该算本机/内网');
  }
  for (const u of [
    'https://api.deepseek.com',
    'https://open.bigmodel.cn/api/paas/v4',
    'http://127.0.0.10:8080/v1', // 不能把 127.0.0.10 当成 127.0.0.1
    'http://192.168.1.8.example.com/v1',
    '127.0.0.1:11434/v1', // 没写协议
    '',
  ]) {
    assert.equal(isLocalUrl(u), false, u + ' 不该算本机');
  }
});

test('normalizeBaseUrl：本机地址少写 http:// 自动补，公网域名不乱补', () => {
  assert.equal(normalizeBaseUrl('127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeBaseUrl('localhost:1234/v1'), 'http://localhost:1234/v1');
  assert.equal(normalizeBaseUrl('192.168.1.8:8080/v1'), 'http://192.168.1.8:8080/v1');
  assert.equal(normalizeBaseUrl('//127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1');
  assert.equal(normalizeBaseUrl('https://api.deepseek.com'), 'https://api.deepseek.com');
  assert.equal(normalizeBaseUrl('api.deepseek.com'), 'api.deepseek.com', '公网域名不补成 http，补了反而打不开');
  assert.equal(normalizeBaseUrl(''), '');
});

/* ---------------- 演示模式不能盖住本地接口 ---------------- */

test('本地 Ollama + 残留的演示模式开关 → 仍然当真接入（不再假装没 Key）', () => {
  const root = tempRoot({
    config: { provider: 'ollama' },
    // 新装用户点开设置时开关就是勾着的，保存时原样提交
    settings: { provider: 'ollama', mock: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  });
  const rt = resolveRuntime(loadConfig({ root, env: {} }));
  assert.equal(rt.needsKey, false);
  assert.equal(rt.mock, false, '本地接口不需要 Key，演示模式必须被关掉');
  assert.equal(new DeepSeekClient({ config: loadConfig({ root, env: {} }), logger: null }).isMock, false);
  cleanup(root);
});

test('自定义 + 本机地址 + 演示模式开关 → 同样如实接入', () => {
  const root = tempRoot({
    config: { provider: 'custom' },
    settings: { provider: 'custom', mock: true, baseUrl: 'http://127.0.0.1:1234/v1', model: 'qwen2.5-7b-instruct' },
  });
  const rt = resolveRuntime(loadConfig({ root, env: {} }));
  assert.equal(rt.needsKey, false);
  assert.equal(rt.mock, false);
  cleanup(root);
});

test('云端服务没 Key 时仍然是演示模式（别把兜底一起改掉）', () => {
  const root = tempRoot({ config: { provider: 'deepseek' }, settings: { provider: 'deepseek' } });
  const rt = resolveRuntime(loadConfig({ root, env: {} }));
  assert.equal(rt.needsKey, true);
  assert.equal(rt.mock, true);
  cleanup(root);
});

/* ---------------- 网页真的能保存并连上 ---------------- */

test('设置接口：新装选本地 Ollama 保存后，演示模式自动关闭', async () => {
  const fake = await startFakeModel();
  const root = tempRoot({ config: { server: { port: 0, openBrowser: false } } });
  const app = await bootServer(root);
  try {
    // 网页读到的初始状态：没 Key → 开关是勾着的
    const before = await (await fetch(app.url + '/api/settings')).json();
    assert.equal(before.mock, true);

    const saved = await (
      await fetch(app.url + '/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'ollama',
          baseUrl: fake.url + '/v1',
          model: 'qwen2.5:7b',
          mock: before.mock, // 网页原样把「勾着」提交上去
          temperature: 0.95,
          userName: '主人',
          group: { requireAt: true, freeChat: false, freeChatChance: 0.06 },
        }),
      })
    ).json();
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.needsKey, false);
    assert.equal(saved.settings.mock, false, '保存后不能还停在演示模式');

    const settings = JSON.parse(fs.readFileSync(path.join(root, 'data', 'settings.json'), 'utf8'));
    assert.equal(settings.mock, false);

    const probe = await (
      await fetch(app.url + '/api/settings/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', baseUrl: fake.url + '/v1', model: 'qwen2.5:7b', mock: true }),
      })
    ).json();
    assert.equal(probe.ok, true, '测试连接应该真的打到本地服务：' + JSON.stringify(probe));
    assert.equal(probe.probe.sample, '咕噜');
    assert.ok(fake.hits.length > 0, '本地服务必须真的收到过请求');
  } finally {
    await app.close();
    await fake.close();
    cleanup(root);
  }
});

test('设置接口：地址少写 http:// 自动补，并存成可用的地址', async () => {
  const fake = await startFakeModel();
  const root = tempRoot({ config: { server: { port: 0, openBrowser: false } } });
  const app = await bootServer(root);
  try {
    const saved = await (
      await fetch(app.url + '/api/settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'custom', baseUrl: `127.0.0.1:${fake.port}/v1`, model: 'my-model', mock: true }),
      })
    ).json();
    assert.equal(saved.ok, true, '本机地址少写协议不该再报错：' + JSON.stringify(saved));
    assert.equal(saved.settings.baseUrl, fake.url + '/v1');
    assert.equal(saved.settings.mock, false);

    const probe = await (await fetch(app.url + '/api/settings/test', { method: 'POST', body: '{}' })).json();
    assert.equal(probe.ok, true);
  } finally {
    await app.close();
    await fake.close();
    cleanup(root);
  }
});

/* ---------------- Ollama 根地址（少 /v1） ---------------- */

test('Ollama 根地址（没有 /v1）会自动再试 /v1/chat/completions', async () => {
  const fake = await startFakeModel({ strict: true });
  const root = tempRoot({
    config: { provider: 'ollama' },
    settings: { provider: 'ollama', baseUrl: fake.url, model: 'qwen2.5:7b' },
  });
  const client = new DeepSeekClient({ config: loadConfig({ root, env: {} }), logger: null });
  assert.equal(client.endpoint(), fake.url + '/chat/completions');
  assert.equal(client.altEndpoint(), fake.url + '/v1/chat/completions');
  const text = await client.complete({ system: 's', turns: [{ role: 'user', content: '在吗' }] });
  assert.equal(text, '咕噜');
  assert.deepEqual(fake.hits, ['/chat/completions', '/v1/chat/completions'], '第一次 404，第二次换 /v1 成功');
  await fake.close();
  cleanup(root);
});

test('云端 404 不换路径乱试（那是模型名不对）', () => {
  const root = tempRoot({
    config: { provider: 'custom' },
    settings: { provider: 'custom', baseUrl: 'https://api.example.com/v1', model: 'x', apiKey: 'sk-1234567890' },
  });
  const client = new DeepSeekClient({ config: loadConfig({ root, env: {} }), logger: null });
  assert.equal(client.altEndpoint(), '');
  cleanup(root);
});

/* ---------------- 网页设置面板 ---------------- */

test('网页设置：本地地址要能自己判免 Key，并把演示模式关掉（静态断言）', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'web', 'assets', 'app.js'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.match(app, /function isLocalBaseUrl/, '要按地址判断是不是本机/内网，不能只看服务商预设');
  assert.match(app, /function applyKeyExpectation/, 'Key 提示和演示模式开关要跟着地址走');
  assert.match(app, /\$\('baseUrl'\)\.addEventListener\('input'/, '手改地址要即时重算');
  assert.match(page, /id="mockHelp"/, '本地地址时要有一句「演示模式已关掉」的说明');
});
