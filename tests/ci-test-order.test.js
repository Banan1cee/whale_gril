'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('CI 在 Node 调用桥接回归之前安装 Python 测试依赖', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/tests.yml'), 'utf8');
  const install = workflow.indexOf('run: python -m pip install');
  const nodeTests = workflow.indexOf('npm test *>');
  const pythonTests = workflow.indexOf('python -m unittest discover');
  assert.ok(install >= 0, '桥接回归需要显式安装 Python 依赖');
  assert.ok(nodeTests >= 0 && pythonTests >= 0, 'Node 和 Python 回归都必须保留');
  assert.ok(install < nodeTests && install < pythonTests,
    'Node 也会运行 Python 桥接用例，依赖不能等到 Node 测试结束才安装');
  const command = workflow.slice(install).split(/\r?\n/)[0];
  for (const dependency of ['pillow', 'cryptography', 'requests']) {
    assert.match(command, new RegExp(`\\b${dependency}\\b`));
  }
});
