'use strict';

/**
 * 记忆的「取」这一半。
 *
 * 以前是把每个人的 notes 全部塞进提示词（最多 6 条），存多少给多少。
 * 现在 notes 变成带时间/类别的结构，这里负责：按当前这句话挑出**最该被想起**的几条。
 *
 * 打分三件事：跟当前话题的词重叠、这条记忆本身有多重要（承诺/雷区加权）、
 * 距上次提到多久（刚说过的降权，很久没聊的旧事升权）。
 */

const DAY = 86400000;

/** notes 里可能是老格式（纯字符串），统一取文本 */
function noteText(n) {
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object' && typeof n.text === 'string') return n.text;
  return '';
}

/** 把一条记忆补成结构：{text, kind, createdAt, lastMentionedAt, mentions, importance} */
function normalizeNote(n, now = Date.now()) {
  const text = noteText(n).trim();
  if (!text) return null;
  if (typeof n === 'string') {
    return { text, kind: 'fact', createdAt: now, lastMentionedAt: 0, mentions: 0, importance: 1 };
  }
  const kind = ['fact', 'preference', 'promise', 'recent', 'taboo'].includes(n.kind) ? n.kind : 'fact';
  const imp = Number(n.importance);
  return {
    text,
    kind,
    createdAt: Number(n.createdAt) > 0 ? Number(n.createdAt) : now,
    lastMentionedAt: Number(n.lastMentionedAt) > 0 ? Number(n.lastMentionedAt) : 0,
    mentions: Number(n.mentions) > 0 ? Number(n.mentions) : 0,
    importance: Number.isFinite(imp) ? Math.max(1, Math.min(3, imp)) : 1,
  };
}

/** 中文按 2-gram、英文/数字按词切。不引依赖，够用了。 */
function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    if (!seg) continue;
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}


function scoreNote(note, queryTokens, now) {
  const n = normalizeNote(note, now);
  if (!n) return null;
  const body = n.text.toLowerCase();
  let score = 0;
  for (const t of queryTokens) {
    if (body.includes(t)) score += 2;
  }
  score += (n.importance - 1) * 1.5;
  if (n.kind === 'promise') score += 2;   // 答应过的事要记得（但别盖过话题直接命中）
  if (n.kind === 'taboo') score += 1.5;   // 雷区别踩
  const ageDays = Math.max(0, (now - n.createdAt) / DAY);
  score += Math.min(2, ageDays / 10);     // 很久没聊的旧事更值得翻出来
  const sinceMention = n.lastMentionedAt ? (now - n.lastMentionedAt) / DAY : 999;
  if (sinceMention < 0.5) score -= 3;     // 刚提过，别复读
  else if (sinceMention < 2) score -= 1;
  return { note: n, score };
}

/**
 * 挑记忆。
 * @param {Array} notes  profile.notes（新旧格式都行）
 * @param {string} query 对方刚说的这句话
 * @returns {Array<{text,kind,createdAt,lastMentionedAt,mentions,importance}>}
 */
function pickNotes(notes, query, { now = Date.now(), limit = 5 } = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const qt = tokens(query);
  const scored = [];
  for (const raw of list) {
    const r = scoreNote(raw, qt, now);
    if (!r) continue;
    // 半小时内刚提过的，这次跳过（避免同一条反复念）
    if (r.note.lastMentionedAt && now - r.note.lastMentionedAt < 30 * 60000) continue;
    scored.push(r);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit)).map((x) => x.note);
}


/**
 * 两条记忆有多像：用 2-gram 的交集 / 较短那条的长度。
 * 警告：0.67 这种分数**不能**用来合并——「他爱吃辣」和「他爱吃甜」也是 0.67，
 * 合并就把两个事实搞混了。所以合并阈值卡在 0.85（基本是同一句的变体），
 * 真正的换说法合并交给整理阶段（有模型判断）。
 */
function similarity(a, b) {
  const ta = tokens(noteText(a));
  const tb = tokens(noteText(b));
  if (!ta.length || !tb.length) return 0;
  const setB = new Set(tb);
  let hit = 0;
  for (const t of ta) if (setB.has(t)) hit += 1;
  return hit / Math.min(ta.length, tb.length);
}

/** 同一件事只留一条：返回要合并进去的老条目下标，找不到就 -1 */
function findSimilar(notes, text, threshold = 0.85) {
  const list = Array.isArray(notes) ? notes : [];
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < list.length; i += 1) {
    const sc = similarity(list[i], text);
    if (sc >= threshold && sc > bestScore) {
      best = i;
      bestScore = sc;
    }
  }
  return best;
}

module.exports = { DAY, noteText, normalizeNote, tokens, scoreNote, pickNotes, similarity, findSimilar };
