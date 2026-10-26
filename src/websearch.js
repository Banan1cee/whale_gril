'use strict';

/**
 * 简易联网检索：抓 Bing 网页结果（标题 / 链接 / 摘要）。
 * 只用 Node 内置 https，不依赖第三方库；失败返回空数组。
 */
const https = require('node:https');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

function getText(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,*/*' } },
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

async function search(query, { limit = 5, timeoutMs = 8000 } = {}) {
  const q = String(query || '').trim().slice(0, 100);
  if (!q) return [];
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=zh-CN&count=10';
  try {
    const html = await getText(url, timeoutMs);
    return parseBing(html).slice(0, limit);
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
  search,
  searchText,
  parseBing,
  hotNews,
  hotNewsText,
  geocodeCity,
  ipCity,
  weatherText,
  wmoText,
};
