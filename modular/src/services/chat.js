'use strict';

const { json, readBody, sseInit, sseSend, sanitizeId } = require('../http/util');
const { LlmError } = require('../llm/client');

/* ---------------- 网页聊天（SSE 流式） ---------------- */

async function handleChat(runtime, req, res) {
  const { bot, config, logger } = runtime;
  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    return json(res, err.statusCode || 400, { ok: false, error: err.message });
  }
  const text = String(body.text || '').trim();
  if (!text) return json(res, 400, { ok: false, error: '说点什么呀~' });

  const mode = body.mode === 'group' ? 'group' : 'private';
  const sessionId = sanitizeId(body.sessionId || 'default');
  const chatId = `${sessionId}:${mode}`;
  const senderName =
    mode === 'group' ? String(body.senderName || '阿螈').slice(0, 20) : String(body.senderName || '你').slice(0, 20);

  const msg = {
    platform: 'web',
    chatId,
    chatType: mode,
    senderId: mode === 'group' ? `web-g-${senderName}` : `web-u-${sessionId}`,
    senderName,
    text,
    atMe: Boolean(body.atMe),
    msgId: body.msgId ? String(body.msgId).slice(0, 100) : '',
    chatTitle: mode === 'group' ? config.persona.name + '的深海鱼塘' : '',
  };

  const abort = new AbortController();
  let closed = false;
  res.on('close', () => {
    closed = true;
    abort.abort();
  });

  let decision;
  try {
    decision = await bot.decide(msg);
  } catch (err) {
    logger.error('decide 失败：' + (err && err.stack ? err.stack : err));
    return json(res, 500, { ok: false, error: '鲸鲸打了个结，稍后再试' });
  }

  // 被忽略（群聊里没被叫到）
  if (decision.action === 'ignore') {
    return json(res, 200, { ok: true, action: 'ignore', reason: decision.reason });
  }

  sseInit(res);
  sseSend(res, {
    type: 'meta',
    action: decision.action,
    mock: Boolean(decision.mock),
    reason: decision.reason,
    mode,
    senderName,
    commandType: decision.commandType || '',
  });

  // 命令 / 只被 @ 一下：直接回复固定台词
  if (decision.action === 'command' || decision.canned) {
    const full = decision.text || decision.canned || '';
    for (let i = 0; i < full.length; i += 3) {
      if (closed) return res.end();
      sseSend(res, { type: 'delta', text: full.slice(i, i + 3) });
    }
    const bubbles = bot.finalize(decision, full);
    sseSend(res, { type: 'done', text: full, bubbles, reason: decision.reason, commandType: decision.commandType || '' });
    return res.end();
  }

  let full = '';
  let failed = null;
  try {
    for await (const piece of bot.generate(decision, { signal: abort.signal })) {
      if (closed) break;
      full += piece;
      sseSend(res, { type: 'delta', text: piece });
    }
  } catch (err) {
    failed = err;
  }
  if (closed) return res.end();

  if (failed) {
    const friendly = failed instanceof LlmError ? failed.userMessage : '呜…深海线路打结了，等会儿再来找人家嘛 (｡•́︿•̀｡)';
    logger.error('生成失败：' + (failed.message || failed));
    bot.finalize(decision, friendly, { error: true });
    sseSend(res, { type: 'delta', text: full ? '\n' + friendly : friendly });
    sseSend(res, { type: 'done', text: (full + (full ? '\n' : '') + friendly).trim(), bubbles: [friendly], error: true, reason: 'llm_error' });
    return res.end();
  }

  const clean = String(full || '').trim();
  const bubbles = bot.finalize(decision, clean);
  sseSend(res, { type: 'done', text: clean, bubbles, reason: decision.reason, mock: Boolean(decision.mock) });
  res.end();
}

module.exports = { handleChat };
