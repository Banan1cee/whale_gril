'use strict';

/**
 * 语义检索：让模型判断「这条旧记忆跟这句话有没有关系」。
 *
 * 为什么不用同义词表：词表要人一条条补，补不完，也补不准
 * （「体检」对「医院」行，那「复查」呢？「化验」呢？）。让模型看一眼比维护词表便宜。
 *
 * 这里不存向量：一次只把 6~8 条候选 + 一句话丢给模型，让它返回下标。
 * 真正的向量库要额外服务和存储，当前的记忆规模（每人几条到几十条）用不上。
 * 失败/没配 Key 就返回 null，调用方退回字面排序，不会因为检索失败而不回消息。
 */

const crypto = require('node:crypto');

const MAX_CANDIDATES = 10;
const TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 200;

const SYSTEM = [
  '你在判断「这些旧记忆里，哪几条跟用户这句话有关」。',
  '只输出 JSON：{"keep":[下标,...]}；一条都不相关就 {"keep":[]}。',
  '判断标准：同一个人、同一件事、或者这句话在追问/延续那件事，才算有关。',
  '只沾到同一个字不算（「医院」和「医院旁边的奶茶店」是两件事）。',
  '宁缺勿滥：最多挑 {max} 条。',
].join('\n');

const cache = new Map();

function hashKey(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

function buildPrompt(query, notes, max) {
  const lines = notes.map((n, i) => `${i}. ${n.text}${n.kind && n.kind !== 'fact' ? `（${n.kind}）` : ''}`);
  return {
    system: SYSTEM.replace('{max}', String(max)),
    turns: [{
      role: 'user',
      content: `用户这句话：${String(query || '').slice(0, 200)}\n\n候选记忆：\n${lines.join('\n')}`,
    }],
  };
}

/** 从模型输出里取下标；越界/重复/乱写都丢掉，解析不出来返回 null（= 退回字面排序） */
function parseKeep(raw, total, max) {
  const text = String(raw || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.keep)) return null;
  const seen = new Set();
  const out = [];
  for (const v of obj.keep) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n >= total || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
    if (out.length >= Math.max(1, max)) break;
  }
  return out;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.keep;
}

function cachePut(key, keep) {
  cache.set(key, { at: Date.now(), keep });
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

/**
 * 让模型挑一遍。
 * @returns {Promise<number[]|null>} 下标数组；null = 这次没判断成功，调用方按原序用
 */
async function rerank(llm, query, notes, { limit = 4, logger = null } = {}) {
  if (!llm || llm.isMock) return null;
  const list = (Array.isArray(notes) ? notes : []).slice(0, MAX_CANDIDATES);
  if (list.length <= 1) return null;

  const key = hashKey(String(query).slice(0, 200) + '|' + list.map((n) => n.text).join('|'));
  const cached = cacheGet(key);
  if (cached) return cached;

  try {
    const raw = await llm.complete(buildPrompt(query, list, Math.max(1, limit)));
    const keep = parseKeep(raw, list.length, Math.max(1, limit));
    if (keep === null) {
      if (logger) logger.warn('语义检索：模型没给出可解析的下标，这一轮用字面排序');
      return null;
    }
    cachePut(key, keep);
    return keep;
  } catch (err) {
    if (logger) logger.warn('语义检索失败，这一轮用字面排序：' + ((err && err.message) || err));
    return null;
  }
}

function clearCache() {
  cache.clear();
}

module.exports = { SYSTEM, MAX_CANDIDATES, TTL_MS, buildPrompt, parseKeep, rerank, clearCache, hashKey };
