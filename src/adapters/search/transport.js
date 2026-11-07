'use strict';

const https = require('node:https');
const { performance } = require('node:perf_hooks');
const { describeError } = require('../../infra/errors');

function searchError(code, status = 0) {
  const err = new Error(code);
  err.code = code;
  err.status = status;
  err.detail = code;
  return err;
}

function remaining(opts = {}) {
  const timeout = Number.isFinite(Number(opts.timeoutMs)) ? Math.max(0, Number(opts.timeoutMs)) : 8000;
  return Math.max(0, Math.min(timeout, opts.deadline == null ? Infinity : opts.deadline - Date.now()));
}

function errorInfo(err) {
  // 系统/解析器错误可能把请求 URL 或响应正文放进 message；日志只保留结构证据。
  const type = /^[A-Za-z]+Error$|^Error$/.test(err?.name) ? err.name : 'Error';
  const code = /^[A-Za-z0-9_]+$/.test(err?.code || '') ? err.code : err instanceof SyntaxError ? 'parse_error' : 'network_error';
  const status = Number(err?.status || err?.statusCode) || 0;
  const safe = { name: type, code, status, detail: code };
  return { type, code, status, detail: code, description: describeError(safe) };
}

function report(trace, stage, data) {
  try { trace?.(stage, data); } catch { /* 诊断失败不应改变搜索结果。 */ }
}

function getText(url, opts = {}) {
  if (typeof opts === 'number') opts = { timeoutMs: opts };
  const budget = remaining(opts);
  if (opts.signal?.aborted) return Promise.reject(searchError('aborted'));
  if (budget <= 0) return Promise.reject(searchError('deadline_exceeded'));
  const deadline = performance.now() + budget;
  const visit = (target, redirects = 0) => new Promise((resolve, reject) => {
    let req, response, timer;
    let settled = false;
    const finish = (err, body) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (err) {
        reject(err);
        response?.destroy();
        req?.destroy(err);
      } else resolve(body);
    };
    const abort = () => finish(searchError('aborted'));
    timer = setTimeout(() => finish(searchError('deadline_exceeded')), Math.max(1, deadline - performance.now()));
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) return abort();
    if (performance.now() >= deadline) return finish(searchError('deadline_exceeded'));
    try {
      const parsed = new URL(target);
      if (parsed.protocol !== 'https:') return finish(searchError('unsupported_protocol'));
      req = https.get(parsed.toString(), { headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9', Accept: 'text/html,application/json,*/*', ...(opts.headers || {}),
      } }, res => {
        response = res;
        res.on('error', err => finish(err));
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          if (redirects >= 5) return finish(searchError('too_many_redirects'));
          let next;
          try { next = new URL(res.headers.location, target); } catch { return finish(searchError('invalid_redirect')); }
          if (next.protocol !== 'https:') return finish(searchError('unsupported_protocol'));
          // 旧跳转页立即释放，新连接沿用同一个绝对时限和取消信号。
          clearTimeout(timer);
          opts.signal?.removeEventListener('abort', abort);
          visit(next.toString(), redirects + 1).then(body => finish(null, body), finish);
          return;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) return finish(searchError('http_error', res.statusCode));
        res.on('aborted', () => finish(searchError('response_aborted')));
        res.on('close', () => { if (!res.complete) finish(searchError('response_closed')); });
        const chunks = [];
        let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) return finish(searchError('response_too_large'));
          chunks.push(chunk);
        });
        res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      });
      req.on('error', err => finish(err));
    } catch (err) { finish(err); }
  });
  return visit(url);
}

async function getJson(url, opts) {
  const body = await getText(url, opts);
  try { return JSON.parse(body); } catch { throw searchError('parse_error'); }
}

module.exports = { getText, getJson, remaining, searchError, errorInfo, report };
