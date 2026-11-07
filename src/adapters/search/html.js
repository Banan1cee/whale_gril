'use strict';

function decodeEntities(s) {
  return String(s || '').replace(/&(?:nbsp|ensp);/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      try { return String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n)); } catch { return ''; }
    });
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function sourceUrl(raw, base) {
  if (!raw || typeof raw !== 'string') return '';
  try {
    let url = new URL(decodeEntities(raw), base);
    if (/(^|\.)bing\.com$/.test(url.hostname) && url.pathname.startsWith('/ck/')) {
      const encoded = url.searchParams.get('u') || '';
      if (encoded.startsWith('a1')) url = new URL(Buffer.from(encoded.slice(2), 'base64url').toString('utf8'));
    }
    if (!['https:', 'http:'].includes(url.protocol)) return '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    return url.toString();
  } catch { return ''; }
}

module.exports = { decodeEntities, stripTags, sourceUrl };
