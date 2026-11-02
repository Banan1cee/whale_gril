'use strict';

/**
 * 「聊天模型支持多模态时，看图模型同步更新」的回归。
 *
 * 背景：看图模型原来只写在 config.json 的 vision.model，切到能看图的聊天模型
 * （比如智谱的 glm-4.6v-flash）之后，界面上还是旧的看图模型，得再去「看图」里
 * 手动改一遍——忘了改就会出现「聊天模型能看图、看图却走另一个模型」。
 *
 * 规则：能看图的聊天模型 → 看图模型自动跟随；用户手动钉过 → 以手动为准；
 * 从能看图的模型切走 → 改用这家服务商自己的看图模型（复用同一把 Key），
 * 只有服务商没有视觉模型时才回落 config.json 的默认值。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { PROVIDERS, resolveVisionConfig, loadConfig } = require('../src/infra/config');
const { decideVisionPatch } = require('../src/services/settings');
const vision = require('../src/adapters/vision');

function tempRoot(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-vision-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false } }));
  if (settings) fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify(settings));
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
}

const ZHIPU = PROVIDERS.zhipu;

test('选中能看图的聊天模型 → 看图模型自动跟随同一个', () => {
  const patch = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.6v-flash', saved: {} });
  assert.equal(patch.visionModel, 'glm-4.6v-flash');
  assert.equal(patch.visionAuto, true);
  assert.equal(patch.visionManual, false);
  assert.equal(patch.visionBaseUrl, ZHIPU.baseUrl, '跟随之后接口地址也要指向同一家');
});

test('普通文本聊天模型 → 改用这家服务商自己的看图模型', () => {
  const patch = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', saved: {} });
  assert.equal(patch.visionModel, ZHIPU.visionModels[0]);
  assert.equal(patch.visionAuto, true, '用服务商自己的视觉模型时仍然是自动模式（复用同一把 Key）');
  assert.equal(patch.visionBaseUrl, ZHIPU.baseUrl);
  // 用户自己钉了看图模型时，切到文本模型也不产生补丁
  assert.equal(
    decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-5.3', saved: { visionModel: 'my-own-vision', visionManual: true } }),
    null
  );
});

test('手动选过看图模型后，换聊天模型不覆盖它', () => {
  const patch = decideVisionPatch({
    preset: ZHIPU,
    nextModel: 'glm-4.6v-flash',
    saved: { visionModel: 'my-own-vision', visionManual: true },
  });
  assert.equal(patch, null, '手动钉住的看图模型不能被自动跟随改掉');
});

test('显式传 visionModel：非空=钉死，空串=回到自动', () => {
  const pinned = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', manualValue: 'glm-4.6v-flash' });
  assert.equal(pinned.visionModel, 'glm-4.6v-flash');
  assert.equal(pinned.visionManual, true);
  assert.equal(pinned.visionBaseUrl, ZHIPU.baseUrl, '钉死智谱模型时接口地址也要回到智谱');

  // 钉死别家的模型（比如跟随 DeepSeek 之后改用千问的视觉模型）：地址跟着模型走
  const qwenPin = decideVisionPatch({ preset: PROVIDERS.deepseek, nextModel: 'deepseek-flash', manualValue: 'qwen3.8-max' });
  assert.equal(qwenPin.visionBaseUrl, PROVIDERS.qwen.baseUrl);

  // 认不出的模型名：清掉面板里的地址，让 config.json 的 vision.baseUrl 生效
  const unknown = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', manualValue: 'my-own-vision' });
  assert.equal(unknown.visionBaseUrl, '');

  // 空串 + 不能看图的聊天模型：解除手动，改用服务商自己的看图模型
  const auto = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', saved: { visionModel: 'glm-4.6v-flash', visionManual: true }, manualValue: '' });
  assert.equal(auto.visionModel, ZHIPU.visionModels[0]);
  assert.equal(auto.visionManual, false);
  assert.equal(auto.visionAuto, true);
});

test('启动器保存时总是带 visionModel="自动"：能看图的聊天模型仍然自动跟随', () => {
  const patch = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.6v-flash', saved: {}, manualValue: '' });
  assert.equal(patch.visionModel, 'glm-4.6v-flash', '空串不能把跟随逻辑挡掉');
  assert.equal(patch.visionAuto, true);
  assert.equal(patch.visionManual, false);
});

test('从能看图的聊天模型切走 → 用服务商自己的看图模型，不空着', () => {
  const patch = decideVisionPatch({
    preset: ZHIPU,
    nextModel: 'glm-4.7-flash',
    saved: { visionModel: 'glm-5.3-flash', visionAuto: true, visionManual: false },
  });
  assert.equal(patch.visionModel, ZHIPU.visionModels[0]);
  assert.equal(patch.visionAuto, true);
});

test('只有 DeepSeek Key、聊天模型是不能看图的 v4-pro：看图自动用 deepseek-flash 并复用这把 Key', () => {
  const patch = decideVisionPatch({
    preset: PROVIDERS.deepseek,
    nextModel: 'deepseek-v4-pro',
    saved: { visionModel: 'glm-4.6v-flash', visionAuto: true, visionManual: false },
  });
  assert.equal(patch.visionModel, 'deepseek-flash');
  assert.equal(patch.visionBaseUrl, 'https://api.deepseek.com');

  const dir = tempRoot({
    provider: 'deepseek',
    keys: { deepseek: 'ds-key-12345678' },
    visionModel: 'deepseek-flash',
    visionAuto: true,
    visionManual: false,
    visionBaseUrl: 'https://api.deepseek.com',
  });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(resolveVisionConfig(cfg).model, 'deepseek-flash');
  assert.equal(vision.resolveKey(cfg), 'ds-key-12345678', '没有智谱 Key 时也必须能看图');
  assert.equal(vision.status(cfg).configured, true);
  cleanup(dir);
});

test('看图模型名不合法时拒绝保存', () => {
  assert.throws(
    () => decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', manualValue: '坏 名字' }),
    /看图模型名/
  );
});

test('resolveVisionConfig：面板设置能盖掉 config.json 的看图模型', () => {
  const dir = tempRoot({ visionModel: 'glm-4.6v-flash' });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.vision.model, 'glm-4.6v-flash', 'config.json 的默认值不变');
  assert.equal(resolveVisionConfig(cfg).model, 'glm-4.6v-flash');
  assert.equal(resolveVisionConfig(cfg).manual, true);
  cleanup(dir);

  const dir2 = tempRoot();
  const cfg2 = loadConfig({ root: dir2, env: {} });
  assert.equal(resolveVisionConfig(cfg2).model, PROVIDERS.deepseek.visionModels[0], '没设置时用当前服务商的看图模型，避免要智谱 Key');
  assert.equal(resolveVisionConfig(cfg2).manual, false);
  cleanup(dir2);
});

test('自动跟随时 visionModel 有值，但 manual 仍是 false（不能显示成手动）', () => {
  const dir = tempRoot({
    provider: 'deepseek',
    keys: { deepseek: 'ds-key-12345678' },
    visionAuto: true,
    visionManual: false,
    visionModel: 'deepseek-flash',
    visionBaseUrl: 'https://api.deepseek.com',
  });
  const cfg = loadConfig({ root: dir, env: {} });
  const st = vision.status(cfg);
  assert.equal(st.model, 'deepseek-flash');
  assert.equal(st.manual, false, '自动跟随不能标成手动');
  assert.equal(st.baseUrl, 'https://api.deepseek.com');
  assert.match(st.hint, /复用同一把 Key/, '提示要说明复用同一家服务商的 Key');
  cleanup(dir);
});

test('status() 反映跟随状态：手动选过 manual=true', () => {
  const dir = tempRoot({ visionApiKey: 'zhipu-test-key-123456', visionModel: 'glm-4.6v-flash', visionManual: true });
  const cfg = loadConfig({ root: dir, env: {} });
  const st = vision.status(cfg);
  assert.equal(st.model, 'glm-4.6v-flash');
  assert.equal(st.manual, true);
  cleanup(dir);
});

test('DeepSeek flash / 千问 max 也算能看图，会跟着聊天模型走', () => {
  const ds = decideVisionPatch({ preset: PROVIDERS.deepseek, nextModel: 'deepseek-flash', saved: {} });
  assert.equal(ds.visionModel, 'deepseek-flash');
  assert.equal(ds.visionBaseUrl, 'https://api.deepseek.com', '接口地址要跟着换到 DeepSeek');

  const qw = decideVisionPatch({ preset: PROVIDERS.qwen, nextModel: 'qwen3.8-max', saved: {} });
  assert.equal(qw.visionModel, 'qwen3.8-max');
  assert.equal(qw.visionBaseUrl, 'https://dashscope.aliyuncs.com/compatible-mode/v1');
});

test('跟随聊天模型时用同一家服务商的 Key，而不是智谱那把', () => {
  const dir = tempRoot({
    provider: 'deepseek',
    keys: { deepseek: 'ds-key-12345678', zhipu: 'zhipu-key-12345678' },
    visionAuto: true,
    visionModel: 'deepseek-flash',
    visionBaseUrl: 'https://api.deepseek.com',
  });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(vision.resolveKey(cfg), 'ds-key-12345678');
  cleanup(dir);
});

test('手动指定看图模型时仍然用看图 Key', () => {
  const dir = tempRoot({
    provider: 'deepseek',
    keys: { deepseek: 'ds-key-12345678' },
    visionApiKey: 'zhipu-vision-12345678',
    visionManual: true,
    visionModel: 'glm-4.6v-flash',
  });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(vision.resolveKey(cfg), 'zhipu-vision-12345678');
  cleanup(dir);
});

test('手动选了本服务商的看图模型，就用这家已有的 Key（不用再申请智谱的）', () => {
  const dir = tempRoot({
    provider: 'deepseek',
    keys: { deepseek: 'ds-key-12345678' },
    visionManual: true,
    visionModel: 'deepseek-flash',
  });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(vision.resolveKey(cfg), 'ds-key-12345678');
  assert.equal(vision.status(cfg).configured, true);
  cleanup(dir);
});

test('自动跟随：settings.json 里没有 provider 字段也要取到聊天那把 Key（否则测试报没填 API）', () => {
  // 现场就是这个形状：provider 只在 config.json，settings.json 只有 apiKey / keys
  const dir = tempRoot({
    keys: { deepseek: 'ds-key-abc123456' },
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'ds-key-abc123456',
    model: 'deepseek-flash',
    visionModel: 'deepseek-flash',
    visionManual: false,
    visionAuto: true,
    visionBaseUrl: 'https://api.deepseek.com',
  });
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(vision.resolveKey(cfg), 'ds-key-abc123456');
  assert.equal(vision.status(cfg).configured, true);
  assert.equal(vision.status(cfg).auto, true);
  cleanup(dir);
});

test('看图服务商下拉：手动选别家时记下 visionProvider 和它的接口地址', () => {
  const patch = decideVisionPatch({
    preset: PROVIDERS.deepseek,
    nextModel: 'deepseek-flash',
    saved: {},
    manualValue: 'glm-4.6v-flash',
    manualProvider: 'zhipu',
  });
  assert.equal(patch.visionModel, 'glm-4.6v-flash');
  assert.equal(patch.visionManual, true);
  assert.equal(patch.visionAuto, false);
  assert.equal(patch.visionProvider, 'zhipu');
  assert.equal(patch.visionBaseUrl, PROVIDERS.zhipu.baseUrl);

  // 选回「自动跟随」：解除手动，服务商清空
  const auto = decideVisionPatch({
    preset: PROVIDERS.deepseek,
    nextModel: 'deepseek-flash',
    saved: { visionManual: true, visionModel: 'glm-4.6v-flash', visionProvider: 'zhipu' },
    manualValue: '',
    manualProvider: '',
  });
  assert.equal(auto.visionAuto, true);
  assert.equal(auto.visionManual, false);
  assert.equal(auto.visionProvider, '');
  assert.ok(!auto.visionBaseUrl || /deepseek/i.test(auto.visionBaseUrl));

  assert.throws(
    () => decideVisionPatch({ preset: PROVIDERS.deepseek, nextModel: 'deepseek-flash', saved: {}, manualValue: '', manualProvider: 'nope' }),
    /看不懂|不认识/
  );
});

/* ---------------- 看图接口的失败提示 ---------------- */

async function fakeVision(handler) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(res));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

function describeVia(baseUrl) {
  return vision.describe(
    { vision: { apiKey: 'test-key-123456', model: 'fake-vision', baseUrl, timeoutMs: 4000 } },
    { imageBase64: vision.TEST_IMAGE, mime: 'image/png', prompt: '这是什么颜色？' }
  );
}

test('看图接口返回 HTML（地址填错）时给人话，不是 JSON.parse 的英文异常', async () => {
  const fake = await fakeVision((res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><h1>404 Not Found</h1></body></html>');
  });
  try {
    await assert.rejects(describeVia(fake.url), (err) => {
      assert.match(err.message, /不是 JSON/);
      assert.match(err.message, /HTTP 200/);
      assert.doesNotMatch(err.message, /Unexpected token|at Object/, '不能把英文解析异常直接丢给用户');
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('看图模型不支持图片输入（400）时提示去换模型', async () => {
  const fake = await fakeVision((res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'model does not support image input' } }));
  });
  try {
    await assert.rejects(describeVia(fake.url), (err) => {
      assert.match(err.message, /视觉模型返回/);
      assert.match(err.message, /不支持图片输入/);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('看图遇到 402 余额不足时说明是同一家服务商的额度问题', async () => {
  const fake = await fakeVision((res) => {
    res.writeHead(402, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }));
  });
  try {
    await assert.rejects(describeVia(fake.url), (err) => {
      assert.match(err.message, /余额不足/);
      assert.match(err.message, /智谱/);
      return true;
    });
  } finally {
    await fake.close();
  }
});

test('本机 / 内网的看图服务（Ollama 等）没有 Key 也能测通，云端没 Key 仍然要报错', async () => {
  let authHeader = 'unset';
  const server = http.createServer((req, res) => {
    authHeader = req.headers.authorization || '';
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '蓝色' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const text = await vision.describe(
      { vision: { model: 'qwen2.5vl:7b', baseUrl, timeoutMs: 4000 } },
      { imageBase64: vision.TEST_IMAGE, mime: 'image/png', prompt: '什么颜色？' }
    );
    assert.equal(text, '蓝色');
    assert.equal(authHeader, '', '本地服务不该带 Authorization');
    const st = vision.status({ vision: { model: 'qwen2.5vl:7b', baseUrl } });
    assert.equal(st.configured, true, '本地地址没有 Key 也算已配置');

    // 云端地址还是必须给 Key
    await assert.rejects(
      vision.describe(
        { vision: { model: 'glm-4.6v-flash', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } },
        { imageBase64: vision.TEST_IMAGE, mime: 'image/png' }
      ),
      /看图没有 Key/
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});
