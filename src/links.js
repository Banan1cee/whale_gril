'use strict';

/**
 * 链接阅读：从聊天里发的链接里读出「标题 / 摘要 / 文章正文片段」。
 *
 * 目的：让鲸鲸对别人分享的链接能像真人一样接一句话，
 * 而不是完全无视，或者瞎编视频内容。
 *
 * 只用 Node 内置模块；带超时、大小限制和短缓存。
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const URL_RE = /https?:\/\/[^\s<>"'（）()【】\[\]\u4e00-\u9fa5]+/g;
const TRAILING = /[.,;:!?，。；：！？、）)】\]》>]*$/;

/** 从一段文字里提取链接（去掉句末标点） */
function extractUrls(text) {
  const raw = String(text || '');
  const found = raw.match(URL_RE) || [];
  const out = [];
  for (const u of found) {
    const clean = u.replace(TRAILING, '');
    if (!clean || out.includes(clean)) continue;
    try {
      const parsed = new URL(clean);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
      out.push(clean);
    } catch {
      /* 不是合法 URL，跳过 */
    }
  }
  return out.slice(0, 2);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    });
}

function stripTags(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function pickMeta(html, names) {
  for (const name of names) {
    const re = new RegExp(
      `<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([\\s\\S]*?)["']`,
      'i'
    );
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return decodeEntities(m[1]).trim();
    const re2 = new RegExp(
      `<meta[^>]+content=["']([\\s\\S]*?)["'][^>]*(?:property|name)=["']${name}["']`,
      'i'
    );
    const m2 = html.match(re2);
    if (m2 && m2[1] && m2[1].trim()) return decodeEntities(m2[1]).trim();
  }
  return '';
}

function kindOf(urlString) {
  let host = '';
  try { host = new URL(urlString).hostname.toLowerCase(); } catch { return 'web'; }
  if (/douyin|iesdouyin|tiktok/.test(host)) return 'video';
  if (/bilibili|b23\.tv/.test(host)) return 'video';
  if (/youtube|youtu\.be/.test(host)) return 'video';
  if (/kuaishou/.test(host)) return 'video';
  if (/xiaohongshu|xhslink/.test(host)) return 'note';
  if (/mp\.weixin\.qq\.com/.test(host)) return 'article';
  return 'web';
}

function fetchUrl(urlString, { timeoutMs = 6000, maxBytes = 700 * 1024, redirects = 4 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      return done({ ok: false, error: 'bad_url' });
    }
    const mod = parsed.protocol === 'http:' ? http : https;
    const req = mod.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
          res.resume();
          const next = new URL(res.headers.location, parsed).toString();
          fetchUrl(next, { timeoutMs, maxBytes, redirects: redirects - 1 }).then(done);
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > maxBytes) {
            res.destroy();
            done({ ok: false, error: 'too_large', status });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          done({
            ok: true,
            status,
            finalUrl: parsed.toString(),
            contentType: String(res.headers['content-type'] || ''),
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', () => done({ ok: false, error: 'read_error', status }));
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: (e && e.code) || 'network' }));
    req.end();
  });
}

/** 从 HTML 里抽标题/摘要/文章正文 */
function parsePage(html, finalUrl) {
  const raw = String(html || '');
  let title = pickMeta(raw, ['og:title', 'twitter:title']) || '';
  if (!title) {
    const t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (t) title = stripTags(t[1]);
  }
  let description = pickMeta(raw, ['og:description', 'description', 'twitter:description']) || '';

  // 公众号文章：正文在 #js_content 里
  let article = '';
  const m = raw.match(/<div[^>]+id=["']js_content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<script|<div[^>]+id=["']js_pc_qr_code)/i);
  if (m) article = stripTags(m[1]);
  if (!article) {
    // 兜底：抓 og 之外的正文段落（最多 1200 字）
    const paras = [];
    const pRe = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pm;
    let guard = 0;
    while ((pm = pRe.exec(raw)) && guard < 60) {
      guard += 1;
      const text = stripTags(pm[1]);
      if (text.length >= 12) paras.push(text);
      if (paras.join('').length > 1200) break;
    }
    article = paras.join('\n').slice(0, 1200);
  }
  if (!description && article) description = article.slice(0, 160);

  return {
    url: finalUrl,
    kind: kindOf(finalUrl),
    title: title.slice(0, 120),
    description: description.slice(0, 240),
    article: article.slice(0, 1200),
  };
}

const cache = new Map();

/**
 * 读取一个链接：返回 { ok, url, kind, title, description, article, error }
 */
async function describeLink(urlString, { timeoutMs = 6000, cacheMinutes = 60 } = {}) {
  const key = String(urlString || '').slice(0, 500);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < cacheMinutes * 60 * 1000) return { ...hit.value, cached: true };

  const res = await fetchUrl(key, { timeoutMs });
  let value;
  if (!res.ok) {
    value = { ok: false, url: key, kind: kindOf(key), error: res.error };
  } else {
    const info = parsePage(res.body, res.finalUrl);
    const ok = Boolean(info.title || info.description || info.article);
    value = {
      ok,
      url: info.url,
      kind: info.kind,
      title: info.title,
      description: info.description,
      article: info.article,
      error: ok ? '' : 'empty',
    };
  }
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 100) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  return value;
}

/** 把链接信息压成一段给模型看的文字 */
/** 视频平台的 og:description 常混着播放量/相关视频，清一下 */
function cleanVideoDesc(s) {
  let t = String(s || '');
  t = t
    .replace(/视频播放量[^,，]*[,，]?/g, '')
    .replace(/弹幕量[^,，]*[,，]?/g, '')
    .replace(/点赞数[^,，]*[,，]?/g, '')
    .replace(/投硬币枚数[^,，]*[,，]?/g, '')
    .replace(/收藏人数[^,，]*[,，]?/g, '')
    .replace(/转发人数[^,，]*[,，]?/g, '');
  const cut = t.search(/相关视频|相关推荐|更多视频/);
  if (cut > 0) t = t.slice(0, cut);
  return t.replace(/^[-—–\s,，。]+/, '').replace(/\s+/g, ' ').trim();
}

function formatForPrompt(info) {
  if (!info) return '';
  if (!info.ok) return `对方发了一个链接（${info.url}），但打不开（${info.error || '未知原因'}）。`;
  const lines = [`链接标题：${info.title || '（无标题）'}`];
  // 短内容（短视频/小红书）：只要标题和文案，正文里的页面噪音没有用
  if (info.kind === 'video' || info.kind === 'note') {
    const desc = cleanVideoDesc(info.description);
    if (desc) lines.push(`文案：${desc.slice(0, 200)}`);
    lines.push('（这是短视频平台的链接，你只看到了标题和文案，并没有真的看完视频画面。）');
  } else {
    if (info.description) lines.push(`简介：${String(info.description).slice(0, 240)}`);
    if (info.article && info.article !== info.description) lines.push(`正文片段：${String(info.article).slice(0, 600)}`);
  }
  return lines.join('\n');
}

module.exports = { extractUrls, describeLink, parsePage, formatForPrompt, kindOf, stripTags, decodeEntities, cleanVideoDesc };
