'use strict';

const { resolveRuntime, maskKey } = require('../infra/config');
const persona = require('../persona');
const personaStore = require('../persona/store');
const { matchMaster, masterWarnings } = require('../core/master');
const links = require('../adapters/links');
const { recentSenders } = require('./status');
const { noteText } = require('../memory/recall');

function debugState(runtime) {
  const { config, llm, gateways, store } = runtime;
  const rt = resolveRuntime(config);
  const now = new Date();
  const mood = persona.moodFor(now);
  const master = (config.persona && config.persona.master) || {};
  return {
    ok: true,
    nowLabel: `${persona.timeLabel(now)} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`,
    mood: { name: mood.name, hint: mood.hint },
    activity: persona.activityFor(now),
    persona: {
      name: config.persona.name,
      aliases: config.persona.aliases || [],
      ownerName: config.persona.ownerName || '',
      master: {
        names: master.names || [],
        wxids: master.wxids || [],
        // 填错了（比如把微信号当 wxid）的时候，调试台直接说出来，别让人瞎猜
        warnings: masterWarnings(config),
      },
    },
    // 最近在微信里说过话的人 + 各自的真实 senderId：主人名单该填哪一串，照着抄就行
    senders: recentSenders(store),
    llm: {
      mock: llm.isMock,
      mockSetting: typeof rt.settings.mock === 'boolean' ? rt.settings.mock : null,
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKeyMasked: maskKey(rt.apiKey),
      needsKey: llm.needsKey,
      temperature: llm.temperature,
      frequencyPenalty: llm.frequencyPenalty,
      presencePenalty: llm.presencePenalty,
    },
    chat: {
      privateMaxChars: config.chat.privateMaxChars,
      groupMaxChars: config.chat.groupMaxChars,
      historyTurns: config.chat.historyTurns,
      groupHistoryTurns: config.chat.groupHistoryTurns,
      maxBubbles: config.chat.maxBubbles,
      // 「颜文字用量」档位换算出来的真实概率（面板上看起来「没生效」时看这个）
      emojiChance: persona.emojiChanceFor(config),
      emojiLevel: (config.persona && config.persona.emojiLevel) || '正常',
    },
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerHour: config.group.maxRepliesPerHour,
    },
    links: {
      enabled: !config.links || config.links.enabled !== false,
      timeoutMs: (config.links && config.links.timeoutMs) || 6000,
    },
    personaStyle: personaStore.summary(config),
    admin: {
      configured: Boolean(config.admin && config.admin.spell),
      minutes: (config.admin && config.admin.minutes) || 30,
      spellMasked: (() => {
        const s = String((config.admin && config.admin.spell) || '');
        return s ? s.slice(0, 2) + '****' + s.slice(-2) : '';
      })(),
    },
    gateways: [...gateways.values()].map((g) => g.status()),
    memory: store.summary(),
    paths: {
      storeFile: config.paths.storeFile,
      configFile: config.paths.configFile,
      settingsFile: config.paths.settingsFile,
    },
  };
}

function debugSessions(runtime) {
  const list = [];
  for (const [key, sess] of runtime.store.sessions) {
    list.push({
      key,
      platform: sess.platform,
      chatType: sess.chatType,
      title: sess.title,
      lastActiveAt: sess.lastActiveAt,
      messageCount: sess.messages.length,
      adminUntil: sess.state.adminUntil || 0,
      profiles: Object.values(sess.profiles).map((p) => ({ uid: p.uid, name: p.name, nickname: p.nickname, notes: (p.notes || []).map((n) => noteText(n)) })),
      messages: sess.messages.slice(-8).map((m) => ({ role: m.role, name: m.name, text: m.text, ts: m.ts })),
    });
  }
  list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return list.slice(0, 50);
}

async function debugPrompt(runtime, body) {
  const config = runtime.config;
  const senderName = String(body.senderName || '').trim() || '朋友';
  const senderId = String(body.senderId || '').trim();
  const chatType = body.chatType === 'group' ? 'group' : 'private';
  const chatTitle = String(body.chatTitle || '').trim();
  const text = String(body.text || '');
  // 和微信里真正跑消息时用同一个判定（src/core/master.js），否则调试台会「说认了、实际没认」
  const masterHit = matchMaster(config, { platform: 'wechat', senderId, senderName });
  const isMaster = masterHit.isMaster;

  let linkText = '';
  if (body.readLink && text) {
    const urls = links.extractUrls(text);
    if (urls.length) {
      try {
        linkText = links.formatForPrompt(await links.describeLink(urls[0]));
      } catch {
        linkText = `对方发了一个链接（${urls[0]}），但读取失败。`;
      }
    }
  }

  const system = persona.buildSystem({
    config,
    msg: { chatType, senderName, chatTitle, isMaster, linkText },
    profile: { count: 1, notes: [] },
    notes: [],
    now: new Date(),
  });
  return {
    ok: true,
    isMaster,
    master: { isMaster, reason: masterHit.reason, warnings: masterWarnings(config) },
    system,
    linkText: Boolean(linkText),
    length: system.length,
  };
}

module.exports = { debugState, debugSessions, debugPrompt };
