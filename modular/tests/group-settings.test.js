'use strict';

/**
 * 群聊三件套（必须@她才回 / 允许插话 / 插话概率）的保存与生效回归。
 *
 * 现场问题：设置页改完，重启又变回去；而且「概率」怎么调都没用。
 * 根因有两个：①人设存档 persona.json 在启动时把 config.json 的群聊/长度设置盖回去；
 * ②「必须@她」关掉时代码直接 wake:true，等于把概率设置架空。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/infra/config');
const { applyConfigPatch } = require('../src/infra/configPatch');
const personaStore = require('../src/persona/store');
const { computeTrigger } = require('../src/core/trigger');

function fixture(t, { config = {}, persona = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-group-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false }, ...config }));
  if (persona) {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'persona.json'), JSON.stringify(persona));
  }
  const cfg = loadConfig({ root: dir, env: {} });
  return { dir, cfg };
}

function makeBot(cfg, rng = () => 0.5) {
  return {
    config: cfg,
    rng,
    store: { messages: () => [] },
  };
}

function groupTrigger(bot, { text = '今天好热', state = {}, nowMs = Date.now(), atMe = false } = {}) {
  return computeTrigger(bot, {
    msg: { chatId: 'g1', chatType: 'group', senderId: 'u1', senderName: '路人', text },
    atMe,
    clean: { text },
    isGroup: true,
    state,
    nowMs,
    isMaster: false,
    key: 'wechat:g:g1',
  });
}

/* ---------------- 保存：嵌套补丁不能抹掉同段其它键 ---------------- */

test('传 { group: { requireAt } } 不会清掉同一段里的 freeChat/概率/冷却', (t) => {
  const { dir, cfg } = fixture(t, { config: { group: { requireAt: true, freeChat: true, freeChatChance: 0.3, cooldownSec: 45 } } });
  const runtime = { config: cfg, logger: { info() {}, warn() {} } };
  applyConfigPatch(runtime, { group: { requireAt: false } });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.group.requireAt, false);
  assert.equal(saved.group.freeChat, true, 'freeChat 不能被整段覆盖清掉');
  assert.equal(saved.group.freeChatChance, 0.3);
  assert.equal(saved.group.cooldownSec, 45);
  assert.equal(cfg.group.freeChatChance, 0.3, '内存里的值也要跟着对');
});

test('真正是 JSON 的字段（outboundHeaders）不会被摊平', (t) => {
  const { dir, cfg } = fixture(t);
  const runtime = { config: cfg, logger: { info() {}, warn() {} } };
  applyConfigPatch(runtime, { 'gateway.wechat.outboundHeaders': { 'X-Test': '1' } });
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.deepEqual(saved.gateway.wechat.outboundHeaders, { 'X-Test': '1' });
});

/* ---------------- 保存：persona.json 不再盖掉 config.json ---------------- */

test('老的 persona.json 值只迁移一次，之后 config.json 说了算', (t) => {
  const { dir, cfg } = fixture(t, {
    config: { group: { requireAt: false } },
    persona: { freeChat: true, privateMaxChars: 320, name: '星野' },
  });
  personaStore.apply(cfg, personaStore.load(cfg));
  assert.equal(cfg.group.freeChat, true, '迁移：persona.json 里的旧值搬进 config.json');
  let saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.group.freeChat, true);
  assert.equal(saved.chat.privateMaxChars, 320);

  // 设置页把「主动接话」关掉
  personaStore.save(cfg, { freeChat: false });
  assert.equal(cfg.group.freeChat, false);

  // 重启：重新 load + apply，不能被 persona.json 里残留的 true 盖回去
  const again = loadConfig({ root: dir, env: {} });
  personaStore.apply(again, personaStore.load(again));
  assert.equal(again.group.freeChat, false, '重启后仍然是关的');
  saved = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(saved.group.freeChat, false);
});

test('群聊开关只落 config.json，persona.json 里不再有这些键', (t) => {
  const { dir, cfg } = fixture(t);
  personaStore.save(cfg, { freeChat: true, privateMaxChars: 200, name: '星野' });
  const savedCfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  assert.equal(savedCfg.group.freeChat, true);
  assert.equal(savedCfg.chat.privateMaxChars, 200);
  const savedPersona = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'persona.json'), 'utf8'));
  assert.equal(savedPersona.freeChat, undefined);
  assert.equal(savedPersona.privateMaxChars, undefined);
  assert.equal(savedPersona.name, '星野', '人设本身还是存 persona.json');
});

/* ---------------- 生效：概率在两种模式下都要管用 ---------------- */

test('「必须@她」关掉时，也是按概率接话，不是每条都回', (t) => {
  const { cfg } = fixture(t, { config: { group: { requireAt: false, freeChat: false, freeChatChance: 0.06 } } });
  // rng 0.5 > 0.06 → 不接
  assert.equal(groupTrigger(makeBot(cfg, () => 0.5)).wake, false);
  // rng 0.01 < 0.06 → 接
  assert.equal(groupTrigger(makeBot(cfg, () => 0.01)).wake, true);
});

test('概率 0 时未点名的消息一律不接（两种模式都一样）', (t) => {
  const off = fixture(t, { config: { group: { requireAt: false, freeChat: true, freeChatChance: 0 } } });
  assert.equal(groupTrigger(makeBot(off.cfg, () => 0)).wake, false);
  const on = fixture(t, { config: { group: { requireAt: true, freeChat: true, freeChatChance: 0 } } });
  assert.equal(groupTrigger(makeBot(on.cfg, () => 0)).wake, false);
});

test('概率 1 时两种模式下未点名都会接', (t) => {
  const off = fixture(t, { config: { group: { requireAt: false, freeChat: false, freeChatChance: 1 } } });
  assert.equal(groupTrigger(makeBot(off.cfg, () => 0.9)).wake, true);
  const free = fixture(t, { config: { group: { requireAt: true, freeChat: true, freeChatChance: 1 } } });
  assert.equal(groupTrigger(makeBot(free.cfg, () => 0.9)).wake, true);
});

test('@ 她永远回，不受概率和「必须@」影响', (t) => {
  const { cfg } = fixture(t, { config: { group: { requireAt: true, freeChat: false, freeChatChance: 0 } } });
  assert.equal(groupTrigger(makeBot(cfg, () => 0.99), { atMe: true }).wake, true);
});

test('冷却期内按概率也不接', (t) => {
  const { cfg } = fixture(t, { config: { group: { requireAt: false, freeChat: false, freeChatChance: 1, cooldownSec: 60 } } });
  const now = Date.now();
  const state = { lastReplyAt: now - 10 * 1000, replyTimes: [] };
  assert.equal(groupTrigger(makeBot(cfg, () => 0), { state, nowMs: now }).wake, false);
});

test('「允许插话」关掉时，@ 之外的消息在「必须@」模式下不接', (t) => {
  const { cfg } = fixture(t, { config: { group: { requireAt: true, freeChat: false, freeChatChance: 1 } } });
  assert.equal(groupTrigger(makeBot(cfg, () => 0.1)).wake, false);
});
