'use strict';

/**
 * 旧记忆自动导入 / 一键转换的 HTTP 接口。
 *
 * 场景：用户升级到 4.0 时直接把旧 data 目录合并进来，不会去敲命令。
 *  - 启动：Store 构造时自动迁移，并留一份待确认报告（launcher 弹窗后 ack）
 *  - 运行中：又拖进来一份旧 store.json → 设置页按钮调 POST /api/memory/import
 *  - 幂等：签名已记录 / 消息已存在时第二次调用什么都不做
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

function legacyStore() {
  return {
    version: 1,
    sessions: {
      'wechat:u:wxid_api1': {
        platform: 'wechat', chatId: 'wxid_api1', chatType: 'private', title: '接口测试',
        createdAt: 1, lastActiveAt: 2,
        messages: [
          { role: 'user', name: '小接口', uid: 'u-api1', text: '我住在杭州', ts: 1 },
          { role: 'assistant', name: '鲸鲸', text: '记住啦', ts: 2 },
        ],
        profiles: { 'u-api1': { uid: 'u-api1', name: '小接口', notes: ['住在杭州'] } },
      },
      'wechat:g:api_group@chatroom': {
        platform: 'wechat', chatId: 'api_group@chatroom', chatType: 'group', title: '接口群',
        messages: [{ role: 'user', name: '阿丙', uid: 'u-api2', text: '大家好', ts: 3 }],
        profiles: {},
      },
    },
  };
}

async function boot(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-import-'));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  if (extra.store) fs.writeFileSync(path.join(root, 'data', 'store.json'), JSON.stringify(extra.store), 'utf8');
  const cfg = {
    server: { port: 0, openBrowser: false },
    persona: { master: { names: ['Master'], wxids: ['wxid_test_master'] } },
    admin: { minutes: 30, spell: 'test-spell' },
    gateway: { wechat: { inboundToken: 'test-token' } },
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
  const instance = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  return { ...instance, root };
}

async function getJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

async function postJson(url, payload = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

test('启动时自动迁移旧 store.json，并留下待确认报告', async () => {
  const app = await boot({ store: legacyStore() });
  try {
    const status = await getJson(app.url + '/api/memory/import/status');
    assert.equal(status.ok, true);
    assert.equal(status.pending, false, '启动时已经迁完，不该还挂着待转换');

    const notice = await getJson(app.url + '/api/memory/import/notice');
    assert.equal(notice.ok, true);
    assert.equal(notice.notice.imported, 2);
    assert.equal(notice.notice.messages, 3);
    assert.equal(notice.notice.acked, false);

    const ack = await postJson(app.url + '/api/memory/import/ack');
    assert.equal(ack.body.ok, true);
    const after = await getJson(app.url + '/api/memory/import/notice');
    assert.equal(after.notice, null, 'ack 之后启动器不该再弹');

    const idle = await postJson(app.url + '/api/memory/import');
    assert.equal(idle.body.idle, true);
  } finally {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  }
});

test('运行中拖进旧 store.json：一键转换能合并，第二次调用是空操作', async () => {
  const app = await boot();
  try {
    // 运行中才出现旧文件（模拟用户直接把旧 data 合并进来）
    fs.writeFileSync(path.join(app.root, 'data', 'store.json'), JSON.stringify(legacyStore()), 'utf8');

    const preview = await getJson(app.url + '/api/memory/import/status');
    assert.equal(preview.pending, true);
    assert.equal(preview.plan.messages, 3);
    assert.equal(preview.plan.imported, 2);
    assert.equal(app.runtime.store.chatStore.chats.size, 0, 'dry-run 不能建 chat');

    const first = await postJson(app.url + '/api/memory/import');
    assert.equal(first.body.ok, true);
    assert.equal(first.body.imported, 2);
    assert.equal(first.body.messages, 3);
    assert.equal(app.runtime.store.sessions.size, 2, '转换后 sessions 视图要能看到新 chat');

    const second = await postJson(app.url + '/api/memory/import');
    assert.equal(second.body.idle, true, '第二次必须什么都不做');
    assert.equal(app.runtime.store.sessions.size, 2);
  } finally {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  }
});

test('同名 chat 已存在时：一键转换按时间合并，不重复', async () => {
  const app = await boot();
  try {
    const storeFile = path.join(app.root, 'data', 'store.json');
    fs.writeFileSync(storeFile, JSON.stringify(legacyStore()), 'utf8');
    await postJson(app.url + '/api/memory/import');

    // 旧文件补一条新消息，再转一次：只补 1 条
    const legacy = legacyStore();
    legacy.sessions['wechat:u:wxid_api1'].messages.push(
      { role: 'user', name: '小接口', uid: 'u-api1', text: '后来又说一句', ts: 4 }
    );
    fs.writeFileSync(storeFile, JSON.stringify(legacy), 'utf8');

    const res = await postJson(app.url + '/api/memory/import');
    assert.equal(res.body.ok, true);
    assert.equal(res.body.merged, 1);
    assert.equal(res.body.messages, 1);
    const texts = app.runtime.store.messages('wechat:u:wxid_api1', 50).map((m) => m.text);
    assert.equal(texts.length, 3);
    assert.equal(texts[2], '后来又说一句');
  } finally {
    await app.close();
    fs.rmSync(app.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 });
  }
});
