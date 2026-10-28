'use strict';

const { saveSettings } = require('../infra/config');
const personaStore = require('../persona/store');

/* ---------------- 人设调教（浏览器表单用） ---------------- */

function applyPersonaPatch(runtime, body) {
  if (body && body.reset) {
    personaStore.clear(runtime.config);
    runtime.logger.info('人设调教：恢复默认');
    return { ok: true, persona: personaStore.summary(runtime.config) };
  }
  const patch = {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (body.name !== undefined) patch.name = str(body.name, 40) || '鲸鲸';
  if (body.job !== undefined) patch.job = str(body.job, 80) || '自由职业';
  if (body.appearance !== undefined) patch.appearance = str(body.appearance, 400);
  if (body.personality !== undefined) patch.personality = str(body.personality, 500);
  if (body.background !== undefined) patch.background = str(body.background, 500);
  if (body.customPrompt !== undefined) patch.customPrompt = str(body.customPrompt, 6000);
  if (body.age !== undefined) patch.age = Math.max(1, Math.min(120, Number(body.age) || 23));
  if (body.preset !== undefined) patch.preset = str(body.preset, 20);
  if (body.text !== undefined) patch.text = str(body.text, 300);
  if (body.emoji !== undefined) patch.emoji = ['关', '少', '正常', '多'].includes(body.emoji) ? body.emoji : '正常';
  if (body.historyTurns !== undefined) patch.historyTurns = Math.max(4, Math.min(400, Number(body.historyTurns) || 200));
  if (body.groupHistoryTurns !== undefined) patch.groupHistoryTurns = Math.max(2, Math.min(300, Number(body.groupHistoryTurns) || 150));
  if (body.privateMaxChars !== undefined) patch.privateMaxChars = Math.max(40, Math.min(800, Number(body.privateMaxChars) || 140));
  if (body.groupMaxChars !== undefined) patch.groupMaxChars = Math.max(20, Math.min(300, Number(body.groupMaxChars) || 70));
  for (const k of ['emotions', 'proactive', 'opinions', 'links', 'freeChat']) {
    if (body[k] !== undefined) patch[k] = Boolean(body[k]);
  }
  if (Array.isArray(body.mutedGroups)) patch.mutedGroups = body.mutedGroups.map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  personaStore.save(runtime.config, patch);
  if (body.model) {
    try {
      saveSettings(runtime.config, { model: String(body.model).slice(0, 80), mock: false });
      runtime.llm.reload();
    } catch (err) {
      runtime.logger.warn('人设调教：切模型失败 ' + (err && err.message));
    }
  }
  runtime.logger.info('人设调教：已保存 ' + Object.keys(patch).join(','));
  return {
    ok: true,
    persona: personaStore.summary(runtime.config),
    llm: {
      provider: runtime.llm.provider,
      providerLabel: runtime.llm.providerLabel,
      model: runtime.llm.model,
      mock: runtime.llm.isMock,
    },
  };
}

module.exports = { applyPersonaPatch };
