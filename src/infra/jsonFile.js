'use strict';

/**
 * 读 JSON 文件。唯一实现：以前 config / backup / chatStore / migrate 各有一份，
 * 后三份逐字节相同，config 版多一个 fallback 形参。
 *
 * 失败（文件不存在 / JSON 坏 / 无权限）一律返回 fallback，不抛：
 * 这些调用点都是「读配置 / 读记忆，没有就用默认值」，抛出去会让启动挂掉。
 */
const fs = require('node:fs');

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/** 旧快照的增量日志可能因断电留下半截行；跳过坏行，但不改写原始文件。 */
function readJournal(file) {
  let raw = '';
  try {
    raw = fs.readFileSync(file + '.journal', 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 半截行跳过 */ }
  }
  return out;
}

module.exports = { readJson, readJournal };
