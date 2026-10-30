'use strict';

/**
 * 简易联网检索：抓 Bing 网页结果（标题 / 链接 / 摘要）。
 * 只用 Node 内置 https，不依赖第三方库；失败返回空数组。
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function getText(url, timeoutMs = 8000, extraHeaders = null) {
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 8000);
  const visit = (target, redirects = 0) => new Promise((resolve, reject) => {
    let req;
    let response;
    let settled = false;
    const finish = (err, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(body);
    };
    // socket timeout 只是“空闲超时”，滴流响应/重定向也必须受同一个总时限约束。
    const timer = setTimeout(() => {
      const err = new Error('search deadline exceeded');
      finish(err);
      if (response) response.destroy();
      if (req) req.destroy(err);
    }, Math.max(1, deadline - Date.now()));
    try {
      if (Date.now() >= deadline) return finish(new Error('search deadline exceeded'));
      req = https.get(target, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*', ...(extraHeaders || {}) },
      }, (res) => {
        response = res;
        res.on('error', (err) => finish(err));
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 不等待跳转页的响应体，否则坏站点可留下永远不结束的连接。
          res.destroy();
          if (redirects >= 5) return finish(new Error('too many redirects'));
          let next;
          try { next = new URL(res.headers.location, target); } catch (err) { return finish(err); }
          if (next.protocol !== 'https:') return finish(new Error('unsupported redirect protocol'));
          // 保留微博等来源必需的请求头，不为每次跳转重置时限。
          clearTimeout(timer);
          visit(next.toString(), redirects + 1).then((body) => finish(null, body), finish);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.destroy();
          return finish(new Error('HTTP ' + res.statusCode));
        }
        res.on('aborted', () => finish(new Error('response aborted')));
        res.on('close', () => { if (!res.complete) finish(new Error('response closed early')); });
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > 2 * 1024 * 1024) {
            finish(new Error('response too large'));
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', (err) => finish(err));
    } catch (err) { finish(err); }
  });
  return visit(url);
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
    from: /苹果电脑|苹果笔记本|苹果|apple/gi, to: 'Mac' },
];

/** 只改检索式，不改变原句语义。 */
function expandBrand(text) {
  let out = String(text || '');
  // 已给出产品名时不能把 iPad/MacBook/Watch 所属的苹果改成 iPhone。
  if (/\b(?:iphone|ipad|mac(?:book)?|watch|airpods)\b/i.test(out)) return out;
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
    .replace(/[，。！？、!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = expandBrand(text) || text;
  // 不把整个查询收敛成“最新机型”：这会丢掉 iPhone 16 Pro / MacBook M4 等指定型号。
  text = text.replace(/\s*(是|有|在|了)\s*$/g, '').replace(/\s+/g, ' ').trim();
  // 「多少钱 / 什么价」问的是价格：保留这个意图，否则只会搜到官网首页。
  if (/(多少钱|什么价|价格|报价)/.test(String(query || '')) && !/价格|报价|行情/.test(text)) {
    text = (text + ' 价格').trim();
  }
  return text || String(query || '').trim();
}

async function search(query, { limit = 5, timeoutMs = 8000 } = {}) {
  const rawQuery = String(query || '').trim();
  if (!rawQuery) return [];
  const siteFilter = (rawQuery.match(/\bsite:[a-z0-9.-]+/i) || [''])[0];
  // 先截正文再附加站点，长专名不能把末尾的平台约束截没了。
  const q = siteFilter
    ? rawQuery.replace(siteFilter, '').trim().slice(0, 100) + ' ' + siteFilter
    : rawQuery.slice(0, 100);
  const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 8000);
  const ask = async (term) => {
    if (siteFilter && !term.toLowerCase().includes(siteFilter.toLowerCase())) term += ' ' + siteFilter;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];
    const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(term) + '&setlang=zh-CN&count=10';
    // 每次纠错独立失败，不能因补搜失败丢掉前面已经拿到的有效资料。
    try { return keepRelevant(q, parseBing(await getText(url, remaining))); } catch { return []; }
  };
  const first = await ask(q);
  // 泛问当前产品阵容时可补官方站点；这只是额外检索，摘要仍须作为外部资料核实。
  const wantsLineup = /(苹果|iphone|mac|macbook)[^。！？]{0,8}(最新|机器|机型|型号|出到|几代|第几|新机|发布)|(最新|机器|机型|型号|出到|几代|第几|新机|发布)[^。！？]{0,8}(苹果|iphone|mac)/i.test(q);
  const lineup = /(电脑|笔记本|mac(book)?)/i.test(q)
    ? 'site:apple.com.cn Mac 机型'
    : 'site:apple.com.cn iPhone 机型';
  // 指定了型号时不改成整个品牌的当前阵容。
  const namedModel = /(?:iphone\s*\d|macbook|\b[ma]\d|ipad|watch|airpods)/i.test(q);
  if (wantsLineup && !namedModel && !siteFilter) {
    const official = await ask(lineup);
    // 即使只补到一条，也必须留到后面的合并结果里。
    const merged0 = [...official, ...first].filter((item, i, all) => all.findIndex((x) => x.url === item.url) === i);
    first.splice(0, first.length, ...merged0);
  }
  if (first.length >= 2) return dropStaleResults(q, first).slice(0, limit);
  // 结果跑题或太少：归一化检索式、词块各重搜一次（纠错，不是重试）。
  const attempts = [...new Set([cleanQuery(q), queryTokens(q).join(' ')])]
    .filter((term) => term && term !== q).slice(0, 2);
  const extra = [];
  for (const term of attempts) {
    extra.push(...await ask(term));
    if (extra.length >= 2) break;
  }
  const merged = [...first, ...extra].filter((item, i, all) => all.findIndex((x) => x.url === item.url) === i);
  return dropStaleResults(q, merged).slice(0, limit);
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

async function hotNewsText(limit = 8, timeoutMs = 8000) {
  const list = await hotNews(limit, timeoutMs);
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
  const timeoutMs = Math.max(1, Number(opts.timeoutMs) || 8000);
  const deadline = Date.now() + timeoutMs;
  const place = await geocodeCity(city, timeoutMs);
  if (!place || Date.now() >= deadline) return '';
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude +
    '&longitude=' + place.longitude +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max' +
    '&timezone=' + encodeURIComponent(place.timezone) +
    '&forecast_days=2';
  try {
    const j = await getJson(url, Math.max(1, deadline - Date.now()));
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
