'use strict';

const { maskKey } = require('../infra/config');
const { LIMITS } = require('../memory/constants');

/** 状态接口用的精简记忆统计 */
function storeSummary(runtime) {
  const s = runtime.store.summary();
  return { sessions: s.sessions, messages: s.messages, notes: s.notes, totalMessages: s.totalMessages, totalReplies: s.totalReplies };
}

/**
 * 本轮用量：只回计数、命中率和价格，绝不带 API Key / 提示词 / 消息正文。
 * 字段逐个白名单输出，以后 bot.lastUsage 里多挂了什么也不会顺着接口漏出去。
 */
function usageSnapshot(runtime) {
  const u = runtime && runtime.bot && runtime.bot.lastUsage;
  if (!u) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const cost = u.cost && typeof u.cost === 'object'
    ? {
      cny: u.cost.cny == null ? null : num(u.cost.cny),
      band: u.cost.band === 'peak' || u.cost.band === 'idle' ? u.cost.band : null,
      model: u.cost.model == null ? null : String(u.cost.model),
    }
    : null;
  return {
    promptTokens: num(u.promptTokens),
    cacheHitTokens: num(u.cacheHitTokens),
    cacheMissTokens: num(u.cacheMissTokens),
    completionTokens: num(u.completionTokens),
    hitRate: num(u.hitRate),
    estimatedPromptTokens: num(u.estimatedPromptTokens),
    ratio: num(u.ratio),
    cost,
    at: num(u.at),
  };
}

/**
 * 单轮预算（只给内部 status / 调试台计数；不接 UI、不提供预算接口）。
 * system 只测量，不参与裁剪。
 */
function budgetSnapshot(runtime) {
  const b = runtime && runtime.bot && runtime.bot.lastBudget;
  return {
    systemTokens: b ? b.systemTokens : 0,
    dialogueBudget: b ? b.dialogueBudget : LIMITS.dialogueBudget,
    // 真实输入估算（system + 实际 turns），不再是 system + 预算上限
    estimatedPromptTokens: b ? (b.estimatedPromptTokens || b.estimatedInputTokens || 0) : 0,
    estimatedInputTokens: b ? (b.estimatedPromptTokens || b.estimatedInputTokens || 0) : 0,
    calibratedPromptTokens: b ? (b.calibratedPromptTokens || 0) : 0,
    calibrationScale: b ? (b.calibrationScale || 1) : 1,
    calibrationSamples: b ? (b.calibrationN || 0) : 0,
    hardTotalTokens: b ? b.hardTotalTokens : LIMITS.hardTotalTokens,
    memoryTokens: b ? b.memoryTokens : 0,
    summaryTokens: b ? b.summaryTokens : 0,
    recentTokens: b ? b.recentTokens : 0,
    lastUsage: usageSnapshot(runtime),
  };
}

function statusPayload(runtime) {
  const { config, llm, gateways } = runtime;
  const apiKey = llm.apiKey;
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
    keyMasked: maskKey(apiKey),
    hasKey: Boolean(apiKey),
    temperature: llm.temperature,
    memory: storeSummary(runtime),
    budget: budgetSnapshot(runtime),
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerMinute: config.group.maxRepliesPerMinute,
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

/**
 * 最近消息（跨会话，按时间倒序）：给启动器状态页的「最近动态」用。
 * 只读内存里的会话快照，不碰磁盘；正文截断，避免把长消息整段塞给界面。
 */
function recentMessages(store, limit = 10) {
  const out = [];
  if (!store || !store.sessions) return out;
  for (const sess of store.sessions.values()) {
    for (const m of sess.messages || []) {
      const text = String(m.text || '').trim();
      if (!text) continue;
      out.push({
        ts: Number(m.ts || 0),
        who: String(m.name || (m.role === 'assistant' ? '鲸鲸' : '对方')),
        text: text.slice(0, 200),
        role: m.role || 'user',
        chatType: sess.chatType || 'private',
        platform: sess.platform || '',
      });
    }
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, Math.max(1, limit));
}

function replyChannelLabel(config) {
  const g = (config.gateway && config.gateway.wechat) || {};
  if (g.outboundUrl) return `中转网关 ${g.outboundUrl}`;
  return '本地桥接（要另开一个「启动微信桥接.bat」窗口，回复才发得出去）';
}

module.exports = { storeSummary, statusPayload, recentSenders, recentMessages, replyChannelLabel, budgetSnapshot, usageSnapshot };
