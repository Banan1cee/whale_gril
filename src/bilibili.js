'use strict';

/**
 * 主动「刷自己的视频」：在 B 站搜「鲸鱼娘 / 鲸娘 / 鲸鱼少女」这类，
 * 挑一个没分享过的，返回标题/链接/简介；找不到就退回到热门里筛「鲸鱼」相关。
 */
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const SEARCH_KEYWORDS = ['鲸鱼娘', '鲸娘', '鲸鱼少女', '鲸鱼拟人', '蓝发少女 鲸鱼'];

function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.bilibili.com/',
          Accept: 'application/json,text/plain,*/*',
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function toVideo(v) {
  return {
    bvid: v.bvid,
    title: stripTags(v.title),
    desc: stripTags(v.description || v.desc || '').slice(0, 200),
    url: `https://www.bilibili.com/video/${v.bvid}`,
    pic: v.pic || '',
    duration: Number(v.duration) || 0,
    owner: (v.author || (v.owner && v.owner.name) || '').trim(),
    stat: { view: Number(v.play || (v.stat && v.stat.view)) || 0 },
  };
}

/** B 站搜索视频 */
async function searchVideos(keyword, timeoutMs = 12000) {
  const url =
    'https://api.bilibili.com/x/web-interface/search/type?search_type=video&page=1&keyword=' +
    encodeURIComponent(keyword);
  const data = await getJson(url, timeoutMs);
  const list = data && data.data && Array.isArray(data.data.result) ? data.data.result : [];
  return list.map(toVideo).filter((v) => v.bvid && v.title);
}

/** 热门视频（兜底） */
async function fetchPopular(limit = 50) {
  const data = await getJson(`https://api.bilibili.com/x/web-interface/popular?ps=${Math.min(50, limit)}&pn=1`);
  const list = data && data.data && Array.isArray(data.data.list) ? data.data.list : [];
  return list.map(toVideo);
}

function logFile(config) {
  const dir = (config.paths && config.paths.dataDir) || path.join(process.cwd(), 'data');
  return path.join(dir, 'share-log.json');
}

function loadLog(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(logFile(config), 'utf8'));
    return { shared: Array.isArray(raw.shared) ? raw.shared : [] };
  } catch {
    return { shared: [] };
  }
}

function saveLog(config, log) {
  try {
    fs.writeFileSync(logFile(config), JSON.stringify({ shared: log.shared.slice(-300) }, null, 2), 'utf8');
  } catch {
    /* ignore */
  }
}

function looksLikeWhale(v) {
  return /鲸鱼|鲸娘|鲸鱼娘|鲸鱼少女|蓝鲸/.test(v.title || '');
}

/** 挑一个没分享过的「鲸鱼娘」视频 */
async function pickVideo(config, { limit = 30 } = {}) {
  const log = loadLog(config);
  const shared = new Set(log.shared);
  const pool = [];

  for (const kw of SEARCH_KEYWORDS) {
    try {
      const list = await searchVideos(kw);
      for (const v of list) {
        if (!v.bvid || shared.has(v.bvid)) continue;
        if (!looksLikeWhale(v)) continue;
        pool.push(v);
      }
    } catch {
      /* 某个关键词被风控就跳过 */
    }
    if (pool.length >= limit) break;
  }

  if (!pool.length) {
    try {
      const popular = await fetchPopular(50);
      for (const v of popular) {
        if (!v.bvid || shared.has(v.bvid)) continue;
        if (!looksLikeWhale(v)) continue;
        pool.push(v);
      }
    } catch {
      /* ignore */
    }
  }
  if (!pool.length) return null;

  const pick = pool[Math.floor(Math.random() * pool.length)];
  log.shared.push(pick.bvid);
  saveLog(config, log);
  return pick;
}

/** 按关键词挑一个没分享过的视频 */
async function pickByKeyword(config, keyword) {
  const log = loadLog(config);
  const shared = new Set(log.shared);
  let list = [];
  try {
    list = await searchVideos(keyword);
  } catch {
    list = [];
  }
  const pool = list.filter((v) => v.bvid && v.title && !shared.has(v.bvid));
  if (!pool.length) return null;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  log.shared.push(pick.bvid);
  saveLog(config, log);
  return pick;
}

/** 拿视频的热门评论（前几条） */
async function fetchComments(bvid, limit = 5) {
  try {
    const view = await getJson(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
    const aid = view && view.data && view.data.aid;
    if (!aid) return [];
    const rep = await getJson(
      `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${limit}&pn=1`
    );
    const list = rep && rep.data && Array.isArray(rep.data.replies) ? rep.data.replies : [];
    return list.map((r) => String((r.content && r.content.message) || '').trim()).filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

module.exports = { fetchPopular, searchVideos, pickVideo, pickByKeyword, fetchComments };
