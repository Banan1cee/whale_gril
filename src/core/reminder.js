'use strict';

/**
 * 提醒的纯逻辑：从一句人话里抽出「什么时候 + 提醒什么事」。
 *
 * 这里不碰存储、不碰网络，只做解析，方便单测。识别分两层：
 *   1. 规则（本文件）：准点、明天/后天、几分钟后、中文数字、上午/下午/晚上；
 *   2. 模型兜底（chat.js 里）：规则解析不出来时，让模型输出结构化结果。
 *
 * 设计原则：**宁可不识别，也不瞎猜时间**。解析失败就返回 null，当作普通聊天。
 */

const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const PERIOD = [
  { re: /(凌晨)/, hours: [0, 5] },
  { re: /(早上|早晨|清晨|上午)/, hours: [6, 11] },
  { re: /(中午|晌午)/, hours: [11, 13] },
  { re: /(下午|午后)/, hours: [13, 18] },
  { re: /(傍晚|黄昏)/, hours: [17, 19] },
  { re: /(晚上|夜里|今晚|明晚)/, hours: [18, 23] },
];

function cnToNumber(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '半') return 0.5;
  if (s === '一刻') return 0.25;
  if (s === '三刻') return 0.75;
  if (!/^[零一二两三四五六七八九十]+$/.test(s)) return null;
  if (s === '十') return 10;
  if (s.length === 1) return CN_NUM[s] ?? null;
  if (s.startsWith('十')) return 10 + (CN_NUM[s[1]] || 0);
  if (s.endsWith('十')) return (CN_NUM[s[0]] || 0) * 10;
  if (s.includes('十')) {
    const [a, b] = s.split('十');
    return (CN_NUM[a] || 0) * 10 + (CN_NUM[b] || 0);
  }
  return null;
}

/** 「3点半」「15:20」「晚上七点一刻」 → {hour, minute} */
function parseClockPhrase(text) {
  const s = String(text || '');
  // 24 小时制：15:20 / 15点20 / 15时20分
  let m = s.match(/(\d{1,2})\s*[:：点时]\s*(\d{1,2}|\d{1,2}分)/);
  if (!m) m = s.match(/(\d{1,2})\s*[:：点时]/);
  if (m && /[:：点时]/.test(m[0])) {
    const hour = Number(m[1]);
    let minute = 0;
    const rest = m[2] ? m[2].replace('分', '') : '';
    if (/^\d+$/.test(rest)) minute = Number(rest);
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) return { hour, minute, raw: m[0] };
  }
  // 中文数字：三点半 / 七点一刻 / 十点
  m = s.match(/([零一二两三四五六七八九十]{1,2})\s*[点时](半|一刻|三刻|[零一二两三四五六七八九十]{1,2}分?)?/);
  if (m) {
    const hour = cnToNumber(m[1]);
    let minute = 0;
    const rest = m[2] || '';
    if (rest === '半') minute = 30;
    else if (rest === '一刻') minute = 15;
    else if (rest === '三刻') minute = 45;
    else if (rest) {
      const n = cnToNumber(rest.replace('分', ''));
      if (n !== null) minute = n;
    }
    if (hour !== null && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return { hour, minute, raw: m[0] };
    }
  }
  return null;
}

function periodOf(text) {
  for (const p of PERIOD) if (p.re.test(String(text || ''))) return p.hours;
  return null;
}

/** 把小时按「上午/下午/晚上」修正：晚上八点 → 20 点；下午三点 → 15 点 */
function applyPeriod(hour, period) {
  if (!period) return hour;
  const [lo, hi] = period;
  if (hour === 12 && lo >= 13) return 12 + (hour - 12); // 下午12点 → 12
  if (hour >= lo && hour <= hi) return hour;
  if (hour < 12 && lo >= 12) return hour + 12;          // 下午3 → 15
  if (hour === 12) return 12;
  if (hour >= 13 && hi <= 12) return hour - 12;         // 凌晨13 → 1
  return hour;
}

const REL_RE = /([零一二两三四五六七八九十\d]{1,3})\s*(秒钟?|分钟|分|个?小时|钟头)\s*(?:之?后|以后)/;
const DAY_RE = /(大后天|后天|明天|明早|明晚|今天|今早|今晚|今儿|当天)/;

function dayOffset(word) {
  if (!word) return 0;
  if (word === '后天') return 2;
  if (word === '大后天') return 3;
  if (word === '明天' || word === '明早' || word === '明晚') return 1;
  return 0;
}

/**
 * 解析提醒时间。
 * @param {string} text 用户原话
 * @param {Date} now
 * @returns {{at:Date, rest:string, matched:string}|null}
 */
function parseWhen(text, now = new Date()) {
  const raw = String(text || '');
  if (!raw) return null;

  // ① 相对时间：30 分钟后 / 两个小时以后
  const rel = raw.match(REL_RE);
  if (rel) {
    const n = cnToNumber(rel[1]);
    if (n !== null && n > 0) {
      const unit = rel[2];
      const ms = /秒/.test(unit) ? n * 1000
        : /小时|钟头/.test(unit) ? n * 3600 * 1000
          : n * 60 * 1000;
      if (ms >= 1000 && ms <= 30 * 24 * 3600 * 1000) {
        return { at: new Date(now.getTime() + ms), rest: raw.replace(rel[0], ''), matched: rel[0] };
      }
    }
  }

  // ② 绝对时间：今天/明天/后天 + 几点几分
  const dayWord = (raw.match(DAY_RE) || [])[1] || '';
  const clock = parseClockPhrase(raw);
  if (!clock) return null;
  const period = periodOf(raw) || (/明晚|今晚|晚上/.test(dayWord) ? [18, 23] : null);
  let hour = applyPeriod(clock.hour, period);
  if (hour > 23 || hour < 0) return null;
  let offset = dayOffset(dayWord);
  const at = new Date(now.getTime());
  at.setSeconds(0, 0);
  at.setHours(hour, clock.minute, 0, 0);
  // 没说「明天」但那个点已经过了 → 顺延到明天（「八点提醒我」晚上说就是明早八点）
  if (!dayWord && at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  if (offset) at.setDate(at.getDate() + offset);
  if (at.getTime() <= now.getTime()) {
    // 明确说了今天但已经过了 → 不猜，交给调用方当普通聊天
    return null;
  }
  return { at, rest: raw.replace(dayWord, '').replace(clock.raw, ''), matched: `${dayWord}${clock.raw}` };
}

// 只认「明确在让她做事」的说法。
// 以前把「记得 / 到点 / 到时候」也算意图词，于是「我记得明天八点要开会」这种
// 自言自语被当成设提醒（用户实测踩到过）。现在必须出现 提醒我 / 叫我 / 别忘。
const INTENT_RE = /(提醒我|提醒一下|提醒下|叫我|别忘)/;
/** 「他叫我明天八点开会」是在转述，不是让她做提醒 */
const REPORTED_RE = /(他|她|你|您|朋友|同事|老板|老师|同学|我妈|我爸|家人|别人)\s*叫我/;
/** 像不像一个「设提醒」的请求（先粗筛，再解析时间） */
function looksLikeReminder(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 120) return false;
  if (!INTENT_RE.test(s)) return false;
  // 「提醒你」「提醒大家」是让别人，不是设提醒
  if (/提醒(你|您|大家|他|她|他们)/.test(s)) return false;
  if (REPORTED_RE.test(s)) return false;
  return true;
}

const TAIL_RE = /\s*(记得|哦|啊|呀|嘛|吧|谢谢|谢了|辛苦了)[。.!！~～]*\s*$/;

/** 把「时间 + 提醒我 + 事情」里的事情抽出来 */
function extractWhat(text) {
  let s = String(text || '').trim();
  // 先去掉时间短语（相对时间 / 今天明天 / 几点几分 / 上午下午）
  s = s.replace(REL_RE, '').replace(DAY_RE, '');
  const clock = parseClockPhrase(s);
  if (clock) s = s.replace(clock.raw, '');
  s = s.replace(/(凌晨|早上|早晨|清晨|上午|中午|晌午|下午|午后|傍晚|黄昏|晚上|夜里|今晚|明晚)/g, '');
  // 提醒意图词可能在句首，也可能跟在时间后面（「十点半提醒我开会」）
  s = s.replace(/帮我|请|麻烦|那个|然后/g, '');
  s = s.replace(/(提醒一下|提醒下|提醒我|提醒|叫我|别忘记|别忘了|别忘|记得|到点|到时候)/g, '');
  s = s.replace(/^(一下|一声|一句|下)[\s,，。.!！~～]*/, '');
  s = s.replace(/^[\s,，:：。.!！~～、]+/, '').replace(TAIL_RE, '').replace(/[\s,，:：。.!！~～、]+$/, '');
  return s.slice(0, 200);
}

/**
 * 完整解析：像提醒 + 有时间 + 有事可提醒，三者齐了才算数。
 * @returns {{at:Date, what:string, when:string}|null}
 */
function parseReminder(text, now = new Date()) {
  if (!looksLikeReminder(text)) return null;
  const when = parseWhen(text, now);
  if (!when) return null;
  const what = extractWhat(text);
  if (!what || what.length < 1) return null;
  return { at: when.at, what, when: when.matched || '' };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 「今天 20:30」/「明天 08:00」这种人话 */
function describeWhen(at, now = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now.getTime() + 24 * 3600 * 1000).toDateString() === d.toDateString();
  const clock = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (sameDay) return `今天 ${clock}`;
  if (tomorrow) return `明天 ${clock}`;
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

/** 设好提醒之后的回执（不经过模型，保证时间和事情都对） */
function confirmText({ at, what }, { now = new Date(), group = false, who = '' } = {}) {
  const when = describeWhen(at, now);
  const target = group && who ? `到点我会在群里 @${who}` : '到点我在这里提醒你';
  return `好，${when} 提醒你${what}。${target}。`;
}

module.exports = {
  parseWhen,
  parseReminder,
  looksLikeReminder,
  extractWhat,
  describeWhen,
  confirmText,
  cnToNumber,
  parseClockPhrase,
  applyPeriod,
};
