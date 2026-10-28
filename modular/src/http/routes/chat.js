'use strict';

const { handleChat } = require('../../services/chat');
const { json, readBody, sanitizeId } = require('../util');

module.exports = function register(router) {
  router.post('/api/chat', (runtime, req, res) => handleChat(runtime, req, res));

  router.post('/api/reset', async (runtime, req, res) => {
    const body = await readBody(req);
    const sessionId = sanitizeId(body.sessionId || 'default');
    if (body.all) {
      runtime.store.resetAll();
    } else {
      const mode = body.mode === 'group' ? 'group' : 'private';
      runtime.store.resetSession(`web:${mode === 'group' ? 'g' : 'u'}:${sessionId}:${mode}`);
    }
    return json(res, 200, { ok: true });
  });
};
