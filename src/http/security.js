'use strict';

const crypto = require('node:crypto');

/**
 * 请求安全闸：
 *   1) CSRF：浏览器跨站写请求一律拒绝（同源写操作还必须是 JSON）
 *   2) 远程写：默认只许本机；开 allowRemote + x-bot-token 才放行
 *   3) 安全响应头：nosniff / 禁 referrer / 禁外部脚本
 */

/** 恒定时间字符串比较：避免靠响应时间猜 token */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * 给每个响应挂安全头。
 *
 * CSP 里 script-src 保留了 'unsafe-inline'：网页里有两段内联脚本，
 * 去掉会直接白屏。即使如此，外部脚本仍然加载不了（default-src 'self'），
 * 这对「本机控制台」这个威胁模型够了。
 */
function applySecurityHeaders(res) {
  try {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'self'"
    );
  } catch { /* 头写不进去不影响响应体 */ }
}

function isLoopbackRequest(req) {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '' || ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 远程写操作：必须显式打开 allowRemote，并且带一个非默认的 x-bot-token */
function remoteAuthorized(req, runtime) {
  const allow = Boolean(runtime.config.server && runtime.config.server.allowRemote);
  if (!allow) return false;
  const token = String(
    (runtime.config.gateway && runtime.config.gateway.wechat && runtime.config.gateway.wechat.inboundToken) || ''
  ).trim();
  if (!token || token === 'change-me-wechat') return false;
  return safeEqual(String(req.headers['x-bot-token'] || '').trim(), token);
}

/**
 * 返回 null 表示放行；返回 { status, error } 表示拒绝。
 * @param {object} runtime
 * @param {import('node:http').IncomingMessage} req
 * @param {{pathname:string, method:string}} info
 */
function checkRequest(runtime, req, { pathname, method }) {
  const { logger } = runtime;

  // CSRF 闸：浏览器发起的跨站写请求一律拒绝。
  // 以前没这道：任何网页都能 POST 到 127.0.0.1:8787 改设置（实测 text/plain 也能过，不需要预检）。
  const reqOrigin = String(req.headers.origin || '');
  if (reqOrigin) {
    const sameOrigin = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(reqOrigin);
    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (!sameOrigin && isWrite) {
      logger.warn(`拒绝跨站请求：${method} ${pathname} Origin=${reqOrigin}`);
      return { status: 403, error: '拒绝跨站请求：只允许在本机页面里操作' };
    }
    // 同源写操作也必须是 JSON：挡住「html 表单提交」这类不需要预检的请求
    if (isWrite && pathname.startsWith('/api/')) {
      const ctype = String(req.headers['content-type'] || '').toLowerCase();
      if (!ctype.includes('application/json')) {
        return { status: 415, error: '写操作必须是 application/json' };
      }
    }
  }

  // 安全闸：这些接口能改配置、注入聊天、上传图片。默认只许本机；
  // 真要放到局域网（server.allowRemote=true）也必须带对的 x-bot-token，否则一律 403。
  if (pathname.startsWith('/api/') && method !== 'GET' && !isLoopbackRequest(req) && !remoteAuthorized(req, runtime)) {
    logger.warn(`拒绝远程写操作：${method} ${pathname} from ${req.socket && req.socket.remoteAddress}`);
    return {
      status: 403,
      error: '远程调用被拒绝：请在运行本程序的电脑上操作，或设 server.allowRemote=true 并在请求头带 x-bot-token',
    };
  }

  return null;
}

module.exports = { isLoopbackRequest, remoteAuthorized, checkRequest, applySecurityHeaders, safeEqual };
