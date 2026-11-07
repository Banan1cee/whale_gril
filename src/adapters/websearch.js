'use strict';

// 旧调用方（定位服务及外部脚本）继续用原接口；聊天流程使用结构化协议。
const quality = require('../core/search/quality');
const { formatResult } = require('../core/search/result');
const { searchResult } = require('./search/web');
const { parseBing } = require('./search/bing');
const { hotlistResult } = require('./search/hotlists');
const weather = require('./search/weather');

async function search(query, opts) {
  return (await searchResult(query, opts)).items.map(({ title, url, snippet }) => ({ title, url, snippet }));
}
async function searchText(query, opts) { return formatResult(await searchResult(query, opts)); }
async function hotNews(limit = 10, timeoutMs = 8000) {
  return (await hotlistResult('toutiao', { limit, timeoutMs })).items.map(({ title, url, hot }) => ({ title, url, hot }));
}
async function hotNewsText(limit = 8, timeoutMs = 8000) { return formatResult(await hotlistResult('toutiao', { limit, timeoutMs })); }
async function bilibiliHot(limit = 10, timeoutMs = 8000) { return (await hotlistResult('bilibili', { limit, timeoutMs })).items.map(x => x.title); }
async function weiboHot(limit = 10, timeoutMs = 8000) { return (await hotlistResult('weibo', { limit, timeoutMs })).items.map(x => x.title); }
async function bilibiliHotText(limit = 10, timeoutMs = 8000) { return formatResult(await hotlistResult('bilibili', { limit, timeoutMs })); }
async function weiboHotText(limit = 10, timeoutMs = 8000) { return formatResult(await hotlistResult('weibo', { limit, timeoutMs })); }
async function geocodeCity(city, timeoutMs = 8000) { try { return await weather.geocodeCity(city, { timeoutMs }); } catch { return null; } }
async function ipCity(timeoutMs = 6000) { try { return await weather.ipCity({ timeoutMs }); } catch { return ''; } }
async function weatherText(city, opts) { return formatResult(await weather.weatherResult(city, opts)); }

module.exports = { ...quality, searchResult, hotlistResult, weatherResult: weather.weatherResult,
  search, searchText, parseBing, hotNews, hotNewsText, bilibiliHot, bilibiliHotText, weiboHot, weiboHotText,
  geocodeCity, ipCity, weatherText, wmoText: weather.wmoText };
