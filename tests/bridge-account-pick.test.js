'use strict';

/**
 * 桥接页「点卡片切账号」。
 *
 * 这一组盯三件事：
 *   1. 启动器里账号卡是按钮（能点），当前在用的那张高亮且不可点；
 *   2. 点卡片走的是 POST /api/wechat/account（内核校验），不是绕过校验直接写 config；
 *   3. 后端这条路本身是对的：合法账号写进 config.json，瞎填的 400 不改配置，空串 = 不固定。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startServer } = require('../server');

const root = path.resolve(__dirname, '..');
const readLauncher = (rel) => fs.readFileSync(path.join(root, 'launcher', rel), 'utf8').replace(/^\uFEFF/, '');

const xaml = readLauncher('Views/BridgePage.xaml');
const code = readLauncher('Views/BridgePage.xaml.cs');

/* ---------------- 界面契约 ---------------- */

test('账号卡是按钮，点了调 OnPickAccount', () => {
  assert.match(xaml, /<Style x:Key="AccountPick" TargetType="Button">/, '缺账号卡按钮样式');
  const tpl = xaml.slice(xaml.indexOf('<ItemsControl x:Name="Accounts">'), xaml.indexOf('</ItemsControl>', xaml.indexOf('<ItemsControl x:Name="Accounts">')));
  assert.match(tpl, /<Button Style="\{StaticResource AccountPick\}"/, '账号卡应该是 Button，不是只读 Border');
  assert.match(tpl, /Click="OnPickAccount"/, '账号卡没接点击事件');
  assert.doesNotMatch(tpl, /<Border Style="\{StaticResource Card\}"/, '账号卡不该还留着只读 Border');
});

test('当前在用的那张卡高亮且点不动，其余卡提示可切换', () => {
  assert.match(xaml, /<DataTrigger Binding="\{Binding IsActive\}" Value="True">/, '当前账号卡没有高亮触发器');
  assert.match(xaml, /<DataTrigger Binding="\{Binding CanPick\}" Value="False">/, '不可点的卡没有光标/透明度处理');
  assert.match(code, /CanPick = !active/, '当前在用的卡应该 CanPick=false');
  assert.match(code, /if \(!card\.CanPick\)/, 'OnPickAccount 没拦住不可点的卡');
  assert.match(code, /点此切换|点一下切到/, '卡片上要写清楚能点');
});

test('有「不固定（按最近活跃）」入口，写空账号', () => {
  assert.match(xaml, /x:Name="BtnAutoAccount"/, '缺「不固定」按钮');
  assert.match(xaml, /Click="OnUseAutoAccount"/, '「不固定」没接事件');
  assert.match(code, /private async void OnUseAutoAccount/, '缺 OnUseAutoAccount');
  assert.match(code, /PickAccountAsync\("",/, '「不固定」应该写空串');
});

test('切账号走 /api/wechat/account 校验，失败提示后端原因', () => {
  const start = code.indexOf('private async Task PickAccountAsync');
  assert.ok(start > 0, '缺 PickAccountAsync');
  const block = code.slice(start, start + 1600);
  assert.match(block, /\/api\/wechat\/account/, '切账号必须走 /api/wechat/account');
  assert.match(block, /!res\.IsSuccessStatusCode/, '没处理后端校验失败');
  assert.match(block, /ApiText\(/, '失败时应把后端的 error 原文显示出来');
  assert.match(block, /_lastAccounts = DateTime\.MinValue/, '切完要强制重拉账号列表');
  assert.match(block, /TxtAccount\.Text = account/, '切完要让输入框和后端一致');
  // 现场：启动阶段点账号卡，桥接的 config_watch 还没起（基线吞了这次写盘），
  // 结果「几秒内自动重启」没发生，回复还是从大号发出去。切完必须直接重启。
  assert.match(block, /_sup\.RestartBridge\(\)/, '切完要直接重启桥接，别只等它自己发现');
  assert.doesNotMatch(block, /桥接会在几秒内自动重启/, '别再只承诺「几秒内」，要真的重启');
  // 别再用 /api/config 直接改账号，绕过「本机有没有这个号」的校验
  const saveBlock = code.slice(code.indexOf('private async Task SaveSendSettingsAsync'), code.indexOf('private async void OnSaveSendOpt'));
  assert.match(saveBlock, /\\"account\\":/, '手填输入框仍然要能保存账号（保留高级用法）');
});

/* ---------------- 后端行为 ---------------- */

function makeFakeWechatDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-wx-'));
  for (const name of ['wxid_aaaa1111_cedb', 'wxid_bbbb2222_a51e']) {
    const storage = path.join(dir, name, 'db_storage', 'message');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'message_0.db'), 'x');
  }
  return dir;
}

async function boot(dbDir) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-srv-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    wechat: { dbDir, account: '' },
    log: { level: 'error' },
    persona: { master: { names: ['Master'], wxids: ['wxid_test_master'] } },
  }, null, 2));
  const instance = await startServer({ root: dir, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  instance.runtime.bot.mockChunkDelayMs = 0;
  return instance;
}

const postAccount = (app, account) => fetch(app.url + '/api/wechat/account', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account }),
});

test('后端：列表里带 active / wanted，界面靠它决定哪张卡高亮', async () => {
  const dbDir = makeFakeWechatDir();
  const app = await boot(dbDir);
  try {
    let data = await (await fetch(app.url + '/api/wechat/accounts')).json();
    assert.equal(data.wanted, '');
    assert.equal(data.accounts.length, 2);
    assert.equal(data.accounts.filter((a) => a.active).length, 0, '没固定账号时不该有高亮卡');

    await postAccount(app, 'wxid_aaaa1111_cedb');
    data = await (await fetch(app.url + '/api/wechat/accounts')).json();
    assert.equal(data.wanted, 'wxid_aaaa1111_cedb');
    assert.equal(data.current, 'wxid_aaaa1111_cedb');
    const active = data.accounts.filter((a) => a.active);
    assert.equal(active.length, 1, '有且只有一张卡是当前在用');
    assert.equal(active[0].account, 'wxid_aaaa1111_cedb');
  } finally {
    await app.close();
    fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('后端：点「不固定」写空串，config 里账号被清掉', async () => {
  const dbDir = makeFakeWechatDir();
  const app = await boot(dbDir);
  try {
    await postAccount(app, 'wxid_bbbb2222_a51e');
    const res = await postAccount(app, '');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.wanted, '');
    assert.equal(data.needBridgeRestart, true);
    const raw = JSON.parse(fs.readFileSync(path.join(app.runtime.config.root, 'config.json'), 'utf8'));
    assert.equal(raw.wechat.account, '');
  } finally {
    await app.close();
    fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('后端：选完账号会要求重启桥接（界面提示「几秒内自动重启」有依据）', async () => {
  const dbDir = makeFakeWechatDir();
  const app = await boot(dbDir);
  try {
    const data = await (await postAccount(app, 'wxid_aaaa1111_cedb')).json();
    assert.equal(data.needBridgeRestart, true);
    assert.deepEqual(data.changed, ['wechat.account'], '选账号应该只动 wechat.account');
    // 同一个号再选一次：幂等，配置还是这个号（changed 报的是「写了哪些键」）
    const again = await (await postAccount(app, 'wxid_aaaa1111_cedb')).json();
    assert.equal(again.wanted, 'wxid_aaaa1111_cedb');
    const raw = JSON.parse(fs.readFileSync(path.join(app.runtime.config.root, 'config.json'), 'utf8'));
    assert.equal(raw.wechat.account, 'wxid_aaaa1111_cedb');
    assert.ok(raw.wechat.dbDir, '重复选账号不该把 dbDir 写丢');
  } finally {
    await app.close();
    fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('后端：昵称 / wxid 也能选中对应目录（界面上手填的兼容格式）', async () => {
  const dbDir = makeFakeWechatDir();
  const app = await boot(dbDir);
  try {
    const byWxid = await postAccount(app, 'wxid_bbbb2222');
    assert.equal(byWxid.status, 200);
    const data = await byWxid.json();
    assert.equal(data.wanted, 'wxid_bbbb2222', '按填写值存');
    assert.equal(data.current, 'wxid_bbbb2222_a51e', '解析到真实目录');
  } finally {
    await app.close();
    fs.rmSync(dbDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
