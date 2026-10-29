'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
test('便携runtime补丁仅处理暂存源码、幂等、不操作微信', (t) => {
  const py = process.env.WHALE_TEST_PYTHON || (process.platform === 'win32'
    ? path.join(__dirname, '..', 'runtime/python/python.exe') : 'python3');
  if (process.platform === 'win32' && !fs.existsSync(py)) { t.skip('缺少便携Python'); return; }
  const run = spawnSync(py, ['-B', path.join(__dirname, 'test_sticker_runtime.py')], {stdio:'inherit'});
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0);
});
