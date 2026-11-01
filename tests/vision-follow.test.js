'use strict';

/**
 * 「聊天模型支持多模态时，看图模型同步更新」的回归。
 *
 * 背景：看图模型原来只写在 config.json 的 vision.model，切到能看图的聊天模型
 * （比如智谱的 glm-4.6v-flash）之后，界面上还是旧的看图模型，得再去「看图」里
 * 手动改一遍——忘了改就会出现「聊天模型能看图、看图却走另一个模型」。
 *
 * 规则：能看图的聊天模型 → 看图模型自动跟随；用户手动钉过 → 以手动为准；
 * 从能看图的模型切走 → 解除跟随，回落默认。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

test('普通文本聊天模型不会改动看图模型', () => {  assert.equal(decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', saved: {} }), null);
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

  // 空串 + 不能看图的聊天模型：清掉手动值，回默认视觉模型
  const auto = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.7-flash', saved: { visionModel: 'glm-4.6v-flash', visionManual: true }, manualValue: '' });
  assert.equal(auto.visionModel, '');
  assert.equal(auto.visionManual, false);
  assert.equal(auto.visionAuto, false);
});

test('启动器保存时总是带 visionModel="自动"：能看图的聊天模型仍然自动跟随', () => {
  const patch = decideVisionPatch({ preset: ZHIPU, nextModel: 'glm-4.6v-flash', saved: {}, manualValue: '' });
  assert.equal(patch.visionModel, 'glm-4.6v-flash', '空串不能把跟随逻辑挡掉');
  assert.equal(patch.visionAuto, true);
  assert.equal(patch.visionManual, false);
});

test('从能看图的聊天模型切走 → 解除跟随，回落默认看图模型', () => {
  const patch = decideVisionPatch({
    preset: ZHIPU,
    nextModel: 'glm-4.7-flash',
    saved: { visionModel: 'glm-4.6v-flash', visionAuto: true, visionManual: false },
  });
  assert.equal(patch.visionModel, '');
  assert.equal(patch.visionAuto, false);
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
  assert.equal(resolveVisionConfig(cfg2).model, 'glm-4.6v-flash', '没设置时回落默认免费视觉');
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
  assert.match(st.hint, /跟随聊天模型/, '提示要说明用聊天模型那家的 Key');
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
