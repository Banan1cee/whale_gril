'use strict';

const { getText, searchError } = require('./transport');
const { stripTags, sourceUrl } = require('./html');

function parseSo360(html) {
  const items = [];
  const text = value => stripTags(String(value || '').replace(/<\/?(?:em|b|strong)\b[^>]*>/gi, ''));
  const blocks = String(html || '').split(/<li\b[^>]*class=["'][^"']*\bres-list\b[^"']*["'][^>]*>/i).slice(1);
  for (const block of blocks) {
    const heading = (block.match(/<h3\b[^>]*class=["'][^"']*\bres-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h3>/i) || [])[1];
    const link = heading?.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const attribute = name => (link[1].match(new RegExp('(?:^|\\s)' + name + '=["\']([^"\']+)["\']', 'i')) || [])[1];
    // 使用页面提供的真实落地 URL，不请求不透明跳转链接，避免串平台或额外耗尽预算。
    const url = sourceUrl(attribute('data-mdurl') || attribute('href'), 'https://www.so.com');
    if (!url) continue;
    if (/(^|\.)so\.com$/i.test(new URL(url).hostname)) continue;
    const title = text(link[2]);
    const snippet = text((block.match(/<p\b[^>]*class=["'][^"']*\bres-desc\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    if (title || snippet) items.push({ title, url, snippet });
    if (items.length >= 10) break;
  }
  return items;
}

async function search(query, opts) {
  const html = await getText('https://www.so.com/s?q=' + encodeURIComponent(query), opts);
  const items = parseSo360(html);
  if (!items.length && /captcha|verify you are human|安全验证|请输入验证码|访问过于频繁/i.test(html)) throw searchError('blocked');
  if (!items.length && html.trim() && !/没有找到|未找到|找不到|无相关结果|no results/i.test(stripTags(html))) throw searchError('parse_error');
  return items;
}

module.exports = { search, parseSo360 };
