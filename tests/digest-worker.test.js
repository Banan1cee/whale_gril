'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('汇总桥接回归：只用模拟配置、网络和桌面，不操作真实微信', (t) => {
  const py = process.env.WHALE_TEST_PYTHON || (process.platform === 'win32'
    ? path.join(__dirname, '..', 'runtime/python/python.exe') : 'python3');
  if (process.platform === 'win32' && !fs.existsSync(py)) { t.skip('缺少便携Python'); return; }
  const run = spawnSync(py, ['-B', path.join(__dirname, 'test_digest_worker.py')], { stdio: 'inherit' });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0);
});
