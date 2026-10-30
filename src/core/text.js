'use strict';

/**
 * 文本处理纯函数：清洗、匹配、时间格式化、数值收敛。
 * 不依赖任何 IO，便于单测。
 */

/** 清洗可能触发模型内容审核的词，避免整段请求被 400 拒掉 */
const SENSITIVE_PATTERNS = [
  /操(你|他|她|你妈|你妈逼)?/g, /你妈/g, /妈的/g, /他妈/g, /傻逼/gi, /傻B/gi, /煞笔/g,
  /草泥马/g, /尼玛/g, /性交/g, /做爱/g, /色情/g, /黄片/g, /裸(照|聊)?/g, /约炮/g, /嫖/g,
];

function sanitizeForModel(text) {
  let s = String(text == null ? '' : text);
  for (const re of SENSITIVE_PATTERNS) s = s.replace(re, '***');
  return s;
}

/** 群名匹配：忽略大小写/空格，允许「鼠标」匹配「鼠标那个群」这种写法 */
function nameMatches(a, b) {
  const x = String(a || '').replace(/\s+/g, '').toLowerCase();
  const y = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function formatChatTime(ts) {
  if (!ts) return '时间未知';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '时间未知';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 只留文字，用来比较「是不是把对方的话重复了一遍」 */
function normalizeForCompare(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

module.exports = {
  SENSITIVE_PATTERNS,
  sanitizeForModel,
  nameMatches,
  formatChatTime,
  normalizeForCompare,
  clampInt,
};
