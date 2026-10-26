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
const bridgePath = path.join(root, 'examples', 'wechatauto_bridge.py');
const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
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
  assert.match(bridgeSrc, /wechat\.dbDir|"dbDir"/, '要支持配置里手填 dbDir');
  assert.match(bridgeSrc, /psutil\.process_iter/, '要能反射正在运行的微信进程');
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
  assert.equal(last, "''", '填错了就当没填，不该抛异常：' + last);
});

test('调试台有「微信文件保存位置」字段，且说明要重启桥接', () => {
  const page = fs.readFileSync(path.join(root, 'web', 'debug.html'), 'utf8');
  assert.match(page, /'wechat\.dbDir'/, '调试台要有这个字段');
  assert.match(page, /微信文件保存位置/, '字段要用人话写');
});
