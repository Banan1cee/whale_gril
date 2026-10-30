'use strict';

/**
 * 提醒的 HTTP 接口。
 *
 *   GET  /api/reminders          启动器列表（本机）
 *   POST /api/reminders/cancel   取消一条（本机）
 *   GET  /api/reminders/due      桥接来领到点的（只允许本机 + 桥接 token）
 *   POST /api/reminders/ack      桥接回执（只允许本机 + 桥接 token）
 *
 * 发送在桥接那边做，服务端只存状态，不直接发消息。
 */

const { json, readBody } = require('../util');
const { isLoopbackRequest } = require('../security');

const BRIDGE_ONLY = new Set(['/api/reminders/due', '/api/reminders/ack']);

module.exports = function register(router) {
  router.pattern(/^\/api\/reminders(?:\/.*)?$/, async (runtime, req, res, info) => {
    const service = runtime.reminders;
    if (!service) return json(res, 404, { ok: false, error: '提醒未启用' });
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '提醒接口仅允许本机访问' });
    if (BRIDGE_ONLY.has(info.pathname)) {
      const gw = runtime.gateways && runtime.gateways.get && runtime.gateways.get('wechat');
      if (!gw || !gw.verifyToken(req, null)) {
        return json(res, 403, { ok: false, error: '桥接 token 不正确' });
      }
    }
    const method = req.method || 'GET';

    if (info.pathname === '/api/reminders' && method === 'GET') {
      const rules = service.rules();
      return json(res, 200, {
        ok: true,
        items: service.list(),
        // 规则跟主动搭话同源同语义，但存在 config.reminder.*，界面也独立
        rules: {
          enabled: rules.enabled,
          maxPerDay: rules.dailyCap,
          quietAfterMinutes: rules.quietAfterMinutes,
          sentToday: rules.sentToday,
        },
      });
    }

    if (info.pathname === '/api/reminders/cancel' && method === 'POST') {
      const body = await readBody(req);
      const out = service.cancel(body && body.id);
      if (!out.ok) return json(res, out.statusCode || 400, out);
      runtime.logger.info('提醒已取消：' + out.item.text);
      return json(res, 200, { ok: true, item: out.item });
    }

    if (info.pathname === '/api/reminders/due' && method === 'GET') {
      const items = service.due();
      // 桥接据此睡到下一个点（准点靠这个，不靠轮询）
      const nextDueAt = service.nextDueAt();
      if (items.length) runtime.logger.info(`提醒到期 ${items.length} 条，等桥接发送`);
      return json(res, 200, { ok: true, items, nextDueAt, now: Date.now() });
    }

    if (info.pathname === '/api/reminders/ack' && method === 'POST') {
      const body = await readBody(req);
      const out = service.ack(body && body.id, { ok: Boolean(body && body.ok), error: (body && body.error) || '' });
      if (!out.ok) return json(res, out.statusCode || 400, out);
      const it = out.item;
      runtime.logger.info(`提醒回执：${it.status}${it.error ? '（' + it.error + '）' : ''} —— ${it.text}`);
      return json(res, 200, { ok: true, item: it });
    }

    return json(res, 404, { ok: false, error: '没有这个接口' });
  });
};
