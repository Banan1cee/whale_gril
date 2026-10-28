'use strict';

const {
  wechatAccountsPayload,
  refreshWechatAccounts,
  matchAccountDir,
} = require('../../services/wechat');
const { applyConfigPatch } = require('../../infra/configPatch');
const { json, readBody } = require('../util');

module.exports = function register(router) {
  // ---- 微信多账号：列账号 / 刷新昵称 / 选账号 ----
  // 网页「设置 → 微信账号」用这三条。选账号 = 把 config.json 的 wechat.account
  // 改成目标账号目录；桥接发现这个值变了会自己 exit 7 让 bridge_loop 拉起来。
  router.get('/api/wechat/accounts', (runtime, req, res) => {
    return json(res, 200, wechatAccountsPayload(runtime));
  });

  router.post('/api/wechat/accounts/refresh', async (runtime, req, res) => {
    const out = await refreshWechatAccounts(runtime);
    const payload = wechatAccountsPayload(runtime);
    if (!out.ok) return json(res, 200, { ...payload, refreshed: false, error: out.error || '扫描失败' });
    return json(res, 200, { ...payload, refreshed: true });
  });

  router.post('/api/wechat/account', async (runtime, req, res) => {
    const body = await readBody(req);
    const wanted = String((body && body.account) || '').trim();
    const snapshot = wechatAccountsPayload(runtime);
    if (wanted && !matchAccountDir(snapshot.accounts, wanted)) {
      const list = snapshot.accounts.map((a) => a.account).join('、') || '（一个都没扫到）';
      return json(res, 400, { ok: false, error: `本机没有账号 ${wanted}。现有：${list}` });
    }
    const out = applyConfigPatch(runtime, { 'wechat.account': wanted });
    runtime.logger.info(`微信账号已设为 ${wanted || '自动（按最近活跃选）'}（桥接会在几秒内自动重启）`);
    return json(res, 200, {
      ...wechatAccountsPayload(runtime),
      changed: out.changed,
      needBridgeRestart: true,
    });
  });
};
