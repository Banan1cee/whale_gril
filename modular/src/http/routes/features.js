'use strict';

const features = require('../../infra/features');
const { applyConfigPatch } = require('../../infra/configPatch');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  // ---- 功能开关（控制台可开关；关掉就回到旧行为）----
  router.get('/api/features', (runtime, req, res) => {
    return json(res, 200, { ok: true, features: features.list(runtime.config) });
  });

  router.post('/api/features', async (runtime, req, res) => {
    const body = await readBody(req);
    const key = String((body && body.key) || '').trim();
    const entry = features.REGISTRY.find((f) => f.key === key);
    if (!entry) return json(res, 400, { ok: false, error: '没有这个开关：' + key });
    const on = Boolean(body.value);
    try {
      applyConfigPatch(runtime, { [entry.path]: on });
      runtime.logger.info(`功能开关 ${entry.label} → ${on ? '开' : '关'}`);
      return json(res, 200, { ok: true, key, value: on, features: features.list(runtime.config) });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  });
};
