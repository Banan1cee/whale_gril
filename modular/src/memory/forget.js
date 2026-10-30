'use strict';

/**
 * 真正会忘的记忆：打分、淘汰、归档。
 *
 * 之前 notes 满了是「最老的先丢」（splice(0)），消息满了也是「最早的先丢」——
 * 那是按时间忘，不是按价值忘：刚聊的寒暄留着，三个月前的「她对花生过敏」反而被挤掉。
 *
 * 这里把「忘」拆成三层，都能从磁盘上看得见：
 *   1. 淘汰（evict）：某个人的记忆超过上限时，扔掉**分数最低**的那条，
 *      不是最老的；承诺/雷区有保护，优先级够高不会被淘汰。
 *   2. 归档（archive）：很久没被用到、分数又低的，从主存移到 memory-archive.json，
 *      不再参与检索（省上下文），但还能翻出来、能导出。
 *   3. 真删（purge）：归档文件也有上限，超过就按时间扔掉最老的。
 *
 * 分数 = 重要度 × 新鲜度（30 天减半）× 类别权重 + 最近被想起的加成。
 */

const DAY = 86400000;
const HALF_LIFE_DAYS = 30;

// 这些类别不该因为「旧」被忘掉
const PROTECTED = new Set(['promise', 'taboo']);

const KIND_WEIGHT = {
  promise: 1.6,
  taboo: 1.4,
  preference: 1.15,
  recent: 1.1,
  fact: 1,
};

/** 记忆的衰减分数：越大越值得留 */
function decayScore(note, now = Date.now()) {
  if (!note) return 0;
  const imp = Math.max(1, Math.min(3, Number(note.importance) || 1));
  const created = Number(note.createdAt) || now;
  const ageDays = Math.max(0, (now - created) / DAY);
  const fresh = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
  const weight = KIND_WEIGHT[note.kind] || 1;
  const last = Number(note.lastMentionedAt) || 0;
  const touchedDays = last ? Math.max(0, (now - last) / DAY) : 999;
  const touched = last ? Math.pow(0.5, touchedDays / 45) * 2 : 0;
  return imp * fresh * weight + touched;
}

/**
 * 超出上限时挑要扔的：从分数最低的挑，保护区（承诺/雷区）最后才动。
 * @returns {number[]} 要淘汰的下标
 */
function pickEvictions(notes, limit, now = Date.now()) {
  const list = Array.isArray(notes) ? notes : [];
  const over = list.length - Math.max(0, limit);
  if (over <= 0) return [];
  const idx = list.map((n, i) => ({
    i,
    score: decayScore(n, now),
    protectedKind: PROTECTED.has(n && n.kind),
  }));
  idx.sort((a, b) => {
    if (a.protectedKind !== b.protectedKind) return a.protectedKind ? 1 : -1; // 非保护区先走
    return a.score - b.score;
  });
  return idx.slice(0, over).map((x) => x.i);
}

/** 这条该不该从主存沉到归档：太旧、又一直没被想起、又不是保护区、分数还低 */
function shouldArchive(note, now = Date.now(), { minAgeDays = 45, maxScore = 0.35 } = {}) {
  if (!note) return false;
  if (PROTECTED.has(note.kind)) return false;
  const created = Number(note.createdAt) || now;
  if ((now - created) / DAY < minAgeDays) return false;
  const last = Number(note.lastMentionedAt) || 0;
  if (last && (now - last) / DAY < minAgeDays) return false;
  return decayScore(note, now) <= maxScore;
}

/** 归档文件也有上限：超了按时间扔掉最老的几条 */
function trimArchive(entries, cap = 3000) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length <= cap) return { kept: list, dropped: [] };
  const sorted = list.slice().sort((a, b) => (Number(a.archivedAt) || 0) - (Number(b.archivedAt) || 0));
  const drop = sorted.slice(0, list.length - cap);
  const dropSet = new Set(drop);
  return { kept: list.filter((x) => !dropSet.has(x)), dropped: drop };
}

module.exports = {
  DAY,
  HALF_LIFE_DAYS,
  PROTECTED,
  KIND_WEIGHT,
  decayScore,
  pickEvictions,
  shouldArchive,
  trimArchive,
};
