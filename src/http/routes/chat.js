'use strict';

const { handleChat } = require('../../services/chat');
const { json } = require('../util');

/**
 * 本机聊天口：/api/chat 只留给本机桥接与测试用。
 *
 * 以前浏览器里的聊天页和桥接共用这个口子，等于把整条对话管线暴露给任何能
 * POST 到 127.0.0.1:8787 的页面。现在要求带桥接 token（网关的
 * inboundToken）才放行；网页界面已在 4.0.2 删除，没有 token 一律 404。
 */
function bridgeOnly(runtime, req, res) {
  const gw = runtime.gateways && runtime.gateways.get && runtime.gateways.get('wechat');
  if (!gw || !gw.verifyToken(req, null)) {
    json(res, 404, { ok: false, error: '网页聊天已下线，请用启动器' });
    return true;
  }
  return null;
}

module.exports = function register(router) {
  router.post('/api/chat', (runtime, req, res) => {
    const denied = bridgeOnly(runtime, req, res);
    if (denied) return denied;
    return handleChat(runtime, req, res);
  });
};
