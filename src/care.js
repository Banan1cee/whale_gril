'use strict';

/**
 * 主动搭话（care）：没事的时候她自己来找你说句话，问问「在干啥 / 累不累」。
 *
 * 和「主动分享视频」是同一套机制：桥接定时问服务端「该不该发」，服务端说该发就生成内容。
 * 区别是这里由调试台控制**时间窗**和**频率**，而且用纯函数算，方便测试。
 *
 * 设计要点：
 *   - 时间窗用 `'09:00-12:00'` 这种字符串，跨零点（22:00-02:00）也认；
 *   - 频率带「稳定抖动」：同一个 lastSentTs 算出来的间隔是固定的，
 *     否则每次轮询都换一个随机值，会造成抖动到临界点时反复横跳；
 *   - 判断逻辑全在这里，服务端只负责调用，桥接只负责定时轮询和发送。
 */

const DEFAULT_WINDOW = '09:00-23:00';

/** 一天里的分钟数：'09:30' → 570 */
function parseClock(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})[:：](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
  if (h < 0 || h > 24 || min < 0 || min > 59) return null;
  if (h === 24 && min !== 0) return null;
  return h * 60 + min;
}

/** '09:00-12:00' → { start: 540, end: 720, raw: '09:00-12:00' }；写错了返回 null */
function parseWindow(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[~～—–到至]/g, '-');
  const m = cleaned.match(/^(.+?)-(.+)$/);
  if (!m) return null;
  const start = parseClock(m[1]);
  const end = parseClock(m[2]);
  if (start === null || end === null) return null;
  // 24:00 当一天结束处理
  return { start, end: end === 1440 ? 1440 : end, raw };
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatMinutes(min) {
  const m = Math.max(0, Math.min(1440, Math.round(min)));
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** 把配置里的时间段整理成数组；空/写错就退回默认（全天 09:00-23:00） */
function parseWindows(list) {
  const arr = Array.isArray(list) ? list : list ? String(list).split(/[\n,;，；]+/) : [];
  const out = [];
  for (const item of arr) {
    const w = parseWindow(item);
    if (w) out.push(w);
  }
  return out;
}

/** 一个时间点在不在这些时间段里（支持跨零点） */
function inWindows(minutesOfDay, windows) {
  const list = windows && windows.length ? windows : parseWindows([DEFAULT_WINDOW]);
  const now = ((Math.round(minutesOfDay) % 1440) + 1440) % 1440;
  for (const w of list) {
    if (w.start === w.end) continue;                    // 空区间（09:00-09:00）跳过
    if (w.start < w.end) {
      if (now >= w.start && now < w.end) return true;
    } else if (now >= w.start || now < w.end) {          // 跨零点，比如 22:00-02:00
      return true;
    }
  }
  return false;
}

/** 配置 → 规范化的 care 设置（缺省值都在这里，别散落各处） */
function normalizeCare(config) {
  const c = (config && config.care) || {};
  const every = Number(c.everyMinutes);
  const jitter = Number(c.jitterMinutes);
  const maxPerDay = Number(c.maxPerDay);
  const quiet = Number(c.quietAfterMinutes);
  return {
    enabled: c.enabled === undefined ? true : Boolean(c.enabled),
    windows: parseWindows(c.windows),
    everyMinutes: Number.isFinite(every) && every > 0 ? every : 90,
    jitterMinutes: Number.isFinite(jitter) && jitter >= 0 ? jitter : 25,
    maxPerDay: Number.isFinite(maxPerDay) && maxPerDay >= 0 ? maxPerDay : 6,
    quietAfterMinutes: Number.isFinite(quiet) && quiet >= 0 ? quiet : 20,
  };
}

/**
 * 稳定的抖动：同一个 lastSentTs 永远算出同一个偏移。
 * 用简单的 32 位混合，不用真随机，避免轮询时反复横跳。
 */
function stableJitter(lastSentTs, jitterMinutes) {
  if (!jitterMinutes) return 0;
  let x = Math.abs(Math.floor(Number(lastSentTs) || 0)) % 2147483647;
  x = (x ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  const span = jitterMinutes * 2;
  return (x % (span + 1)) - jitterMinutes;
}

/**
 * 现在该不该主动搭话。
 *
 * @param {object} config 整份配置（读 care 段）
 * @param {object} opts
 *   - lastSentTs   上次主动搭话的时间（毫秒），0 = 从没发过
 *   - sentToday    今天已经发了几次
 *   - now          当前时间（毫秒），测试用
 * @returns {{due:boolean, reason:string, ...}}
 */
function careDue(config, { lastSentTs = 0, sentToday = 0, now = Date.now() } = {}) {
  const care = normalizeCare(config);
  if (!care.enabled) return { due: false, reason: 'disabled', care };

  const d = new Date(now);
  const minutesOfDay = d.getHours() * 60 + d.getMinutes();
  const windows = care.windows.length ? care.windows : parseWindows([DEFAULT_WINDOW]);
  if (!inWindows(minutesOfDay, windows)) {
    return {
      due: false,
      reason: 'out_of_window',
      now: formatMinutes(minutesOfDay),
      windows: windows.map((w) => w.raw),
    };
  }

  if (care.maxPerDay > 0 && Number(sentToday) >= care.maxPerDay) {
    return { due: false, reason: 'daily_cap', sentToday: Number(sentToday), maxPerDay: care.maxPerDay };
  }

  // 抖动只用来「打散节奏」，不能盖过用户明确设的间隔：
  // 比如 everyMinutes=1、jitterMinutes=25，再不收窄就变成等 22 分钟，等于设置没生效。
  const jitterCap = Math.max(0, Math.floor(care.everyMinutes / 2));
  const jitter = stableJitter(lastSentTs, Math.min(care.jitterMinutes, jitterCap));
  const gapMinutes = Math.max(1, care.everyMinutes + jitter);
  const gapMs = gapMinutes * 60 * 1000;
  const elapsed = lastSentTs ? now - Number(lastSentTs) : Infinity;
  if (lastSentTs && elapsed < gapMs) {
    return {
      due: false,
      reason: 'too_soon',
      waitMinutes: Math.max(1, Math.ceil((gapMs - elapsed) / 60000)),
      gapMinutes,
    };
  }

  return { due: true, reason: 'ok', gapMinutes, now: formatMinutes(minutesOfDay) };
}

/** 演示模式 / 模型挂了时候的兜底台词（她主动开口的那几种） */
const CARE_TEMPLATES = [
  '在干啥呢',
  '忙完了没，累不累',
  '今天累不累啊',
  '在忙吗，我就问一句',
  '干嘛呢，有没有好好吃饭',
  '闲下来没，陪我说句话',
  '在干活吗，别太累了',
  '你这会儿在忙啥',
];

function pickTemplate(rng = Math.random) {
  const i = Math.floor(rng() * CARE_TEMPLATES.length);
  return CARE_TEMPLATES[Math.min(CARE_TEMPLATES.length - 1, Math.max(0, i))];
}

/**
 * 生成「主动搭话」用的提示词。
 * 参考最近聊过什么：别重复、接着话头问，比干巴巴一句「在干啥」自然。
 */
function buildCarePrompt({ persona = {}, recent = [], name = '', hour = null } = {}) {
  const who = String(persona.name || '鲸鲸');
  const master = String(persona.ownerName || '主人');
  const lines = [
    `你叫${who}，现在是你自己主动找人说话（对方没先开口）。`,
    `对方叫「${name || master}」。`,
    '目的很简单：关心一下对方在干嘛、累不累。',
    '',
    '要求：',
    '- 一句话，8~20 个字，像真人随手发的一条微信。',
    '- 可以是「在干啥呢」「忙完了没，累不累」这种感觉，但不要每次都说同一句。',
    '- 可以顺着最近聊的内容接一句，但别翻旧账、别追问隐私。',
    '- 不要自我介绍，不要说「我是 AI / 模型」，不要解释为什么找他。',
    '- 不要用颜文字堆砌，最多一个；不要用「~」。',
    '- 只输出这一句话本身。',
  ];
  if (Number.isFinite(hour)) {
    const part = hour < 6 ? '凌晨' : hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';
    lines.push(`- 现在是${part}，语气跟这个时间搭一点。`);
  }
  const user = recent.length
    ? '最近你们聊的（旧→新，只用来参考语气和话题，别复述）：\n' + recent.slice(-8).join('\n')
    : '你们有一阵没说话了。';
  return { system: lines.join('\n'), user };
}

/** 清理模型输出：先取第一行，再去掉引号 / 波浪号 */
function cleanCareText(raw) {
  let t = String(raw == null ? '' : raw).trim();
  // 先按行切：模型有时会先来一句废话换行，再给正文
  const firstLine = t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)[0] || '';
  t = firstLine || t;
  // 引号要按「行内」剥，否则第一行尾部的引号会留下来
  t = t.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, '').trim();
  t = t.replace(/[~～]+\s*$/g, '').trim();
  return t.slice(0, 40).trim();
}

module.exports = {
  parseClock,
  parseWindow,
  parseWindows,
  inWindows,
  normalizeCare,
  stableJitter,
  careDue,
  CARE_TEMPLATES,
  pickTemplate,
  buildCarePrompt,
  cleanCareText,
  formatMinutes,
  DEFAULT_WINDOW,
};
