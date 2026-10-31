'use strict';

const { statusPayload } = require('../../services/status');
const { json } = require('../util');
const { isLoopbackRequest } = require('../security');
const memoryBackup = require('../../memory/backup');

module.exports = function register(router) {
  router.get('/api/status', (runtime, req, res) => json(res, 200, statusPayload(runtime)));
  // 本机运维控制，只回成功/失败；不开放任何记忆正文、导出或恢复接口。
  router.post('/api/runtime/prepare-stop', (runtime, req, res) => {
    const gateway = runtime.gateways.get('wechat');
    if (!isLoopbackRequest(req) || !gateway || !gateway.verifyToken(req, null)) {
      return json(res, 403, { ok: false, error: '停止准备仅允许通过本机令牌调用' });
    }
    runtime.store.flush();
    const pending = [...runtime.store.chatStore.chats.values()].some(chat => chat.dirtyMeta || chat.dirtySummary);
    if (pending) return json(res, 503, { ok: false, error: '记忆尚未保存，已取消停止准备' });
    memoryBackup.writeSnapshot(runtime.config.root, 'before-stop');
    return json(res, 200, { ok: true });
  });
};
