'use strict';

const { shareForChat } = require('../../services/share');
const { buildDigest } = require('../../services/status');
const { json } = require('../util');

module.exports = function register(router) {
  router.get('/api/share', async (runtime, req, res, info) => {
    try {
      const share = await shareForChat(runtime, info.url.searchParams.get('chat') || '');
      return json(res, 200, share);
    } catch (err) {
      runtime.logger.warn('挑视频失败：' + (err && err.message));
      return json(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });

  router.get('/api/digest', (runtime, req, res, info) => {
    const since = Number(info.url.searchParams.get('since') || 0);
    const items = runtime.store.listDigest(since).slice(-120);
    return json(res, 200, buildDigest(items));
  });
};
