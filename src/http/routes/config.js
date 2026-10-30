'use strict';

const { publicConfig, applyConfigPatch } = require('../../infra/configPatch');
const { statusPayload } = require('../../services/status');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  router.get('/api/config', (runtime, req, res) => {
    const pub = publicConfig(runtime.config);
    return json(res, 200, {
      ok: true,
      config: pub.config,
      secrets: pub.secrets,
      configFile: runtime.config.paths.configFile,
      settingsFile: runtime.config.paths.settingsFile,
    });
  });

  router.post('/api/config', async (runtime, req, res) => {
    const body = await readBody(req);
    try {
      const out = applyConfigPatch(runtime, body && body.patch);
      const pub = publicConfig(runtime.config);
      return json(res, 200, {
        ok: true,
        changed: out.changed,
        clearedSettings: out.cleared,
        config: pub.config,
        secrets: pub.secrets,
        status: statusPayload(runtime),
      });
    } catch (err) {
      return json(res, 400, { ok: false, error: String((err && err.message) || err) });
    }
  });
};
