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

const stickers = require('../src/adapters/stickers');
const features = require('../src/infra/features');
const { loadConfig } = require('../src/infra/config');

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

test('表情包：旧关键词辅助函数保持兼容（选图只用三分类）', () => {
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

test('表情包：「发个表情」必发；开启后没有冷却，私聊群聊都按概率发', () => {
  const root = makeRoot(['炸毛/a.gif', '其他/o.gif']);
  const cfg = cfgOn(root, { chances: { angry: 0, other: 0 } });
  // 概率 0 → 普通消息不该发
  assert.equal(stickers.pick({ config: cfg, root, key: 'g:1', text: '你个傻逼', rng: () => 0.99 }), null);
  // 明确要表情 → 必发
  const forced = stickers.pick({ config: cfg, root, key: 'g:1', text: '发个表情', request: '发个表情', rng: () => 0.99 });
  assert.ok(forced && forced.path, '「发个表情」应该必发');
  // 紧接着再要一次也发：没有任何时间间隔限制
  const again = stickers.pick({ config: cfg, root, key: 'g:1', text: '发个表情', request: '发个表情', rng: () => 0.99 });
  assert.ok(again && again.path, '不应有冷却');
  // 私聊场景（同一个 key 反复）也照概率发
  cfg.sticker.chances.angry = 1;
  for (let i = 0; i < 3; i += 1) {
    assert.ok(stickers.pick({ config: cfg, root, key: 'u:1', text: '你个傻逼', rng: () => 0.01 }));
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：概率命中才发（rng 可控）', () => {
  const root = makeRoot(['开心/h.gif']);
  // 现在普通发言按「通用」概率算（强信号才走分类），所以这里给 genericChance
  const cfg = cfgOn(root, { chances: { other: 0.5 }, genericChance: 0.5 });
  const hit = stickers.pick({ config: cfg, root, key: 'u:1', text: '今天星期三', rng: () => 0.1 });
  assert.ok(hit && hit.path, '概率命中就该发一张（没有强情绪信号时全库随机）');
  const miss = stickers.pick({ config: cfg, root, key: 'u:2', text: '今天星期三', rng: () => 0.9 });
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

test('普通发言只在 开心/嫌弃/敷衍 里随机，不会抽到炸毛和撒娇', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pool-'));
  const mk = (emo, n) => {
    const d = path.join(root, 'data/stickers', emo);
    fs.mkdirSync(d, { recursive: true });
    for (let i = 0; i < n; i += 1) fs.writeFileSync(path.join(d, emo + i + '.gif'), 'x');
  };
  mk('开心', 2); mk('嫌弃', 2); mk('敷衍', 2); mk('炸毛', 3); mk('撒娇', 3);
  const cfg = cfgOn(root, { chances: {}, genericChance: 1 });
  const seen = new Set();
  for (let i = 0; i < 300; i += 1) {
    const hit = stickers.pick({ config: cfg, root, key: 'k', text: '今天星期三', rng: Math.random });
    if (hit && hit.path) seen.add(path.basename(path.dirname(hit.path)));
  }
  assert.deepEqual([...seen].sort(), ['开心', '嫌弃', '敷衍'].sort(), '只有这三类会被随机选中');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('骂人和撒娇仍然只走对应分类', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-pool2-'));
  const mk = (emo) => { const d = path.join(root, 'data/stickers', emo); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'a.gif'), 'x'); };
  mk('开心'); mk('炸毛'); mk('撒娇');
  const cfg = cfgOn(root, { chances: { angry: 1, cute: 1 }, genericChance: 1 });
  for (let i = 0; i < 20; i += 1) {
    const a = stickers.pick({ config: cfg, root, key: 'k', text: '气死我了', rng: Math.random });
    assert.equal(path.basename(path.dirname(a.path)), '炸毛');
    const c = stickers.pick({ config: cfg, root, key: 'k', text: '抱抱我', rng: Math.random });
    assert.equal(path.basename(path.dirname(c.path)), '撒娇');
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});
