'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const stickers = require('../src/stickers');
const { StickerService } = require('../src/stickerService');
const { loadConfig } = require('../src/config');
const { startServer } = require('../server');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
function fixture(t, on = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-3cat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const cfg = { root, features: { stickers: on }, sticker: { dir: 'data/stickers', chances: { cute: 1, angry: 1, other: 1 } } };
  const dir = path.join(root, 'data/stickers');
  function put(rel, bytes = GIF) { const file = path.join(dir, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; }
  return { root, cfg, dir, put };
}

test('分类白名单仅三类，旧key可读但原型属性不被接受', () => {
  assert.deepEqual(stickers.EMOTIONS, { cute: '傲娇', angry: '炸毛', other: '其他' });
  for (const key of ['constructor', '__proto__', 'toString', 'valueOf', '', 'other/../../', undefined, {}, 1]) {
    assert.equal(stickers.hasEmotion(key), false, String(key));
  }
  assert.equal(stickers.normalizeEmotion('happy'), 'other');
  assert.equal(stickers.normalizeEmotion('cute'), 'cute');
});

test('旧中英文分类、通用、根目录图片全部有明确归属；不串傲娇炸毛', (t) => {
  const { dir, put } = fixture(t);
  for (const label of ['开心', 'happy', '嫌弃', 'meh', '敷衍', 'bored', '其他', 'other', '通用']) put(label + '/a.gif');
  put('root.gif');
  for (const label of ['撒娇', 'cute', '傲娇']) put(label + '/a.gif');
  put('angry/a.gif'); put('炸毛/a.gif');
  assert.equal(stickers.categoryImages(dir, 'other').length, 10);
  assert.equal(stickers.categoryImages(dir, 'cute').length, 3);
  assert.equal(stickers.categoryImages(dir, 'angry').length, 2);
  assert.deepEqual(stickers.categoryImages(dir, 'constructor'), []);
});

test('其他为空时绝不偷发炸毛/傲娇；强信号空池也不冒充', (t) => {
  const { cfg, root, put } = fixture(t);
  put('炸毛/a.gif'); put('傲娇/a.gif');
  for (const request of ['', '发个表情包']) {
    assert.equal(stickers.pick({ config: cfg, root, text: '你好', request, rng: () => 0 }), null);
  }
  put('其他/a.gif');
  const hit = stickers.pick({ config: cfg, root, text: '正常聊天', rng: () => 0 });
  assert.equal(hit.emotion, 'other'); assert.equal(path.basename(path.dirname(hit.path)), '其他');
  const empty = fixture(t);
  empty.put('其他/a.gif');
  assert.equal(stickers.pick({ config: empty.cfg, root: empty.root, text: '气死我了', rng: () => 0 }), null);
  assert.equal(stickers.pick({ config: empty.cfg, root: empty.root, text: '抱抱我', rng: () => 0 }), null);
});

test('三类概率读写使用同一个key，25%阈值可确定验证，不叠加第二次概率', (t) => {
  const { cfg, root, put } = fixture(t);
  put('其他/a.gif'); put('炸毛/a.gif'); put('傲娇/a.gif');
  cfg.sticker.chances = { other: 0.25, angry: 0, cute: 1 }; cfg.sticker.genericChance = 1;
  assert.ok(stickers.pick({ config: cfg, root, text: '天气不错', rng: () => 0.249 }));
  assert.equal(stickers.pick({ config: cfg, root, text: '天气不错', rng: () => 0.25 }), null);
  assert.equal(stickers.pick({ config: cfg, root, text: '气死我了', rng: () => 0 }), null);
  assert.equal(stickers.pick({ config: cfg, root, text: '抱抱我', rng: () => 0.99 }).emotion, 'cute');
  cfg.sticker.chances.other = 0;
  assert.equal(stickers.pick({ config: cfg, root, text: '我不会发表情包', rng: () => 0 }), null, '她自己说发不能绕过概率');
  assert.equal(stickers.pick({ config: cfg, root, text: '好呀', request: '不要发表情包', rng: () => 0 }), null);
  assert.ok(stickers.pick({ config: cfg, root, text: '好呀', request: '发个表情包', rng: () => 0.99 }));
});

test('其他选择多个文件可遍历全部，轮换一圈也不立刻重复最后一张', (t) => {
  const { cfg, root, put } = fixture(t);
  for (const n of ['a', 'b', 'c', 'd']) put('其他/' + n + '.gif');
  const seen = new Set();
  let recent = [];
  for (let i = 0; i < 8; i++) {
    const hit = stickers.pick({ config: cfg, root, text: '普通聊天', recent, rng: () => 0 });
    assert.notEqual(hit.path, recent.at(-1)); seen.add(hit.path); recent.push(hit.path);
  }
  assert.equal(seen.size, 4);
});

test('迁移无覆盖、字节不变、可重复执行；相同内容去重，不同同名重命名', (t) => {
  const { cfg, root, dir, put } = fixture(t);
  put('其他/same.gif', Buffer.from('canonical'));
  put('开心/same.gif', Buffer.from('happy'));
  put('happy/same.gif', Buffer.from('english'));
  put('嫌弃/same.gif', Buffer.from('happy'));
  put('撒娇/c.gif', Buffer.from('cute'));
  put('angry/a.gif', Buffer.from('angry'));
  put('通用/g.gif', Buffer.from('generic'));
  put('root.gif', Buffer.from('root'));
  const report = stickers.migrateLegacy(cfg, root);
  assert.deepEqual(report.errors, []);
  assert.equal(report.moved, 6); assert.equal(report.deduplicated, 1);
  assert.equal(fs.readFileSync(path.join(dir, '其他/same.gif'), 'utf8'), 'canonical');
  const bytes = stickers.categoryImages(dir, 'other').map((file) => fs.readFileSync(file, 'utf8')).sort();
  assert.deepEqual(bytes, ['canonical', 'happy', 'english', 'generic', 'root'].sort());
  assert.equal(stickers.categoryImages(dir, 'cute').length, 1);
  assert.equal(stickers.categoryImages(dir, 'angry').length, 1);
  assert.deepEqual(stickers.migrateLegacy(cfg, root), { moved: 0, deduplicated: 0, errors: [] });
});

test('迁移复制失败保留旧图，带相对ID仍能预览；未知文件不被清理', (t) => {
  const { cfg, root, dir, put } = fixture(t);
  const src = put('开心/source.gif'); put('开心/readme.txt', Buffer.from('keep me'));
  const copy = t.mock.method(fs, 'copyFileSync', () => { throw new Error('simulated copy failure'); });
  const report = stickers.migrateLegacy(cfg, root);
  assert.ok(report.errors.length);
  assert.equal(fs.existsSync(src), true);
  assert.equal(stickers.resolveImage(dir, 'other', '开心/source.gif'), src);
  assert.equal(fs.readFileSync(path.join(dir, '开心/readme.txt'), 'utf8'), 'keep me');
  copy.mock.restore();
  assert.deepEqual(stickers.migrateLegacy(cfg, root).errors, []);
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.existsSync(path.join(dir, '开心/readme.txt')), true);
});

test('关闭总开关不创建目录、不迁移图，启动一次服务也不碰旧库', (t) => {
  const { cfg, root, dir, put } = fixture(t, false);
  assert.deepEqual(stickers.migrateLegacy(cfg, root), { moved: 0, deduplicated: 0, errors: [] });
  assert.equal(fs.existsSync(dir), false);
  const src = put('开心/old.gif');
  new StickerService(cfg);
  assert.equal(fs.existsSync(src), true);
  assert.equal(fs.existsSync(path.join(dir, '其他')), false);
});

test('旧同名文件使用相对id精确解析，basename歧义拒绝而不是误删', (t) => {
  const { dir, put } = fixture(t);
  const old = put('开心/same.gif', Buffer.from('old'));
  const fresh = put('其他/same.gif', Buffer.from('fresh'));
  assert.equal(stickers.resolveImage(dir, 'other', 'same.gif'), '');
  assert.equal(stickers.resolveImage(dir, 'other', '开心/same.gif'), old);
  assert.equal(stickers.resolveImage(dir, 'other', '其他/same.gif'), fresh);
  for (const id of ['../same.gif', '其他/../same.gif', '其他\\same.gif', '/same.gif', '其他//same.gif', '其他/text.txt']) {
    assert.equal(stickers.resolveImage(dir, 'other', id), '', id);
  }
  assert.equal(stickers.resolveImage(dir, 'cute', '其他/same.gif'), '');
});

test('祖先junction不被迁移/上传/预览跟随，外部文件不被修改', (t) => {
  const { root, cfg } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-3cat-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  fs.mkdirSync(path.join(outside, 'stickers/其他'), { recursive: true });
  const external = path.join(outside, 'stickers/其他/x.gif'); fs.writeFileSync(external, GIF);
  try { fs.symlinkSync(outside, path.join(root, 'data'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) { t.skip('缺少链接权限'); return; } throw err; }
  const dir = stickers.stickerDir(cfg, root);
  assert.equal(stickers.regularFile(path.join(dir, '其他/x.gif'), dir), false);
  assert.equal(stickers.resolveImage(dir, 'other', '其他/x.gif'), '');
  assert.throws(() => stickers.upload(cfg, root, 'other', [{name:'u.gif', data:GIF.toString('base64')}]));
  assert.ok(stickers.migrateLegacy(cfg, root).errors.length);
  assert.deepEqual(fs.readFileSync(external), GIF);
});

test('旧genericChance只做内存兼容，不改原配置或被默认other盖掉', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, 'config.json');
  const raw = JSON.stringify({ sticker: { genericChance: 0.67, chances: { happy: 0.1 } } }); fs.writeFileSync(file, raw);
  const cfg = loadConfig({ root, env: {} });
  assert.equal(stickers.chanceFor(cfg, 'other'), 0.67);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('45秒不允许同会话并排两张；过90秒旧任务失效不能再领取', (t) => {
  const { root, cfg, put } = fixture(t); put('其他/a.gif');
  let now = 1000;
  const service = new StickerService(cfg, {now: () => now, rng: () => 0});
  const msg = { platform: 'wechat', chatId: 'peer', chatType: 'private' };
  const old = service.plan(msg, '你好');
  service.claim(old.id);
  now += 46000; assert.equal(service.plan(msg, '你好'), null);
  now += 45000;
  const next = service.plan(msg, '你好'); assert.ok(next);
  assert.equal(service.jobs.get(old.id).status, 'unconfirmed');
  assert.throws(() => service.claim(old.id), { statusCode: 409 });
});

test('HTTP三类旧图迁移、预览字节与删除对象一致；不改主人/设置', async (t) => {
  const { root, put } = fixture(t, false);
  put('开心/same.gif', Buffer.from(GIF)); put('其他/same.gif', Buffer.concat([GIF, Buffer.from('different')]));
  put('撒娇/c.gif'); put('angry/a.gif');
  const config = JSON.stringify({server:{port:0,openBrowser:false},watchConfig:false,features:{stickers:true}, persona:{name:'测试名字',ownerName:'测试主人'}, sticker:{chances:{other:0.45,cute:0.2,angry:0.3}}});
  fs.writeFileSync(path.join(root, 'config.json'), config);
  fs.mkdirSync(path.join(root, 'data'), { recursive:true }); fs.writeFileSync(path.join(root, 'data/settings.json'), '{}');
  const inst = await startServer({root,env:{WHALE_LOG_FILE:'',WHALE_TEST_NO_SHELL:'1'},port:0,openBrowser:false}); t.after(() => inst.close());
  const get = (r) => fetch(inst.url + r);
  const status = await (await get('/api/stickers/status')).json();
  assert.deepEqual(status.emotions.map((e) => e.key), ['cute','angry','other']);
  const other = status.emotions.find((e) => e.key === 'other');
  assert.equal(other.chance, 0.45); assert.equal(other.count, 2);
  assert.equal(new Set(other.items.map((i) => i.id)).size, 2);
  const victim = other.items.find((i) => i.name.includes('迁移'));
  const response = await get('/api/stickers/image?emotion=other&name=' + encodeURIComponent(victim.id));
  assert.equal(response.status,200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), GIF);
  const del = await fetch(inst.url+'/api/stickers/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({emotion:'other',name:victim.id})});
  assert.equal(del.status,200);
  assert.equal((await (await get('/api/stickers/status')).json()).emotions.find((e) => e.key==='other').count,1);
  for (const name of ['../same.gif','其他/../same.gif']) assert.equal((await get('/api/stickers/image?emotion=other&name='+encodeURIComponent(name))).status,404);
  assert.equal((await get('/api/stickers/image?emotion=constructor&name=same.gif')).status,404);
  assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),config);
  assert.equal(fs.readFileSync(path.join(root,'data/settings.json'),'utf8'),'{}');
});
