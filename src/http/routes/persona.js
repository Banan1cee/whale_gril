'use strict';

const personaStore = require('../../persona/store');
const presets = require('../../persona/presets');
const { applyPersonaPatch } = require('../../services/persona');
const { checkPersonaTokens, PERSONA_MAX_TOKENS } = require('../../persona/tokenCheck');
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
    const result = await applyPersonaPatch(runtime, body);
    return json(res, result && result.ok ? 200 : 400, result);
  });

  // 人设预设：personas/ 下每个版本一个文件
  router.get('/api/persona/presets', (runtime, req, res) => {
    return json(res, 200, { ok: true, presets: presets.list(runtime.config) });
  });

  // 预览：只回内容、不写盘 —— 页面选到哪版就先把那版填进输入框，
  // 用户看一眼再点保存，不用先点「导入」。
  router.get('/api/persona/preset', (runtime, req, res, info) => {
    const preset = presets.load(runtime.config, info.url.searchParams.get('id'));
    if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
    const patch = presets.toPatch(preset);
    if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
    return json(res, 200, {
      ok: true,
      preset: {
        id: preset.id,
        version: preset.version || '',
        name: preset.name || '',
        description: preset.description || '',
      },
      patch,
    });
  });

  router.post('/api/persona/preset', async (runtime, req, res) => {
    const body = await readBody(req);
    const preset = presets.load(runtime.config, body && body.id);
    if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
    const patch = presets.toPatch(preset);
    if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
    // 记下来源，页面上能直接看到「现在用的是哪一版」
    patch.sourcePreset = preset.id;
    // 导入预设同样做一次精确 token 校验，避免导进一个会顶爆单轮上限的人设
    const tokenCheck = await checkPersonaTokens(runtime, patch);
    if (tokenCheck.overLimit) {
      runtime.logger.warn(`人设预设 ${preset.id} 太长，拒绝导入：${tokenCheck.tokens} token`);
      return json(res, 400, {
        ok: false,
        error: `这个人设预设太长：约 ${tokenCheck.tokens} token，超过上限 ${PERSONA_MAX_TOKENS}。`,
        tokenCheck,
      });
    }
    personaStore.save(runtime.config, patch);
    runtime.logger.info(`人设预设：已导入 ${preset.id}（${preset.version || '无版本号'}，${tokenCheck.tokens} token）`);
    return json(res, 200, {
      ok: true,
      applied: { id: preset.id, version: preset.version || '', name: preset.name || '' },
      persona: personaStore.summary(runtime.config),
      tokenCheck,
    });
  });
};
