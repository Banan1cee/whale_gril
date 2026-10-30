'use strict';

/**
 * 极简日志：控制台彩色输出 + 可选文件追加。
 * 不依赖任何第三方库。
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

function createLogger({ level = 'info', file = null } = {}) {
  let stream = null;
  if (file) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      stream = fs.createWriteStream(file, { flags: 'a' });
      stream.on('error', () => { stream = null; });
    } catch {
      stream = null;
    }
  }
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lv, args) {
    if ((LEVELS[lv] ?? 0) < threshold) return;
    const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
    const text = args
      .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 3, colors: false, breakLength: 120 })))
      .join(' ');
    const line = `[${ts}] ${lv.toUpperCase().padEnd(5)} ${text}`;
    if (process.stdout.isTTY) {
      process.stdout.write(`${COLORS[lv] || ''}${line}${COLORS.reset}\n`);
    } else {
      console.log(line);
    }
    if (stream) stream.write(line + '\n');
  }

  return {
    debug: (...a) => emit('debug', a),
    info: (...a) => emit('info', a),
    warn: (...a) => emit('warn', a),
    error: (...a) => emit('error', a),
    level,
    close() {
      if (stream) { stream.end(); stream = null; }
    },
  };
}

module.exports = { createLogger, LEVELS };
