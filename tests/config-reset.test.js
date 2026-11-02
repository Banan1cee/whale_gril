'use strict';

/**
 * 「恢复默认」（POST /api/config/reset）的行为回归。
 *
 * 启动器设置页的「这一组恢复默认」只发字段名，默认值由内核按 DEFAULT_CONFIG 取 ——
 * 这样启动器不用自己抄一份默认值（抄的那份迟早和 config.js 对不上）。
 * 这里钉住三件事：写回默认值、只动传进来的字段、不碰密钥。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, DEFAULT_CONFIG } = require('../src/infra/config');
const { resetConfig, defaultOf } = require('../src/infra/configPatch');

function fixture(t, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reset-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    server: { port: 0, openBrowser: false },
    ...patch,
  }, null, 2));
  const cfg = loadConfig({ root: dir, env: {} });
  const runtime = { config: cfg, logger: { info() {}, warn() {} } };
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  return { dir, cfg, runtime, read };
}

test('恢复默认：传进来的字段写回 DEFAULT_CONFIG，同段其它键不动', (t) => {
  const { runtime, read } = fixture(t, {
    group: { requireAt: true, freeChat: false, freeChatChance: 0.5, cooldownSec: 99 },
  });

  const out = resetConfig(runtime, ['group.requireAt', 'group.cooldownSec']);

  assert.deepEqual(out.changed.sort(), ['group.cooldownSec', 'group.requireAt']);
  assert.deepEqual(out.unknown, []);
  const saved = read();
  assert.equal(saved.group.requireAt, DEFAULT_CONFIG.group.requireAt);
  assert.equal(saved.group.cooldownSec, DEFAULT_CONFIG.group.cooldownSec);
  // 没点名的两项必须保持用户值 —— 「恢复这一组」不等于「清空这一组」
  assert.equal(saved.group.freeChatChance, 0.5);
  assert.equal(saved.group.freeChat, false);
});

test('恢复默认：内存里的配置当场生效，不用重启', (t) => {
  const { runtime } = fixture(t, { deepseek: { temperature: 1.6 } });
  resetConfig(runtime, ['deepseek.temperature']);
  assert.equal(runtime.config.deepseek.temperature, DEFAULT_CONFIG.deepseek.temperature);
});

test('恢复默认：不认识的字段进 unknown，不写盘也不抛错', (t) => {
  const { runtime, read } = fixture(t, { group: { cooldownSec: 12 } });
  const out = resetConfig(runtime, ['group.cooldownSec', 'group.不存在', '根本没有.这个']);
  assert.deepEqual(out.changed, ['group.cooldownSec']);
  assert.deepEqual(out.unknown.sort(), ['group.不存在', '根本没有.这个'].sort());
  assert.equal(read().group.cooldownSec, DEFAULT_CONFIG.group.cooldownSec);
});

test('恢复默认：密钥字段一律跳过，别把人家的 Key 清了', (t) => {
  const { runtime, read } = fixture(t, { deepseek: { apiKey: 'sk-keep-me' } });
  const out = resetConfig(runtime, ['deepseek.apiKey', 'deepseek.temperature']);
  assert.deepEqual(out.unknown, ['deepseek.apiKey']);
  assert.deepEqual(out.changed, ['deepseek.temperature']);
  assert.equal(read().deepseek.apiKey, 'sk-keep-me');
});

test('恢复默认：paths 空或不是数组直接 400', (t) => {
  const { runtime } = fixture(t);
  for (const bad of [undefined, null, [], 'group.requireAt', {}]) {
    assert.throws(() => resetConfig(runtime, bad), (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    });
  }
});

test('defaultOf：取得到 DEFAULT_CONFIG 的值，取不到给 undefined', () => {
  assert.equal(defaultOf('group.requireAt'), DEFAULT_CONFIG.group.requireAt);
  assert.equal(defaultOf('memory.dialogueBudget'), DEFAULT_CONFIG.memory.dialogueBudget);
  assert.equal(defaultOf('group.根本没有'), undefined);
});
