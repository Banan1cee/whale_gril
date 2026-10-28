'use strict';

const { resolveRuntime, maskKey } = require('../infra/config');

/** 状态接口用的精简记忆统计 */
function storeSummary(runtime) {
  const s = runtime.store.summary();
  return { sessions: s.sessions, messages: s.messages, notes: s.notes, totalMessages: s.totalMessages, totalReplies: s.totalReplies };
}

function statusPayload(runtime) {
  const { config, llm, gateways } = runtime;
  const rt = resolveRuntime(config);
  return {
    ok: true,
    name: config.persona.name,
    version: runtime.version,
    node: process.version,
    uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
    mock: llm.isMock,
    provider: llm.provider,
    providerLabel: llm.providerLabel,
    needsKey: llm.needsKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    temperature: llm.temperature,
    memory: storeSummary(runtime),
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerHour: config.group.maxRepliesPerHour,
    },
    gateways: [...gateways.values()].map((g) => g.status()),
    webhookPaths: [...gateways.keys()].map((p) => `/webhook/${p}`),
  };
}

/** 最近的发言者：昵称 + 真实 senderId（主人名单照着这个填） */
function recentSenders(store, limit = 8) {
  const seen = new Map();
  if (!store || !store.sessions) return [];
  for (const sess of store.sessions.values()) {
    for (const m of sess.messages || []) {
      if (m.role !== 'user' || !m.uid) continue;
      const uid = String(m.uid);
      const ts = Number(m.ts || 0);
      const cur = seen.get(uid);
      if (cur && cur.ts >= ts) continue;
      seen.set(uid, {
        uid,
        name: String(m.name || ''),
        platform: sess.platform || '',
        chatType: sess.chatType || 'private',
        ts,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

/* ---------------- 消息汇总 ---------------- */

function buildDigest(items) {
  if (!items.length) return { ok: true, count: 0, text: '' };
  const map = new Map();
  for (const it of items) {
    const key = (it.chatType === 'group' ? '群 ' : '私聊 ') + (it.chat || it.sender || '');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  const lines = [`📥 消息汇总（${items.length} 条）`];
  let n = 0;
  for (const [key, arr] of map) {
    lines.push(`【${key}】${arr.length} 条`);
    for (const it of arr.slice(-5)) {
      lines.push(`- ${String(it.sender || '对方')}：${String(it.text || '').replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    n += 1;
    if (n >= 10) { lines.push('……还有更多会话未列出'); break; }
  }
  return { ok: true, count: items.length, text: lines.join('\n') };
}

function replyChannelLabel(config) {
  const g = (config.gateway && config.gateway.wechat) || {};
  if (g.outboundUrl) return `中转网关 ${g.outboundUrl}`;
  return '本地桥接（要另开一个「启动微信桥接.bat」窗口，回复才发得出去）';
}

module.exports = { storeSummary, statusPayload, recentSenders, buildDigest, replyChannelLabel };
