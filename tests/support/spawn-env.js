'use strict';

/**
 * 当前环境能不能「带管道地」起子进程。
 *
 * 沙箱 / 受限环境里进程创建可以成功，但管道（命名管道）建不起来：
 *   - spawnSync(..., { stdio: 'ignore' })  → 正常
 *   - spawnSync(..., 默认 pipe)            → EPERM
 * 依赖子进程 stdout 的测试在这种环境下没有意义（不是被测代码坏了），
 * 统一用这里探测，命中就 skip，并在消息里说明原因。
 */
const { spawnSync } = require('node:child_process');

let cached = null;

function pipedSpawnBlocked() {
  if (cached !== null) return cached;
  try {
    const out = spawnSync(process.execPath, ['-e', 'process.stdout.write("1")'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    cached = Boolean(out && out.error && (out.error.code === 'EPERM' || out.error.code === 'EACCES'));
  } catch (err) {
    cached = Boolean(err && (err.code === 'EPERM' || err.code === 'EACCES'));
  }
  return cached;
}

const SKIP_REASON = '当前环境不允许采集子进程输出（沙箱限制），本机/CI 正常运行时会执行';

module.exports = { pipedSpawnBlocked, SKIP_REASON };
