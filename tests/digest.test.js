'use strict';
/**
 * 消息汇总：总开关关掉 = 功能完全不存在；打开后按间隔推送。
 * 这里守住三件事：默认关、开关能读能写、三处代码都受同一个开关控制。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_CONFIG, resolveRuntime } = require('../src/config');
const features = require('../src/features');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('默认关闭，间隔默认 30 分钟', () => {
  assert.equal(DEFAULT_CONFIG.digest.everyMinutes, 30);
  assert.equal(DEFAULT_CONFIG.digest.enabled, false);
  assert.equal(features.isOn(DEFAULT_CONFIG, 'digest'), false);
});

test('开关可读可写（控制台走的就是这条路径）', () => {
  const cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  cfg.digest.enabled = true;
  assert.equal(features.isOn(cfg, 'digest'), true);
  cfg.digest.enabled = false;
  assert.equal(features.isOn(cfg, 'digest'), false);
  const entry = features.REGISTRY.find((f) => f.key === 'digest');
  assert.ok(entry, '功能开关登记表里要有 digest');
  assert.equal(entry.path, 'digest.enabled');
  assert.equal(entry.default, false, '默认必须是关');
});

test('服务端：关着时接口 404，开着时才返回汇总', () => {
  const server = read('server.js');
  const route = server.slice(server.indexOf("'/api/digest'"));
  assert.match(route.slice(0, 400), /features\.isOn\(runtime\.config, 'digest'\)/, '接口要判开关');
  assert.match(route.slice(0, 400), /404/, '关掉时返回 404');
  assert.match(server, /function buildDigest/, '要有汇总文本生成');
});

test('机器人：关着时不采集任何人的消息', () => {
  const bot = read('src/bot.js');
  const idx = bot.indexOf('this.store.addDigest(');
  assert.ok(idx > 0, '要有采集调用');
  const guard = bot.slice(Math.max(0, idx - 500), idx);
  assert.match(guard, /features\.isOn\(this\.config, 'digest'\)/, '采集必须受总开关控制');
});

test('桥接：开关关掉时线程空转，不请求接口', () => {
  const bridge = read('examples/wechatauto_bridge.py');
  assert.match(bridge, /def digest_watch/, '要有汇总线程');
  assert.match(bridge, /threading\.Thread\(target=digest_watch, daemon=True\)\.start\(\)/, '线程要真的启动');
  const fn = bridge.slice(bridge.indexOf('def digest_watch'));
  const body = fn.slice(0, fn.indexOf('def ', 10));
  assert.match(body, /features.*digest|digest", False/, '要读 features.digest');
  assert.match(body, /everyMinutes/, '间隔要可调');
});
