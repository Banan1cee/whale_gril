'use strict';

const bing = require('./bing');
const so360 = require('./so360');
const { remaining, report, errorInfo } = require('./transport');
const quality = require('../../core/search/quality');
const { result } = require('../../core/search/result');

async function searchResult(query, opts = {}) {
  const started = Date.now();
  const deadline = Math.min(opts.deadline ?? Infinity, started + remaining(opts));
  const raw = String(query || '').trim();
  if (!raw) return result([], { status: 'skipped', reason: 'empty_input' });
  const site = (raw.match(/\bsite:([a-z0-9.-]+)/i) || [])[1] || '';
  const body = raw.replace(/\bsite:[a-z0-9.-]+/gi, '').trim().slice(0, 100);
  const q = body + (site ? ' site:' + site : '');
  const attempts = [], all = [], staleItems = [];
  const seen = new Set();
  let deadlineExpired = false;
  const budget = () => remaining({ ...opts, deadline });
  const valid = () => quality.splitFreshness(q, all, opts).items;
  const ask = async (provider, term, reserve = false) => {
    if (deadlineExpired || opts.signal?.aborted || budget() <= 0) return;
    if (site && !term.toLowerCase().includes('site:' + site.toLowerCase())) term += ' site:' + site;
    const start = Date.now();
    const left = budget();
    // 首源最多占大部分预算，给备用源留出机会；极短预算不再切成无意义的小请求。
    const timeoutMs = reserve && left > 100 ? Math.floor(left * 0.65) : left;
    try {
      const parsed = await ({ bing, so360 }[provider]).search(term, { ...opts, deadline, timeoutMs });
      const scoped = site ? parsed.filter(item => {
        const host = new URL(item.url).hostname.toLowerCase();
        return host === site.toLowerCase() || host.endsWith('.' + site.toLowerCase());
      }) : parsed;
      const relevant = quality.keepRelevant(body, scoped);
      report(opts.trace, 'filter', { provider, parsed: parsed.length, relevant: relevant.length,
        rejected: parsed.length - relevant.length, reason: 'relevance_filter' });
      const fetchedAt = new Date().toISOString();
      for (const item of relevant) {
        if (seen.has(item.url)) continue;
        seen.add(item.url);
        all.push({ ...item, provider, fetchedAt, publishedAt: null });
      }
      attempts.push({ provider, status: relevant.length ? 'ok' : 'empty', parsed: parsed.length,
        relevant: relevant.length, elapsedMs: Date.now() - start });
    } catch (err) {
      // 保留上游总预算耗尽后停止补搜的修复；首源的预留预算超时仍可切备用源。
      if (err?.code === 'deadline_exceeded' && timeoutMs >= left) deadlineExpired = true;
      const info = errorInfo(err);
      attempts.push({ provider, status: 'failed', code: info.code, error: info, elapsedMs: Date.now() - start });
      report(opts.trace, 'failed', { provider, ...info });
    }
  };
  await ask('bing', q, true);
  const named = quality.modelNames(body).length || /\b(?:macbook|ipad|watch|airpods)\b/i.test(body);
  if (!site && !named && /(苹果|iphone|mac)/i.test(body) && /(最新|机器|机型|型号|出到|几代|发布)/.test(body)) {
    const product = /(电脑|笔记本|mac)/i.test(body) ? 'Mac 机型' : /手机|iphone/i.test(body) ? 'iPhone 机型' : '苹果 产品';
    await ask('bing', 'site:apple.com.cn ' + product, true);
  }
  if (valid().length < 2) {
    // 保留原始查询作主检索，纠错只产生候选，不覆盖用户的专名和型号。
    const alternatives = [...new Set([quality.cleanQuery(body), quality.queryTokens(body).join(' ')])]
      .filter(x => x && x !== body).slice(0, 2);
    for (const term of alternatives) {
      await ask('bing', term, true);
      if (valid().length >= 2) break;
    }
  }
  if (valid().length < 2) await ask('so360', q);
  const split = quality.splitFreshness(q, quality.keepRelevant(body, all), opts);
  staleItems.push(...split.staleItems);
  const items = split.items.slice(0, Math.max(1, Math.min(10, Number(opts.limit) || 5)));
  const reason = items.length ? 'available' : opts.signal?.aborted ? 'aborted' : deadlineExpired || budget() <= 0 ? 'deadline_exceeded'
    : staleItems.length ? 'stale_only' : attempts.every(a => a.status === 'failed') ? attempts.at(-1)?.code || 'no_results' : 'no_results';
  report(opts.trace, 'result', { candidates: all.length, stale: staleItems.length, selected: items.length,
    sources: items.map(x => new URL(x.url).hostname) });
  return result(items, { attempts, staleItems, reason, elapsedMs: Date.now() - started,
    ...(!items.length && ['aborted', 'deadline_exceeded'].includes(reason) ? { status: 'failed' } : {}) });
}

module.exports = { searchResult };
