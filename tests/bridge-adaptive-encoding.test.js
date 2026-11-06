'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const script of ['test_bg_live_encoding.py', 'test_uia_recovery.py']) {
  test('离线微信回归：' + script, () => {
    const run = spawnSync(process.env.PYTHON || 'python', ['-B', path.join('tests', script)], {
      cwd: path.resolve(__dirname, '..'), env: { ...process.env, PYTHONUTF8: '1' },
      encoding: 'utf8', timeout: 15000,
    });
    assert.equal(run.status, 0, run.stdout + run.stderr + (run.error ? String(run.error) : ''));
  });
}
