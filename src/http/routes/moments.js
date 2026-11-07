'use strict';

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');

module.exports = function register(router) {
  // 即使启用了远程控制，朋友圈隐私也不随管理接口暴露到局域网。
  const local = req => { if (!isLoopbackRequest(req)) throw Object.assign(new Error('朋友圈仅允许本机访问'), { statusCode: 403 }); };
  const bridge = (runtime, req) => {
    local(req);
    if (!runtime.gateways.get('wechat')?.verifyToken(req, null)) throw Object.assign(new Error('桥接 token 不正确'), { statusCode: 403 });
  };
  router.post('/api/moments/read', async (runtime, req, res) => {
    local(req);
    return json(res, 200, runtime.moments.request(await readBody(req)));
  });
  router.post('/api/moments/action', async (runtime, req, res) => {
    local(req);
    return json(res, 200, runtime.moments.action(await readBody(req)));
  });
  router.get('/api/moments/result', (runtime, req, res, info) => {
    local(req);
    return json(res, 200, runtime.moments.result(info.url.searchParams.get('id')));
  });
  router.post('/api/moments/claim', async (runtime, req, res) => {
    bridge(runtime, req);
    const body = await readBody(req);
    return json(res, 200, { ok: true, job: runtime.moments.claim(body.account) });
  });
  router.post('/api/moments/complete', async (runtime, req, res) => {
    bridge(runtime, req);
    return json(res, 200, runtime.moments.complete(await readBody(req)));
  });
};
