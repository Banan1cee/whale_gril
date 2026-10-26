'use strict';

/**
 * 「热激活 UIA 失败」的可诊断性：桥接要把原因说清楚，并提供一个只读诊断工具。
 * 背景：这句日志有三种完全不同的原因（枚举不到 Weixin.dll / 版本不支持 / 校验失败），
 * 光看一句没法修，所以固定下来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');
const diagPath = path.join(root, 'tools', 'uia-diag.py');

test('桥接预热失败时会解释属于哪一类原因', () => {
  assert.match(bridge, /def explain_uia_failure/, '要有专门的解释函数');
  assert.match(bridge, /原因A/, '枚举不到 Weixin.dll');
  assert.match(bridge, /原因B/, '版本不支持');
  assert.match(bridge, /原因C/, '补丁写了但校验失败');
  assert.match(bridge, /explain_uia_failure\(\)/, '预热失败时要调用它');
});

test('诊断工具存在，且能只读地报告版本/候选 RVA', () => {
  assert.ok(fs.existsSync(diagPath), '缺少 tools/uia-diag.py');
  const tool = fs.readFileSync(diagPath, 'utf8');
  assert.match(tool, /QACCESSIBLE_ACTIVE_RVA_BY_VERSION/, '要能读库内置版本表');
  assert.match(tool, /--probe/, '要支持真的热激活一次');
  assert.match(tool, /非 ASCII/, '要能提示中文路径这个坑');
  assert.match(tool, /ffmpeg/, '顺手报一下 ffmpeg（看图要用）');
});

test('文档里写了「热激活 UIA 失败」的三类原因', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', '接入微信.md'), 'utf8');
  assert.match(doc, /热激活 UIA 失败/);
  assert.match(doc, /uia-diag\.py/);
  assert.match(doc, /4\.1\.13\.65|4\.1\.15\.53/);
});
