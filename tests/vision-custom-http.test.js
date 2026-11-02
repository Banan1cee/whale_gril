'use strict';

/**
 * 看图自定义接口的 HTTP 端到端回归（不是源码断言）。
 *
 * 为什么要这一层：启动器那个「换模型服务后下拉变空白」的 bug，一半在 UI 事件里，
 * 一半在「保存后重新拉配置」这条链上。UI 那半只能靠源码断言钉，但数据这半
 * （换服务商后 /api/settings 还能不能回出 provider/baseUrl/model、自定义看图会不会被
 * 换服务商冲掉、从聊天复制到底复制成什么）可以用真服务跑一遍。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

async function boot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-vision-http-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    provider: 'deepseek',
  }));
  const app = await startServer({ root, env: {}, port: 0, openBrowser: false });
  return { app, root };
}

function post(app, body) {
  return fetch(app.url + '/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function settings(app) {
  return (await fetch(app.url + '/api/settings')).json();
}

async function shutdown(app, root) {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
}

test('换模型服务后重新拉配置：provider / baseUrl / model 都还在（下拉恢复靠这份数据）', async () => {
  const { app, root } = await boot();
  try {
    const res = await post(app, {
      provider: 'opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      model: 'deepseek-v4.1-flash',
      mock: true,
    });
    assert.equal(res.status, 200);

    // 启动器换完服务商 -> 自动保存 -> LoadConfigAsync 重读，靠的就是这个响应
    const s = await settings(app);
    assert.equal(s.provider, 'opencode', '重读后 provider 必须是新选的那家，否则下拉找不到选中项');
    assert.equal(s.baseUrl, 'https://opencode.ai/inference/go/openai/v1');
    assert.equal(s.model, 'deepseek-v4.1-flash');
    assert.equal(s.mock, true);
    assert.ok(s.providers && s.providers.opencode, 'providers 里要有这家，下拉才列得出来');
  } finally {
    await shutdown(app, root);
  }
});

test('自定义看图接口：存进去、读出来，少写协议自动补 http', async () => {
  const { app, root } = await boot();
  try {
    const res = await post(app, {
      visionProvider: 'custom',
      visionModel: 'qwen2.5vl:7b',
      visionBaseUrl: '127.0.0.1:8000/v1',
    });
    assert.equal(res.status, 200);

    const v = (await settings(app)).vision;
    assert.equal(v.provider, 'custom');
    assert.equal(v.custom, true);
    assert.equal(v.manual, true);
    assert.equal(v.auto, false);
    assert.equal(v.model, 'qwen2.5vl:7b');
    assert.equal(v.baseUrl, 'http://127.0.0.1:8000/v1', '本机地址应自动补 http://');
    assert.match(v.hint, /自定义接口/);
  } finally {
    await shutdown(app, root);
  }
});

test('自定义看图接口：缺地址拒绝保存，且不写入半个配置', async () => {
  const { app, root } = await boot();
  try {
    const res = await post(app, { visionProvider: 'custom', visionModel: 'qwen2.5vl:7b' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /接口地址/);

    const v = (await settings(app)).vision;
    assert.equal(v.custom, false, '保存失败不能留下自定义标记');
  } finally {
    await shutdown(app, root);
  }
});

test('从聊天复制：抄地址 + 纯文本聊天模型换成这家服务商的视觉模型，并复用聊天 Key', async () => {
  const { app, root } = await boot();
  try {
    await post(app, {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-pro',      // 只收文本
      apiKey: 'sk-test-1234567890',
    });

    const res = await post(app, { visionCopyFromChat: true });
    assert.equal(res.status, 200);

    const v = (await settings(app)).vision;
    assert.equal(v.provider, 'custom');
    assert.equal(v.baseUrl, 'https://api.deepseek.com');
    assert.equal(v.model, 'deepseek-flash', '聊天模型不能看图时要换成本家的视觉模型');
    assert.equal(v.configured, true, '和聊天同址时应直接复用聊天那把 Key');
  } finally {
    await shutdown(app, root);
  }
});

test('换模型服务不会把自定义看图配置冲掉', async () => {
  const { app, root } = await boot();
  try {
    await post(app, {
      visionProvider: 'custom',
      visionModel: 'qwen2.5vl:7b',
      visionBaseUrl: 'http://127.0.0.1:8000/v1',
    });

    // 网页 / 其它入口只改聊天服务商，不带 vision 字段
    const res = await post(app, {
      provider: 'opencode',
      baseUrl: 'https://opencode.ai/inference/go/openai/v1',
      model: 'deepseek-v4.1-flash',
      mock: true,
    });
    assert.equal(res.status, 200);

    const v = (await settings(app)).vision;
    assert.equal(v.provider, 'custom', '换聊天服务商不能把「自定义」重置掉');
    assert.equal(v.baseUrl, 'http://127.0.0.1:8000/v1');
    assert.equal(v.model, 'qwen2.5vl:7b');
  } finally {
    await shutdown(app, root);
  }
});

test('切回「自动跟随」：自定义标记清掉，回到聊天服务商的看图模型', async () => {
  const { app, root } = await boot();
  try {
    await post(app, {
      visionProvider: 'custom',
      visionModel: 'qwen2.5vl:7b',
      visionBaseUrl: 'http://127.0.0.1:8000/v1',
    });

    const res = await post(app, { visionProvider: '', visionModel: '' });
    assert.equal(res.status, 200);

    const v = (await settings(app)).vision;
    assert.equal(v.custom, false);
    assert.equal(v.auto, true);
    assert.equal(v.provider, 'deepseek', '自动模式下 provider 就是聊天服务商');
    assert.ok(v.model.length > 0, '自动模式下也要给出一个能用的看图模型');
  } finally {
    await shutdown(app, root);
  }
});
