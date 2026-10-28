'use strict';

/**
 * 主人身份认证 —— 全项目只在这里判断「这条消息是不是主人发的」。
 *
 * 为什么要单独一个文件：以前 bot.js（真正跑消息的地方）和 server.js（调试台预览提示词）
 * 各写了一套规则，两边不一致 —— 调试台显示「识别为主人」，微信里却当陌生人，
 * 于是在控制台怎么改都像没生效。现在两边都调 matchMaster()。
 *
 * 判定顺序：
 *   1. senderId 等于 master.wxids 里的某一项 → 是主人（微信内部 id，改不了昵称也冒充不了）
 *   2. 微信以外的渠道（网页 / 抖音）没有稳定 id，昵称对上就算
 *   3. 微信里只有当 master.wxids 里没有任何「像 wxid 的值」时，才退回用昵称认
 *      —— 微信里谁都能改昵称，配了真 wxid 还认昵称就等于给所有人开后门
 */

const WXID_RE = /^wxid_[A-Za-z0-9_-]+$/;

function asList(value) {
  return (Array.isArray(value) ? value : [])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
}

/** 取出主人名单（顺手去掉空行和首尾空格，网页里一行一个） */
function masterLists(config) {
  const master = (config && config.persona && config.persona.master) || {};
  return { names: asList(master.names), wxids: asList(master.wxids) };
}

/** 这串是不是微信内部 id（wxid_xxx）。自己设的微信号（形如 abc12345）和昵称都不算 */
function looksLikeWxid(value) {
  return WXID_RE.test(String(value == null ? '' : value).trim());
}

/**
 * 判断这条消息的发送者是不是主人。
 * @param {object} config 运行时配置
 * @param {{platform?: string, senderId?: string, senderName?: string}} msg
 * @returns {{
 *   isMaster: boolean, reason: string, names: string[], wxids: string[], hardIds: string[],
 *   nameHit: boolean, nameFallback: boolean, senderId: string, senderName: string, platform: string
 * }}
 * reason: 'wxid' 按 id 认的 / 'nickname' 按昵称认的 / 'name_blocked' 昵称对上了但被 rule 3 挡住 / '' 都不是
 */
function matchMaster(config, msg = {}) {
  const { names, wxids } = masterLists(config);
  const senderId = String((msg && msg.senderId) || '').trim();
  const senderName = String((msg && msg.senderName) || '').trim();
  const platform = String((msg && msg.platform) || '').trim().toLowerCase();

  const idHit = Boolean(senderId) && wxids.some((w) => w.toLowerCase() === senderId.toLowerCase());
  const nameHit = Boolean(senderName) && names.some((n) => n.toLowerCase() === senderName.toLowerCase());
  const hardIds = wxids.filter(looksLikeWxid);
  // 微信里只信 senderId；网页/抖音这类渠道没有稳定 id，才允许昵称兜底
  const nameFallback = platform !== 'wechat' || hardIds.length === 0;
  const isMaster = idHit || (nameFallback && nameHit);

  let reason = '';
  if (idHit) reason = 'wxid';
  else if (isMaster) reason = 'nickname';
  else if (nameHit) reason = 'name_blocked';

  return { isMaster, reason, names, wxids, hardIds, nameHit, nameFallback, senderId, senderName, platform };
}

/** 配置明显有问题时返回人话提示（调试台和日志用，不影响判定） */
function masterWarnings(config) {
  const { names, wxids } = masterLists(config);
  const out = [];
  if (!names.length && !wxids.length) {
    out.push('还没设置主人：persona.master.names / wxids 都是空的，谁都不算主人');
    return out;
  }
  const bad = wxids.filter((w) => !looksLikeWxid(w));
  if (bad.length) {
    out.push(
      '「' + bad.join('、') + '」不是 wxid（微信内部 id 形如 wxid_xxxxxxxx，不是你设置的微信号），' +
      '在微信里认不出来'
    );
  }
  if (!wxids.length && names.length) {
    out.push('现在只靠昵称认主人：微信里谁都能改成同名，建议在 master.wxids 里补一个真正的 wxid');
  }
  return out;
}

module.exports = { matchMaster, masterWarnings, masterLists, looksLikeWxid };
