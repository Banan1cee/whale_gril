'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MomentsService } = require('../src/services/moments');
const register = require('../src/http/routes/moments');

test('朋友圈互动：完整定位、单次领取、仅报告未确认', () => {
  const s = new MomentsService();
  assert.throws(() => s.action({ action: 'comment', publisher: 'Peer', keyword: 'spring' }));
  const j = s.action({ action: 'like', publisher: 'Peer', keyword: 'spring' });
  assert.equal(s.claim('test-account').action, 'like');
  assert.equal(s.claim('test-account'), null);
  assert.equal(s.complete({ id: j.id, account: 'test-account', performed: true }).status, 'unconfirmed');
  assert.throws(() => s.action({ action: 'publish' }));
});

test('朋友圈：手动请求才产生任务；只领取一次且账号绑定', () => {
  const s = new MomentsService();
  assert.equal(s.claim('test-account'), null);
  const j = s.request({ keyword: '春天', own: true });
  assert.equal(j.status, 'queued');
  assert.equal(s.claim(''), null);
  assert.deepEqual(s.claim('test-account').query, { limit: 20, keyword: '春天', username: '', own: true });
  assert.equal(s.claim('test-account'), null);
  assert.throws(() => s.complete({ id: j.id, account: 'other', items: [] }), { statusCode: 409 });
  assert.equal(s.result(j.id).status, 'reading');
});

test('朋友圈：结果限量/白名单，路径/定位/评论不传回客户端', () => {
  const s = new MomentsService();
  const j = s.request({ limit: 1 });
  s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', items: [
    { text: '测试', id: '1', location: 'private', path: 'secret', comments: ['secret'], images: ['secret'] },
    { text: '不返回' },
  ] });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].text, '测试');
  assert.ok(!JSON.stringify(r).includes('secret'));
  assert.throws(() => s.complete({ id: j.id, account: 'test-account', items: [] }), { statusCode: 409 });
});

test('朋友圈：超时/过期结果不能污染新任务', () => {
  let now = 1000;
  const s = new MomentsService({ now: () => now });
  const a = s.request(); s.claim('test-account');
  assert.throws(() => s.request(), { statusCode: 409 });
  now += 91000;
  assert.equal(s.result(a.id).status, 'failed');
  const b = s.request();
  assert.throws(() => s.complete({ id: a.id, account: 'test-account', items: [] }), { statusCode: 404 });
  now += 301000;
  assert.throws(() => s.result(b.id), { statusCode: 404 });
  assert.equal(s.job, null);
});

test('朋友圈：限制扫描范围，错误不泄露内部异常', () => {
  const s = new MomentsService();
  for (const limit of [0, -1, 51, 1.5, 'abc']) assert.throws(() => s.request({ limit }), { statusCode: 400 });
  assert.throws(() => s.request(null), { statusCode: 400 });
  const j = s.request(); s.claim('test-account');
  const r = s.complete({ id: j.id, account: 'test-account', error: 'secret path' });
  assert.equal(r.status, 'failed');
  assert.ok(!r.error.includes('secret'));
});

test('朋友圈：所有接口限制本机，桥接写入必须验证 token', async () => {
  const routes = {};
  register({ get: (p, f) => { routes[p] = f; }, post: (p, f) => { routes[p] = f; } });
  const runtime = { moments: new MomentsService(), gateways: new Map([['wechat', { verifyToken: () => false }]]) };
  const remote = { socket: { remoteAddress: '192.0.2.1' } };
  for (const route of Object.values(routes)) {
    await assert.rejects(async () => route(runtime, remote), { statusCode: 403 });
  }
  for (const p of ['/api/moments/claim', '/api/moments/complete']) {
    await assert.rejects(async () => routes[p](runtime, { socket: { remoteAddress: '127.0.0.1' } }), { statusCode: 403 });
  }
});

test('朋友圈 HTTP 全链路：请求、鉴权领取、回传与读取', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { startServer } = require('../server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'moments-test-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    watchConfig: false, server: { openBrowser: false },
    gateway: { wechat: { enabled: true, inboundToken: 'test-moments-token' } },
  }));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  const post = (route, body, token = '') => fetch(app.url + route, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bot-token': token }, body: JSON.stringify(body),
  });
  try {
    const job = await (await post('/api/moments/read', { limit: 2 })).json();
    assert.equal(job.status, 'queued');
    assert.equal((await post('/api/moments/claim', { account: 'test-account' })).status, 403);
    const claimed = await (await post('/api/moments/claim', { account: 'test-account' }, 'test-moments-token')).json();
    assert.equal(claimed.job.id, job.id);
    const completed = await post('/api/moments/complete', { id: job.id, account: 'test-account', items: [{ text: '测试动态' }] }, 'test-moments-token');
    assert.equal(completed.status, 200);
    const result = await (await fetch(app.url + '/api/moments/result?id=' + job.id)).json();
    assert.equal(result.status, 'done');
    assert.equal(result.items[0].text, '测试动态');
    assert.equal((await fetch(app.url + '/healthz')).status, 200);
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
