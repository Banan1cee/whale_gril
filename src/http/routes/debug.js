'use strict';

const { debugState, debugSessions, debugPrompt } = require('../../services/debug');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  router.get('/api/debug/state', (runtime, req, res) => json(res, 200, debugState(runtime)));

  router.get('/api/debug/sessions', (runtime, req, res) => json(res, 200, { ok: true, sessions: debugSessions(runtime) }));

  router.post('/api/debug/prompt', async (runtime, req, res) => {
    const body = await readBody(req);
    return json(res, 200, await debugPrompt(runtime, body));
  });

  router.post('/api/debug/reset', async (runtime, req, res) => {
    const body = await readBody(req);
    if (!body.key) return json(res, 400, { ok: false, error: '缺少 key' });
    runtime.store.resetSession(String(body.key));
    runtime.logger.info('调试台清空了会话记忆：' + String(body.key));
    return json(res, 200, { ok: true });
  });
};
