'use strict';

/**
 * 请求安全闸：
 *   1) CSRF：浏览器跨站写请求一律拒绝（同源写操作还必须是 JSON）
 *   2) 远程写：默认只许本机；开 allowRemote + x-bot-token 才放行
 */

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
  return String(req.headers['x-bot-token'] || '').trim() === token;
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

module.exports = { isLoopbackRequest, remoteAuthorized, checkRequest };
