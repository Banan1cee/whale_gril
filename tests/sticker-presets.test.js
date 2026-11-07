'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { StickerService } = require('../src/services/stickerService');
const stickers = require('../src/adapters/stickers');

const ROOT = path.resolve(__dirname, '..');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t, enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-presets-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  const assets = path.join(root, 'assets', 'stickers');
  const files = Object.values(stickers.EMOTIONS).map(category => {
    const file = category + '/whale-test.gif';
    fs.mkdirSync(path.dirname(path.join(assets, file)), { recursive: true });
    fs.writeFileSync(path.join(assets, file), GIF);
    return { file, sha256: hash(GIF) };
  });
  fs.writeFileSync(path.join(assets, 'manifest.json'), JSON.stringify({ version: 1, files }));
  const config = { root, features: { stickers: enabled }, sticker: { dir: 'data/stickers' } };
  return { root, assets, files, config, dir: path.join(root, 'data', 'stickers') };
}

test('仓库预设为三类各九张有效 PNG，清单哈希与实际文件一致', () => {
  const assets = path.join(ROOT, 'assets', 'stickers');
  assert.ok(fs.existsSync(path.join(assets, 'manifest.json')), '缺少随包预设清单');
  const manifest = JSON.parse(fs.readFileSync(path.join(assets, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.files.length, 27);
  assert.equal(new Set(manifest.files.map(item => item.file)).size, 27);
  for (const category of Object.values(stickers.EMOTIONS)) {
    const files = fs.readdirSync(path.join(assets, category)).filter(file => file.endsWith('.png'));
    assert.equal(files.length, 9, category);
    for (const file of files) assert.ok(manifest.files.some(item => item.file === category + '/' + file));
  }
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(path.join(assets, item.file));
    assert.equal(hash(bytes), item.sha256);
    assert.equal(stickers.imageType(bytes), '.png');
    assert.ok(bytes.length < stickers.MAX_UPLOAD_BYTES);
  }
});

test('开启后后台导入，分类及图片字节不变，构造阶段不落盘', async t => {
  const f = fixture(t);
  const service = new StickerService(f.config);
  assert.equal(fs.existsSync(f.dir), false);
  const state = await service.startMaintenanceNow();
  assert.deepEqual(state.errors, []);
  for (const item of f.files) {
    assert.deepEqual(fs.readFileSync(path.join(f.dir, item.file)), GIF);
    assert.deepEqual(fs.readFileSync(path.join(f.assets, item.file)), GIF);
  }
  for (const key of Object.keys(stickers.EMOTIONS)) {
    assert.equal(stickers.categoryImages(f.dir, key).length, 1);
    assert.ok(stickers.pick({ config: f.config, root: f.root, category: key }));
  }
});

test('真实预设包经启动后台导入后，HTTP 图库可见三类各九张且健康检查可用', async () => {
  const { startServer } = require('../server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-presets-http-'));
  let inst;
  try {
    fs.cpSync(path.join(ROOT, 'assets', 'stickers'), path.join(root, 'assets', 'stickers'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      server: { port: 0, openBrowser: false }, watchConfig: false, log: { level: 'error' },
      features: { stickers: true, memorySnapshot: false, mediaCleanup: false, envContext: false },
    }));
    inst = await startServer({ root, env: { WHALE_LOG_FILE: '', WHALE_TEST_NO_SHELL: '1' }, port: 0, openBrowser: false });
    assert.equal((await fetch(inst.url + '/healthz')).status, 200);
    let state;
    for (let i = 0; i < 250; i++) {
      state = await (await fetch(inst.url + '/api/stickers/status?queueOnly=1')).json();
      if (state.maintenance?.phase === 'done') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(state.maintenance?.phase, 'done');
    assert.deepEqual(state.maintenance.errors, []);
    const status = await (await fetch(inst.url + '/api/stickers/status')).json();
    assert.deepEqual(status.emotions.map(category => [category.label, category.count]), [['傲娇', 9], ['炸毛', 9], ['开心', 9]]);
  } finally {
    if (inst) await inst.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('总闸关闭时有预设也不创建 data、不导入图片', async t => {
  const f = fixture(t, false);
  await new StickerService(f.config).startMaintenanceNow();
  assert.equal(fs.existsSync(path.join(f.root, 'data')), false);
});

test('不覆盖已有同名图，删除预设后重启也不复活', async t => {
  const f = fixture(t);
  const conflict = path.join(f.dir, f.files[0].file);
  fs.mkdirSync(path.dirname(conflict), { recursive: true });
  fs.writeFileSync(conflict, 'existing-user-image');
  await new StickerService(f.config).startMaintenanceNow();
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'existing-user-image');
  const deleted = path.join(f.dir, f.files[1].file);
  assert.equal(fs.existsSync(deleted), true);
  fs.unlinkSync(deleted);
  await new StickerService(f.config).startMaintenanceNow();
  assert.equal(fs.existsSync(deleted), false);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'existing-user-image');
});

test('已有用户图库保留，可对自定义图库路径初始化', async t => {
  const f = fixture(t);
  f.config.sticker.dir = 'my-library';
  const dir = path.join(f.root, 'my-library');
  fs.mkdirSync(path.join(dir, '开心'), { recursive: true });
  fs.writeFileSync(path.join(dir, '开心', 'user.gif'), GIF);
  await new StickerService(f.config).startMaintenanceNow();
  assert.deepEqual(fs.readFileSync(path.join(dir, '开心', 'user.gif')), GIF);
  for (const item of f.files) assert.deepEqual(fs.readFileSync(path.join(dir, item.file)), GIF);
  assert.equal(fs.existsSync(path.join(f.root, 'data')), false);
});

test('预设损坏会报错但不影响旧图库，不标记完成，修复后可重试', async t => {
  const f = fixture(t);
  const file = path.join(f.assets, f.files[0].file);
  fs.writeFileSync(file, 'corrupt');
  fs.mkdirSync(path.join(f.dir, '开心'), { recursive: true });
  const user = path.join(f.dir, '开心', 'user.gif');
  fs.writeFileSync(user, GIF);
  const state = await new StickerService(f.config).startMaintenanceNow();
  assert.ok(state.errors.length > 0);
  assert.deepEqual(fs.readFileSync(user), GIF);
  fs.writeFileSync(file, GIF);
  const next = await new StickerService(f.config).startMaintenanceNow();
  assert.deepEqual(next.errors, []);
  for (const item of f.files) assert.deepEqual(fs.readFileSync(path.join(f.dir, item.file)), GIF);
});

test('预设清单不能借路径穿越写出图库', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.assets, 'manifest.json'), JSON.stringify({ version: 1, files: [{ file: '../outside.gif', sha256: hash(GIF) }] }));
  const state = await new StickerService(f.config).startMaintenanceNow();
  assert.ok(state.errors.length > 0);
  assert.equal(fs.existsSync(path.join(f.root, 'data', 'outside.gif')), false);
});

test('图库分类若为链接不能借预设导入修改外部目录', async t => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.mkdirSync(f.dir, { recursive: true });
  try { fs.symlinkSync(outside, path.join(f.dir, '傲娇'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) { t.skip('无链接权限'); return; } throw err; }
  const state = await new StickerService(f.config).startMaintenanceNow();
  assert.ok(state.errors.length > 0);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('安装包、源码包与部署都显式包含预设 PNG，源文件夹不重复打包', () => {
  const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  assert.match(read('installer/whale.iss'), /Source: "\.\.\\assets\\stickers\\\*"; DestDir: "\{app\}\\assets\\stickers"/);
  for (const rel of ['scripts/build-release.ps1', 'scripts/deploy.ps1']) {
    assert.ok(read(rel).includes('assets\\stickers'), rel + ' 需单独复制 PNG，不能被全局排除规则漏掉');
    assert.ok(read(rel).includes('鲸鲸表情包'), rel + ' 不应重复分发原始收集目录');
    const bytes = fs.readFileSync(path.join(ROOT, rel));
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], rel + ' 保留 UTF-8 BOM');
  }
});

test('发布自检逐张校验资源：缺一张图片就明确拒绝', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-preset-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.cpSync(path.join(ROOT, 'assets', 'stickers'), path.join(root, 'assets', 'stickers'), { recursive: true });
  const check = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'release-check.js'), root], { encoding: 'utf8' });
  // 精简暂存树没有其他发布文件；这里只验证预设检查项，不能让其它缺失项掩盖漏图。
  const valid = check();
  assert.match(valid.stdout, /^✓ 预设表情包清单及图片完整/m);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'stickers', 'manifest.json'), 'utf8'));
  fs.unlinkSync(path.join(root, 'assets', 'stickers', manifest.files[0].file));
  const missing = check();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stdout, /^✗ 预设表情包清单及图片完整/m);
  assert.ok(missing.stdout.includes(path.basename(manifest.files[0].file)));
});
