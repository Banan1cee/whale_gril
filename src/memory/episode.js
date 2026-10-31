'use strict';

/**
 * Episode：一段连续话题，从开始到关闭。
 *
 * 关闭条件（任一）：空闲 30 分钟 / 话题切换 / 累计 6,000 token / 持续 3 小时。
 * 关闭时：生成摘要 → 给每个发言人写 L2 事件 → 抽 fact / trait / thread → 清空 L3。
 * 幂等：同一个 episodeId 只写一次 L2（meta.closedEpisodes 去重 + 事件 id 去重 + 写入前检查）。
 */
const { LIMITS, DAY_MS } = require('./constants');
const personCard = require('./personCard');
const extractor = require('./extractor');
const compression = require('./compression');
const retrieval = require('./retrieval');
const { personHash } = require('./hash');

const TOPIC_SHIFT_RE = /(换个话题|换话题|不说这个|不聊这个|聊点别的|说点别的|跳过这个话题|别聊了|算了不聊)/;

function dateString(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function episodeStart(chat, { now = Date.now(), seq = chat.meta.nextSeq } = {}) {
  chat.meta.episodeSeq = (Number(chat.meta.episodeSeq) || 0) + 1;
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  const id = `ep_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${String(chat.meta.episodeSeq).padStart(2, '0')}`;
  chat.meta.episode = {
    id,
    startedAt: now,
    lastMessageAt: now,
    tokens: 0,
    userMessages: 0,
    messageSeqFrom: seq,
    messageSeqTo: seq - 1,
    activeTopic: '',
    participants: [],
  };
  return chat.meta.episode;
}

function ensureEpisode(chat, { now = Date.now() } = {}) {
  if (!chat.meta.episode) episodeStart(chat, { now });
  return chat.meta.episode;
}

/** 每条消息进来后更新 episode 计数 */
function touchEpisode(chat, message, { now = Date.now() } = {}) {
  const ep = ensureEpisode(chat, { now });
  ep.lastMessageAt = now;
  ep.tokens += Number(message && message.tokens) || 0;
  ep.messageSeqTo = Math.max(ep.messageSeqTo, Number(message && message.seq) || 0);
  if (message && message.role === 'user') {
    ep.userMessages += 1;
    if (message.uid) {
      const uid = String(message.uid);
      if (!ep.participants.includes(uid)) ep.participants.push(uid);
    }
    if (!ep.activeTopic && message.text) ep.activeTopic = String(message.text).replace(/\s+/g, ' ').slice(0, 20);
  }
  return ep;
}

/** 关闭条件；返回原因或 null */
function shouldClose(chat, { text = '', now = Date.now() } = {}) {
  const ep = chat.meta.episode;
  if (!ep) return null;
  if (now - ep.lastMessageAt >= LIMITS.episodeIdleMinutes * 60000) return 'idle';
  if (now - ep.startedAt >= LIMITS.episodeMaxHours * 3600000) return 'max_hours';
  if (ep.tokens >= LIMITS.episodeMaxTokens) return 'tokens';
  if (ep.userMessages >= LIMITS.topicShiftMinMessages) {
    if (TOPIC_SHIFT_RE.test(String(text || ''))) return 'topic_shift';
    const recent = chat.messages
      .filter((m) => m.role === 'user' && m.seq <= ep.messageSeqTo && m.text)
      .slice(-6)
      .map((m) => m.text);
    if (text && recent.length >= 5 && retrieval.topicOverlap(text, recent) < LIMITS.topicShiftOverlap) {
      return 'topic_shift';
    }
  }
  return null;
}

function episodeMessages(chat, ep) {
  if (!ep) return [];
  return chat.messages.filter((m) => m.seq >= ep.messageSeqFrom && m.seq <= ep.messageSeqTo && m.text);
}

function speakersOf(messages) {
  const seen = new Map();
  for (const m of messages) {
    if (m.role !== 'user' || !m.uid) continue;
    if (!seen.has(String(m.uid))) seen.set(String(m.uid), m.name || '群友');
  }
  return [...seen.entries()].map(([uid, name]) => ({ uid, name }));
}

function enqueue(chat, task) {
  chat.closeQueue = (chat.closeQueue || Promise.resolve()).then(task, task);
  return chat.closeQueue;
}

/**
 * 关闭一个 episode，写 L2 + thread。可重复调用，第二次直接返回 already_closed。
 * @returns {Promise<{closed:boolean, reason?:string, episodeId?:string, events?:number}>}
 */
async function closeEpisode({ chat, chatStore, llm = null, logger = null, now = Date.now(), reason = 'manual', episode = null }) {
  const ep = episode || chat.meta.episode;
  if (!ep) return { closed: false, reason: 'no_episode' };
  if ((chat.meta.closedEpisodes || []).includes(ep.id)) return { closed: false, reason: 'already_closed', episodeId: ep.id };
  if (chat.closingEpisode === ep.id) return { closed: false, reason: 'closing', episodeId: ep.id };
  chat.closingEpisode = ep.id;
  try {
    const messages = episodeMessages(chat, ep);
    const speakers = speakersOf(messages);
    const date = dateString(now);
    const allUids = speakers.map((s) => s.uid);
    const extracted = await extractor.extractEpisode({ messages, llm, speakers, logger, now });
    const summaryText = String(extracted.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400)
      || extractor.extractiveSummary(messages, 200);
    const messageIds = messages.filter((m) => m.role === 'user').map((m) => m.id).slice(-40);
    let writtenEvents = 0;

    // 没有发言人（只有机器人自己的消息）：不建卡，只记一条 chat 级关闭
    for (const speaker of speakers) {
      const card = chatStore.ensurePerson(chat, speaker.uid, speaker.name);
      const personFacts = extracted.facts.filter((f) => !f.uid || f.uid === speaker.uid);
      for (const fact of personFacts) {
        personCard.addPreference(card, {
          text: fact.text,
          confidence: Math.min(0.9, Number(fact.confidence) || 0.7),
          source: messageIds[messageIds.length - 1] || '',
          kind: 'fact',
        }, { chatId: chat.chatId, now });
      }
      const personTraits = extracted.traits.filter((t) => !t.uid || t.uid === speaker.uid);
      for (const trait of personTraits) {
        personCard.addTrait(card, {
          text: trait.text,
          confidence: trait.confidence,
          evidence: (trait.evidence && trait.evidence.length ? trait.evidence : messageIds).slice(-8),
        }, { chatId: chat.chatId, now });
      }
      const personThreads = extracted.threads.filter((t) => !t.uid || t.uid === speaker.uid);
      for (const thread of personThreads) {
        personCard.addThread(card, { text: thread.text }, { chatId: chat.chatId, now });
      }
      const personEvents = extracted.events.filter((e) => !e.uid || e.uid === speaker.uid);
      for (const ev of personEvents) {
        personCard.addEvent(card, {
          id: `evt_${ep.id}_${personHash(speaker.uid).slice(0, 6)}${personEvents.indexOf(ev) ? '_' + personEvents.indexOf(ev) : ''}`,
          date,
          title: ev.title,
          summary: ev.summary,
          keywords: ev.keywords,
          participants: allUids,
          importance: ev.importance,
          confidence: ev.confidence,
          valence: ev.valence,
          resolved: ev.resolved,
          source: { chatId: chat.chatId, messageIds },
        }, { chatId: chat.chatId, now });
        if (ev.threadText) personCard.addThread(card, { text: ev.threadText }, { chatId: chat.chatId, now });
        writtenEvents += 1;
      }
      // 没有抽到具体事件：把整段 episode 压成一条，保证「这段事」不会消失
      if (!personEvents.length) {
        personCard.addEvent(card, {
          id: `evt_${ep.id}_${personHash(speaker.uid).slice(0, 6)}`,
          date,
          title: (ep.activeTopic || messages.find((m) => m.role === 'user' && m.text) || {}).text?.slice(0, 20) || '一段聊天',
          summary: summaryText || '这段聊了一会儿。',
          keywords: [],
          participants: allUids,
          importance: 0.5,
          confidence: extracted.fallback ? 0.55 : 0.7,
          source: { chatId: chat.chatId, messageIds },
        }, { chatId: chat.chatId, now });
        writtenEvents += 1;
      }
      chatStore.saveCard(chat, card);
    }

    // 幂等标记 + 清空 L3
    chat.meta.closedEpisodes = [...(chat.meta.closedEpisodes || []), ep.id].slice(-LIMITS.closedEpisodeMemory);
    chat.meta.lastClosedEpisodeId = ep.id;
    compression.resetSummary(chat, {
      episodeId: ep.id,
      coveredThroughSeq: ep.messageSeqTo,
      now,
    });
    // 关闭不等于失忆：这一段的最终摘要留在 summary 里（后续事件段继续合并，上限 900 token），
    // 原文仍在 messages.jsonl；只是不再占 prompt 的 recent 缓冲。
    if (summaryText) {
      compression.applySegment(chat, {
        text: summaryText,
        fromSeq: ep.messageSeqFrom,
        toSeq: ep.messageSeqTo,
        now,
      });
    }
    if (chat.meta.episode && chat.meta.episode.id === ep.id) chat.meta.episode = null;
    chatStore.saveSummary(chat);
    chatStore.saveMeta(chat, { immediate: true });

    if (logger) {
      logger.info(`episode 关闭（${reason}）：事件 ${writtenEvents} 条（chat ${chat.chatId}）`);
    }
    return { closed: true, episodeId: ep.id, reason, events: writtenEvents, summary: summaryText };
  } finally {
    if (chat.closingEpisode === ep.id) delete chat.closingEpisode;
  }
}

/**
 * 在写入新消息前检查是否要换 episode。
 * @returns {{reason:string, promise:Promise|null}|null}
 */
function rotateIfNeeded({ chat, text = '', now = Date.now(), chatStore, llm = null, logger = null }) {
  const ep = chat.meta.episode;
  if (!ep) {
    episodeStart(chat, { now });
    return null;
  }
  const reason = shouldClose(chat, { text, now });
  if (!reason) return null;
  const snapshot = { ...ep };
  // 关闭动作是异步的，但 L3 缓冲要立刻推进水位：否则这一轮会把刚关闭的旧原文
  // 当成「刚发生」又塞回 prompt。最终摘要稍后由后台补进 summary。
  compression.resetSummary(chat, {
    episodeId: snapshot.id,
    coveredThroughSeq: snapshot.messageSeqTo,
    now,
  });
  chatStore.saveSummary(chat);
  const promise = enqueue(chat, () => closeEpisode({ chat, chatStore, llm, logger, now, reason, episode: snapshot }))
    .catch((err) => {
      if (logger) logger.warn('episode 关闭失败（不影响聊天）：' + ((err && err.message) || err));
      return null;
    });
  episodeStart(chat, { now });
  return { reason, promise };
}

/** 启动/空闲扫描：距上次消息超过 30 分钟就补写 L2 */
function closeIdleEpisodes({ chat, chatStore, llm = null, logger = null, now = Date.now() }) {
  const ep = chat.meta.episode;
  if (!ep) return null;
  if (now - ep.lastMessageAt < LIMITS.episodeIdleMinutes * 60000) return null;
  const snapshot = { ...ep };
  return enqueue(chat, () => closeEpisode({ chat, chatStore, llm, logger, now, reason: 'idle', episode: snapshot }))
    .catch((err) => {
      if (logger) logger.warn('补写 episode 失败：' + ((err && err.message) || err));
      return null;
    });
}

module.exports = {
  TOPIC_SHIFT_RE,
  episodeStart,
  ensureEpisode,
  touchEpisode,
  shouldClose,
  episodeMessages,
  speakersOf,
  closeEpisode,
  rotateIfNeeded,
  closeIdleEpisodes,
  dateString,
  DAY_MS,
};
