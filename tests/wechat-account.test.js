'use strict';

/**
 * 微信多账号（双开）相关：
 *   - 网页「设置 → 微信账号」靠 /api/wechat/accounts 列出本机账号
 *   - 选账号 = 把 config.json 的 wechat.account 改成目标账号目录
 *   - 桥接心跳要上报「现在用的是哪个号」
 *   - 桥接 / uia_compat 里必须有关键的「钉账号」代码（静态守住，别被后来的人改丢）
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

/** 造一棵假的 xwechat_files：两个账号目录，各带一个 db_storage/xxx.db */
function makeFakeWechatDir(mtimes = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-wx-'));
  const accounts = ['wxid_aaaa1111_cedb', 'wxid_bbbb2222_a51e'];
  accounts.forEach((name, i) => {
    const storage = path.join(root, name, 'db_storage', 'message');
    fs.mkdirSync(storage, { recursive: true });
    const dbFile = path.join(storage, 'message_0.db');
    fs.writeFileSync(dbFile, 'not-a-real-db');
    const t = mtimes[i] ? new Date(mtimes[i]) : new Date();
    fs.utimesSync(dbFile, t, t);
  });
  return { root, accounts };
}

async function boot(configPatch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-srv-'));
  const cfg = { server: { port: 0, openBrowser: false }, ...configPatch };
  cfg.persona = { ...(cfg.persona || {}), master: { names: ['Master'], wxids: ['wxid_test_master'] } };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg, null, 2));
  const instance = await startServer({ root, env: {}, port: 0, openBrowser: false });
  instance.runtime.bot.mockChunkDelayMs = 0;
  return instance;
}

test('列账号：扫 dbDir 下的账号目录，按最近活跃排序，wxid 去掉 4 位哈希', async () => {
  const fake = makeFakeWechatDir([Date.now() - 3600_000, Date.now()]);
  const app = await boot({ wechat: { dbDir: fake.root, account: '' } });
  try {
    const res = await fetch(app.url + '/api/wechat/accounts');
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.dbDir, fake.root);
    assert.equal(data.accounts.length, 2);
    // 最新的排前面
    assert.equal(data.accounts[0].account, 'wxid_bbbb2222_a51e');
    assert.equal(data.accounts[0].wxid, 'wxid_bbbb2222');
    assert.equal(data.accounts[1].account, 'wxid_aaaa1111_cedb');
    assert.equal(data.current, '');
  } finally {
    await app.close();
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('选账号：写进 config.json 的 wechat.account，其它配置不被冲掉', async () => {
  const fake = makeFakeWechatDir();
  const app = await boot({ wechat: { dbDir: fake.root, account: '' }, log: { level: 'error' } });
  try {
    const res = await fetch(app.url + '/api/wechat/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'wxid_aaaa1111_cedb' }),
    });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.wanted, 'wxid_aaaa1111_cedb');
    assert.equal(data.current, 'wxid_aaaa1111_cedb');
    assert.equal(data.needBridgeRestart, true);

    const file = path.join(app.runtime.config.root, 'config.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.wechat.account, 'wxid_aaaa1111_cedb');
    // 同文件里的其它键还在（没被只写一个字段的补丁冲掉）
    assert.ok(raw.server, 'server 段要还在');
    assert.ok(raw.persona && raw.persona.master, 'persona.master 要还在');
  } finally {
    await app.close();
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('选账号：填一个本机没有的号要 400，并且不改配置', async () => {
  const fake = makeFakeWechatDir();
  const app = await boot({ wechat: { dbDir: fake.root, account: '' } });
  try {
    const res = await fetch(app.url + '/api/wechat/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: 'wxid_nope' }),
    });
    assert.equal(res.status, 400);
    const raw = JSON.parse(fs.readFileSync(path.join(app.runtime.config.root, 'config.json'), 'utf8'));
    assert.equal(raw.wechat.account || '', '');
  } finally {
    await app.close();
    fs.rmSync(fake.root, { recursive: true, force: true });
  }
});

test('心跳带上账号 → /api/status 里能读到「桥接当前在用哪个号」', async () => {
  const app = await boot();
  try {
    const token = app.runtime.config.gateway.wechat.inboundToken;
    const hb = await fetch(app.url + '/api/bridge/heartbeat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bot-token': token },
      body: JSON.stringify({
        platform: 'wechat',
        uia: true,
        listener: true,
        account: 'wxid_aaaa1111_cedb',
        account_wxid: 'wxid_aaaa1111',
        account_nick: '川水往事',
        account_ok: true,
        account_why: '命中最近会话 8 条',
      }),
    });
    assert.equal(hb.status, 200);
    const status = await (await fetch(app.url + '/api/status')).json();
    const gw = status.gateways.find((g) => g.platform === 'wechat');
    assert.equal(gw.bridge.account, 'wxid_aaaa1111_cedb');
    assert.equal(gw.bridge.accountNick, '川水往事');
    assert.equal(gw.bridge.accountOk, true);
  } finally {
    await app.close();
  }
});

test('桥接源码里必须留着「钉账号」的关键代码（别被后来的改动弄丢）', () => {
  const bridge = fs.readFileSync(path.join(__dirname, '..', 'examples', 'wechatauto_bridge.py'), 'utf8');
  assert.match(bridge, /--list-accounts/, '要有给网页列账号的一次性模式');
  assert.match(bridge, /def resolve_account_dir/, '要能把目录名/wxid/昵称解析成账号目录');
  assert.match(bridge, /db\.account != acct/, '建库后要断言没被库偷偷换号');
  assert.match(bridge, /def ensure_account_window/, '发送前要确认窗口还活着');
  assert.match(bridge, /def account_send_allowed/, '要有统一的发送闸');
  assert.match(bridge, /account_send_allowed\("UIA"\)/, 'UIA 发送要走账号闸');
  assert.match(bridge, /account_send_allowed\("键盘通道"\)/, '键盘兜底也要走账号闸');
  assert.match(bridge, /os\._exit\(7\)/, '账号设置变了要 exit 7 让 bridge_loop 拉起新进程');
  assert.match(bridge, /"account": db\.account/, '心跳要上报当前账号');

  const compat = fs.readFileSync(path.join(__dirname, '..', 'examples', 'uia_compat.py'), 'utf8');
  assert.match(compat, /def pin_window/, 'uia_compat 要能把引擎钉在指定窗口');
  assert.match(compat, /def pinned_window/, '要能查当前钉住哪个窗口');
  assert.match(compat, /_pinned_hwnd/, '_find_main 要先认钉住的窗口');
  assert.match(compat, /def _session_rows_of/, '要能只读某个窗口的会话行（认账号用）');
});
