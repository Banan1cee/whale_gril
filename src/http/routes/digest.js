'use strict';

/**
 * 消息汇总（digest）接口。
 *
 * GET /api/digest?since=&until=&generation=&check=1
 *   - 关着 → 404（和没这功能一样）
 *   - 开关变过（generation 对不上）→ 409，让旧任务丢弃
 *   - check=1 只回开关状态，不取内容
 * 桥接定时来取；本地桥接那一侧接进汇总线程是另外一步。
 */

const { json } = require('../protocol');

module.exports = function register(router) {
  router.get('/api/digest', (runtime, req, res) => {
    const service = runtime.bot && runtime.bot.digestService;
    if (!service) return json(res, 404, { ok: false, error: '消息汇总未开启' });
    const q = new URL(req.url, 'http://localhost');
    const result = service.read({
      since: q.searchParams.get('since') ?? 0,
      until: q.searchParams.get('until') ?? undefined,
      generation: q.searchParams.get('generation') || '',
      check: q.searchParams.get('check') === '1',
    });
    return json(res, result.status, result.body);
  });
};
