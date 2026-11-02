'use strict';

/**
 * 极简日志：控制台彩色输出 + 可选文件追加。
 * 不依赖任何第三方库。
 *
 * 两个级别分开控制（2026-10 起）：
 *   level      控制台/启动器看到的级别，默认 info（去掉排查噪音）
 *   fileLevel  文件里保存的级别，默认 debug（全量，事后能溯源）
 * 所以同一个 logger 可以「界面干净、文件完整」：debug 行不打印，但一定落盘。
 *
 * 来源定位（2026-11 起）：
 *   warn / error 会自动抓调用点，行首多一段 [pipeline/chat.js:422]。
 *   只有这两个级别抓栈——info/debug 量大，为了几微秒的定位去抓栈不值当；
 *   需要模块名的 info 用 child('llm') 这种子 logger，会在行首打 [llm]。
 *   为什么只给 warn/error：用户报障时翻日志，最先找的就是这两级，
 *   而「哪一行报的」决定了能不能直接跳到代码，比搜文案快得多。
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

/** 栈帧 → { file, line }：兼容 `at fn (E:\a\b.js:12:3)` 和 `at E:\a\b.js:12:3` */
function parseFrame(frame) {
  let s = frame.trim();
  if (s.startsWith('at ')) s = s.slice(3);
  if (s.endsWith(')')) s = s.slice(0, -1);
  const paren = s.lastIndexOf('(');
  if (paren >= 0) s = s.slice(paren + 1);
  const parts = s.split(':');
  if (parts.length < 3) return null;
  parts.pop();                                    // 列号用不上
  const line = parts.pop();
  if (!/^\d+$/.test(line)) return null;
  const file = parts.join(':');                   // 盘符里的冒号要拼回去
  if (!file || !/[\\/]/.test(file)) return null;
  return { file, line };
}

/** 只留最后两段路径：src/pipeline/chat.js → pipeline/chat.js */
function shortPath(file) {
  const parts = String(file).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/**
 * 抓调用点。跳过 logger 自己和 node 内部帧。
 * 抓不到就返回空串（某些打包/压缩环境下栈不可用），调用方退回模块 tag。
 */
function callerSite() {
  let stack = '';
  try {
    const err = new Error();
    stack = String(err.stack || '');
  } catch {
    return '';
  }
  if (!stack) return '';
  const frames = stack.split('\n');
  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i];
    if (!frame) continue;
    if (frame.includes('logger.js')) continue;
    if (frame.includes('(node:') || frame.includes('node:internal')) continue;
    const hit = parseFrame(frame);
    if (hit) return `${shortPath(hit.file)}:${hit.line}`;
  }
  return '';
}

function createLogger({ level = 'info', fileLevel = 'debug', file = null, tag = '' } = {}) {
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

  function emit(lv, args, tagName) {
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
    // warn/error 抓调用点；抓不到（打包压缩过）就退回模块 tag
    const site = n >= LEVELS.warn ? callerSite() : '';
    const prefix = (site || tagName) ? `${site || tagName}  ` : '';
    const line = `[${ts}] ${lv.toUpperCase().padEnd(5)} ${prefix}${text}`;

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

  function make(tagName) {
    return {
      debug: (...a) => emit('debug', a, tagName),
      info: (...a) => emit('info', a, tagName),
      // warn/error 的 tagName 只是兜底：抓得到调用栈时 emit 会用 file:line
      warn: (...a) => emit('warn', a, tagName),
      error: (...a) => emit('error', a, tagName),
      child: (name) => make(tagName ? `${tagName}/${name}` : String(name)),
      tag: tagName,
      level,
      fileLevel,
      close() {
        if (stream) { stream.end(); stream = null; }
      },
    };
  }

  return make(tag);
}

module.exports = { createLogger, LEVELS, callerSite };
