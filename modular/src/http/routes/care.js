'use strict';

const care = require('../../services/care');
const features = require('../../infra/features');
const { careForChat } = require('../../services/careChat');
const { json } = require('../util');

module.exports = function register(router) {
  // 主动搭话：桥接定时来问「现在该不该发」（时间窗 / 频率 / 每日上限都在 services/care.js 里算）
  router.get('/api/care/due', (runtime, req, res, info) => {
    const q = info.url;
    const last = Number(q.searchParams.get('last') || 0);
    const sentToday = Number(q.searchParams.get('sentToday') || 0);
    const out = care.careDue(runtime.config, {
      lastSentTs: Number.isFinite(last) && last > 0 ? last : 0,
      sentToday: Number.isFinite(sentToday) ? sentToday : 0,
    });
    // 主动搭话的收件人规则（默认只找主人）：
    //   群里一律不发（除非 care.allowGroups）；非主人的私聊也不发（除非 care.allowOthers）
    const careCfg = runtime.config.care || {};
    const allowGroups = features.toBool(careCfg.allowGroups, false);
    const allowOthers = features.toBool(careCfg.allowOthers, false);
    const onlyMaster = features.toBool(careCfg.onlyMaster, true);
    const chatHint = String(q.searchParams.get('chat') || '');
    // 只有调用方明确传了 chat（声明要发给谁）才在这里拦；
    // 现役桥接不传 chat，收件人规则由桥接自己挑目标时保证（默认只挑主人）。
    if (out.due && chatHint && !allowGroups && /@chatroom$/i.test(chatHint)) {
      return json(res, 200, { ok: true, due: false, reason: 'group_not_allowed' });
    }
    if (out.due && chatHint && onlyMaster && !allowOthers) {
      const masters = ((runtime.config.persona || {}).master || {}).wxids || [];
      const isMasterChat = masters.some((m) => m && String(m).trim() && String(m).trim() === chatHint);
      if (!isMasterChat) {
        return json(res, 200, { ok: true, due: false, reason: 'only_master' });
      }
    }
    return json(res, 200, { ok: true, ...out });
  });

  // 主动搭话：生成那句关心的话（带最近聊天上下文，避免每次同一句）
  router.get('/api/care', async (runtime, req, res, info) => {
    try {
      const out = await careForChat(runtime, info.url.searchParams.get('chat') || '');
      return json(res, 200, out);
    } catch (err) {
      runtime.logger.warn('生成搭话失败：' + (err && err.message));
      return json(res, 500, { ok: false, error: String((err && err.message) || err) });
    }
  });
};
