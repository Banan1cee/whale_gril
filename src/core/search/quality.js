'use strict';

const TIME_SENSITIVE_RE = /(最新|现在|今年|目前|当前|今天|今日|刚刚|实时|这周|本周|最近几天|这两天|出到几|第几代|什么型号|哪个版本|多少钱|什么价|行情|发布会|刚出|新出)/;
const STOP_WORDS = /(帮我|请问|请|一下|查查|查一查|搜搜|搜索|看看|我想知道|谁是|是谁|这个|那个|什么|怎么|为什么|是不是|有没有|最新|现在|目前|当前|今天|多少钱|什么价|价格是|怎么样|如何|的|吗|呢|啊|呀|吧|了|嘛|呗)/gi;
const GENERIC = new Set(['谁是', '是谁', '这个', '那个', '一个', '什么', '怎么', '为什', '时候', '东西',
  '事情', '问题', '方法', '我们', '你们', '他们', '自己', '可以', '不是', '就是', '还是', '如果', '但是',
  '所以', '因为', '这样', '那样', '知道', '觉得', '应该', '需要', '很多', '非常', '真的', '一直',
  '已经', '开始', '结束', '现在', '今天', '明天', '如何', '哪些']);
const ALIASES = { 苹果: ['iphone', 'apple', 'mac', 'ipad'], iphone: ['苹果'], mac: ['macbook'] };

function expandBrand(text) {
  const s = String(text || '');
  if (/\b(?:iphone|ipad|mac(?:book)?|watch|airpods)\b/i.test(s)) return s;
  // “机器”不足以确定产品线，只有明确手机/电脑语境才扩展。
  if (/(苹果|apple)/i.test(s) && /(电脑|笔记本)/.test(s)) return s.replace(/苹果电脑|苹果笔记本|苹果|apple/gi, 'Mac');
  if (/(苹果|apple)/i.test(s) && /手机/.test(s)) return s.replace(/苹果手机|苹果|apple/gi, 'iPhone');
  return s;
}

function queryTokens(query) {
  const text = expandBrand(String(query || '').replace(/\bsite:[a-z0-9.-]+/gi, '')).replace(STOP_WORDS, ' ');
  const tokens = (text.match(/[a-z0-9][a-z0-9+.\-]{1,}/gi) || []).map(x => x.toLowerCase());
  for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) || []) {
    for (let i = 0; i + 1 < run.length; i++) tokens.push(run.slice(i, i + 2));
    if (run.length <= 4) tokens.push(run);
  }
  return [...new Set(tokens)].filter(x => !GENERIC.has(x));
}

function cleanQuery(query) {
  let text = String(query || '').replace(/^\s*(帮我|请|你|麻烦)?\s*(查一下|查查|查一查|查|搜一下|搜搜|搜|找一下|找|看看)/, ' ')
    .replace(STOP_WORDS, ' ').replace(/[，。！？、!?]/g, ' ').replace(/\s+/g, ' ').trim();
  text = expandBrand(text).replace(/\s*(是|有|在|了)\s*$/g, '').trim();
  if (/(多少钱|什么价|价格|报价)/.test(query) && !/价格|报价|行情/.test(text)) text = (text + ' 价格').trim();
  return text || String(query || '').trim();
}

function modelNames(text) {
  return (String(text).match(/\b(?:iphone\s*\d+(?:\s*(?:pro\s*max|pro|plus|mini|air))?|(?:rtx|gtx)\s*\d+(?:\s*(?:ti|super))?|deepseek\s*v\d+(?:\.\d+)*|[ma]\d+(?:\s*(?:pro|max|ultra))?)\b/gi) || [])
    .map(x => x.toLowerCase().replace(/\s+/g, ''));
}

function relevanceScore(query, item) {
  const hay = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
  if (/(手机|机器|机型|型号|iphone)/i.test(query) && /(蔷薇科|苹果属|malus|水果|落叶乔木|果树)/i.test(hay)) return 0;
  const models = modelNames(query);
  const found = modelNames(hay);
  if (models.length && !models.every(x => found.includes(x))) return 0;
  const tokens = queryTokens(query);
  if (!tokens.length) return 1;
  const hits = tokens.filter(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a)));
  if (!hits.length) return 0;
  // 有明确英文实体时，不能只靠“价格/更新”等泛词留下另一种产品。
  const entities = tokens.filter(t => /^[a-z]/.test(t) && !['pro', 'max', 'plus', 'mini', 'air'].includes(t));
  if (entities.length && !entities.some(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a)))) return 0;
  // 中文短主体（小米汽车、小蓝鲸、北京）不能仅靠“价格/天气”等需求词命中。
  // 长句暂不强行切实体，避免二字分词把自然问句误当成完整专名。
  const topics = cleanQuery(query).replace(/\bsite:[a-z0-9.-]+/gi, '')
    .replace(/B站|哔哩哔哩|微博|今日头条/gi, ' ')
    .replace(/明天|后天|多少度|天气|气温|温度|预报|下雨|下雪|会不会|会|价格|报价|行情|热搜|热榜|新闻|更新|进度|发布|上市|机型|型号|机器|推荐|是什么|怎么样/g, ' ')
    .match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const anchors = topics.filter(x => x.length <= 4);
  if (!entities.length && anchors.length && !anchors.some(t => hay.includes(t) || (ALIASES[t] || []).some(a => hay.includes(a)))) return 0;
  const title = String(item.title || '').toLowerCase();
  return hits.length / tokens.length + hits.filter(t => title.includes(t)).length + models.length * 4;
}

function keepRelevant(query, results) {
  return results.map((item, index) => ({ item, index, score: relevanceScore(query, item) }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.item);
}

function parseSnippetAgeDays(snippet, nowMs = Date.now()) {
  const s = String(snippet || '').replace(/&ensp;|&#8194;|&nbsp;/g, ' ').trim();
  const now = new Date(nowMs);
  // 只读开头的时间标记。正文的“今天/去年”可能是事件时间，不是发布时间。
  const prefix = s.replace(/^(?:发布(?:于|时间)?|更新(?:于|时间)?)\s*[:：]?\s*/, '');
  let m = prefix.match(/^(20\d{2})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})/);
  let year, month, day;
  if (m) [, year, month, day] = m.map(Number);
  else {
    m = prefix.match(/^(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      year = now.getFullYear(); month = Number(m[1]); day = Number(m[2]);
      if (new Date(year, month - 1, day).getTime() > nowMs + 86400000) year--;
    }
  }
  if (year) {
    const date = new Date(year, month - 1, day);
    if (date.getMonth() !== month - 1 || date.getDate() !== day || date.getTime() > nowMs + 86400000) return null;
    return Math.max(0, (nowMs - date.getTime()) / 86400000);
  }
  if (/^(刚刚|刚才)/.test(prefix)) return 0;
  if (/^(今天|今日)/.test(prefix)) return 0.5;
  if (/^(昨天|昨日)/.test(prefix)) return 1;
  if (/^(前天|前日)/.test(prefix)) return 2;
  m = prefix.match(/^(\d+)\s*(分钟|小时|天|周|个月|月|年)\s*(?:之)?前/);
  if (m) return Number(m[1]) * ({ 分钟: 1 / 1440, 小时: 1 / 24, 天: 1, 周: 7, 个月: 30, 月: 30, 年: 365 }[m[2]]);
  return null;
}

function tightenFreshness(query, limit) {
  if (/(今天|今日|刚刚|刚才|实时|现在|此刻)/.test(query)) return limit == null ? 2 : Math.min(Number(limit), 2);
  if (/(这周|本周|最近几天|这两天|近几天)/.test(query)) return limit == null ? 7 : Math.min(Number(limit), 7);
  return limit;
}

function effectiveMaxAgeDays(query, routeFresh, timeRange) {
  // 用户明确的今天/本周约束优先于模型的宽泛时效标签。
  const base = routeFresh === 'any' || timeRange === 'history' ? null : routeFresh === 'strict' ? 90 : routeFresh === 'normal' ? 365 : undefined;
  const limit = tightenFreshness(query, base);
  const rangeLimit = ['current', 'today', 'tomorrow'].includes(timeRange) ? 2 : timeRange === 'week' ? 7 : null;
  return rangeLimit === null ? limit : limit == null ? rangeLimit : Math.min(limit, rangeLimit);
}

function isTimeSensitive(query) { return TIME_SENSITIVE_RE.test(String(query || '')); }

function splitFreshness(query, results, { maxAgeDays, nowMs = Date.now() } = {}) {
  const unlimited = maxAgeDays === null || maxAgeDays === Infinity || (maxAgeDays === undefined && !isTimeSensitive(query));
  const limit = tightenFreshness(query, maxAgeDays === undefined ? 550 : maxAgeDays);
  const items = [], staleItems = [];
  for (const item of results) {
    const published = item.publishedAt ? Date.parse(item.publishedAt) : NaN;
    const age = Number.isFinite(published) ? (nowMs - published) / 86400000 : parseSnippetAgeDays(item.snippet || '', nowMs);
    (unlimited || age === null || age <= limit ? items : staleItems).push(item);
  }
  return { items, staleItems };
}

function dropStaleResults(query, results, opts) { return splitFreshness(query, results, opts).items; }

module.exports = { expandBrand, cleanQuery, queryTokens, modelNames, relevanceScore, keepRelevant,
  parseSnippetAgeDays, tightenFreshness, effectiveMaxAgeDays, isTimeSensitive, splitFreshness, dropStaleResults };
