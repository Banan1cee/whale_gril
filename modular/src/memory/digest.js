'use strict';

/**
 * 记忆的「整理」这一半：滚动摘要 + 自动抽取事实。
 *
 * 以前只有「记住：…」这种显式命令才写记忆，聊一百句她也不会自己记下来；
 * 历史一长就把最早的对话挤掉，等于健忘。这里每隔一段对话做一次整理：
 * 把「你们最近聊了什么」压成一段摘要，并顺手抽出几条值得长期记住的事实。
 *
 * 一次 LLM 调用同时拿到摘要和事实，不额外多花钱；失败就跳过，不影响回复。
 */

const DIGEST_EVERY = 12;      // 每攒够 12 条新消息整理一次
const TRANSCRIPT_LIMIT = 40;  // 一次最多喂 40 条，别把上下文撑爆

const SYSTEM = [
  '你在整理一段聊天记录，供以后回忆用。只输出 JSON，不要解释。',
  '格式：{"summary":"...","facts":[{"text":"...","kind":"fact|preference|promise|recent|taboo","importance":1}]}',
  'summary：第三人称、80~150 字，写「他们最近在聊什么、关系状态、有没有未完成的事」。',
  'facts：0~3 条，只写关于对方个人的、以后还用得上的事实。',
  '不要写寒暄、不要写鲸鲸自己的话、不要编造记录里没有的东西。',
].join('\n');

function transcript(messages, limit = TRANSCRIPT_LIMIT) {
  return messages
    .slice(-limit)
    .map((m) => {
      const who = m.role === 'assistant' ? '鲸鲸' : (m.name || '对方');
      return `${who}：${String(m.text || '').replace(/\s+/g, ' ').slice(0, 200)}`;
    })
    .join('\n');
}

/** 该不该整理：攒够 DIGEST_EVERY 条新消息才动，避免每条消息都调一次模型 */
function shouldDigest(session, every = DIGEST_EVERY) {
  const total = Array.isArray(session && session.messages) ? session.messages.length : 0;
  const upto = Number(session && session.summaryUpto) || 0;
  return total - upto >= Math.max(6, Number(every) || DIGEST_EVERY);
}

/** 从模型输出里把 JSON 抠出来（它经常包 ```json 或带前言） */
function parseDigest(raw) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const summary = typeof obj.summary === 'string' ? obj.summary.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  const facts = [];
  for (const f of Array.isArray(obj.facts) ? obj.facts.slice(0, 3) : []) {
    if (!f) continue;
    const t = typeof f === 'string' ? f : f.text;
    const text2 = String(t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!text2) continue;
    const kind = ['fact', 'preference', 'promise', 'recent', 'taboo'].includes(f.kind) ? f.kind : 'fact';
    const imp = Number(f.importance);
    facts.push({ text: text2, kind, importance: Number.isFinite(imp) ? Math.max(1, Math.min(3, imp)) : 1 });
  }
  if (!summary && !facts.length) return null;
  return { summary, facts };
}

function buildPrompt(session) {
  const prev = session && session.summary ? `上一次的摘要（可以接着写，别重复）：${session.summary}\n\n` : '';
  const msgs = (session && session.messages) || [];
  return {
    system: SYSTEM,
    turns: [{ role: 'user', content: `${prev}聊天记录：\n${transcript(msgs)}` }],
  };
}

/**
 * 跑一次整理。任何异常都吞掉——整理失败不该影响聊天。
 * @returns {Promise<{summary:string, facts:Array, total:number}|null>}
 */
async function digest(store, llm, key, { uid = '', logger, enabled = true, every = DIGEST_EVERY } = {}) {
  if (!enabled || !llm || llm.isMock) return null;
  const session = store.ensureSession(key);
  if (!shouldDigest(session, every)) return null;

  try {
    const prompt = buildPrompt(session);
    const raw = await llm.complete(prompt);
    const parsed = parseDigest(raw);
    if (!parsed) {
      if (logger) logger.warn('记忆整理：模型没给出可解析的 JSON，跳过');
      return null;
    }
    const total = session.messages.length;
    if (parsed.summary) store.setSummary(key, parsed.summary, { upto: total });
    for (const f of parsed.facts) {
      if (uid) store.addNote(key, uid, f.text, { kind: f.kind, importance: f.importance });
    }
    if (logger) {
      logger.info(`记忆整理：摘要 ${parsed.summary ? '已更新' : '无'}，抽到 ${parsed.facts.length} 条事实`);
    }
    return { ...parsed, total };
  } catch (err) {
    if (logger) logger.warn('记忆整理失败（不影响聊天）：' + (err && err.message));
    return null;
  }
}

module.exports = { DIGEST_EVERY, SYSTEM, shouldDigest, parseDigest, buildPrompt, transcript, digest };
