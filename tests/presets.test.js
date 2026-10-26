'use strict';

/**
 * 人设预设：一个版本一个文件，导入后立即生效。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const presets = require('../src/presets');

function makeRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-presets-'));
  fs.mkdirSync(path.join(dir, 'personas'), { recursive: true });
  return dir;
}

function writePreset(dir, name, data) {
  fs.writeFileSync(path.join(dir, 'personas', name), JSON.stringify(data, null, 2), 'utf8');
}

test('personas/ 下每个文件都被识别，按版本号排序', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v2.json', { id: 'persona-v2', version: '2.0.0', name: '第二版', customPrompt: 'x' });
  writePreset(root, 'persona-v10.json', { id: 'persona-v10', version: '10.0.0', name: '第十版', customPrompt: 'y' });
  writePreset(root, 'persona-v1.json', { id: 'persona-v1', version: '1.0.0', name: '第一版', customPrompt: 'z' });
  const list = presets.list({ paths: { root } });
  assert.deepEqual(list.map((x) => x.id), ['persona-v1', 'persona-v2', 'persona-v10']);
  assert.equal(list[0].name, '第一版');
  fs.rmSync(root, { recursive: true, force: true });
});

test('坏文件和目录不存在时不会崩', () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, 'personas', 'broken.json'), '{ not json', 'utf8');
  assert.deepEqual(presets.list({ paths: { root } }), []);
  assert.deepEqual(presets.list({ paths: { root: path.join(root, 'nope') } }), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('导入只取白名单字段，带不进乱七八糟的东西', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v1.json', {
    id: 'persona-v1',
    version: '1.0.0',
    name: '鲸鲸',
    customPrompt: '完整人设',
    historyTurns: 90,
    master: { wxids: ['wxid_evil'] },
    apiKey: 'sk-should-not-pass',
    shell: 'rm -rf',
  });
  const preset = presets.load({ paths: { root } }, 'persona-v1');
  const patch = presets.toPatch(preset);
  assert.equal(patch.customPrompt, '完整人设');
  assert.equal(patch.historyTurns, 90);
  assert.equal(patch.master, undefined);
  assert.equal(patch.apiKey, undefined);
  assert.equal(patch.shell, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

test('id 里带路径穿越取不到东西', () => {
  const root = makeRoot();
  writePreset(root, 'persona-v1.json', { id: 'persona-v1', customPrompt: 'ok' });
  assert.equal(presets.load({ paths: { root } }, '../config'), null);
  assert.equal(presets.load({ paths: { root } }, '../../etc/passwd'), null);
  assert.equal(presets.load({ paths: { root } }, 'nope'), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('仓库自带的 persona-v1 是通用版：不含微信号、群昵称、Key', () => {
  const root = path.resolve(__dirname, '..');
  const list = presets.list({ paths: { root } });
  assert.ok(list.length >= 1, '至少要有一个人设预设');
  for (const item of list) {
    const preset = presets.load({ paths: { root } }, item.id);
    const text = JSON.stringify(preset);
    assert.doesNotMatch(text, /wxid_gk6o4|wxid_[a-z0-9]{10,}|sk-[A-Za-z0-9]{10}/, item.id + ' 里疑似有隐私');
    assert.doesNotMatch(text, /1[3-9]\d{9}|[\w.+-]+@[\w-]+\.[a-z]{2,}/i, item.id + ' 里疑似有手机号/邮箱');
    assert.ok(String(preset.customPrompt || '').length > 100, item.id + ' 应该有完整提示词');
  }
});
