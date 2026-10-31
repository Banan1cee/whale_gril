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
};
