'use strict';

/**
 * 真实事故（2026-11-07 用户日志包）：
 *
 *   用户在 config.json 里手填 Windows 路径，只写了一个反斜杠
 *     → 第 101 行 `Invalid \escape`，JSON 非法
 *   内核 readJson 静默当空对象，一行日志都不打
 *   启动器每点一次「保存」，applyConfigPatch 就 `catch { raw = {} }` 再整文件重写
 *     → 23 个配置段被逐次抹到只剩 wechat 一段，gateway.wechat.inboundToken
 *       也跟着没了，webhook 随后 403。
 *
 * 所以这里盯两件事：
 *   1) 文件坏了必须**拒绝写入**（一个字节都不许动）；
 *   2) loadConfig 必须把解析错误带出来，让启动日志 / 自检能报。
 * 文件不存在（首次运行）仍然要能从 {} 起步，不能把这个也堵死。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/infra/config');
const { applyConfigPatch, saveConfigPatch, publicConfig } = require('../src/infra/configPatch');

// JSON 里 \W 不是合法转义 —— 这就是那份日志里的 `Invalid \escape: line 101 column 17`
const BROKEN_TEXT = '{\n  "wechat": {\n    "dbDir": "E:\\WeChat Files\\xwechat_files",\n    "quoteReply": true\n  },\n  "gateway": { "wechat": { "inboundToken": "keep-me" } }\n}\n';

function makeRoot(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-broken-'));
  if (text !== null) fs.writeFileSync(path.join(root, 'config.json'), text, 'utf8');
  return root;
}

function makeRuntime(root) {
  return {
    config: loadConfig({ root, env: {} }),
    logger: { info() {}, warn() {}, error() {}, close() {} },
    llm: { reload() {} },
  };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 });
}

test('config.json 解析失败：applyConfigPatch 拒绝写入，文件一个字节都不动', () => {
  const root = makeRoot(BROKEN_TEXT);
  const configFile = path.join(root, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const runtime = makeRuntime(root);

  assert.throws(
    () => applyConfigPatch(runtime, { 'wechat.quoteReply': false }),
    (err) => err.statusCode === 500 && /config\.json/.test(err.message),
    '坏文件要抛 500 并说清是 config.json 的问题'
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, '拒绝写入 = 文件必须逐字节不变');
  cleanup(root);
});

test('config.json 解析失败：saveConfigPatch 同样拒绝，且不改内存里的 config', () => {
  const root = makeRoot(BROKEN_TEXT);
  const configFile = path.join(root, 'config.json');
  const before = fs.readFileSync(configFile, 'utf8');
  const config = loadConfig({ root, env: {} });

  assert.throws(
    () => saveConfigPatch(config, { 'group.requireAt': false }),
    (err) => err.statusCode === 500
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  cleanup(root);
});

test('config.json 解析失败：loadConfig 把错误带出来，不再静默走默认值', () => {
  const root = makeRoot(BROKEN_TEXT);
  const config = loadConfig({ root, env: {} });
  assert.ok(config.configError, '要能拿到解析错误');
  assert.match(config.configError, /Invalid \\escape|JSON|Unexpected/i, '错误信息要能看出是 JSON 坏了');
  assert.equal(config.configExists, true, '文件确实在，只是坏了');
  // 服务还得起来，所以配置本身退回默认值
  assert.ok(config.server && config.server.port, '默认值照常可用');
  // 但这个字段不许漏到界面上
  assert.equal(publicConfig(config).config.configError, undefined, 'configError 是内部字段');
  cleanup(root);
});

test('文件不存在（首次运行）仍然能从 {} 起步写入', () => {
  const root = makeRoot(null);
  const configFile = path.join(root, 'config.json');
  const runtime = makeRuntime(root);
  const res = applyConfigPatch(runtime, { 'chat.historyTurns': 42 });
  assert.deepEqual(res.changed, ['chat.historyTurns']);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).chat.historyTurns, 42);
  cleanup(root);
});

test('自检和启动日志要报出 config.json 解析失败（源码级）', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /config\.configError/, 'server.js 要读这个字段');
  assert.match(serverSrc, /config\.json 读不出来/, '启动时要打醒目日志');
  assert.match(serverSrc, /解析失败：\$\{config\.configError\}/, '自检要把错误原样显示出来');
});
