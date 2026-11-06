'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { startServer } = require('../server');
const persona = require('../src/persona');

async function boot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-live-name-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    env: { autoDetect: false }, features: { memorySnapshot: false },
  }));
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0 });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); });
  return { ...app, root };
}

async function post(app, route, body) {
  const response = await fetch(app.url + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  assert.equal(response.status, 200, result.error);
  assert.equal(result.ok, true, result.error);
  return result;
}

test('完整人设页保存顺序不会把新名字覆盖；热重载与重启均保留，不清空历史', async (t) => {
  const app = await boot(t);
  const configRef = app.runtime.config;
  app.runtime.store.ensureSession('wechat:g:test_name_group', { platform: 'wechat', chatType: 'group' });
  app.runtime.store.appendMessage('wechat:g:test_name_group', { role: 'assistant', text: '我是鲸鲸，主人你好' });
  await post(app, '/api/persona', { name: '小鱼' });
  const owner = await post(app, '/api/settings', { userName: '老大' });
  assert.equal(owner.settings.userName, '老大');
  await post(app, '/api/config', { patch: { 'persona.aliases': ['小鱼'], 'chat.emojiChance': 0.1 } });
  assert.equal(app.runtime.config.persona.name, '小鱼');
  assert.equal(app.runtime.config.persona.ownerName, '老大');
  await delay(450);
  assert.equal(app.runtime.config, configRef, '聊天模块持有的配置引用不变');
  assert.equal(app.runtime.bot.config.persona.name, '小鱼');
  assert.equal(app.runtime.config.persona.ownerName, '老大');
  const history = app.runtime.store.messages('wechat:g:test_name_group');
  assert.equal(history.length, 1);
  assert.equal(history[0].text, '我是鲸鲸，主人你好', '历史正文原样保留');
  const turns = app.runtime.bot.buildTurns({ chatType: 'group', chatId: 'test_name_group', text: '在吗' }, history);
  assert.match(turns[0].content, /小鱼（机器人）/);
  const restarted = await startServer({ root: app.root, env: { WHALE_LOG_FILE: '' }, port: 0 });
  t.after(() => restarted.close());
  assert.equal(restarted.runtime.config.persona.name, '小鱼');
  assert.equal(restarted.runtime.config.persona.ownerName, '老大');
});

test('自定义人设中的旧名字不盖过当前设置，主人称呼不授予陌生人身份', async (t) => {
  const app = await boot(t);
  await post(app, '/api/persona', { name: '小鱼', customPrompt: '你叫鲸鲸，称呼主人为主人。' });
  await post(app, '/api/settings', { userName: '老大' });
  const make = (isMaster) => persona.buildPromptParts({ config: app.runtime.config,
    msg: { chatType: 'private', senderName: '测试成员', isMaster, text: '你叫什么' }, profile: {}, now: new Date() });
  const master = make(true);
  assert.match(master.system, /你现在的名字是「小鱼」/);
  assert.match(master.system, /当前称呼为「老大」/);
  assert.match(master.system, /旧名字与旧称呼仅是历史，不沿用/);
  assert.match(make(false).system, /当前发言者不是主人|没有命令权/);
});
