'use strict';

const { getJson, searchError } = require('./transport');
const { createCache } = require('./cache');
const { providerResult } = require('./providerResult');
const { sourceUrl } = require('./html');
const cache = createCache();
const SOURCES = {
  bilibili: { url: 'https://api.bilibili.com/x/web-interface/search/square?limit=10', title: 'B站热搜' },
  weibo: { url: 'https://weibo.com/ajax/side/hotSearch', title: '微博热搜',
    headers: { Referer: 'https://weibo.com/', 'X-Requested-With': 'XMLHttpRequest' } },
  toutiao: { url: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', title: '今日头条热榜' },
};

async function hotlistResult(site = 'toutiao', opts = {}) {
  const source = SOURCES[site];
  return providerResult(site, async () => {
    if (!source) throw searchError('unsupported_provider');
    const items = await cache.get(site, async shared => {
      const data = await getJson(source.url, { ...shared, headers: source.headers });
      const list = site === 'bilibili' ? data?.data?.trending?.list : site === 'weibo' ? data?.data?.realtime : data?.data;
      if (!Array.isArray(list)) throw searchError('parse_error');
      const fetchedAt = new Date().toISOString();
      return list.map(row => {
        const title = String(row.Title || row.show_name || row.keyword || row.word || row.note || '').trim();
        const rawUrl = site === 'toutiao' ? row.Url : site === 'bilibili'
          ? 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(title)
          : 'https://s.weibo.com/weibo?q=' + encodeURIComponent(title);
        return { title, url: sourceUrl(rawUrl, source.url), snippet: source.title + '（榜单获取时间不代表事件发生时间）',
          provider: site, fetchedAt, publishedAt: null, hot: Number(row.HotValue) || 0 };
      }).filter(x => x.title && x.url);
    }, { ...opts, ttlMs: 60000 });
    return items.slice(0, Math.max(1, Math.min(20, Number(opts.limit) || 10)));
  }, opts);
}

module.exports = { hotlistResult };
