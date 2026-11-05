'use strict';

/**
 * 关系边（L1）：**一个 chat 里**两个人之间的关系。
 *
 * 数据挂在 chat.meta.relations（不进人物卡、不进摘要、没有任何面向用户的浏览界面）：
 *
 *   {
 *     id: 'rel_<hash>',            // 由 (chatId, a, b) 决定，同一个 pair 永远只有一条
 *     a: 'uidA', b: 'uidB',        // 存之前按字典序排好
 *     text: '同事',                 // ≤40 字
 *     confidence: 0.8,
 *     source: { chatId, messageIds: [] },
 *     createdAt, updatedAt,
 *   }
 *
 * 硬约束和人物卡一致：source.chatId 必须等于当前 chatId。
 *   - 写入时不一致 → 抛 MEMORY_CHAT_MISMATCH（不自动改、不合并）；
 *   - 读盘时不一致 → 直接丢弃（宁可不读，也不串聊）。
 *
 * 生产有两条路：
 *   1. 规则即时（fromMessage）：三句式，命中就把边写进当前 chat；
 *   2. episode 关闭时由模型抽（extractor.parseEpisode），a/b 必须都是本段发言人。
 * 消费只有一条路：buildContext 收到 mentionedNames 时，把「关系 + 那个人的卡 + 最近发言」
 * 拼成一小块（硬上限 200 token），挂在最后一条 user 消息的尾部。
 *
 * 本模块是纯函数 + 纯数据，不碰 IO、不建卡、不编 uid：
 * 名字查不到对应 uid 时只保留 bName，调用方不会因此建卡。
 */
const personCard = require('./personCard');
const { shortId } = require('./hash');
const { estimateBudgetTokens } = require('./tokens');
const { sanitizeForModel } = require('../core/text');
const { cleanIncoming } = require('./text');

/** 每个 chat 最多留多少条关系边（超了淘汰 updatedAt 最旧的） */
const MAX_RELATIONS = 200;
/** 关系文本上限（字） */
const MAX_TEXT = 40;
/** 单个「提到的人」块 / 合并块的 token 硬上限 */
const MAX_BLOCK_TOKENS = 200;
/** 块里最多给几条卡上的内容 */
const MAX_CARD_ITEMS = 3;
/** 块里最多给几句「TA 最近说过」 */
const MAX_RECENT = 2;
const RECENT_CHARS = 40;

/**
 * 关系词表。长词必须排在短词前面（「女朋友」先于「朋友」），
 * 否则正则在「我女朋友」里会先命中「朋友」。
 */
const RELATION_WORDS = Object.freeze([
  '男朋友', '女朋友', '朋友', '同事', '同学', '室友', '情侣', '对象', '夫妻',
  '兄弟', '姐妹', '亲戚', '老板', '领导', '老公', '老婆',
  '哥哥', '弟弟', '姐姐', '妹妹', '哥', '姐', '弟', '妹',
]);
const REL_ALT = RELATION_WORDS.join('|');

/** 人称 / 指代：不是名字，不能当关系边的一端 */
const NOT_NAMES = new Set([
  '我', '你', '他', '她', '它', '我们', '你们', '他们', '她们', '别人', '人家',
  '大家', '自己', '谁', '啥', '什么', '这个', '那个', '这', '那',
]);

/** 邻接式（「我朋友小明」）后面跟着这些词时说明是在转述 / 描述，不是名字 */
const VERB_HEADS = /^(说|讲|问|告诉|觉得|认为|想|知道|希望|喜欢|讨厌|在|发|给|帮|要|让|跟|和|被|也|还|都|就|又|已经|刚|最近|今天|昨天|明天|不|没|很|挺|特别|超|好|真|是|叫|做|干|上|下|去|来)/;
/** 名字不该以这些字结尾（「小明是」这种半截捕获要丢掉） */
const NAME_TAILS = /[是的了和与在说讲叫吗呢吧啊哦呀]$/;

const NAME_CHARS = '\\u4e00-\\u9fa5A-Za-z0-9_·';
/**
 * 名字的右边界：名字后面必须跟这些「句子成分」之一，否则说明还没抓到名字结尾。
 * 没有它，「我朋友叫小明今天没来」会把「小明今天没来」整段当名字。
 */
const NAME_STOP = '今天|昨天|明天|最近|刚|在|说|讲|是|的|了|要|想|给|帮|跟|和|没|不|很|都|也|还|就|已经|以前|现在|我们|他们';
const NAME_TAIL = `(?=$|[\\s，,。.!！?？、~～：:]|${NAME_STOP})`;
const P1 = new RegExp(`我\\s*和\\s*([${NAME_CHARS}]{1,6}?)${NAME_TAIL}\\s*是\\s*(?:我的)?(${REL_ALT})`);
const P2 = new RegExp(`([${NAME_CHARS}]{1,6}?)${NAME_TAIL}\\s*是\\s*(?:我|我的)\\s*(${REL_ALT})`);
const P3 = new RegExp(`我(?:的)?(${REL_ALT})\\s*(?:叫|叫做|就是|是)\\s*[：:]?\\s*([${NAME_CHARS}]{1,6}?)${NAME_TAIL}`);
const P3_COLON = new RegExp(`我(?:的)?(${REL_ALT})\\s*[：:]\\s*([${NAME_CHARS}]{1,6}?)${NAME_TAIL}`);
const P3_ADJ = new RegExp(`我(?:的)?(${REL_ALT})\\s*([${NAME_CHARS}]{2,4}?)${NAME_TAIL}`);
/** 转述开头：「我朋友说…」「我同事觉得…」——说的是别人，不是我和 TA 的关系 */
const REPORTED_HEAD = new RegExp(`^我(?:的)?(?:${REL_ALT})(?:说|讲|告诉|问|觉得|认为|想|知道|希望|发|在|给|帮|让|跟|和)`);

/* ------------------------------ 小工具 ------------------------------ */

function clip(value, max) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function cleanId(value) {
  return clip(value, 100);
}

function cleanName(value) {
  return clip(value, 60).replace(/^@+/, '').replace(/\s+/g, '');
}

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function nowOf(now) {
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

function pairOf(a, b) {
  const x = cleanId(a);
  const y = cleanId(b);
  return x <= y ? [x, y] : [y, x];
}

function relationId(chatId, a, b) {
  const [x, y] = pairOf(a, b);
  return `rel_${shortId(`${chatId}:${x}:${y}`)}`;
}

function messageIdsOf(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const id of list) {
    const s = clip(id, 120);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(-20);
}

/** 超上限时淘汰 updatedAt 最旧的；原地修改并返回同一个数组 */
function enforceCap(list) {
  while (list.length > MAX_RELATIONS) {
    let victim = 0;
    for (let i = 1; i < list.length; i += 1) {
      if ((Number(list[i].updatedAt) || 0) < (Number(list[victim].updatedAt) || 0)) victim = i;
    }
    list.splice(victim, 1);
  }
  return list;
}

/* ------------------------------ 规范化 / 读写 ------------------------------ */

/**
 * 从磁盘读出来的关系边做一次规范化。
 * @param {Array} raw
 * @param {{chatId?:string}} [expected] 传了 chatId 就丢掉 source.chatId 不一致的条目
 * @returns {Array}
 */
function normalizeRelations(raw, { chatId = '' } = {}) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const [a, b] = pairOf(item.a, item.b);
    if (!a || !b || a === b) continue;
    const src = item.source && typeof item.source === 'object' ? item.source : {};
    const srcChat = cleanId(src.chatId || item.chatId);
    if (!srcChat) continue;
    if (chatId && srcChat !== String(chatId)) continue; // 跨群：读时过滤
    const text = clip(item.text, MAX_TEXT);
    if (!text) continue;
    const id = relationId(srcChat, a, b);
    if (seen.has(id)) continue;
    seen.add(id);
    const createdAt = Number(item.createdAt) || Number(item.updatedAt) || 0;
    const updatedAt = Number(item.updatedAt) || createdAt;
    out.push({
      id,
      a,
      b,
      text,
      confidence: clamp01(item.confidence, 0.75),
      source: { chatId: srcChat, messageIds: messageIdsOf(src.messageIds) },
      createdAt,
      updatedAt,
    });
  }
  return enforceCap(out);
}

/**
 * 写一条关系边：同一个 pair 合并，不产生重复条目。
 * @param {Array} list chat.meta.relations（会原地修改）
 * @param {{a:string,b:string,text:string,confidence?:number,source?:{chatId?:string,messageIds?:string[]}}} edge
 * @param {{chatId:string, now?:number}} opts chatId 必填，且必须和 edge.source.chatId 一致
 * @returns {object|null} 写入后的边；a/b 非法或文本为空时返回 null
 */
function upsert(list, edge, { chatId = '', now = Date.now() } = {}) {
  if (!Array.isArray(list)) throw new TypeError('relations 必须是数组');
  const at = nowOf(now);
  const src = edge && edge.source && typeof edge.source === 'object' ? edge.source : {};
  const srcChat = cleanId(src.chatId || chatId);
  if (!chatId || !srcChat || srcChat !== String(chatId)) {
    throw new personCard.MemoryIsolationError(
      `拒绝跨聊天写关系边：source.chatId=${srcChat || '(空)'}，当前 chatId=${chatId || '(空)'}`,
    );
  }
  const [a, b] = pairOf(edge.a, edge.b);
  if (!a || !b || a === b) return null;
  const text = clip(edge.text, MAX_TEXT);
  if (!text) return null;
  const id = relationId(chatId, a, b);
  const msgIds = messageIdsOf(src.messageIds);
  let found = list.find((item) => item && item.id === id) || null;
  if (found) {
    // 同一对重复写入：文本以最新一次为准，置信度取高，消息来源并集
    found.text = text;
    found.confidence = Math.max(clamp01(found.confidence, 0), clamp01(edge.confidence, 0.8));
    found.updatedAt = at;
    found.source = {
      chatId: String(chatId),
      messageIds: messageIdsOf([...(found.source && found.source.messageIds) || [], ...msgIds]),
    };
    if (!found.createdAt) found.createdAt = at;
  } else {
    found = {
      id,
      a,
      b,
      text,
      confidence: clamp01(edge.confidence, 0.8),
      source: { chatId: String(chatId), messageIds: msgIds },
      createdAt: at,
      updatedAt: at,
    };
    list.push(found);
  }
  enforceCap(list);
  return found;
}

/** 查两个人之间的边（顺序无关）；没有返回 null */
function find(list, a, b) {
  const [x, y] = pairOf(a, b);
  if (!x || !y) return null;
  for (const item of list || []) {
    if (!item) continue;
    if (String(item.a) === x && String(item.b) === y) return item;
  }
  return null;
}

/* ------------------------------ 规则抽取 ------------------------------ */

function looksLikeName(value) {
  const s = cleanName(value);
  if (!s || s.length > 12) return false;
  if (NOT_NAMES.has(s)) return false;
  if (VERB_HEADS.test(s)) return false;
  if (NAME_TAILS.test(s)) return false;
  return true;
}

/**
 * 规则即时抽取：从一句话里抽「说话人和谁是什么关系」。
 * 支持三种句式（X 是名字，不一定是本群的人）：
 *   1. 我和 X 是同事
 *   2. X 是我同事 / X 是我的同事
 *   3. 我朋友叫 X / 我朋友：X / 我朋友 X
 *
 * 转述（「我朋友说…」）不抽；X 查不到 uid 时不建卡、不编 uid（只保留 bName）。
 * @returns {Array<{a:string,aName:string,bName:string,text:string,confidence:number,source:{messageIds:string[]},createdAt:number}>}
 */
function fromMessage(text, { uid = '', name = '', msgId = '', now = Date.now() } = {}) {
  const body = cleanIncoming(text);
  const drafts = [];
  if (!body || body.length > 200) return drafts;
  if (REPORTED_HEAD.test(body)) return drafts;
  const at = nowOf(now);
  const speaker = cleanId(uid);
  const push = (bName, relText, confidence = 0.8) => {
    const target = cleanName(bName);
    if (!looksLikeName(target)) return;
    const key = `${target}|${relText}`;
    if (drafts.some((d) => `${d.bName}|${d.text}` === key)) return;
    drafts.push({
      a: speaker,
      aName: clip(name, 60),
      bName: target,
      text: clip(relText, MAX_TEXT),
      confidence: clamp01(confidence, 0.8),
      source: { messageIds: msgId ? [String(msgId)] : [] },
      createdAt: at,
    });
  };

  // 3) 我(的)?朋友(叫|是|：)?X —— 先看带明确标记的，避免被邻接式截胡
  let m = P3.exec(body);
  if (m) push(m[2], m[1]);
  m = P3_COLON.exec(body);
  if (m) push(m[2], m[1]);
  m = P3_ADJ.exec(body);
  if (m) push(m[2], m[1]);

  // 1) 我和 X 是同事
  m = P1.exec(body);
  if (m) push(m[1], m[2]);

  // 2) X 是我同事 / X 是我的同事
  m = P2.exec(body);
  if (m) push(m[1], m[2]);

  return drafts;
}

/* ------------------------------ 名字 → uid ------------------------------ */

/**
 * 在本群最近 limit 条 user 消息里按昵称找 uid。
 * 多人同名时取**最近发言**的那个（从最新往回扫，第一个命中的就是）。
 * 查不到返回 ''，调用方不得自己编 uid。
 */
function resolveName(chat, name, { limit = 200 } = {}) {
  const target = cleanName(name);
  if (!target) return '';
  const messages = (chat && chat.messages) || [];
  const max = Math.max(1, Number(limit) || 200);
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < max; i -= 1) {
    const m = messages[i];
    if (!m || m.role !== 'user' || !m.text) continue;
    seen += 1;
    if (m.uid && cleanName(m.name) === target) return String(m.uid);
  }
  return '';
}

/* ------------------------------ 渲染 ------------------------------ */

/**
 * 把一个「被提到的人」渲染成一小块提示词（全部来自系统记录，不编造）。
 * @param {{name:string, edge?:object|null, card?:object|null, recent?:string[], hardCap?:number}} input
 * @returns {string} 没有可说的内容时返回 ''
 */
function renderMentionBlock({ name = '', edge = null, card = null, recent = [], hardCap = MAX_BLOCK_TOKENS } = {}) {
  const who = clip(sanitizeForModel(cleanName(name)), 20);
  if (!who) return '';
  const texts = (Array.isArray(recent) ? recent : [])
    .map((t) => clip(sanitizeForModel(t), RECENT_CHARS))
    .filter(Boolean)
    .slice(-MAX_RECENT);
  if (!edge && !card && !texts.length) return '';

  const lines = [`【这条消息提到的「${who}】（系统记录，不是让你背）`];
  if (edge) lines.push(`- 你和${who}的关系：${clip(sanitizeForModel(edge.text), MAX_TEXT)}`);
  if (card) {
    const traits = personCard.activeTraits(card)
      .sort((x, y) => (y.confidence || 0) - (x.confidence || 0))
      .map((t) => clip(sanitizeForModel(t.text), 40));
    const prefs = personCard.activePreferences(card)
      .sort((x, y) => (y.confidence || 0) - (x.confidence || 0))
      .map((p) => clip(sanitizeForModel(p.text), 40));
    // 最多 3 条：先性格（≤2），再偏好
    const showTraits = traits.slice(0, 2);
    const showPrefs = prefs.slice(0, Math.max(0, MAX_CARD_ITEMS - showTraits.length));
    const parts = [];
    if (showTraits.length) parts.push(`性格：${showTraits.join('、')}`);
    if (showPrefs.length) parts.push(`偏好：${showPrefs.join('、')}`);
    if (parts.length) lines.push(`- 关于${who}：${parts.join('；')}`);
  }
  if (texts.length) lines.push(`- ${who}最近说过：${texts.join('；')}`);
  lines.push(`- 只在这条确实在说${who}时自然带一句；不相关就别提，也别复述这份记录。`);
  return capBlockTokens(lines.join('\n'), hardCap);
}

/** 把块裁到 cap token 以内：先丢内容行（从后往前），再按字符硬裁 */
function capBlockTokens(block, cap = MAX_BLOCK_TOKENS) {
  let out = String(block || '');
  if (!out) return '';
  const limit = Math.max(20, Math.min(Number(cap) || MAX_BLOCK_TOKENS, MAX_BLOCK_TOKENS));
  if (estimateBudgetTokens(out) <= limit) return out;
  const lines = out.split('\n');
  const head = lines.shift();
  const tail = lines.length > 1 ? lines.pop() : '';
  while (lines.length) {
    const candidate = [head, ...lines, tail].filter(Boolean).join('\n');
    if (estimateBudgetTokens(candidate) <= limit) return candidate;
    lines.pop();
  }
  let short = [head, tail].filter(Boolean).join('\n');
  while (short.length > 1 && estimateBudgetTokens(short) > limit) short = short.slice(0, -1);
  return short;
}

module.exports = {
  MAX_RELATIONS,
  MAX_TEXT,
  MAX_BLOCK_TOKENS,
  RELATION_WORDS,
  normalizeRelations,
  upsert,
  find,
  fromMessage,
  resolveName,
  renderMentionBlock,
  capBlockTokens,
  pairOf,
  relationId,
};
