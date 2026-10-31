'use strict';

/**
 * 事件检索：只查「当前 chat 的当前说话人」的事件卡。
 *
 * 中文不引分词库：字符 bigram + BM25；再按 recency / importance / confidence / pinned
 * 重排，最后用 MMR 去重。返回 3~5 条，约 300~500 token。
 */
const { LIMITS, DAY_MS } = require('./constants');
const personCard = require('./personCard');

function tokens(value) {
  const s = String(value || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    // 单字也进索引：query 里的「辣」要能命中「爱吃辣」
    for (const ch of seg) out.add(ch);
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 两条文本的 bigram 重合度（0~1） */
function overlap(a, b) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hit = 0;
  for (const t of ta) if (setB.has(t)) hit += 1;
  return hit / Math.min(ta.length, tb.length);
}

function eventDoc(event) {
  return [
    event.title,
    event.summary,
    ...(Array.isArray(event.keywords) ? event.keywords : []),
    ...(Array.isArray(event.participants) ? event.participants : []),
  ].filter(Boolean).join(' ');
}

/** BM25 over events */
function bm25(events, queryTokens) {
  const docs = events.map((e) => tokens(eventDoc(e)));
  const n = docs.length;
  const avgLen = docs.reduce((sum, d) => sum + d.length, 0) / Math.max(1, n);
  const df = new Map();
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) || 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;
  return docs.map((doc) => {
    const tf = new Map();
    for (const t of doc) tf.set(t, (tf.get(t) || 0) + 1);
    let score = 0;
    for (const q of queryTokens) {
      const f = tf.get(q);
      if (!f) continue;
      const idf = Math.log(1 + (n - (df.get(q) || 0) + 0.5) / ((df.get(q) || 0) + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (doc.length / Math.max(1, avgLen)))));
    }
    return score;
  });
}

function recencyScore(date, now, halfLifeDays) {
  const ts = Date.parse(`${date}T00:00:00`);
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (now - ts) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * @param {object} card 当前说话人的人物卡
 * @param {{query?:string, recentTexts?:string[], activeTopic?:string, now?:number, topK?:number, uid?:string}} opts
 * @returns {Array<object>} 事件（带 _score）
 */
function selectEvents(card, { query = '', recentTexts = [], activeTopic = '', now = Date.now(), topK = LIMITS.retrievalTopK, uid = '' } = {}) {
  const events = personCard.activeEvents(card);
  if (!events.length) return [];
  const queryText = [query, ...(recentTexts || []).slice(-2), activeTopic].filter(Boolean).join(' ');
  const qt = tokens(queryText);
  const bm = bm25(events, qt);
  const maxBm = Math.max(...bm, 0.0001);
  const scored = [];
  for (let i = 0; i < events.length; i += 1) {
    const ev = events[i];
    // 只保留当前说话人参与的事件（卡本身就是他的，这里再兜一层）
    if (uid && Array.isArray(ev.participants) && ev.participants.length && !ev.participants.includes(String(uid))) continue;
    const relevance = qt.length ? Math.min(1, bm[i] / maxBm) : 0;
    const r = recencyScore(ev.date, now, 14);
    const score = 0.55 * relevance
      + 0.20 * r
      + 0.15 * (Number(ev.importance) || 0)
      + 0.10 * (Number(ev.confidence) || 0)
      + 0.05 * (ev.pinned ? 1 : 0);
    if (score < LIMITS.retrievalMinScore) continue;
    scored.push({ event: ev, score, relevance });
  }
  scored.sort((a, b) => b.score - a.score);

  // 先去掉近重复（同一件事的多个写法），再 MMR；否则三条一模一样的会占满 topK
  const distinct = [];
  for (const cand of scored) {
    const doc = eventDoc(cand.event);
    if (distinct.some((chosen) => overlap(doc, eventDoc(chosen.event)) >= 0.9)) continue;
    distinct.push(cand);
  }

  // MMR：λ*相关 − (1−λ)*和已选的最大相似度
  const picked = [];
  const pool = distinct.slice();
  while (picked.length < Math.max(0, topK) && pool.length) {
    let bestIdx = 0;
    let best = -Infinity;
    for (let i = 0; i < pool.length; i += 1) {
      const cand = pool[i];
      let sim = 0;
      for (const chosen of picked) sim = Math.max(sim, overlap(eventDoc(cand.event), eventDoc(chosen.event)));
      const mmr = LIMITS.mmrLambda * cand.score - (1 - LIMITS.mmrLambda) * sim;
      if (mmr > best) { best = mmr; bestIdx = i; }
    }
    picked.push(pool.splice(bestIdx, 1)[0]);
  }
  return picked.map((x) => ({ ...x.event, _score: Number(x.score.toFixed(4)) }));
}

/** episode 话题切换用：当前消息和最近几条的重合度 */
function topicOverlap(text, recentTexts) {
  const recent = (recentTexts || []).filter(Boolean).slice(-6).join(' ');
  return overlap(text, recent);
}

module.exports = { tokens, overlap, bm25, selectEvents, topicOverlap, recencyScore };
