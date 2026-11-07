'use strict';

const KEYWORDS = /(查一下|查查|搜一下|搜搜|帮我查|帮我看看|最新|热搜|新闻|发生了什么|怎么回事|多少钱|什么价格|几块钱|什么时候|是谁|谁是|行情|报价|天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量|出到|第几代|几代|什么型号|哪个型号|哪个版本|什么版本|现在还|今年|去年|苹果|iphone|ipad|华为|小米|三星|索尼|任天堂|switch|ps5|显卡|rtx|骁龙|麒麟|芯片|发布会)/i;
const FACT = /(是什么|是谁|多少|几号|几点|怎么样|怎么|为什么|哪一?[个些张条]|有没有|是不是|能不能|会不会|可不可以|排行|排名|热搜|热榜|热门|最新|出到|第几)/;
const CHITCHAT = /^(在吗|在不在|你好|嗨|hi|哈喽|早安|晚安|睡了|吃饭了吗|吃了吗|你在干嘛|在干啥|干啥呢|干嘛呢)/i;
const OPINION = /(你觉得|你认为|你看|你怎么看|该不该|要不要|喜不喜欢|喜欢吗|讨厌|爱我吗|想我了吗)/;
const DOMAINS = { bilibili: 'bilibili.com', weibo: 'weibo.com', toutiao: 'toutiao.com' };

function gate(text, mode) {
  const keyword = KEYWORDS.test(text);
  const fact = FACT.test(text) && !CHITCHAT.test(text.trim()) && !OPINION.test(text);
  return { fallback: keyword || fact, route: mode === true || (mode !== false && (keyword || fact || /[?？]|吗|呢|什么|怎么|多少|几[个号点]|谁|哪|为什么|如何|查|搜|最新|今天|现在|价格|天气/.test(text))) };
}

function inferKind(text) {
  if (/(天气|下雨|下雪|气温|多少度|冷不冷|热不热|带伞)/.test(text)) return 'weather';
  const plain = text.replace(/^(?:帮我|请)?(?:查一下|查查|搜一下|看看)?\s*/, '').replace(/[?？。！!]+$/, '');
  if (/^(?:(?:b站|哔哩哔哩|bilibili|微博|weibo|今日头条|头条)的?)?(?:今天|今日|现在|最新)?的?(?:热搜|热榜|热点榜|排行榜|热门榜)(?:是什么|有哪些|前十|前十名)?$/i.test(plain)
    || /^(?:今天|今日|现在|刚刚|最新|最近|这两天)?(?:的|有|什么|哪些|热点|重大|最新)*(?:新闻|热点|大事件|大事|头条)(?:是什么|有哪些|发生了什么)?$/.test(plain)
    || /^(?:今天|今日|最近)?发生了什么$/.test(plain)) return 'hotlist';
  return 'web';
}

function weatherSupported(text, timeRange) {
  // 当前接口只有今明两天常规预报，不能拿它回答灾害路径、空气质量或远期/历史天气。
  return !/(台风|雾霾|空气|aqi|紫外线|历史|去年|昨天|前天|后天|周末|下周|下个月|未来|一周|这周|本周|周[一二三四五六日天]|20\d{2}[年\-/]|\d+月\d+日|[三四五六七八九十\d]+天)/i.test(text)
    && (!timeRange || ['today', 'tomorrow', 'current', 'any'].includes(timeRange));
}

function intent(text, route = {}) {
  const site = /(b站|哔哩哔哩|bilibili)/i.test(text) ? 'bilibili'
    : /(微博|weibo)/i.test(text) ? 'weibo' : /(今日头条|头条)/.test(text) ? 'toutiao' : route.site || '';
  let kind = route.kind || inferKind(text);
  if (kind === 'weather' && !weatherSupported(text, route.timeRange)) kind = 'web';
  return { kind, site, city: route.city || '', timeRange: route.timeRange || null,
    query: String(route.need && route.query ? route.query : text).trim().slice(0, 100),
    fresh: route.failed ? undefined : route.fresh };
}

function cityCandidate(text) {
  return String(text).replace(/(今天|明天|现在|早上|上午|中午|下午|晚上|夜里)/g, ' ')
    .replace(/(天气|气温|温度|怎么样|如何|多少度|冷不冷|热不热|下雨|下雪|要不要带伞|带伞)/g, ' ')
    .replace(/[?？!！。，,、\s]+/g, ' ').trim()
    .replace(/^(?:帮我|请|查一下|查查|看看|的|会不会|会|要不要|吗|呢|呀|啊|\s)+/, '')
    .replace(/(?:的|会不会|会|要不要|吗|呢|呀|啊|\s)+$/, '').trim();
}

module.exports = { gate, inferKind, intent, cityCandidate, weatherSupported, DOMAINS };
