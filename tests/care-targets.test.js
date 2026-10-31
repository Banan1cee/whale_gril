'use strict';

/**
 * 主动搭话的目标判定（白名单 + 三个开关 + 时间段 + 忙碌）。
 * 现场问题：三个选项和时间段「改了没反应」，根因是桥接侧自己又判一遍，
 * 而且 master.wxids 为空会把所有目标筛掉。现在判定只在服务端做一次。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/infra/config');
const { ContactsCache, normalizeItem } = require('../src/services/contacts');
const care = require('../src/services/care');

function fixture(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-care-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0, openBrowser: false } }));
  const config = loadConfig({ root: dir, env: {} });
  config.persona.master = { names: ['测试主人'], wxids: ['wxid_master'] };
  config.care = { ...config.care, enabled: true, windows: ['00:00-23:59'], everyMinutes: 1, jitterMinutes: 0, maxPerDay: 0, ...patch };
  const contacts = new ContactsCache(config);
  contacts.sync({
    account: 'wxid_master',
    items: [
      { wxid: 'wxid_master', name: '测试主人' },
      { wxid: 'filehelper', name: '文件传输助手' },
      { wxid: 'wxid_other', name: '路人' },
      { wxid: '1@chatroom', name: '深海鱼塘', isGroup: true },
    ],
  });
  return { dir, config, contacts };
}

const decide = (config, contacts, opts = {}) => care.careDecide(config, {
  contacts, lastSentTs: 0, sentToday: 0, now: Date.now(), ...opts,
});

test('白名单默认为「主人 + 文件传输助手」，不需要手填', () => {
  const config = { persona: { master: { wxids: ['wxid_master'], names: [] } }, care: {} };
  assert.deepEqual(care.defaultWhitelist(config), ['wxid_master', 'filehelper']);
  assert.deepEqual(care.careWhitelist(config), ['wxid_master', 'filehelper']);
});

test('wxids 为空时按昵称认主人，不再一个目标都发不出去', (t) => {
  const { config, contacts } = fixture(t);
  config.persona.master = { names: ['测试主人'], wxids: [] };
  const out = decide(config, contacts);
  assert.equal(out.due, true);
  assert.equal(out.target.wxid, 'wxid_master');
  assert.equal(out.target.kind, 'master');
});

test('默认只找主人：白名单里的非主人私聊不会成为目标', (t) => {
  const { config, contacts } = fixture(t, { whitelist: ['wxid_other', 'filehelper'] });
  const out = decide(config, contacts);
  assert.equal(out.due, true);
  assert.equal(out.target.wxid, 'filehelper', '主人不在名单里，剩下的是文件传输助手');
});

test('允许主动找别人后，白名单里的非主人私聊才可用', (t) => {
  const { config, contacts } = fixture(t, { whitelist: ['wxid_other'], allowOthers: true });
  const out = decide(config, contacts);
  assert.equal(out.target.wxid, 'wxid_other');
  assert.equal(out.target.kind, 'other');
});

test('群默认不主动，开了「允许进群」才可用', (t) => {
  const base = fixture(t, { whitelist: ['1@chatroom'] });
  assert.equal(decide(base.config, base.contacts).reason, 'whitelist_filtered');
  const withGroups = fixture(t, { whitelist: ['1@chatroom'], allowGroups: true });
  const out = decide(withGroups.config, withGroups.contacts);
  assert.equal(out.target.wxid, '1@chatroom');
  assert.equal(out.target.isGroup, true);
});

test('时间段外不发（并给出 out_of_window）', (t) => {
  const { config, contacts } = fixture(t, { windows: ['03:00-04:00'] });
  const out = decide(config, contacts);
  assert.equal(out.due, false);
  assert.equal(out.reason, 'out_of_window');
});

test('白名单里的人都在聊 → all_busy，不打扰', (t) => {
  const { config, contacts } = fixture(t);
  const out = decide(config, contacts, { activeWxids: ['wxid_master', 'filehelper'] });
  assert.equal(out.due, false);
  assert.equal(out.reason, 'all_busy');
});

test('被三个开关全筛掉时，reason 是 whitelist_filtered（不再静默）', (t) => {
  const { config, contacts } = fixture(t, { whitelist: ['wxid_other', '1@chatroom'] });
  const out = decide(config, contacts);
  assert.equal(out.due, false);
  assert.equal(out.reason, 'whitelist_filtered');
});

test('总开关关掉就不发', (t) => {
  const { config, contacts } = fixture(t, { enabled: false });
  assert.equal(decide(config, contacts).reason, 'disabled');
});

/* ---------------- 联系人缓存 ---------------- */

test('联系人缓存能存能查，群按 wxid 后缀识别', (t) => {
  const { config, contacts } = fixture(t);
  assert.equal(contacts.get('wxid_master').name, '测试主人');
  assert.equal(contacts.search('测试')[0].wxid, 'wxid_master');
  assert.equal(contacts.search('', { type: 'group' }).length, 1);
  assert.equal(contacts.search('', { type: 'user' }).length, 3);
  assert.equal(contacts.payload({ q: '鱼塘' }).items[0].wxid, '1@chatroom');
});

test('联系人缓存落盘后能重新读出来（原子写）', (t) => {
  const { config, contacts } = fixture(t);
  const again = new ContactsCache(config);
  assert.equal(again.items.length, contacts.items.length);
  assert.equal(again.account, 'wxid_master');
});

test('未同步时返回空列表而不是报错', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-contacts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ server: { port: 0 } }));
  const config = loadConfig({ root: dir, env: {} });
  const cache = new ContactsCache(config);
  const payload = cache.payload({ q: '' });
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.items, []);
  assert.equal(payload.updatedAt, 0);
});

test('联系人字段会做规范化，缺 wxid 的直接丢', () => {
  assert.equal(normalizeItem({ name: '没有 id' }), null);
  const item = normalizeItem({ username: '2@chatroom', nick_name: '群', remark: '' });
  assert.equal(item.isGroup, true);
  assert.equal(item.label, '群');
});
