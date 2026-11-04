'use strict';

/**
 * R5 回归：自建分类目录自动发现（「隐形分类」）。
 *
 * 老行为：分类清单只来自 data/sticker-categories.json，用户在 data/stickers 里
 * 新建「恼怒」放图 → 页签不出现、模型不知道、[[sticker:恼怒]] 被拒、图永远收不到。
 *
 * 新原则：目录是事实来源，JSON 只是缓存。一级子目录里有图、又不是内置/旧别名，
 * 就自动登记（幂等、保留已有 chance），页签立刻出现、模型立刻能用。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stickers = require('../src/adapters/stickers');
const { StickerService } = require('../src/services/stickerService');

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-discover-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const dir = path.join(root, 'data', 'stickers');
  const put = (rel, bytes = GIF) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  fs.mkdirSync(path.join(dir, '傲娇'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    watchConfig: false,
    features: { stickers: true },
    sticker: { dir: 'data/stickers' },
  }), 'utf8');
  const cfg = { root, features: { stickers: true }, sticker: { dir: 'data/stickers' } };
  return { root, dir, cfg, put };
}

const categoryFile = (root) => path.join(root, 'data', 'sticker-categories.json');
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

test('自建目录里有图 → 自动登记，页签出现，模型能用', (t) => {
  const { root, dir, cfg, put } = fixture(t);
  put('恼怒/a.gif'); put('恼怒/b.gif');
  const service = new StickerService(cfg);
  const status = service.status();
  const found = status.emotions.find((e) => e.label === '恼怒');
  assert.ok(found, '自建分类要出现在 status 里');
  assert.equal(found.key, 'x:恼怒');
  assert.equal(found.count, 2);
  assert.equal(found.extra, true);
  assert.equal(found.discovered, true);
  // 已经写回 JSON，重启也还在
  const saved = readJson(categoryFile(root));
  assert.deepEqual(saved.map((c) => c.label), ['恼怒']);
  assert.equal(saved[0].chance, 0.25);
  // 模型写「恼怒」能解析到、也能挑到图
  assert.equal(stickers.resolveCategory({ ...cfg, root }, '恼怒'), 'x:恼怒');
  const hit = stickers.pick({ config: cfg, root, category: '恼怒', rng: () => 0 });
  assert.equal(hit.emotion, 'x:恼怒');
  assert.match(hit.path, /恼怒/);
});

test('幂等：重复扫描不会重复登记，也不会改掉已有的 chance / 顺序', (t) => {
  const { root, cfg, put } = fixture(t);
  put('猫猫/a.gif');
  put('先有的/x.gif');   // 目录要在，否则会被当成「文件夹已删除」摘掉（见下一条用例）
  fs.writeFileSync(categoryFile(root), JSON.stringify([{ label: '先有的', chance: 0.9 }]), 'utf8');
  const first = stickers.syncDiscoveredCategories(cfg, root);
  assert.deepEqual(first.added, ['猫猫']);
  const second = stickers.syncDiscoveredCategories(cfg, root);
  assert.deepEqual(second.added, [], '第二次不应该再新增');
  const saved = readJson(categoryFile(root));
  assert.deepEqual(saved.map((c) => c.label), ['先有的', '猫猫']);
  assert.equal(saved[0].chance, 0.9, '已有分类的 chance 不能被覆盖');
});

test('文件夹被删掉 → 该分类自动取消登记（不留空页签）', (t) => {
  const { root, dir, cfg, put } = fixture(t);
  put('恼怒/a.gif');
  assert.deepEqual(stickers.syncDiscoveredCategories(cfg, root).added, ['恼怒']);
  assert.deepEqual(readJson(categoryFile(root)).map((c) => c.label), ['恼怒']);
  // 用户在资源管理器里把整个文件夹删了
  fs.rmSync(path.join(dir, '恼怒'), { recursive: true, force: true });
  const after = stickers.syncDiscoveredCategories(cfg, root);
  assert.deepEqual(after.removed, ['恼怒']);
  assert.deepEqual(readJson(categoryFile(root)), [], '登记也要一起清掉');
  // 重新建回来还能再被发现
  put('恼怒/b.gif');
  assert.deepEqual(stickers.syncDiscoveredCategories(cfg, root).added, ['恼怒']);
});

test('空目录、内置分类、旧别名都不登记', (t) => {
  const { root, dir, cfg, put } = fixture(t);
  fs.mkdirSync(path.join(dir, '空文件夹'), { recursive: true });
  put('通用/a.gif'); put('其他/a.gif'); put('撒娇/a.gif'); put('happy/a.gif');
  put('开心/a.gif'); put('傲娇/b.gif');
  put('猫猫/a.gif');
  const { added } = stickers.syncDiscoveredCategories(cfg, root);
  assert.deepEqual(added, ['猫猫'], '只有真正有图的自建目录才登记');
});

test('忽略列表里的目录不再登记（防手滑/临时目录污染提示词）', (t) => {
  const { root, cfg, put } = fixture(t);
  put('临时/a.gif'); put('猫猫/a.gif');
  stickers.writeIgnored(cfg, root, ['临时']);
  const { added } = stickers.syncDiscoveredCategories(cfg, root);
  assert.deepEqual(added, ['猫猫']);
  assert.deepEqual(stickers.readIgnored(cfg, root), ['临时']);
});

test('目录联接 / 软链不被当成分类', (t) => {
  const { root, dir, cfg } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-discover-out-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'a.gif'), GIF);
  try { fs.symlinkSync(outside, path.join(dir, '外面'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(err.code)) { t.skip('无创建链接权限'); return; }
    throw err;
  }
  const { added } = stickers.syncDiscoveredCategories(cfg, root);
  assert.deepEqual(added, [], '链接目录必须被拒');
});

test('发现是节流的：3 秒内重复 status 不会反复写文件', (t) => {
  const { root, cfg, put } = fixture(t);
  put('猫猫/a.gif');
  let clock = 10000;
  const service = new StickerService(cfg, { now: () => clock });
  service.status();
  const first = readJson(categoryFile(root));
  assert.deepEqual(first.map((c) => c.label), ['猫猫']);
  // 塞进第二个目录，但节流期内不该被发现
  put('狗子/a.gif');
  clock += 1000;
  service.status();
  assert.deepEqual(readJson(categoryFile(root)).map((c) => c.label), ['猫猫'], '节流期内不重扫');
  clock += 5000;
  service.status();
  assert.deepEqual(readJson(categoryFile(root)).map((c) => c.label), ['猫猫', '狗子'], '过了节流要能发现新目录');
});
