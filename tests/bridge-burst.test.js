'use strict';

/**
 * 桥接侧「连发消息被当成过期丢掉」的回归入口。
 *
 * 真正的断言在 `tests/test_msg_batches.py`（那里能直接读 engine.py 的 AST、
 * 还能把 merge_text_batch 抠出来单跑）。这里只负责按 CI 的规矩把它挂进
 * `npm test`，顺带在没有 Python 的机器上干净地跳过。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATES = [
  process.env.WHALE_TEST_PYTHON,
  path.join(ROOT, 'runtime', 'python', 'python.exe'),
  process.platform === 'win32' ? 'python' : 'python3',
].filter(Boolean);

function runPython() {
  for (const py of CANDIDATES) {
    const probe = spawnSync(py, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) continue;
    const run = spawnSync(py, ['-B', path.join(__dirname, 'test_msg_batches.py')], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 60000,
    });
    return run;
  }
  return null;
}

test('连发的消息按会话攒批：一条不丢、同一个人合并（桥接侧）', (t) => {
  const run = runPython();
  if (!run) {
    t.skip('这台机器上没有可用的 python');
    return;
  }
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 0, `python 用例没过：\n${run.stdout || ''}\n${run.stderr || ''}`);
});
