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

test('表情包：分类名认得出英文 key、中文标签和自定义标签', () => {
  const root = makeRoot(['炸毛/a.gif']);
  const cfg = cfgOn(root);
  assert.equal(stickers.categoryFromName(cfg, 'cute'), 'cute');
  assert.equal(stickers.categoryFromName(cfg, '傲娇'), 'cute');
  assert.equal(stickers.categoryFromName(cfg, '炸毛'), 'angry');
  assert.equal(stickers.categoryFromName(cfg, 'x:猫猫'), '', '没登记的自定义分类不认');
  assert.equal(stickers.categoryFromName(cfg, '随便写'), '');
  assert.equal(stickers.categoryFromName(cfg, ''), '');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
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

test('表情包：没有分类标记时链路不发；pick 自己的兜底只服务「认不出」', () => {
  const root = makeRoot(['炸毛/a.gif', '其他/o.gif']);
  // 概率字段全拉满也没用：发不发只看 finalize 有没有抠出分类
  const cfg = cfgOn(root, { chances: { angry: 1, cute: 1, other: 1 }, genericChance: 1 });
  const { Bot } = require('../src/pipeline/chat');
  const ctx = { config: cfg, stickerService: { plan: () => { throw new Error('没有分类时不该调用服务'); } } };
  assert.equal(Bot.prototype.stickerFor.call(ctx, { msg: { platform: 'wechat' } }), null);
  // pick 本身不再因为「没写分类」返回 null：图库有图就兜底一张，供「认不出」那条路用
  const hit = stickers.pick({ config: cfg, root });
  assert.ok(hit && hit.path);
  assert.equal(hit.fallbackFrom, '');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：模型指定哪个分类就发哪个分类，跟概率字段无关', () => {
  const root = makeRoot(['炸毛/a.gif', '撒娇/c.gif', '其他/o.gif']);
  const cfg = cfgOn(root, { chances: { angry: 0, cute: 0, other: 0 }, genericChance: 0 });
  const angry = stickers.pick({ config: cfg, root, category: '炸毛', rng: () => 0 });
  assert.equal(angry.emotion, 'angry');
  assert.match(angry.path, /炸毛/);
  const cute = stickers.pick({ config: cfg, root, category: 'cute', rng: () => 0 });
  assert.equal(cute.emotion, 'cute');
  assert.match(cute.path, /撒娇/);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：分类不存在或该分类没图，兜底发一张并记下原写的分类名', () => {
  const root = makeRoot(['其他/o.gif']);
  const cfg = cfgOn(root);
  const unknown = stickers.pick({ config: cfg, root, category: '不存在', rng: () => 0 });
  assert.equal(unknown.emotion, 'happy');
  assert.equal(unknown.fallbackFrom, '不存在');
  const empty = stickers.pick({ config: cfg, root, category: '炸毛', rng: () => 0 });
  assert.equal(empty.emotion, 'happy', '炸毛没有图，退到开心的根目录图');
  assert.equal(empty.fallbackFrom, '炸毛');
  assert.ok(stickers.pick({ config: cfg, root, category: '其他' }), '有图的分类正常发');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：自定义分类登记后能按标签或 x: 选中', () => {
  const root = makeRoot(['猫猫/c1.gif', '猫猫/c2.gif']);
  const cfg = cfgOn(root);
  stickers.writeExtraCategories(cfg, root, [{ label: '猫猫' }]);
  const byLabel = stickers.pick({ config: cfg, root, category: '猫猫', rng: () => 0 });
  assert.equal(byLabel.emotion, 'x:猫猫');
  assert.match(byLabel.path, /猫猫/);
  const byKey = stickers.pick({ config: cfg, root, category: 'x:猫猫', rng: () => 0 });
  assert.equal(byKey.emotion, 'x:猫猫');
  const missing = stickers.pick({ config: cfg, root, category: 'x:没登记', rng: () => 0 });
  assert.equal(missing.emotion, 'x:猫猫', '没登记的分类兜底到用户自己建的有图分类');
  assert.equal(missing.fallbackFrom, 'x:没登记');
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：目录里没有图时安静返回 null（不崩、不刷日志）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-empty-'));
  const cfg = cfgOn(root);
  assert.equal(stickers.pick({ config: cfg, root, category: '其他' }), null);
  assert.deepEqual(stickers.listImages(path.join(root, 'data', 'stickers')), []);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});

test('表情包：提示词用的分类清单带中文名和张数（含自定义分类）', () => {
  const root = makeRoot(['炸毛/a.gif', '炸毛/b.gif', '猫猫/c.gif']);
  const cfg = cfgOn(root);
  stickers.writeExtraCategories(cfg, root, [{ label: '猫猫' }, { label: '空分类' }]);
  const byKey = Object.fromEntries(stickers.promptCategories(cfg, root).map((c) => [c.key, c]));
  assert.equal(byKey.angry.count, 2);
  assert.equal(byKey.angry.label, '炸毛');
  assert.equal(byKey.cute.count, 0);
  assert.equal(byKey['x:猫猫'].count, 1);
  assert.equal(byKey['x:空分类'].count, 0);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
});
