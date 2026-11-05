'use strict';

/**
 * 一行式错误摘要，专供日志使用。
 *
 * 为什么需要它：以前很多失败分支写的是 `'xxx 失败：' + err.message`，而 LlmError 的
 * message 是**给用户看的话术**（「咕噜…这次只吐出了个空泡泡」），真正的 code / status /
 * detail（finish=length、reasoning_tokens=700、HTTP 429…）全被丢掉了 —— 日志里只剩
 * 「抽取失败」，查不出为什么失败。
 *
 * 这里只拼结构信息：
 *   type=LlmError code=empty status=429 retryable detail=空响应（finish=length …）
 * 普通 Error 没有 detail 时退回 msg（fs 错误的 EPERM/ENOSPC 也在这里）。
 *
 * 注意：detail 由抛错方负责只放结构证据，不要放聊天正文 / 记忆正文。
 *
 * @param {*} err
 * @param {{maxDetail?:number}} [opts]
 * @returns {string}
 */
function describeError(err, { maxDetail = 300 } = {}) {
  if (err == null) return '无错误对象';
  if (typeof err !== 'object') return 'msg=' + clipWithEllipsis(err, maxDetail);

  const bits = [];
  const name = err.name || (err.constructor && err.constructor.name) || 'Error';
  bits.push('type=' + name);
  if (err.code) bits.push('code=' + clipWithEllipsis(err.code, 60));
  if (Number(err.status)) bits.push('status=' + Number(err.status));
  if (err.retryable === true) bits.push('retryable');

  const detail = clipWithEllipsis(err.detail, maxDetail);
  if (detail) {
    bits.push('detail=' + detail);
  } else if (name !== 'LlmError' && err.message) {
    // 普通 Error 的 message 就是真相（文件系统错误会带 EPERM/ENOSPC 和路径）
    bits.push('msg=' + clipWithEllipsis(err.message, maxDetail));
  } else if (name === 'LlmError') {
    // LlmError 没有 detail 时，message 是给用户看的话术，不能当日志证据
    bits.push('detail=(无)');
  }
  return bits.join(' ');
}

function clipWithEllipsis(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

module.exports = { describeError };
