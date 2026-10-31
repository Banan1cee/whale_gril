'use strict';

/**
 * 压缩（只影响 prompt 缓冲，不删 messages.jsonl）。
 *
 * 软阈值 2,400：后台准备「最旧 800 token」的摘要；
 * 硬阈值 3,200：应用摘要，把 recent 压回 2,400；
 * summary 上限 900：超了合并最旧段，不直接丢事实。
 *
 * 热路径只用「已准备好的摘要 / 抽取式摘要」，不在回复前等模型；
 * 需要模型摘要的后台任务走 compressAsync。
 */
const { LIMITS } = require('./constants');
const { estimateTokens, messageBudgetTokens } = require('./tokens');
const extractor = require('./extractor');

const SUMMARY_SYSTEM = [
  '你在给一段聊天做摘要，供以后回忆用。只输出 JSON，不要解释。',
  '格式：{"summary":"..."}',
  'summary：80~150 字，写当前话题、已确认事实、情绪基调、没解决的问题、上一句承诺。',
  '群聊必须保留「谁说的」，不要把多人揉成「用户说」。不要编造记录里没有的事。',
].join('\n');

function clampPromptMessage(m) {
  const textValue = String(m.text || '');
  return {
    ...m,
    text: textValue.length > LIMITS.maxTurnChars ? textValue.slice(0, LIMITS.maxTurnChars) : textValue,
  };
}

function recentSince(chat, { currentSeq = 0 } = {}) {
  const covered = Number(chat.summary && chat.summary.coveredThroughSeq) || 0;
  return chat.messages.filter((m) => m.seq > covered && (!currentSeq || m.seq < currentSeq));
}

function recentTokens(chat, opts = {}) {
  return recentSince(chat, opts).reduce((sum, m) => sum + messageBudgetTokens(m), 0);
}

/**
 * 取最近原文（含当前消息），按 token 预算从新往旧装。
 * @returns {{messages:Array, tokens:number}}
 */
function recentForPrompt(chat, { currentSeq = 0, maxTokens = LIMITS.recentMaxTokens, maxCount = LIMITS.recentMessages } = {}) {
  const covered = Number(chat.summary && chat.summary.coveredThroughSeq) || 0;
  const all = chat.messages.filter((m) => m.seq > covered);
  const window = all.slice(-Math.max(1, maxCount));
  const picked = [];
  let total = 0;
  for (let i = window.length - 1; i >= 0; i -= 1) {
    const m = clampPromptMessage(window[i]);
    const t = messageBudgetTokens(m);
    if (picked.length && total + t > maxTokens) break;
    picked.unshift(m);
    total += t;
  }
  // 当前消息必须留下：即使单条超预算也保留（只截断，不丢）
  const current = all.find((m) => m.seq === currentSeq);
  if (current && !picked.some((m) => m.seq === currentSeq)) {
    picked.push(clampPromptMessage(current));
    total += messageBudgetTokens(current);
  }
  return { messages: picked, tokens: total };
}

function parseSummary(raw) {
  const textValue = String(raw || '');
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start < 0 || end <= start) return '';
  try {
    const obj = JSON.parse(textValue.slice(start, end + 1));
    return String(obj.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  } catch {
    return '';
  }
}

async function llmSummary(messages, llm) {
  if (!llm || llm.isMock || typeof llm.complete !== 'function') return '';
  const transcript = messages
    .map((m) => `${m.role === 'assistant' ? '鲸鲸' : (m.name || '对方')}：${String(m.text).slice(0, 200)}`)
    .join('\n')
    .slice(0, 8000);
  const raw = await llm.complete({
    system: SUMMARY_SYSTEM,
    turns: [{ role: 'user', content: `聊天记录：\n${transcript}` }],
    maxTokens: 300,
  });
  return parseSummary(raw);
}

/** 取最旧的一段（目标 max(800, recent-2400) token），不包含当前消息 */
function takeChunk(messages, targetTokens) {
  const chunk = [];
  let acc = 0;
  for (const m of messages) {
    if (acc >= targetTokens && chunk.length) break;
    chunk.push(m);
    acc += messageBudgetTokens(m);
    if (chunk.length >= 300) break;
  }
  return { chunk, tokens: acc };
}

function recomputeSummary(chat) {
  const segments = Array.isArray(chat.summary.segments) ? chat.summary.segments : [];
  chat.summary.text = segments.map((s) => s.text).filter(Boolean).join('\n');
  chat.summary.tokens = estimateTokens(chat.summary.text);
  chat.summary.updatedAt = Date.now();
}

/** summary 超 900：合并最旧两段（保留每段开头），直到回到上限 */
function trimSummary(chat, { now = Date.now() } = {}) {
  const segments = Array.isArray(chat.summary.segments) ? chat.summary.segments : [];
  let guard = 0;
  while (estimateTokens(segments.map((s) => s.text).join('\n')) > LIMITS.summaryTokens && segments.length > 1 && guard < 50) {
    guard += 1;
    const a = segments.shift();
    const b = segments.shift();
    const folded = `更早：${[a, b].map((s) => String(s.text || '').slice(0, 60)).join('；')}`;
    segments.unshift({
      text: folded,
      tokens: estimateTokens(folded),
      fromSeq: Math.min(Number(a.fromSeq) || 0, Number(b.fromSeq) || 0),
      toSeq: Math.max(Number(a.toSeq) || 0, Number(b.toSeq) || 0),
      at: now,
    });
  }
  if (segments.length === 1 && estimateTokens(segments[0].text) > LIMITS.summaryTokens) {
    const textValue = segments[0].text.slice(0, LIMITS.summaryTokens);
    segments[0].text = textValue;
    segments[0].tokens = estimateTokens(textValue);
  }
  chat.summary.segments = segments;
  recomputeSummary(chat);
}

/** 写入一段摘要，并推进 coveredThroughSeq */
function applySegment(chat, { text, fromSeq, toSeq, now = Date.now() }) {
  const body = String(text || '').trim();
  if (!body) return false;
  chat.summary.segments = Array.isArray(chat.summary.segments) ? chat.summary.segments : [];
  chat.summary.segments.push({
    text: body.slice(0, 600),
    tokens: estimateTokens(body.slice(0, 600)),
    fromSeq,
    toSeq,
    at: now,
  });
  chat.summary.coveredThroughSeq = Math.max(Number(chat.summary.coveredThroughSeq) || 0, toSeq);
  trimSummary(chat, { now });
  return true;
}

/**
 * 同步压缩：只用 pending 摘要或抽取式摘要，绝不等待模型。
 * @returns {{before:number, after:number, compressed:number, chunks:number}}
 */
function compressSync(chat, { currentSeq = 0, now = Date.now() } = {}) {
  const before = recentTokens(chat, { currentSeq });
  let recent = recentSince(chat, { currentSeq });
  let tokens = before;
  let compressed = 0;
  let chunks = 0;
  while (tokens > LIMITS.hardTriggerTokens && recent.length) {
    const target = Math.max(LIMITS.compressChunkTokens, tokens - LIMITS.recentLowTokens);
    const { chunk, tokens: chunkTokens } = takeChunk(recent, target);
    if (!chunk.length) break;
    const fromSeq = chunk[0].seq;
    const toSeq = chunk[chunk.length - 1].seq;
    let textValue = '';
    const pending = chat.pendingSummary;
    if (pending && pending.fromSeq === fromSeq && pending.toSeq === toSeq && pending.text) {
      textValue = pending.text;
      chat.pendingSummary = null;
    } else {
      textValue = extractor.extractiveSummary(chunk, 220);
    }
    if (!textValue) break;
    applySegment(chat, { text: textValue, fromSeq, toSeq, now });
    recent = recent.slice(chunk.length);
    tokens -= chunkTokens;
    compressed += chunkTokens;
    chunks += 1;
  }
  return { before, after: tokens, compressed, chunks };
}

/**
 * 异步压缩：可以调用模型生成高质量摘要。模型失败 → 什么都不改（原文保留、coverage 不前进）。
 * @returns {Promise<{before:number, after:number, compressed:number, chunks:number, failed?:boolean}>}
 */
async function compressAsync(chat, { currentSeq = 0, now = Date.now(), llm = null, logger = null, requireLlm = false } = {}) {
  const before = recentTokens(chat, { currentSeq });
  if (before <= LIMITS.hardTriggerTokens) return { before, after: before, compressed: 0, chunks: 0 };
  if (requireLlm && (!llm || llm.isMock)) return { before, after: before, compressed: 0, chunks: 0, failed: true };
  let recent = recentSince(chat, { currentSeq });
  let tokens = before;
  let compressed = 0;
  let chunks = 0;
  while (tokens > LIMITS.hardTriggerTokens && recent.length) {
    const target = Math.max(LIMITS.compressChunkTokens, tokens - LIMITS.recentLowTokens);
    const { chunk, tokens: chunkTokens } = takeChunk(recent, target);
    if (!chunk.length) break;
    const fromSeq = chunk[0].seq;
    const toSeq = chunk[chunk.length - 1].seq;
    let textValue = '';
    try {
      textValue = await llmSummary(chunk, llm);
    } catch (err) {
      if (logger) logger.warn('摘要失败，原文保留、coverage 不前进：' + ((err && err.message) || err));
      return { before, after: before, compressed: 0, chunks: 0, failed: true };
    }
    if (!textValue) {
      if (requireLlm) return { before, after: before, compressed: 0, chunks: 0, failed: true };
      textValue = extractor.extractiveSummary(chunk, 220);
    }
    applySegment(chat, { text: textValue, fromSeq, toSeq, now });
    recent = recent.slice(chunk.length);
    tokens -= chunkTokens;
    compressed += chunkTokens;
    chunks += 1;
  }
  return { before, after: tokens, compressed, chunks };
}

/**
 * 软阈值预热：准备「最旧 800 token」的摘要，不删消息。
 * 同一时间只准备一份；失败就下次再试。
 */
async function prepareSoft(chat, { currentSeq = 0, llm = null, logger = null, now = Date.now() } = {}) {
  if (chat.pendingSummary) return false;
  if (recentTokens(chat, { currentSeq }) < LIMITS.softTriggerTokens) return false;
  const recent = recentSince(chat, { currentSeq });
  const { chunk } = takeChunk(recent, LIMITS.compressChunkTokens);
  if (!chunk.length) return false;
  const fromSeq = chunk[0].seq;
  const toSeq = chunk[chunk.length - 1].seq;
  try {
    const textValue = await llmSummary(chunk, llm);
    if (!textValue) return false;
    chat.pendingSummary = { fromSeq, toSeq, text: textValue, tokens: estimateTokens(textValue), at: now };
    return true;
  } catch (err) {
    if (logger) logger.warn('预热摘要失败（不影响聊天）：' + ((err && err.message) || err));
    return false;
  }
}

/** episode 关闭后：清空当前 episode 的摘要缓冲，原文水位推进到最后一条 */
function resetSummary(chat, { episodeId = '', coveredThroughSeq = 0, now = Date.now() } = {}) {
  const previousCovered = Number(chat.summary && chat.summary.coveredThroughSeq) || 0;
  chat.summary = {
    chatId: chat.chatId,
    episodeId,
    text: '',
    tokens: 0,
    coveredThroughSeq: Math.max(previousCovered, Number(coveredThroughSeq) || 0),
    segments: [],
    updatedAt: now,
  };
  chat.pendingSummary = null;
}

module.exports = {
  SUMMARY_SYSTEM,
  recentSince,
  recentTokens,
  recentForPrompt,
  takeChunk,
  parseSummary,
  llmSummary,
  applySegment,
  trimSummary,
  compressSync,
  compressAsync,
  prepareSoft,
  resetSummary,
  recomputeSummary,
};
