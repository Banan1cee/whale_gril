'use strict';

/**
 * 表情包（实验性）单测。
 *
 * 这一组只测「挑图规则」，不测真发（真发在桥接，需要微信窗口）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const stickers = require('../src/stickers');
const features = require('../src/features');
const { loadConfig } = require('../src/config');

function makeRoot(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-'));
  for (const rel of files) {
    const full = path.join(root, 'data', 'stickers', rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, 'x');
  }
  return root;
}

function cfgOn(root, extra = {}) {
  const cfg = loadConfig({ root, env: {} });
  cfg.root = root;
  cfg.features.stickers = true;
  Object.assign(cfg.sticker, extra);
  return cfg;
}

test('表情包：默认关（总闸），关着时一片空白', () => {
  const root = makeRoot(['炸毛/a.gif']);
  const cfg = loadConfig({ root, env: {} });
  cfg.root = root;
  assert.equal(features.isOn(cfg, 'stickers'), false, '实验性功能默认必须是关的');
  assert.equal(stickers.pick({ config: cfg, root, key: 'k', text: '你个傻逼' }), null);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：开关在调试台登记表最前面，并标着 experimental', () => {
  assert.equal(features.REGISTRY[0].key, 'stickers', '实验性总闸要排在最上面');
  assert.equal(features.REGISTRY[0].experimental, true);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-s-'));
  try {
    const listed = features.list(loadConfig({ root, env: {} }));
    assert.equal(listed[0].experimental, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('表情包：情绪判定 5 类', () => {
  assert.equal(stickers.detectEmotion('你个傻逼', 12), 'angry');
  assert.equal(stickers.detectEmotion('你好可爱啊', 12), 'happy');
  assert.equal(stickers.detectEmotion('主人抱抱', 12), 'cute');
  assert.equal(stickers.detectEmotion('？？？', 12), 'meh');
  assert.equal(stickers.detectEmotion('随便聊聊', 2), 'bored');
});

test('表情包：按情绪找文件夹（中文/英文都认），没图回落通用', () => {
  const root = makeRoot(['炸毛/a.gif', 'angry2/占位.txt', '通用/g.gif']);
  const dir = stickers.stickerDir(cfgOn(root), root);
  const angry = stickers.imagesFor(dir, 'angry');
  assert.equal(angry.length, 1);
  assert.match(angry[0], /a\.gif$/);
  const bored = stickers.imagesFor(dir, 'bored');
  assert.equal(bored.length, 1, '该类没图要回落到通用');
  assert.match(bored[0], /g\.gif$/);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：「发个表情」必发，且不受冷却限制；普通回复要掷骰子', () => {
  const root = makeRoot(['炸毛/a.gif']);
  fs.mkdirSync(path.join(root, 'data/stickers/通用'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data/stickers/通用/g.gif'), 'x');
  const cfg = cfgOn(root, { chances: { angry: 0 }, cooldownMinutes: 60 });
  const state = new Map();
  // 概率 0 → 普通消息不该发
  assert.equal(stickers.pick({ config: cfg, root, key: 'g:1', text: '你个傻逼', state, rng: () => 0.99 }), null);
  // 明确要表情 → 必发
  const forced = stickers.pick({ config: cfg, root, key: 'g:1', text: '发个表情', request: '发个表情', state, rng: () => 0.99 });
  assert.ok(forced && forced.path, '「发个表情」应该必发');
  // 冷却内不再发
  const again = stickers.pick({ config: cfg, root, key: 'g:1', text: '发个表情', request: '发个表情', state, rng: () => 0.99 });
  assert.ok(again, '明确点名要表情时仍应发（不受冷却）');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：概率命中才发（rng 可控）', () => {
  const root = makeRoot(['开心/h.gif']);
  const cfg = cfgOn(root, { chances: { happy: 0.5 } });
  const state = new Map();
  const hit = stickers.pick({ config: cfg, root, key: 'u:1', text: '你好可爱', state, rng: () => 0.1 });
  assert.ok(hit && hit.emotion === 'happy');
  const missState = new Map();
  const miss = stickers.pick({ config: cfg, root, key: 'u:2', text: '你好可爱', state: missState, rng: () => 0.9 });
  assert.equal(miss, null);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：目录里没有图时安静返回 null（不崩、不刷日志）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-empty-'));
  const cfg = cfgOn(root);
  assert.equal(stickers.pick({ config: cfg, root, key: 'k', text: '你个傻逼' }), null);
  assert.deepEqual(stickers.listImages(path.join(root, 'data', 'stickers')), []);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});
