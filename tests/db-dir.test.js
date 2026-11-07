'use strict';

/**
 * 用户截图里的报错：
 *   RuntimeError: 未找到微信数据库目录，请通过 db_dir 参数手动指定
 *   Bridge exited with code 1.
 *
 * 原因：微信 4.x 的数据目录如果在别的盘（E:\xwechat_files 这种很常见），
 * wechatauto 自带的 auto_detect 只查「文档 / 用户目录 / 注册表」，永远找不到，
 * 桥接启动即崩，用户只看到一大段 Traceback。
 *
 * 现在桥接自己找：wechat.dbDir → 正在运行的微信进程打开的文件 → 各盘根目录，
 * 并且找不到时给的是「照着点哪里」的提示，不是 traceback。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const py = path.join(root, 'runtime', 'python', 'python.exe');
const bridgePath = path.join(root, 'bridge', 'engine.py');
const bridgeSrc = require('./helpers/bridge-source');
// 目录探测已拆到 wechat_db.py；engine.py 只留同名薄封装。
const wechatDbSrc = fs.readFileSync(path.join(root, 'bridge', 'wechat_db.py'), 'utf8');
const hasPy = fs.existsSync(py);

function runPy(code) {
  return execFileSync(py, ['-c', code], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  });
}

test('桥接源码：有更狠的目录探测，且找不到时给的是提示而不是 traceback', () => {
  assert.match(bridgeSrc, /def resolve_db_dir/, '要有自己的目录探测函数');
  assert.match(bridgeSrc, /def looks_like_db_root/, '要有目录结构判断');
  assert.match(bridgeSrc + '\n' + wechatDbSrc, /wechat\.dbDir|"dbDir"/, '要支持配置里手填 dbDir');
  assert.match(wechatDbSrc, /psutil\.process_iter/, '要能反射正在运行的微信进程');
  assert.match(bridgeSrc, /微信文件默认保存位置|文件管理/, '报错要告诉用户去点哪里');
  assert.match(bridgeSrc, /except RuntimeError/, '要接住库抛的 RuntimeError');
  const m = bridgeSrc.match(/except RuntimeError as e:[\s\S]{0,900}/);
  assert.ok(m, '要有一段处理 RuntimeError 的代码');
  assert.ok(!/raise/.test(m[0]), '这段里不能再把异常抛出去（否则还是 traceback）');
  assert.match(m[0], /return 2/, '要返回非 0 退出码，但不要 traceback');
});

test('目录判断：能认出 xwechat_files/<账号>/db_storage 这种布局', { skip: !hasPy && '没有内置 python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-db-'));
  const good = path.join(dir, 'xwechat_files', 'wxid_test', 'db_storage');
  fs.mkdirSync(good, { recursive: true });
  const flat = path.join(dir, 'flat', 'wxid_test2', 'db_storage');
  fs.mkdirSync(flat, { recursive: true });

  const out = runPy([
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("br", r"${bridgePath}")`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `print(json.dumps({`,
    `  "root": m.looks_like_db_root(r"${path.join(dir, 'xwechat_files')}"),`,
    `  "flat": m.looks_like_db_root(r"${path.join(dir, 'flat')}"),`,
    `  "bad": m.looks_like_db_root(r"${path.join(dir, 'nope')}"),`,
    '}))',
  ].join('\n'));

  const r = JSON.parse(out.trim().split(/\r?\n/).pop());
  assert.equal(r.root, true, 'xwechat_files 下有账号库 → 认');
  assert.equal(r.flat, true, '账号目录直接铺开 → 也认');
  assert.equal(r.bad, false, '空目录/不存在 → 不认');
});

test('配置里填了 dbDir 就优先用它（用户手动指定必须生效）', { skip: !hasPy && '没有内置 python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-db2-'));
  const data = path.join(dir, 'my-wechat-data');
  fs.mkdirSync(path.join(data, 'wxid_abc', 'db_storage'), { recursive: true });
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ wechat: { dbDir: data } }), 'utf8');

  const out = runPy([
    'import importlib.util, json',
    `spec = importlib.util.spec_from_file_location("br", r"${bridgePath}")`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    // drives="" → 不扫盘，确保命中来自配置
    `print(m.resolve_db_dir(config_path=r"${cfg}", drives=""))`,
  ].join('\n'));

  assert.equal(out.trim().split(/\r?\n/).pop(), data, '配置里的 dbDir 要被采用');
});

test('配置里的 dbDir 是错的（用户填错路径）时不会卡死，会继续自动找', { skip: !hasPy && '没有内置 python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-db3-'));
  const cfg = path.join(dir, 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ wechat: { dbDir: path.join(dir, 'not-exist') } }), 'utf8');

  const out = runPy([
    'import importlib.util',
    `spec = importlib.util.spec_from_file_location("br", r"${bridgePath}")`,
    'm = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(m)',
    `print(repr(m.resolve_db_dir(config_path=r"${cfg}", drives="")))`,
  ].join('\n'));

  const last = out.trim().split(/\r?\n/).pop();
  const value = last.replace(/^'|'$/g, '');
  // 本机微信正在跑时，resolve_db_dir 会从进程打开的文件里扫到真实目录 —— 那是正确行为。
  // 这条用例只保证「填错的那个路径不会被当成结果」，不锁死必须是空串。
  assert.notEqual(value, path.join(dir, 'not-exist'), '填错的路径不能被当成结果');
  assert.ok(value === '' || fs.existsSync(value), '要么空串，要么是真实存在的目录：' + last);
});

test('启动器有「微信文件保存位置」字段，且说明要重启桥接', () => {
  // 调试台已删除，这个字段现在只在启动器「设置」页里；断言它的源码位置，
  // 防止有人把字段从界面里删掉、用户再也没法手动指定微信目录。
  const page = fs.readFileSync(path.join(root, 'launcher', 'Views', 'SettingsPage.xaml.cs'), 'utf8');
  assert.match(page, /"wechat\.dbDir"/, '启动器要有这个字段');
  assert.match(page, /微信文件保存位置/, '字段要用人话写');
});

/* ---------------- looks_like_db_root 与 find_account_dirs 必须同口径 ---------------- */

/**
 * 真实事故（2026-11-07 用户日志包）：
 *   dbDir = `E:\WeChat Files`，真实库在它下面一层 `xwechat_files\<wxid>\db_storage`
 *   → looks_like_db_root 说「是数据根」（所以被原样打印出来）
 *   → find_account_dirs 却是 []（所以「找不到账号（一个都没有）」）
 * 两个函数各说各话，用户按提示改账号名、改成「自动」全都救不回来。
 *
 * 这里用同一批 fixture 同时断言两边：looks 说「是」的，账号必须列得出来。
 */
test('looks 说「是」的目录，find_account_dirs 必须能列出账号（四种布局）', { skip: !hasPy && '没有内置 python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-db4-'));
  try {
    const fixtures = {
      // 用户事故现场：数据根填高了一层，真实库在里面那层 xwechat_files 下
      nested: path.join(dir, 'outer', 'WeChat Files'),
      root: path.join(dir, 'xwechat_files'),
      flat: path.join(dir, 'flat'),
      account: path.join(dir, 'xwechat_files', 'wxid_self_cedb'),
      dbstore: path.join(dir, 'xwechat_files', 'wxid_self_cedb', 'db_storage'),
    };
    fs.mkdirSync(path.join(fixtures.nested, 'xwechat_files', 'wxid_testnested_abcd', 'db_storage'), { recursive: true });
    fs.mkdirSync(path.join(fixtures.root, 'wxid_testroot_efgh', 'db_storage'), { recursive: true });
    fs.mkdirSync(path.join(fixtures.flat, 'wxid_testflat_ijkl', 'db_storage'), { recursive: true });
    fs.mkdirSync(path.join(fixtures.account, 'db_storage'), { recursive: true });
    const empty = path.join(dir, 'empty');
    fs.mkdirSync(empty, { recursive: true });

    const code = [
      'import importlib.util, json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(root, 'bridge'))})`,
      'import wechat_db as w',
      `fixtures = ${JSON.stringify(fixtures, null, 0)}`,
      'out = {}',
      'for key, p in fixtures.items():',
      '    n = w.normalize_db_root(p)',
      '    out[key] = {',
      '        "looks": w.looks_like_db_root(p),',
      '        "accounts": w.find_account_dirs(p),',
      '        "norm": n,',
      '        "norm_idem": w.normalize_db_root(n) == n,',
      '        "norm_accounts": w.find_account_dirs(n),',
      '    }',
      `out["empty"] = {"looks": w.looks_like_db_root(${JSON.stringify(empty)}), "accounts": w.find_account_dirs(${JSON.stringify(empty)})}`,
      'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n');

    const got = JSON.parse(runPy(code).trim().split(/\r?\n/).pop());
    for (const [key, v] of Object.entries(got)) {
      if (key === 'empty') {
        assert.equal(v.looks, false, '空目录不该被认成数据根');
        assert.deepEqual(v.accounts, [], '空目录当然也列不出账号');
        continue;
      }
      assert.equal(v.looks, true, `${key}：looks_like_db_root 要认`);
      assert.ok(v.accounts.length > 0, `${key}：looks 认了就必须列得出账号，实际是 []（这就是「一个都没有」）`);
      assert.ok(v.norm_idem, `${key}：normalize_db_root 要幂等（归一完再归一还是它自己）`);
      assert.ok(v.norm_accounts.length > 0, `${key}：归一后的目录同样要列得出账号`);
    }
    // 归一到「直接含 <账号>/db_storage」的那一层，wechatauto 开库才开得到
    assert.deepEqual(got.nested.norm_accounts, ['wxid_testnested_abcd'], '填高一层要下钻到 xwechat_files');
    assert.equal(got.account.norm, path.join(dir, 'xwechat_files'), '直填账号目录要退回上一层');
    assert.equal(got.dbstore.norm, path.join(dir, 'xwechat_files'), '直填 db_storage 要退回两层');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});

test('dbDir 填高一层时 resolve_db_dir 要归一到真正含账号的那层', { skip: !hasPy && '没有内置 python' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-db5-'));
  try {
    // 事故现场复刻：E:\WeChat Files\xwechat_files\<wxid>\db_storage
    const manual = path.join(dir, 'WeChat Files');
    fs.mkdirSync(path.join(manual, 'xwechat_files', 'wxid_testvictim_0001', 'db_storage'), { recursive: true });
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ wechat: { dbDir: manual } }), 'utf8');

    const out = runPy([
      'import importlib.util, json, sys',
      `sys.path.insert(0, ${JSON.stringify(path.join(root, 'bridge'))})`,
      'import wechat_db as w',
      // drives="" → 不扫盘；手填路径本来就排在最前，不会被本机微信进程干扰
      `print(json.dumps({`,
      `  "resolved": w.resolve_db_dir(config_path=${JSON.stringify(cfg)}, drives=""),`,
      `  "accounts": w.find_account_dirs(w.resolve_db_dir(config_path=${JSON.stringify(cfg)}, drives="")),`,
      '}))',
    ].join('\n'));

    const got = JSON.parse(out.trim().split(/\r?\n/).pop());
    assert.equal(got.resolved, path.join(manual, 'xwechat_files'), '要下钻到真正含账号的那一层');
    assert.deepEqual(got.accounts, ['wxid_testvictim_0001'], '列出来的账号要对得上');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
  }
});
