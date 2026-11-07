'use strict';

const { remaining, searchError } = require('./transport');

// 仅缓存公开榜单/地理编码；每位等待者有独立预算，取消一位不能取消其他人的请求。
function createCache({ maxEntries = 128, now = Date.now } = {}) {
  const values = new Map();
  const pending = new Map();
  function get(key, load, { ttlMs, ...opts } = {}) {
    if (opts.signal?.aborted) return Promise.reject(searchError('aborted'));
    const budget = remaining(opts);
    if (budget <= 0) return Promise.reject(searchError('deadline_exceeded'));
    const cached = values.get(key);
    if (cached && cached.until > now()) return Promise.resolve(structuredClone(cached.value));
    values.delete(key);
    let job = pending.get(key);
    if (!job) {
      const controller = new AbortController();
      job = { controller, users: 0, done: false };
      pending.set(key, job);
      job.promise = Promise.resolve().then(() => load({ signal: controller.signal, timeoutMs: 8000 }))
        .then(value => {
          if (!controller.signal.aborted && value != null && value !== '' && (!Array.isArray(value) || value.length)) {
            for (const [k, entry] of values) if (entry.until <= now()) values.delete(k);
            while (values.size >= maxEntries) values.delete(values.keys().next().value);
            values.set(key, { value: structuredClone(value), until: now() + ttlMs });
          }
          return value;
        }).finally(() => {
          job.done = true;
          if (pending.get(key) === job) pending.delete(key);
        });
    }
    job.users++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', abort);
        if (--job.users === 0 && !job.done) {
          job.controller.abort();
          if (pending.get(key) === job) pending.delete(key);
        }
        if (err) reject(err); else resolve(structuredClone(value));
      };
      const abort = () => finish(searchError('aborted'));
      const timer = setTimeout(() => finish(searchError('deadline_exceeded')), budget);
      opts.signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(value => finish(null, value), err => finish(err));
      if (opts.signal?.aborted) abort();
    });
  }
  return { get };
}

module.exports = { createCache };
