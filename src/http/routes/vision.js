'use strict';

const vision = require('../../adapters/vision');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  // 「测试看图」：拿内置的 64x64 PNG 试一下 Key 通不通。
  // body.apiKey 可选 —— 网页里可以先测再保存。
  router.post('/api/vision/test', async (runtime, req, res) => {
    let vbody = {};
    try { vbody = await readBody(req); } catch { vbody = {}; }
    const override = vbody && typeof vbody.apiKey === 'string' ? vbody.apiKey.trim() : '';
    const cfg = override
      ? { ...runtime.config, vision: { ...(runtime.config.vision || {}), apiKey: override } }
      : runtime.config;
    try {
      const text = await vision.describe(cfg, {
        imageBase64: vision.TEST_IMAGE,
        mime: 'image/png',
        prompt: '这张图是什么颜色？只回答颜色。',
      });
      return json(res, 200, { ok: true, sample: String(text || '').slice(0, 60), vision: vision.status(runtime.config) });
    } catch (err) {
      return json(res, 500, { ok: false, error: String((err && err.message) || err), vision: vision.status(runtime.config) });
    }
  });

  router.post('/api/vision', async (runtime, req, res) => {
    try {
      const body = await readBody(req, 12 * 1024 * 1024);
      const text = await vision.describe(runtime.config, {
        imageBase64: body && body.image,
        mime: (body && body.mime) || 'image/jpeg',
        prompt: (body && body.prompt) || '',
      });
      return json(res, 200, { ok: true, text });
    } catch (err) {
      runtime.logger.warn('图片识别失败：' + (err && err.message));
      return json(res, err.statusCode || 500, { ok: false, error: String((err && err.message) || err) });
    }
  });
};
