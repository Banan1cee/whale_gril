'use strict';

/**
 * 简易联网检索：抓 Bing 网页结果（标题 / 链接 / 摘要）。
 * 只用 Node 内置 https，不依赖第三方库；失败返回空数组。
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function getText(url, timeoutMs = 8000, extraHeaders = null) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*', ...(extraHeaders || {}) } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return getText(new URL(res.headers.location, url).toString(), timeoutMs).then(resolve, reject);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function getJson(url, timeoutMs = 8000) {
  return getText(url, timeoutMs).then((body) => JSON.parse(body));
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    });
}

function parseBing(html) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const url = decodeEntities(linkMatch[1]);
    const title = stripTags(linkMatch[2]);
    const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = pMatch ? stripTags(pMatch[1]) : '';
    if (title || snippet) out.push({ title, url, snippet });
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 时效过滤：问「最新 / 现在出到几 / 今年」这类问题时，把明显过期的结果剔掉。
 * 实测「苹果现在出到几了」会同时返回 2026 的预测文和「2007-2025 iPhone 全线回顾」，
 * 模型看到旧文就答旧型号（把 iPhone 18 说成 16）。
 * 注意：**不要**简单给查询加年份——实测加了反而把「1 天前」的新结果挤掉。
 */
const TIME_SENSITIVE_RE = /(最新|现在|今年|目前|当前|出到几|第几代|什么型号|哪个版本|多少钱|什么价|行情|发布会|刚出|新出)/;

function parseSnippetAgeDays(snippet) {
  const s = String(snippet || '');
  const rel = s.match(/(\d+)\s*(分钟|小时|天|周)之前/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { 分钟: 1 / 1440, 小时: 1 / 24, 天: 1, 周: 7 }[rel[2]] || 1;
    return n * unit;
  }
  const abs = s.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日/);
  if (abs) {
    const t = new Date(Number(abs[1]), Number(abs[2]) - 1, Number(abs[3])).getTime();
    if (!Number.isNaN(t)) return (Date.now() - t) / 86400000;
  }
  return null;
}

function isTimeSensitive(query) {
  return TIME_SENSITIVE_RE.test(String(query || ''));
}

function dropStaleResults(query, results, { maxAgeDays = 550 } = {}) {
  if (!TIME_SENSITIVE_RE.test(String(query || ''))) return results;
  const fresh = [];
  for (const r of results) {
    const age = parseSnippetAgeDays(r.snippet || r.title || '');
    if (age !== null && age > maxAgeDays) continue; // 明显过期，丢掉
    fresh.push(r);
  }
  // 全被判过期（说明判断依据不可靠）就保留原始结果，别把她弄成「搜不到」
  return fresh.length ? fresh : results;
}

const STOP_WORDS = /(帮我|请问|请|一下|查查|查一查|搜搜|搜索|看看|我想知道|谁是|是谁|这个|那个|什么|怎么|为什么|是不是|有没有|最新|现在|目前|当前|今天|多少钱|什么价|价格是|怎么样|如何|的|吗|呢|啊|呀|吧|了|嘛|呗)/gi;

/** 把口语问句拆成可判定相关性的词块（英文词 + 中文二字组）。 */
// 品牌口语 → 检索词。现场问题：搜「苹果最新的机器是什么」命中的是
// 「苹果（蔷薇科植物）」和「苹果公司」百科，她只能回答「我记的是旧的」。
// 手机/电脑语境下换成 iPhone / Mac，结果才对得上。
const BRAND_HINTS = [
  { test: /(苹果|apple)[^。！？]{0,6}(手机|机器|机型|型号|出到|几代|第几|新机)|(手机|机器|机型|型号|出到|几代|第几|新机)[^。！？]{0,6}(苹果|apple)/i,
    from: /苹果手机|苹果|apple/gi, to: 'iPhone' },
  { test: /(苹果|apple)[^。！？]{0,6}(电脑|笔记本|mac)|(电脑|笔记本|mac)[^。！？]{0,6}(苹果|apple)/i,
    from: /苹果电脑|苹果笔记本|苹果|apple|macbook/gi, to: 'Mac' },
];

/** 只改检索式，不改变原句语义。 */
function expandBrand(text) {
  let out = String(text || '');
  for (const rule of BRAND_HINTS) {
    if (!rule.test.test(out)) continue;
    const replaced = out.replace(rule.from, rule.to).replace(/\s+/g, ' ').trim();
    if (replaced && replaced !== out) out = replaced;
  }
  return out;
}

// 检索式写成 iPhone、原句写的是「苹果」时也要算命中。
const TOKEN_ALIASES = { '苹果': ['iphone', 'apple', 'mac'], iphone: ['苹果'], mac: ['苹果', 'macbook'] };

// 这些二字组太泛，几乎任何页面都能命中（「谁」「这个」「时候」…），
// 用它们判相关性等于没判，会把字典页、歌词页当成有效资料。
const GENERIC_TOKENS = new Set([
  '谁是', '是谁', '这个', '那个', '一个', '什么', '怎么', '为什', '什们', '时候', '东西',
  '事情', '问题', '方法', '我们', '你们', '他们', '自己', '可以', '不是', '就是', '还是',
  '如果', '但是', '所以', '因为', '这样', '那样', '知道', '觉得', '应该', '需要', '很多',
  '非常', '真的', '一直', '已经', '开始', '结束', '现在', '今天', '明天', '如何', '哪些',
]);

function queryTokens(query) {
  const text = expandBrand(String(query || '')).replace(STOP_WORDS, ' ');
  const latin = (text.match(/[a-z0-9][a-z0-9+.\-]{1,}/gi) || []).map((w) => w.toLowerCase());
  const cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const bigrams = [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) bigrams.push(run.slice(i, i + 2));
  }
  for (const run of cjkRuns) if (run.length <= 4) bigrams.push(run);
  return [...new Set([...latin, ...bigrams])]
    .filter((t) => t.length >= 2 && (!GENERIC_TOKENS.has(t) || /^[a-z0-9]/.test(t)));
}

/**
 * 相关性过滤。现场问题：「最新 iPhone 多少钱」经 Bing 中国站返回的是 Yandex 官网，
 * 「显卡行情」返回「帮」字字典页——垃圾结果照样喂给模型，她只能回答「我记的是旧的」。
 * 判据：标题或摘要里至少命中一个查询词块。
 */
function keepRelevant(query, results) {
  const tokens = queryTokens(query);
  // 现场问题：问「苹果最新的机器」时命中「苹果（蔷薇科植物）」百科，
  // 提示词里塞进水果条目，她只能答非所问。
  const phoneContext = /(手机|机器|机型|型号|出到|几代|第几|新机|iphone)/i.test(String(query || ''));
  const fruitPage = /(蔷薇科|苹果属|Malus|水果|落叶乔木|栽培苹果|果树)/i;
  if (!tokens.length) return results;
  const kept = [];
  for (const item of results) {
    const hay = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
    if (phoneContext && fruitPage.test(hay)) continue;
    if (tokens.some((t) => hay.includes(t)
      || (TOKEN_ALIASES[t] || []).some((alias) => hay.includes(alias)))) kept.push(item);
  }
  return kept;
}

/** 去掉口语填充词后的检索式，供第一次结果跑题时重搜。 */
function cleanQuery(query) {
  let text = String(query || '')
    .replace(/^\s*(帮我|请|你|麻烦)?\s*(查一下|查查|查一查|查|搜一下|搜搜|搜|找一下|找|看看)/, ' ')
    .replace(STOP_WORDS, ' ')
    .replace(/[，。！？、,.!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = expandBrand(text) || text;
  // 「苹果最新的机器是什么」清洗后会剩「iPhone 机器是」这种别扭短语，
  // 搜出来还是百科页。收敛成「iPhone 最新机型」这类能出硬货的检索式。
  text = text.replace(/\s*(是|有|在|了)\s*$/g, '').replace(/\s+/g, ' ').trim();
  if (/iphone/i.test(text) && /(机器|机型|型号|出到|几代|第几|最新|新机|发布)/.test(text)) {
    text = 'iPhone 最新机型';
  } else if (/\bmac\b/i.test(text) && /(机器|机型|型号|最新|笔记本|发布)/.test(text)) {
    text = 'Mac 最新机型';
  }
  // 「多少钱 / 什么价」问的是价格：保留这个意图，否则只会搜到官网首页。
  if (/(多少钱|什么价|价格|报价)/.test(String(query || '')) && !/价格|报价|行情/.test(text)) {
    text = (text + ' 价格').trim();
  }
  return text || String(query || '').trim();
}

async function search(query, { limit = 5, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  const ask = async (term) => {
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(term) + '&setlang=zh-CN&count=10';
    return parseBing(await getText(url, timeoutMs));
  };
  try {
    const first = keepRelevant(q, await ask(q));
    // 产品类问句（「苹果最新的机器是什么」）Bing 只给官网首页，首页摘要里没有型号。
    // 官方「机型比较」页的摘要会直接列出当前阵容（实测含 iPhone 18 Pro / iPhone Duo），
    // 所以这类问题优先补一次站内检索。
    const wantsLineup = /(苹果|iphone|mac|macbook)[^。！？]{0,8}(最新|机器|机型|型号|出到|几代|第几|新机|发布)|(最新|机器|机型|型号|出到|几代|第几|新机|发布)[^。！？]{0,8}(苹果|iphone|mac)/i.test(q);
    const lineup = /(电脑|笔记本|mac(book)?)/i.test(q)
      ? 'site:apple.com.cn Mac 机型'
      : 'site:apple.com.cn iPhone 机型';
    if (wantsLineup) {
      const official = keepRelevant(q, await ask(lineup));
      // 官方机型页信息最硬（摘要里直接列当前阵容），排在前面，避免被官网首页挤掉。
      const merged0 = [...official, ...first].filter((item, i, all) => all.findIndex((x) => x.url === item.url) === i);
      if (merged0.length >= 2) return dropStaleResults(q, merged0).slice(0, limit);
    }
    if (first.length >= 2) return dropStaleResults(q, first).slice(0, limit);
    // 结果跑题或太少：归一化检索式、词块各重搜一次（纠错，不是重试）。
    const attempts = [...new Set([cleanQuery(q), queryTokens(q).join(' ')])
      .filter((term) => term && term !== q)].slice(0, 2);
    const extra = [];
    for (const term of attempts) {
      extra.push(...keepRelevant(q, await ask(term)));
      if (extra.length >= 2) break;
    }
    const merged = [...first, ...extra].filter((item, i, all) => all.findIndex((x) => x.url === item.url) === i);
    return dropStaleResults(q, merged).slice(0, limit);
  } catch {
    return [];
  }
}

async function searchText(query, opts = {}) {
  const list = await search(query, opts);
  if (!list.length) return '';
  return list
    .map((r, i) => `${i + 1}. ${r.title || '（无标题）'}\n   ${r.snippet || ''}\n   ${r.url || ''}`)
    .join('\n');
}

/** 今日头条热榜（真实当前热点） */
async function hotNews(limit = 10, timeoutMs = 8000) {
  try {
    const raw = await getText('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', timeoutMs);
    const data = JSON.parse(raw);
    const list = Array.isArray(data.data) ? data.data : [];
    return list.slice(0, limit).map((item) => ({
      title: String(item.Title || '').trim(),
      url: String(item.Url || '').trim(),
      hot: Number(item.HotValue) || 0,
    })).filter((x) => x.title);
  } catch {
    return [];
  }
}

async function hotNewsText(limit = 8) {
  const list = await hotNews(limit);
  if (!list.length) return '';
  return list.map((x, i) => `${i + 1}. ${x.title}`).join('\n');
}

// ---------------------------------------------------------------------------
// 天气：只靠 Bing 摘要答不准（常常只有「多云」没有温度，还容易搜到别的城市），
// 所以单独接 open-meteo（免费、不要 key、支持中文地名）。
// ---------------------------------------------------------------------------

const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨',
  66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};

function wmoText(code) {
  const n = Number(code);
  return WMO[n] || (Number.isFinite(n) ? '天气代码' + n : '未知');
}

/** B站热搜（官方接口，不需要 Key） */
async function bilibiliHot(limit = 10, timeoutMs = 8000) {
  try {
    const raw = await getText('https://api.bilibili.com/x/web-interface/search/square?limit=10', timeoutMs);
    const data = JSON.parse(raw);
    const list = (data && data.data && data.data.trending && data.data.trending.list) || [];
    return list.slice(0, limit)
      .map((item) => String(item.show_name || item.keyword || '').trim())
      .filter(Boolean);
  } catch { return []; }
}

/** 微博热搜（公开热搜榜，不需要登录） */
async function weiboHot(limit = 10, timeoutMs = 8000) {
  try {
    const raw = await getText('https://weibo.com/ajax/side/hotSearch', timeoutMs,
      { Referer: 'https://weibo.com/', 'X-Requested-With': 'XMLHttpRequest' });
    const data = JSON.parse(raw);
    const list = (data && data.data && data.data.realtime) || [];
    return list.slice(0, limit)
      .map((item) => String(item.word || item.note || '').trim())
      .filter(Boolean);
  } catch { return []; }
}

function hotListText(title, list) {
  if (!list.length) return '';
  return '【' + title + '】\n' + list.map((x, i) => (i + 1) + '. ' + x).join('\n');
}

async function bilibiliHotText(limit = 10, timeoutMs = 8000) {
  return hotListText('B站热搜（实时）', await bilibiliHot(limit, timeoutMs));
}

async function weiboHotText(limit = 10, timeoutMs = 8000) {
  return hotListText('微博热搜（实时）', await weiboHot(limit, timeoutMs));
}

/** 按本机公网 IP 猜城市（没配 city 时用；拿不到就返回空，不影响别的） */
let _ipCity = { value: '', at: 0 };
async function ipCity(timeoutMs = 6000) {
  const now = Date.now();
  if (_ipCity.value && now - _ipCity.at < 6 * 3600 * 1000) return _ipCity.value;
  try {
    const j = await getJson('https://ipinfo.io/json', timeoutMs);
    const city = String((j && j.city) || '').trim();
    if (city) {
      _ipCity = { value: city, at: now };
      return city;
    }
  } catch { /* 拿不到就算了 */ }
  return '';
}

/** 地名 → 经纬度（找不到返回 null） */
async function geocodeCity(city, timeoutMs = 8000) {
  const name = String(city || '').trim();
  if (!name) return null;
  const url =
    'https://geocoding-api.open-meteo.com/v1/search?name=' +
    encodeURIComponent(name) +
    '&count=1&language=zh&format=json';
  try {
    const j = await getJson(url, timeoutMs);
    const r = Array.isArray(j.results) && j.results[0];
    if (!r) return null;
    return {
      name: r.name || name,
      admin1: r.admin1 || '',
      latitude: r.latitude,
      longitude: r.longitude,
      timezone: r.timezone || 'Asia/Shanghai',
    };
  } catch {
    return null;
  }
}

/** 当前天气 + 今明两天（返回给模型看的一段中文） */
async function weatherText(city, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 8000;
  const place = await geocodeCity(city, timeoutMs);
  if (!place) return '';
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude +
    '&longitude=' + place.longitude +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    '&timezone=' + encodeURIComponent(place.timezone) +
    '&forecast_days=2';
  try {
    const j = await getJson(url, timeoutMs);
    const cur = j.current || {};
    const d = j.daily || {};
    const day = (i) => ({
      date: (d.time || [])[i] || '',
      max: (d.temperature_2m_max || [])[i],
      min: (d.temperature_2m_min || [])[i],
      code: (d.weather_code || [])[i],
      rain: (d.precipitation_probability_max || [])[i],
    });
    const today = day(0);
    const tomorrow = day(1);
    const lines = [];
    lines.push(`【${place.name}${place.admin1 && place.admin1 !== place.name ? '（' + place.admin1 + '）' : ''} 实时天气】`);
    if (cur.temperature_2m != null) {
      lines.push(
        `现在 ${cur.temperature_2m}°C（体感 ${cur.apparent_temperature}°C，${wmoText(cur.weather_code)}，` +
        `湿度 ${cur.relative_humidity_2m}%，风 ${cur.wind_speed_10m} km/h）`
      );
    }
    if (today.max != null) {
      lines.push(`今天 ${wmoText(today.code)}，${today.min}~${today.max}°C，降水概率 ${today.rain ?? 0}%`);
    }
    if (tomorrow.max != null) {
      lines.push(`明天 ${wmoText(tomorrow.code)}，${tomorrow.min}~${tomorrow.max}°C，降水概率 ${tomorrow.rain ?? 0}%`);
    }
    lines.push('（数据源 open-meteo，按预报时间当地时区）');
    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  expandBrand,
  queryTokens,
  keepRelevant,
  cleanQuery,
  dropStaleResults,
  isTimeSensitive,
  parseSnippetAgeDays,
  search,
  searchText,
  parseBing,
  hotNews,
  hotNewsText,
  bilibiliHot,
  bilibiliHotText,
  weiboHot,
  weiboHotText,
  geocodeCity,
  ipCity,
  weatherText,
  wmoText,
};
