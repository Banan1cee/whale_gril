'use strict';

const { getJson, remaining, searchError } = require('./transport');
const { createCache } = require('./cache');
const { providerResult } = require('./providerResult');
const cache = createCache();
const WMO = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴', 45: '有雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒', 80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '强阵雪', 95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷暴伴冰雹',
};
function wmoText(code) {
  if (code == null) return '未知';
  const n = Number(code);
  return WMO[n] || (Number.isFinite(n) ? '天气代码' + n : '未知');
}

async function geocodeCity(city, opts = {}) {
  const name = String(city || '').trim().slice(0, 80);
  if (!name) return null;
  return cache.get('geo:' + name.toLowerCase(), async shared => {
    const data = await getJson('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(name)
      + '&count=1&language=zh&format=json', shared);
    if (!data || typeof data !== 'object' || (data.results != null && !Array.isArray(data.results))) throw searchError('parse_error');
    const row = data.results?.[0];
    if (!row) return null;
    if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) throw searchError('parse_error');
    return { name: row.name || name, admin1: row.admin1 || '', latitude: row.latitude, longitude: row.longitude, timezone: row.timezone || 'Asia/Shanghai' };
  }, { ...opts, ttlMs: 6 * 3600000 });
}

async function ipCity(opts = {}) {
  return cache.get('ip-city', async shared => {
    const data = await getJson('https://ipinfo.io/json', shared);
    return String(data?.city || '').trim();
  }, { ...opts, ttlMs: 6 * 3600000 });
}

function weatherSnippet(place, data) {
  const cur = data.current || {}, daily = data.daily || {};
  const lines = [];
  if (Number.isFinite(cur.temperature_2m)) {
    const extras = [];
    if (Number.isFinite(cur.apparent_temperature)) extras.push(`体感 ${cur.apparent_temperature}°C`);
    extras.push(wmoText(cur.weather_code));
    if (Number.isFinite(cur.relative_humidity_2m)) extras.push(`湿度 ${cur.relative_humidity_2m}%`);
    if (Number.isFinite(cur.wind_speed_10m)) extras.push(`风 ${cur.wind_speed_10m} km/h`);
    lines.push(`${cur.time || '当前'}：${cur.temperature_2m}°C（${extras.join('，')}）`);
  }
  for (let i = 0; i < 2; i++) {
    if (!daily.time?.[i] || !Number.isFinite(daily.temperature_2m_max?.[i]) || !Number.isFinite(daily.temperature_2m_min?.[i])) continue;
    const rain = daily.precipitation_probability_max?.[i];
    lines.push(`${daily.time[i]}：${wmoText(daily.weather_code?.[i])}，${daily.temperature_2m_min[i]}~${daily.temperature_2m_max[i]}°C`
      + (Number.isFinite(rain) ? `，降水概率 ${rain}%` : ''));
  }
  if (!lines.length) return '';
  return lines.join('\n') + `\n（按预报当地时区 ${place.timezone}；只含接口列出的日期）`;
}

async function weatherResult(city, opts = {}) {
  const deadline = Math.min(opts.deadline ?? Infinity, Date.now() + remaining(opts));
  return providerResult('open-meteo', async () => {
    const place = opts.place || await geocodeCity(city, { ...opts, deadline });
    if (!place) return [];
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + place.latitude + '&longitude=' + place.longitude
      + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max'
      + '&timezone=' + encodeURIComponent(place.timezone) + '&forecast_days=2';
    const data = await getJson(url, { ...opts, deadline });
    if (!data || typeof data !== 'object') throw searchError('parse_error');
    const snippet = weatherSnippet(place, data);
    if (!snippet) throw searchError('missing_weather_data');
    return [{ title: `${place.name}${place.admin1 && place.admin1 !== place.name ? '（' + place.admin1 + '）' : ''} 天气`,
      url, snippet, provider: 'open-meteo', fetchedAt: new Date().toISOString(), publishedAt: null,
      weather: { place, current: data.current || null, daily: data.daily || null } }];
  }, opts);
}

module.exports = { geocodeCity, ipCity, weatherResult, weatherSnippet, wmoText };
