'use strict';

/**
 * 极简日志：控制台彩色输出 + 可选文件追加。
 * 不依赖任何第三方库。
 *
 * 两个级别分开控制（2026-10 起）：
 *   level      控制台/启动器看到的级别，默认 info（去掉排查噪音）
 *   fileLevel  文件里保存的级别，默认 debug（全量，事后能溯源）
 * 所以同一个 logger 可以「界面干净、文件完整」：debug 行不打印，但一定落盘。
 */
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
const COLORS = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  reset: '\x1b[0m',
};

const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 单文件 10MB + 一个 .1 备份
const ROTATE_CHECK_MS = 60 * 1000;

function createLogger({ level = 'info', fileLevel = 'debug', file = null } = {}) {
  let stream = null;
  let lastRotateCheck = 0;

  function openStream() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => { stream = null; });
    } catch {
      stream = null;
    }
  }
  openStream();

  const threshold = LEVELS[level] ?? LEVELS.info;
  const fileThreshold = LEVELS[fileLevel] ?? LEVELS.debug;

  function rotateIfNeeded() {
    if (!file || !stream) return;
    const now = Date.now();
    if (now - lastRotateCheck < ROTATE_CHECK_MS) return;
    lastRotateCheck = now;
    try {
      if (fs.statSync(file).size <= MAX_FILE_BYTES) return;
      stream.end();
      try { fs.rmSync(file + '.1', { force: true }); } catch { /* 没有就算了 */ }
      try { fs.renameSync(file, file + '.1'); } catch { /* 被占用就继续追加 */ }
      openStream();
    } catch { /* 统计失败不影响写 */ }
  }

  function emit(lv, args) {
    const n = LEVELS[lv] ?? 0;
    const toConsole = n >= threshold;
    const toFile = !!stream && n >= fileThreshold;
    if (!toConsole && !toFile) return;

    const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
    // 不省略：对象展开到任意深度、长字符串不截断，否则出错时看不到真正的现场。
    const text = args
      .map((a) => (typeof a === 'string' ? a : util.inspect(a, {
        depth: null,
        maxArrayLength: 200,
        maxStringLength: null,
        colors: false,
        breakLength: 160,
      })))
      .join(' ');
    const line = `[${ts}] ${lv.toUpperCase().padEnd(5)} ${text}`;

    if (toConsole) {
      if (process.stdout.isTTY) {
        process.stdout.write(`${COLORS[lv] || ''}${line}${COLORS.reset}\n`);
      } else {
        console.log(line);
      }
    }
    if (toFile) {
      stream.write(line + '\n');
      rotateIfNeeded();
    }
  }

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    level,
    fileLevel,
    close() {
      if (stream) { stream.end(); stream = null; }
    },
  };
}

module.exports = { createLogger, LEVELS };
