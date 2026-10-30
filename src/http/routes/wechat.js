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

  // ---- 联系人缓存：选择器（白名单 / 黑名单）用 ----
  // 微信的 wxid 只有桥接读得到，桥接定期把清单推上来；这里只做缓存和查询。
  router.get('/api/wechat/contacts', (runtime, req, res, info) => {
    const contacts = runtime.contacts;
    if (!contacts) return json(res, 200, { ok: true, items: [], updatedAt: 0, total: 0, account: '' });
    const q = info.url.searchParams.get('q') || '';
    const type = String(info.url.searchParams.get('type') || 'all');
    return json(res, 200, contacts.payload({ q, type: ['user', 'group'].includes(type) ? type : 'all' }));
  });

  router.post('/api/wechat/contacts/sync', async (runtime, req, res) => {
    // 只有桥接能推：token 不对一律 403，避免同机别的程序往里塞假联系人
    const gw = runtime.gateways && runtime.gateways.get && runtime.gateways.get('wechat');
    if (!gw || !gw.verifyToken(req, null)) {
      return json(res, 403, { ok: false, error: '桥接 token 不正确' });
    }
    const contacts = runtime.contacts;
    if (!contacts) return json(res, 503, { ok: false, error: '联系人缓存未启用' });
    const body = await readBody(req);
    const out = contacts.sync({
      account: (body && body.account) || '',
      items: (body && body.items) || [],
      at: (body && body.at) || Date.now(),
    });
    runtime.logger.info(`联系人缓存已同步：${out.count} 条${out.account ? `（账号 ${out.account}）` : ''}`);
    return json(res, 200, { ok: true, ...out });
  });
};
