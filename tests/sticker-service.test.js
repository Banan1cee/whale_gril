'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const stickers = require('../src/adapters/stickers');
const { StickerService } = require('../src/services/stickerService');
const { startServer } = require('../server');
const { loadConfig } = require('../src/infra/config');
const { Gateway: GatewayAdapter } = require('../src/adapters/gateway');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
function fixture(t, on = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-fix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }));
  const cfg = loadConfig({ root, env: {} });
  cfg.root = root;
  cfg.features.stickers = on;
  cfg.sticker.chances = { cute: 1, angry: 1, other: 1 };
  return { root, cfg };
}
function upload(cfg, root, emotion = 'other', name = '动画.gif', bytes = GIF) {
  return stickers.upload(cfg, root, emotion, [{ name, data: bytes.toString('base64') }]);
}

test('上传按情绪归档，保留 GIF 原始字节且同名不覆盖', (t) => {
  const { root, cfg } = fixture(t);
  const one = upload(cfg, root)[0];
  assert.equal(one.emotion, 'other');
  assert.deepEqual(fs.readFileSync(path.join(root, 'data/stickers/其他', one.name)), GIF);
  assert.equal(upload(cfg, root)[0].name, one.name, '重复上传应幂等');
  assert.equal(stickers.categoryImages(stickers.stickerDir(cfg, root), 'angry').length, 0);
  assert.equal(stickers.imagesFor(stickers.stickerDir(cfg, root), 'angry').length, 0, '不能拿别的情绪的图冒充');
});

test('上传拒绝伪装/超限/路径穿越/未知情绪；无有效批次不落盘', (t) => {
  const { root, cfg } = fixture(t);
  for (const [emotion, files] of [
    ['constructor', [{ name: 'a.gif', data: GIF.toString('base64') }]],
    ['other', [{ name: '../config.json', data: GIF.toString('base64') }]],
    ['other', [{ name: 'a.png', data: GIF.toString('base64') }]],
    ['other', [{ name: 'a.gif', data: Buffer.from('not image').toString('base64') }]],
    ['other', [{ name: 'a.gif', data: '####' }]],
    ['other', [{ name: 'a.gif', data: Buffer.alloc(stickers.MAX_FILE_BYTES + 1).toString('base64') }]],
    ['other', new Array(stickers.MAX_UPLOAD_FILES + 1).fill({ name: 'a.gif', data: GIF.toString('base64') })],
    ['other', [{ name: 'ok.gif', data: GIF.toString('base64') }, { name: 'bad.exe', data: '' }]],
  ]) assert.throws(() => stickers.upload(cfg, root, emotion, files));
  assert.equal(fs.existsSync(path.join(root, 'data/stickers')), false);
  cfg.features.stickers = false;
  assert.throws(() => upload(cfg, root), { statusCode: 404 });
});

test('旧通用仅归入其他，炸毛和傲娇不借图', (t) => {
  const { root, cfg } = fixture(t);
  upload(cfg, root, 'angry');
  const dir = stickers.stickerDir(cfg, root);
  assert.equal(stickers.categoryImages(dir, 'other').length, 0, '分类计数必须是精确的');
  assert.equal(stickers.imagesFor(dir, 'other').length, 0, '该类没图也不拿别的情绪顶替');
  fs.mkdirSync(path.join(dir, '通用'));
  fs.writeFileSync(path.join(dir, '通用/g.gif'), GIF);
  assert.equal(stickers.imagesFor(dir, 'other').length, 1);
  assert.equal(stickers.categoryImages(dir, 'other').length, 1);
  assert.equal(stickers.imagesFor(dir, 'cute').length, 0);
});

test('关闭开关取消已取出和未领取任务，重新开启不重放，重启不读旧队列', (t) => {
  const { root, cfg } = fixture(t);
  upload(cfg, root);
  let service = new StickerService(cfg);
  const first = service.enqueue('other', '文件传输助手');
  const second = service.enqueue('other', '文件传输助手');
  service.claim(first.id);
  const generation = service.generation;
  cfg.features.stickers = false; service.reconcile();
  assert.throws(() => service.pending(), { statusCode: 404 });
  cfg.features.stickers = true; service.reconcile();
  assert.notEqual(service.generation, generation);
  assert.deepEqual(service.pending(), []);
  assert.throws(() => service.claim(second.id), { statusCode: 409 });
  assert.throws(() => service.ack(first.id, 'confirmed'), { statusCode: 409 });
  fs.writeFileSync(path.join(root, 'data/sticker-queue.json'), JSON.stringify([{ path: 'secret.txt', chat: 'wrong' }]));
  service = new StickerService(cfg);
  assert.deepEqual(service.pending(), []);
});

test('任务原子领取，仅一次；失败/未确认状态不伪装成成功，ACK不重复发送', (t) => {
  const { root, cfg } = fixture(t);
  upload(cfg, root);
  const service = new StickerService(cfg);
  const job = service.enqueue('other', '文件传输助手');
  assert.equal(service.claim(job.id).status, 'sending');
  assert.throws(() => service.claim(job.id), { statusCode: 409 });
  assert.throws(() => service.ack(job.id, true), { statusCode: 400 });
  const result = service.ack(job.id, 'unconfirmed', '数据库没有证据');
  assert.equal(result.status, 'unconfirmed');
  assert.equal(service.status().jobs[0].error, '数据库没有证据');
  assert.throws(() => service.ack(job.id, 'confirmed'), { statusCode: 409 });
  assert.deepEqual(service.pending(), []);
});

test('没有冷却：私聊也能连续按概率发；同一会话同时只排一个任务', (t) => {
  const { root, cfg } = fixture(t);
  upload(cfg, root);
  cfg.sticker.chances.other = 1;
  const service = new StickerService(cfg, { rng: () => 0 });
  const msg = { platform: 'wechat', chatId: 'wxid-test', chatType: 'private' };
  const first = service.plan(msg, '哈哈');
  assert.equal(first.status, 'reserved', '私聊也要能自动发');
  assert.equal(service.plan(msg, '哈哈'), null, '同一会话同时只排一个，避免连发刷屏');
  assert.equal(service.pending().length, 0, '自动回复应等文字发完，不让轮询抢先发图');
  service.claim(first.id); service.ack(first.id, 'confirmed');
  // 立刻就能再发，不需要等十分钟
  const second = service.plan(msg, '哈哈');
  assert.ok(second, '确认后立刻可以再发（无冷却）');
  service.claim(second.id); service.ack(second.id, 'confirmed');
  assert.ok(service.plan(msg, '哈哈'), '再紧接着也还能发');
  assert.equal(service.plan({ ...msg, platform: 'web' }, '哈哈'), null, '网页聊天不排表情包');
});

test('任务过期不重试，满队列明确报错而非静默丢任务', (t) => {
  const { root, cfg } = fixture(t);
  upload(cfg, root);
  let now = 1;
  const service = new StickerService(cfg, { now: () => now });
  const first = service.enqueue('other', '文件传输助手'); service.claim(first.id);
  for (let i = 1; i < 20; i++) service.enqueue('other', '文件传输助手');
  assert.throws(() => service.enqueue('other', '文件传输助手'), { statusCode: 429 });
  now += 5 * 60000 + 1;
  assert.deepEqual(service.pending(), []);
  assert.equal(service.jobs.get(first.id).status, 'unconfirmed');
});

async function live(t) {
  const { root } = fixture(t, false);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, watchConfig: false,
    persona: { ownerName: '测试主人', master: { wxids: ['wxid-master'] } },
    gateway: { wechat: { enabled: true, inboundToken: 'sticker-test-token' } } }));
  const inst = await startServer({ root, env: { WHALE_LOG_FILE: '', WHALE_TEST_NO_SHELL: '1' }, port: 0, openBrowser: false });
  t.after(() => inst.close());
  async function request(route, body, token) {
    const response = await fetch(inst.url + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { 'x-bot-token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  const toggle = (value) => request('/api/features', { key: 'stickers', value });
  return { root, inst, request, toggle };
}

test('HTTP：默认关404；热开上传/分类/领取/结果；关闭取消任务且不改主人配置', async (t) => {
  const { root, request, toggle } = await live(t);
  assert.equal((await request('/api/stickers/status')).status, 404);
  assert.equal((await request('/api/stickers/upload', { emotion: 'other', files: [] })).status, 404);
  assert.equal((await toggle(true)).status, 200);
  const up = await request('/api/stickers/upload', { emotion: 'other', files: [{ name: 'a.gif', data: GIF.toString('base64') }] });
  assert.equal(up.status, 200);
  const status = (await request('/api/stickers/status')).body;
  assert.equal(status.emotions.find((e) => e.key === 'other').count, 1);
  assert.equal(status.emotions.find((e) => e.key === 'angry').count, 0);
  assert.equal((await request('/api/stickers/pending')).status, 403);
  const job = (await request('/api/stickers/test', { emotion: 'other', chat: '文件传输助手' })).body.queued;
  assert.equal((await request('/api/stickers/claim', { id: job.id }, 'bad')).status, 403);
  assert.equal((await request('/api/stickers/claim', { id: job.id }, 'sticker-test-token')).body.item.status, 'sending');
  assert.equal((await request('/api/stickers/claim', { id: job.id }, 'sticker-test-token')).status, 409);
  assert.equal((await request('/api/stickers/ack', { id: job.id, status: 'failed', error: '目标未打开' }, 'sticker-test-token')).status, 200);
  assert.equal((await request('/api/stickers/status')).body.jobs[0].status, 'failed');
  await request('/api/stickers/test', { emotion: 'other', chat: '文件传输助手' });
  await toggle('false');
  assert.equal((await request('/api/stickers/status')).status, 404, '字符串false也必须关');
  await toggle(true);
  assert.equal((await request('/api/stickers/pending', undefined, 'sticker-test-token')).body.items.length, 0);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(cfg.persona.ownerName, '测试主人');
  assert.deepEqual(cfg.persona.master.wxids, ['wxid-master']);
});

test('网关默认关回包真正无sticker字段，不给远程/其他平台发本机路径', async () => {
  // No model, server, runtime or WeChat needed.
  const gateway = new GatewayAdapter({ platform: 'wechat', options: {}, bot: {
    handle: async () => ({ action: 'reply', reply: '你好', bubbles: ['你好'] }), stickerFor: () => null,
  } });
  const result = await gateway.handleInbound({ chat_id: 'wxid-x', text: 'hello' }, { local: true });
  assert.equal(Object.hasOwn(result, 'sticker'), false);
  gateway.bot.stickerFor = () => { throw new Error('must not be called remotely'); };
  const remote = await gateway.handleInbound({ chat_id: 'wxid-x', text: 'hello' });
  assert.equal(Object.hasOwn(remote, 'sticker'), false);
});

test('HTTP：自动回包带一次性任务，网页SSE不泄漏本地路径，网页聊天不占微信配额', async (t) => {
  const { root, inst, request, toggle } = await live(t);
  await toggle(true);
  await request('/api/stickers/upload', { emotion: 'other', files: [{ name: 'a.gif', data: GIF.toString('base64') }] });
  inst.runtime.config.sticker.chances.other = 1;
  inst.runtime.bot.handle = async () => ({ action: 'reply', reply: '哈哈', bubbles: ['哈哈'] });
  const response = await fetch(inst.url + '/webhook/wechat', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': 'sticker-test-token', 'x-whale-bridge': '1' },
    body: JSON.stringify({ chat_id: 'wxid-test', text: '发个表情' }) });
  const payload = await response.json();
  assert.ok(payload.sticker?.id);
  assert.equal(payload.sticker.status, 'reserved');
  assert.equal((await request('/api/stickers/pending', undefined, 'sticker-test-token')).body.items.length, 0);
  const web = await fetch(inst.url + '/api/chat', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': 'sticker-test-token' },
    body: JSON.stringify({ text: '在吗', sessionId: 'sticker-visibility' }) });
  assert.equal((await web.text()).includes('"sticker"'), false);
  assert.equal(inst.runtime.stickerService.jobs.size, 1, '网页聊天不该排队表情包');
  await toggle(false);
  const off = await fetch(inst.url + '/webhook/wechat', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bot-token': 'sticker-test-token', 'x-whale-bridge': '1' },
    body: JSON.stringify({ chat_id: 'wxid-test', text: '发个表情' }) });
  assert.equal(Object.hasOwn(await off.json(), 'sticker'), false);
});

test('HTTP：上传请求尚在读取时关闭总闸，不允许存图或悄悄重排队', async (t) => {
  const { root, inst, request, toggle } = await live(t);
  await toggle(true);
  const body = JSON.stringify({ emotion: 'other', files: [{ name: 'a.gif', data: GIF.toString('base64') }] });
  let finish;
  const result = new Promise((resolve, reject) => {
    const req = http.request(inst.url + '/api/stickers/upload', { method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    finish = () => req.end(body.slice(1));
    req.write(body.slice(0, 1));
  });
  await toggle(false);
  finish();
  assert.equal(await result, 404);
  assert.deepEqual(stickers.listImages(path.join(root, 'data/stickers')), []);
});

test('目录链接不能把上传和挑图重定向到表情包库外', (t) => {
  const { root, cfg } = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sticker-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'data/stickers'), { recursive: true });
  const dir = stickers.stickerDir(cfg, root);
  try { fs.symlinkSync(outside, path.join(dir, '其他'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (err) { if (['EPERM', 'EACCES'].includes(err.code)) { t.skip('无创建链接权限'); return; } throw err; }
  assert.throws(() => upload(cfg, root));
  fs.writeFileSync(path.join(outside, 'x.gif'), GIF);
  assert.deepEqual(stickers.categoryImages(dir, 'other'), []);
});

test('HTTP：缩略图只回传表情包目录里的真图，越界/未知情绪一律 404', async (t) => {
  const { inst, request, toggle } = await live(t);
  await toggle(true);
  const up = await request('/api/stickers/upload', { emotion: 'other', files: [{ name: 'a.gif', data: GIF.toString('base64') }] });
  const name = up.body.uploaded[0].name;
  const ok = await fetch(`${inst.url}/api/stickers/image?emotion=other&name=${encodeURIComponent(name)}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'image/gif');
  for (const query of ['emotion=other&name=../config.json', 'emotion=../x&name=a.gif', 'emotion=other&name=', 'emotion=nope&name=a.gif']) {
    const r = await fetch(`${inst.url}/api/stickers/image?${query}`);
    assert.equal(r.status, 404, query);
  }
});

test('HTTP：可以删掉单张表情包；越界和未知情绪删不掉；能打开文件夹', async (t) => {
  const { root, request, toggle } = await live(t);
  await toggle(true);
  const up = await request('/api/stickers/upload', { emotion: 'other', files: [{ name: 'a.gif', data: GIF.toString('base64') }] });
  const name = up.body.uploaded[0].name;
  const file = path.join(root, 'data/stickers/其他', name);
  assert.ok(fs.existsSync(file));
  assert.equal((await request('/api/stickers/delete', { emotion: 'other', name: '../config.json' })).status, 404);
  assert.equal((await request('/api/stickers/delete', { emotion: 'nope', name })).status, 404);
  assert.equal((await request('/api/stickers/delete', { emotion: 'other', name })).status, 200);
  assert.equal(fs.existsSync(file), false, '文件要被真删掉');
  assert.equal((await request('/api/stickers/delete', { emotion: 'other', name })).status, 404, '重复删要 404');
  const folder = await request('/api/stickers/open-folder', {});
  assert.equal(folder.status, 200);
  assert.ok(folder.body.dir.endsWith('stickers'));
});

test('桥接：mock-only Python安全行为测试', (t) => {
  const py = process.env.WHALE_TEST_PYTHON || (process.platform === 'win32'
    ? path.join(__dirname, '..', 'runtime', 'python', 'python.exe') : 'python3');
  if (process.platform === 'win32' && !fs.existsSync(py) && !process.env.WHALE_TEST_PYTHON) {
    t.skip('未提供便携Python；可设 WHALE_TEST_PYTHON 运行纯mock桥接测试'); return;
  }
  const result = spawnSync(py, ['-B', path.join(__dirname, 'test_sticker_transport.py')], { stdio: 'inherit' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
});
