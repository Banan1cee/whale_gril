'use strict';

const { getText, searchError } = require('./transport');
const { stripTags, sourceUrl } = require('./html');

function parseBing(html) {
  const out = [];
  for (const block of String(html || '').split(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>/i).slice(1)) {
    const link = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = sourceUrl(link[1], 'https://cn.bing.com');
    const title = stripTags(link[2]);
    const snippet = stripTags((block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    if (url && (title || snippet)) out.push({ title, url, snippet });
    if (out.length >= 10) break;
  }
  return out;
}

async function search(query, opts) {
  const html = await getText('https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&count=10', opts);
  const items = parseBing(html);
  if (!items.length && /captcha|verify you are human|b_captcha/i.test(html)) throw searchError('blocked');
  if (!items.length && html.trim() && !/b_no|没有找到|没有与|no results/i.test(html)) throw searchError('parse_error');
  return items;
}

module.exports = { search, parseBing };
