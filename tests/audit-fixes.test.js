'use strict';

/**
 * 三个审计出来的功能性问题（3.4.13）：
 * A. 看图接口写死 https、不传端口 → 本地 http 视觉服务连不上。
 * B. 语音配置（Key / 超时 / 时长）改完必须重启桥接才生效；Key 回退也没读 config.deepseek.apiKey。
 * C. 桥接数据库目录只认 xwechat_files/<账号>/db_storage，直填账号目录 / L: 盘 / UNC 都找不到。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const visionSrc = fs.readFileSync(path.join(ROOT, 'src', 'vision.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'examples', 'wechatauto_bridge.py'), 'utf8');
const mediaSrc = fs.readFileSync(path.join(ROOT, 'examples', 'media_fallback.py'), 'utf8');

test('看图：按 URL 协议选 http/https，并且真的把端口传下去', () => {
  assert.match(visionSrc, /const http = require\('node:http'\)/, '要能走 http');
  assert.match(visionSrc, /isHttps \? https : http/, '按协议选 transport');
  assert.match(visionSrc, /port: u\.port \|\| \(isHttps \? 443 : 80\)/, '端口必须传到 request');
  assert.doesNotMatch(visionSrc, /const req = https\.request\(/, '不能写死 https');
});

test('看图：本地 http 视觉服务真的能被打通', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '本地视觉服务收到请求' } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const { describe } = require('../src/vision');
  const text = await describe(
    { vision: { apiKey: 'test-key', baseUrl: `http://127.0.0.1:${port}`, model: 'local-vl', timeoutMs: 5000 } },
    { imageBase64: 'AAAA', mime: 'image/jpeg' }
  );
  assert.match(text, /本地视觉服务收到请求/);
  await new Promise((r) => server.close(r));
});

test('语音：Key 查找链包含 config.deepseek.apiKey，并且 reload 会刷新', () => {
  assert.match(bridgeSrc, /def _resolve_voice_key/, '要有一个统一的 Key 解析函数');
  assert.match(bridgeSrc, /_resolve_voice_key\(cfg\)/, '启动和热更新都要用它');
  assert.match(bridgeSrc, /deepseek.*apiKey|apiKey.*deepseek/s, '要回退到 deepseek.apiKey');
  assert.match(
    bridgeSrc,
    /global VOICE_ENABLED, VOICE_BASE_URL, VOICE_MODEL, VOICE_API_KEY, VOICE_TIMEOUT, VOICE_MAX_SECONDS/,
    'reload_config 必须能刷新语音这几项'
  );
  assert.match(bridgeSrc, /VOICE_TIMEOUT = float\(vo\.get\("timeoutMs"\)\) \/ 1000\.0/, '热更新要刷新超时');
  assert.match(bridgeSrc, /VOICE_MAX_SECONDS = float\(vo\.get\("maxSeconds"\)\)/, '热更新要刷新时长上限');
});

test('数据库目录：直填账号目录、拍平布局、L: 盘都能认出来', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'whale-db-'));
  const account = path.join(tmp, 'xwechat_files', 'wxid_demo123');
  fs.mkdirSync(path.join(account, 'db_storage'), { recursive: true });
  const flat = path.join(tmp, 'flat', 'xwechat_files');
  fs.mkdirSync(path.join(flat, 'db_storage'), { recursive: true });
  const empty = path.join(tmp, 'empty');
  fs.mkdirSync(empty, { recursive: true });

  const code = [
    'import sys, json',
    `sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'examples'))})`,
    'import wechatauto_bridge as b',
    `print(json.dumps({`,
    `  "account": b.looks_like_db_root(${JSON.stringify(account)}),`,
    `  "root": b.looks_like_db_root(${JSON.stringify(path.join(tmp, 'xwechat_files'))}),`,
    `  "flat": b.looks_like_db_root(${JSON.stringify(flat)}),`,
    `  "dbstorage": b.looks_like_db_root(${JSON.stringify(path.join(account, 'db_storage'))}),`,
    `  "notdb": b.looks_like_db_root(${JSON.stringify(empty)}),`,
    `}))`,
  ].join('\n');
  // 开源包不带 runtime，用系统 python 也能跑；两边都没有就跳过（断言结构已在上面覆盖）
  const bundledPy = path.join(ROOT, 'runtime', 'python', 'python.exe');
  const py = fs.existsSync(bundledPy) ? bundledPy : 'python';
  let out;
  try {
    out = execFileSync(py, ['-c', code], { encoding: 'utf8' });
  } catch (err) {
    if (err && err.code === 'ENOENT') return; // 这台机器没有 python，跳过
    throw err;
  }
  const got = JSON.parse(out.trim().split('\n').pop());
  assert.equal(got.account, true, '直填账号目录（含 db_storage）要认');
  assert.equal(got.root, true, '标准布局要认');
  assert.equal(got.flat, true, '拍平的 db_storage 要认');
  assert.equal(got.dbstorage, true, '直填 db_storage 要认');
  assert.equal(got.notdb, false, '空目录不能误判');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('媒体兜底：盘符不再写死 C..K，会扫真实挂载点', () => {
  assert.match(mediaSrc, /psutil\.disk_partitions/, '要用真实分区列表');
  assert.doesNotMatch(mediaSrc, /for letter in \(drives or ""\):\n\s+for name in root_names:/, '不能继续无脑按写死盘符扫');
});
