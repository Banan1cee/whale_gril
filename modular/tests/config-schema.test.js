'use strict';

/**
 * 配置校验：非法值要当场报出来，而不是被 `Number(x) || 默认` 静默吃掉。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/infra/config');
const { validate, checkValue, formatErrors } = require('../src/infra/configSchema');
const { applyConfigPatch } = require('../src/infra/configPatch');

function makeRuntime(configPatch = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-schema-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(configPatch));
  const config = loadConfig({ root, env: {} });
  const runtime = {
    config,
    logger: { info() {}, warn() {}, error() {}, close() {} },
    llm: { reload() {} },
  };
  return { runtime, root, configFile: path.join(root, 'config.json'), cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }) };
}

test('默认配置没有校验错误', () => {
  const { runtime, cleanup } = makeRuntime();
  assert.deepEqual(validate(runtime.config), []);
  cleanup();
});

test('越界的数字会被指出来，并带上字段路径', () => {
  const errors = validate({ server: { port: 99999 }, chat: { maxBubbles: 0 }, group: { cooldownSec: -1 } });
  const paths = errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['chat.maxBubbles', 'group.cooldownSec', 'server.port']);
  assert.match(formatErrors(errors), /server\.port/);
});

test('类型错（把「很多」填进轮数）会被指出来', () => {
  const errors = validate({ chat: { historyTurns: '很多' } });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].path, 'chat.historyTurns');
  assert.match(errors[0].message, /整数/);
});

test('字符串形式的布尔老配置仍然算合法', () => {
  assert.equal(checkValue('false', { type: 'bool' }), null);
  assert.equal(checkValue('开', { type: 'bool' }), null);
  assert.ok(checkValue('随便', { type: 'bool' }));
});

test('缺省字段不算错（用默认值）', () => {
  assert.deepEqual(validate({}), []);
});

test('调试台保存非法值时整批拒绝，而且一个字节都不写', () => {
  const { runtime, configFile, cleanup } = makeRuntime();
  const before = fs.readFileSync(configFile, 'utf8');
  assert.throws(
    () => applyConfigPatch(runtime, { 'chat.historyTurns': 99999 }),
    (err) => err.statusCode === 400 && /chat\.historyTurns/.test(err.message)
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), before, '校验失败不能落盘');
  cleanup();
});

test('合法值照常写入', () => {
  const { runtime, configFile, cleanup } = makeRuntime();
  const res = applyConfigPatch(runtime, { 'chat.historyTurns': 50 });
  assert.deepEqual(res.changed, ['chat.historyTurns']);
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).chat.historyTurns, 50);
  cleanup();
});

test('一批里有一个非法值，整批都不写（不会改一半）', () => {
  const { runtime, configFile, cleanup } = makeRuntime();
  const before = fs.readFileSync(configFile, 'utf8');
  assert.throws(() => applyConfigPatch(runtime, { 'chat.historyTurns': 50, 'chat.maxBubbles': 99 }));
  assert.equal(fs.readFileSync(configFile, 'utf8'), before);
  cleanup();
});
