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
    if (!probe.ok) {
      // 启动器只认顶层 error 字段；只回 probe 对象的话它拿不到文案，
      // 会把整段原始 JSON 当提示贴出来（用户看到的就是一串看不懂的字符）。
      const detail = String(probe.detail || '').trim();
      const message = String(probe.message || '连接测试没通过').trim();
      return json(res, 200, {
        ok: false,
        error: detail && !message.includes(detail) ? message + '（原始错误：' + detail.slice(0, 200) + '）' : message,
        probe,
      });
    }
    return json(res, 200, { ok: true, probe });
  });
};
