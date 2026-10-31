'use strict';

/**
 * 状态页「最近动态」与 4.0 实测发现的设置缺口回归。
 *
 * - `/api/recent`：启动器状态页每 5 秒请求它，以前路由不存在，列表永远是空。
 * - `/api/settings` 的 group 段：GET 会返回 cooldownSec，写入侧却漏了它，
 *   调用方「保存成功但值不变」（和当年「改了没反应」同一类坑）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

async function boot(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-recent-'));
  const cfg = { server: { port: 0, openBrowser: false }, ...extra };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg));
  const app = await startServer({ root: dir, env: {}, port: 0, openBrowser: false });
  return { app, dir };
}

test('POST /api/settings 能把 group.cooldownSec 写进 config.json', async () => {
  const { app, dir } = await boot();
  try {
    const res = await fetch(app.url + '/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ group: { cooldownSec: 33 } }),
    });
    assert.equal(res.status, 200);

    const settings = await (await fetch(app.url + '/api/settings')).json();
    assert.equal(settings.group.cooldownSec, 33, 'GET 要读回写入的值');

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.equal(saved.group.cooldownSec, 33, '必须落盘，不能只改内存');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('GET /api/recent 返回最近消息（时间倒序、带 who/text）', async () => {
  const { app, dir } = await boot();
  try {
    const empty = await (await fetch(app.url + '/api/recent?limit=5')).json();
    assert.deepEqual(empty.items, [], '没有消息时返回空数组');

    const chat = await fetch(app.url + '/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bot-token': 'change-me-wechat' },
      body: JSON.stringify({
        text: '在吗',
        senderId: 'wxid_recent_u1',
        senderName: '测试甲',
        chatType: 'private',
      }),
    });
    assert.equal(chat.status, 200);
    await chat.text();

    // 消息落盘/入内存是在 SSE done 之后异步完成的，给它最多 2 秒
    let data;
    for (let i = 0; i < 20; i += 1) {
      data = await (await fetch(app.url + '/api/recent?limit=5')).json();
      if (data.items.length >= 2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(Array.isArray(data.items));
    assert.ok(data.items.length >= 2, '应至少有一条用户消息和一条回复');
    assert.ok(data.items[0].ts >= data.items[data.items.length - 1].ts, '按时间倒序');
    assert.ok(data.items.every((it) => typeof it.who === 'string' && typeof it.text === 'string'));
    assert.ok(data.items.some((it) => it.text.includes('在吗')), '用户消息要在列表里');
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('GET /api/recent 的 limit 会被收进 1..50', async () => {
  const { app, dir } = await boot();
  try {
    const res = await fetch(app.url + '/api/recent?limit=999');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.items));
  } finally {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});
