'use strict';

const { result } = require('../../core/search/result');
const { errorInfo, report } = require('./transport');

async function providerResult(provider, load, opts = {}) {
  const started = Date.now();
  try {
    const items = await load();
    const attempt = { provider, status: items.length ? 'ok' : 'empty', selected: items.length, elapsedMs: Date.now() - started };
    report(opts.trace, 'provider', attempt);
    return result(items, { attempts: [attempt], elapsedMs: attempt.elapsedMs });
  } catch (err) {
    const info = errorInfo(err);
    report(opts.trace, 'failed', { provider, ...info });
    return result([], { status: 'failed', reason: info.code,
      attempts: [{ provider, status: 'failed', code: info.code, error: info, elapsedMs: Date.now() - started }], elapsedMs: Date.now() - started });
  }
}

module.exports = { providerResult };
