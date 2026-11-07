'use strict';

function result(items = [], { reason = '', attempts = [], staleItems = [], elapsedMs = 0, status } = {}) {
  return { status: status || (items.length ? 'ok' : attempts.some(a => a.status === 'failed') && !attempts.some(a => a.status === 'ok' || a.status === 'empty') ? 'failed' : 'empty'),
    reason: reason || (items.length ? 'available' : staleItems.length ? 'stale_only' : 'no_results'),
    items, staleItems, attempts, elapsedMs };
}

function formatResult(value, { maxChars = 1400 } = {}) {
  if (!value || value.status !== 'ok') return '';
  let text = '';
  for (const [index, item] of value.items.entries()) {
    const meta = [item.provider, item.publishedAt ? `发布时间：${item.publishedAt}` : '发布时间未确认',
      item.fetchedAt ? `获取时间：${item.fetchedAt}` : ''].filter(Boolean).join('；');
    const head = `${index + 1}. ${String(item.title || '（无标题）').slice(0, 120)}\n${meta}\n${item.url || ''}\n`;
    const available = maxChars - text.length - head.length - 2;
    if (available < 0) break;
    const snippet = String(item.snippet || '').slice(0, Math.min(500, available));
    text += head + snippet + '\n\n';
  }
  return text.trim();
}

module.exports = { result, formatResult };
