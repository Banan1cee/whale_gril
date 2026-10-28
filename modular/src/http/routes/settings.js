'use strict';

const { getSettings, applySettings } = require('../../services/settings');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  router.get('/api/settings', (runtime, req, res) => json(res, 200, getSettings(runtime)));

  router.post('/api/settings', async (runtime, req, res) => {
    const body = await readBody(req);
    try {
      const data = await applySettings(runtime, body);
      return json(res, 200, data);
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  });

  router.post('/api/settings/test', async (runtime, req, res) => {
    const body = await readBody(req);
    if (body && Object.keys(body).length) {
      try {
        await applySettings(runtime, body);
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message });
      }
    }
    const probe = await runtime.llm.probe();
    return json(res, 200, { ok: probe.ok, probe });
  });
};
