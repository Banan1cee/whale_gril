'use strict';

const personaStore = require('../../persona/store');
const presets = require('../../persona/presets');
const { applyPersonaPatch } = require('../../services/persona');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  router.get('/api/persona', (runtime, req, res) => {
    return json(res, 200, {
      ok: true,
      persona: personaStore.summary(runtime.config),
      llm: {
        provider: runtime.llm.provider,
        providerLabel: runtime.llm.providerLabel,
        model: runtime.llm.model,
        mock: runtime.llm.isMock,
      },
    });
  });

  router.post('/api/persona', async (runtime, req, res) => {
    const body = await readBody(req);
    return json(res, 200, applyPersonaPatch(runtime, body));
  });

  // 人设预设：personas/ 下每个版本一个文件
  router.get('/api/persona/presets', (runtime, req, res) => {
    return json(res, 200, { ok: true, presets: presets.list(runtime.config) });
  });

  router.post('/api/persona/preset', async (runtime, req, res) => {
    const body = await readBody(req);
    const preset = presets.load(runtime.config, body && body.id);
    if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
    const patch = presets.toPatch(preset);
    if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
    // 记下来源，页面上能直接看到「现在用的是哪一版」
    patch.sourcePreset = preset.id;
    personaStore.save(runtime.config, patch);
    runtime.logger.info(`人设预设：已导入 ${preset.id}（${preset.version || '无版本号'}）`);
    return json(res, 200, {
      ok: true,
      applied: { id: preset.id, version: preset.version || '', name: preset.name || '' },
      persona: personaStore.summary(runtime.config),
    });
  });
};
