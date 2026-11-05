'use strict';

/**
 * 按 "a.b.c" 取嵌套值。合并了 configPatch / configSchema / features 三份同名实现。
 *
 * 统一成显式 `cur === null || typeof cur !== 'object'` 判断（features 原来写 `!cur`）：
 * 对 0 / '' 这类假值，属性访问本来也只返回 undefined，不会抛；用显式 null 判断
 * 意图更清楚，也避免以后有人把 `!cur` 当成业务规则加东西。
 * dotted 缺失时 String(undefined) 得到 "undefined"，逐段查不到 → undefined，和旧行为一致。
 */
function getByPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

module.exports = { getByPath };
