'use strict';

/**
 * 写入触发器：只抽「当前说话人自己说的」。
 *
 * 规则在前、模型在后：
 *  - 明确自述 / 明确纠正 / 手动记住：规则即时落卡（不调模型）
 *  - 连续 20 条 user 消息：只做轻量 fact 候选（规则，不调模型）
 *  - episode 关闭：批量交给模型；失败时退回规则 + 抽取式摘要
 */
const personCard = require('./personCard');
const { LIMITS } = require('./constants');

const QUESTION_RE = /[?？]|(?:吗|呢|吧)\s*$|如果|要是|假如|假设|开玩笑|哈哈|呵呵|不是吧/;
const THIRD_PERSON_RE = /^(?:他|她|他们|她们|别人|人家|我朋友|我同事|我同学|我妈|我爸|我哥|我姐|我弟|我妹|我家那位)/;

function cleanIncoming(text) {
  return String(text || '')
    .replace(/^[A-Za-z0-9_-]{4,}:\s*/, '')
    .replace(/^@\S+\s*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clampText(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function looksExplicitSelf(text) {
  const s = cleanIncoming(text);
  if (!s || s.length > 120) return false;
  return /^我(?:叫|的名字|住在|搬到|搬去|在|是|喜欢|爱|讨厌|不喜欢|怕|害怕|不吃|不能吃|对.*过敏|的?生日|今天|刚刚|刚|最近|已经|要)/.test(s);
}

/**
 * 从一句话抽「自己说的事实」。
 * @returns {{facts:Array, correction?:{old:string,new:string}, event?:object}}
 */
function extractSelfFacts(text, { msgId = '', now = Date.now() } = {}) {
  const original = cleanIncoming(text);
  if (!original || original.length > 120) return { facts: [] };
  if (THIRD_PERSON_RE.test(original)) return { facts: [] };
  const manual = /^(?:记住|记一下|帮我记住|帮我记一下|记下|别忘了)[：:\s]*(.+)$/.exec(original);
  const body = manual ? manual[1].trim() : original;
  if (!body) return { facts: [] };
  const explicit = true;
  const source = msgId || '';
  const facts = [];
  const push = (textValue, key, confidence = 0.85, extra = {}) => {
    const t = clampText(textValue, 80);
    if (!t) return;
    facts.push({ text: t, key, confidence, source, explicit, kind: extra.kind || 'fact', ...extra });
  };

  // 明确纠正：「不是杭州，是上海」「你记错了，是上海」
  const correction = /(?:不是|我说的是|我说过的是)\s*([^，,。！!？?\s]{1,16})[，,]\s*(?:是|而是)\s*([^，,。！!？?\s]{1,20})/.exec(body)
    || /(?:不是|我说的是|我说过的是)\s*([^，,。！!？?\s]{1,16})\s*(?:而是|是)\s*([^，,。！!？?\s]{1,20})/.exec(body);
  if (correction) {
    return { facts: [{ text: clampText(`是${correction[2]}`, 80), key: '', confidence: 1, source, explicit: true, supersedes: [correction[1]] }], correction: { old: correction[1], new: correction[2] } };
  }
  const wrong = /你记错了[，,：:]?\s*(?:是)?\s*([^，,。！!？?\s]{1,20})/.exec(body);
  if (wrong) {
    return { facts: [{ text: clampText(`是${wrong[1]}`, 80), confidence: 1, source, explicit: true }] };
  }

  if (QUESTION_RE.test(body) && !manual) return { facts: [] };

  let m = /^我(?:叫|的名字(?:是|叫)?|就叫)\s*([\u4e00-\u9fa5A-Za-z0-9_·]{1,12})/.exec(body);
  if (m) push(`名字是${m[1]}`, 'name', 0.9, { kind: 'preference', renameTo: m[1] });

  m = /^我(?:住在|搬到|搬去|刚到|现在住(?:在)?)\s*([\u4e00-\u9fa5A-Za-z0-9]{2,12})/.exec(body);
  if (m) push(`住在${m[1]}`, 'city', 0.85, { kind: 'preference' });

  m = /^我(?:在|于)\s*([^，,。！!？?\s]{2,16}?)(?:工作|上班)/.exec(body);
  if (m) push(`在${m[1]}工作`, 'job', 0.8, { kind: 'preference' });
  m = /^我(?:在|于)?\s*([^，,。！!？?\s]{2,16}?)(?:读书|上学|读大学|读研)/.exec(body);
  if (m) push(`在${m[1]}读书`, 'school', 0.8, { kind: 'preference' });

  m = /^我(?:很|挺|特别|超级|有点|最近)?(喜欢|爱|讨厌|不喜欢|怕|害怕|不吃|不能吃)\s*([^，,。！!？?\s]{1,16})/.exec(body);
  if (m) push(`我${m[1]}${m[2]}`, `pref:${m[2]}`, 0.8, { kind: m[1] === '怕' || m[1] === '害怕' || m[1] === '讨厌' || m[1] === '不喜欢' || m[1] === '不吃' || m[1] === '不能吃' ? 'taboo' : 'preference' });

  m = /^我(?:对)\s*([^，,。！!？?\s]{1,10})\s*过敏/.exec(body);
  if (m) push(`对${m[1]}过敏`, `allergy:${m[1]}`, 0.95, { kind: 'taboo' });

  m = /^我(?:的)?生日(?:是)?\s*(\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{4}-\d{1,2}-\d{1,2})/.exec(body);
  if (m) push(`生日 ${m[1]}`.trim(), 'birthday', 0.9, { kind: 'fact' });

  // 人生事件：既写一条偏好（便于检索），也让上层补一条事件
  m = /^我(?:今天|刚刚|刚|最近|已经)?\s*(离职|辞职|分手|结婚|订婚|搬家|搬走|换工作|毕业|考上|生病|住院|怀孕|生了|离婚)/.exec(body);
  if (m) {
    push(clampText(body, 60), `life:${m[1]}`, 0.9, { kind: 'recent' });
  }

  return facts.length ? { facts } : { facts: [] };
}

/** 把规则抽到的事实写进卡（校验 chatId） */
function applyFacts(card, facts, { chatId, now = Date.now() } = {}) {
  const written = [];
  for (const fact of facts || []) {
    try {
      const item = personCard.addPreference(card, {
        text: fact.text,
        key: fact.key || '',
        kind: fact.kind || 'fact',
        confidence: fact.confidence,
        source: fact.source,
        supersedes: fact.supersedes || [],
        explicit: true,
      }, { chatId, now });
      if (!item) continue;
      if (fact.renameTo) card.nickname = clampText(fact.renameTo, 20);
      written.push(item);
    } catch (err) {
      if (err && err.code === 'MEMORY_CHAT_MISMATCH') throw err;
    }
  }
  return written;
}

/** 连续 20 条 user 消息：只做轻量候选，不调模型、不写 L2 */
function lightweightCandidates(messages, { now = Date.now() } = {}) {
  const out = [];
  for (const m of (messages || []).filter((x) => x && x.role === 'user' && x.text).slice(-LIMITS.factExtractEveryUserMessages)) {
    const { facts } = extractSelfFacts(m.text, { msgId: m.id || '', now });
    for (const f of facts) out.push({ ...f, uid: m.uid || '', name: m.name || '', confidence: Math.min(f.confidence, 0.55) });
  }
  return out;
}

/* ------------------------------ episode 批量抽取 ------------------------------ */

const EPISODE_SYSTEM = [
  '你在整理一段聊天 episode，供以后回忆用。只输出 JSON，不要解释、不要代码块。',
  '格式：{"summary":"...","facts":[{"uid":"u1","text":"...","confidence":0.8}],"traits":[{"uid":"u1","text":"...","confidence":0.7,"evidence":["msg_1"]}],"events":[{"uid":"u1","title":"≤20字","summary":"60~150字","keywords":["..."],"importance":0.6,"confidence":0.8}],"threads":[{"uid":"u1","text":"..."}]}',
  'summary：80~150 字，写这段在聊什么、情绪基调、有没有没解决的事；群聊必须保留「谁说的」，不要揉成「用户说」。',
  'facts：只写这些人自己明确说过的、以后还用得上的事实；第三人称转述、玩笑、假设、反问不写。',
  'traits：至少两次独立观察才写，confidence ≥ 0.65，evidence 填消息 id；一次情绪不写。',
  'events：一段事一条，不要每句话一条；summary 60~150 字。',
  'uid 只能从下面给出的发言人列表里选；不要编造没出现的人。',
].join('\n');

function transcript(messages) {
  return (messages || [])
    .filter((m) => m && m.text)
    .map((m) => {
      const who = m.role === 'assistant' ? '鲸鲸' : (m.name || m.uid || '对方');
      return `[${m.id || ('msg_' + m.seq)}] ${who}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 200)}`;
    })
    .join('\n')
    .slice(0, 8000);
}

function parseEpisode(raw) {
  const textValue = String(raw || '');
  const start = textValue.indexOf('{');
  const end = textValue.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(textValue.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const summary = clampText(obj.summary, 400);
  const facts = (Array.isArray(obj.facts) ? obj.facts : []).slice(0, 12).map((f) => {
    if (!f) return null;
    const body = clampText(typeof f === 'string' ? f : f.text, 60);
    if (!body) return null;
    return { uid: String(f.uid || ''), text: body, confidence: clamp01(f.confidence, 0.6) };
  }).filter(Boolean);
  const traits = (Array.isArray(obj.traits) ? obj.traits : []).slice(0, 8).map((t) => {
    if (!t) return null;
    const body = clampText(typeof t === 'string' ? t : t.text, 40);
    if (!body) return null;
    const evidence = (Array.isArray(t.evidence) ? t.evidence : []).map((x) => String(x)).slice(0, 8);
    return { uid: String(t.uid || ''), text: body, confidence: clamp01(t.confidence, 0.65), evidence };
  }).filter(Boolean);
  const events = (Array.isArray(obj.events) ? obj.events : []).slice(0, 8).map((e) => {
    if (!e) return null;
    const title = clampText(e.title, 20);
    const body = clampText(e.summary, 150);
    if (!title && !body) return null;
    return {
      uid: String(e.uid || ''),
      title: title || body.slice(0, 20),
      summary: body || title,
      keywords: (Array.isArray(e.keywords) ? e.keywords : []).map((k) => clampText(k, 16)).filter(Boolean).slice(0, 10),
      importance: clamp01(e.importance, 0.5),
      confidence: clamp01(e.confidence, 0.65),
      valence: e.valence == null ? undefined : Math.max(-1, Math.min(1, Number(e.valence) || 0)),
      resolved: typeof e.resolved === 'boolean' ? e.resolved : undefined,
      threadText: clampText(e.threadText || '', 80),
    };
  }).filter(Boolean);
  const threads = (Array.isArray(obj.threads) ? obj.threads : []).slice(0, 8).map((t) => {
    if (!t) return null;
    const body = clampText(typeof t === 'string' ? t : t.text, 80);
    if (!body) return null;
    return { uid: String(t.uid || ''), text: body };
  }).filter(Boolean);
  if (!summary && !facts.length && !events.length && !threads.length) return null;
  return { summary, facts, traits, events, threads };
}

function clamp01(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/** 抽取式兜底摘要：保留谁说了什么，不退化成「用户说」 */
function extractiveSummary(messages, maxChars = 160) {
  const parts = [];
  for (const m of messages || []) {
    if (!m || !m.text) continue;
    const who = m.role === 'assistant' ? '鲸鲸' : (m.name || '对方');
    const body = String(m.text).replace(/\s+/g, ' ').trim();
    if (!body) continue;
    parts.push(`${who}：${body.slice(0, 40)}`);
    if (parts.join('；').length >= maxChars) break;
  }
  const textValue = parts.join('；');
  return textValue.length > maxChars ? textValue.slice(0, maxChars) : textValue;
}

/**
 * 批量抽取。失败返回规则兜底（不抛），调用方可以照常写 L2。
 * @returns {Promise<{summary:string,facts:Array,traits:Array,events:Array,threads:Array,fallback?:boolean}>}
 */
async function extractEpisode({ messages, llm, speakers = [], logger = null, now = Date.now() }) {
  const users = (messages || []).filter((m) => m && m.role === 'user' && m.text);
  const fallback = () => {
    const facts = [];
    for (const m of users) {
      const { facts: got } = extractSelfFacts(m.text, { msgId: m.id || '', now });
      for (const f of got) facts.push({ uid: m.uid || '', text: f.text, confidence: Math.min(0.7, f.confidence) });
    }
    return {
      summary: extractiveSummary(messages),
      facts,
      traits: [],
      events: [],
      threads: [],
      fallback: true,
    };
  };
  if (!llm || llm.isMock || speakers.length === 0) return fallback();
  const allowed = new Set(speakers.map((s) => String(s.uid)));
  const speakerText = speakers.map((s) => `${s.uid}=${s.name || '群友'}`).join('、');
  try {
    const raw = await llm.complete({
      system: EPISODE_SYSTEM,
      turns: [{
        role: 'user',
        content: `发言人：${speakerText}\n\n聊天记录：\n${transcript(messages)}`,
      }],
      maxTokens: 900,
    });
    const parsed = parseEpisode(raw);
    if (!parsed) return fallback();
    // 只接受本 episode 里出现过的人；没写 uid 的按最后一个说话人归
    const lastUid = String((users[users.length - 1] || {}).uid || '');
    const fix = (item) => {
      if (!item.uid || !allowed.has(item.uid)) item.uid = lastUid;
      return allowed.has(item.uid) ? item : null;
    };
    parsed.facts = parsed.facts.map(fix).filter(Boolean);
    parsed.traits = parsed.traits.map(fix).filter(Boolean);
    parsed.events = parsed.events.map(fix).filter(Boolean);
    parsed.threads = parsed.threads.map(fix).filter(Boolean);
    return parsed;
  } catch (err) {
    if (logger) logger.warn('episode 抽取失败，退回规则：' + ((err && err.message) || err));
    return fallback();
  }
}

module.exports = {
  EPISODE_SYSTEM,
  cleanIncoming,
  looksExplicitSelf,
  extractSelfFacts,
  applyFacts,
  lightweightCandidates,
  parseEpisode,
  extractiveSummary,
  extractEpisode,
};
