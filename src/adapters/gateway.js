'use strict';

/**
 * 通用 HTTP 网关适配器：把微信/抖音中转服务发来的 JSON 变成统一消息，
 * 再把鲸鲸的回复 POST 回中转服务。
 *
 * 收消息：POST /webhook/{platform}  （协议见 docs/GATEWAY.md）
 * 发消息：POST {gateway.outboundUrl}  JSON:
 *   { platform, chat_id, chat_type, text, bubbles, reply_to, bot }
 */
const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const PLATFORMS = ['wechat', 'douyin'];

function firstDefined(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function toBool(v) {
  return v === true || v === 1 || v === '1' || v === 'true' || v === 'yes';
}

/** 从网关发来的任意 JSON 里提取统一消息 */
function normalizeInbound(payload, platform) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const body = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? { ...root, ...root.data } : root;
  const rawChatId = firstDefined(body, ['chat_id', 'chatId', 'room_id', 'roomId', 'conversation_id', 'group_id', 'from_chat_id', 'session_id']);
  const explicitType = String(firstDefined(body, ['chat_type', 'chatType', 'type']) || '').toLowerCase();
  const hasRoom = Boolean(firstDefined(body, ['room_id', 'roomId', 'group_id', 'groupName', 'group_name']));
  const isGroup = explicitType === 'group' || explicitType === '群' || toBool(firstDefined(body, ['is_group', 'isGroup', 'from_group'])) || hasRoom;
  const text =
    firstDefined(body, ['text', 'content', 'message', 'msg', 'body', 'payload', 'text_content']) ?? '';
  const atMe = toBool(firstDefined(body, ['at_me', 'atMe', 'is_at', 'isAt', 'at', 'mentioned', 'addressed']));
  const replyToBot = toBool(firstDefined(body, ['reply_to_bot', 'replyToBot', 'quote_from_bot', 'is_reply_to_bot']));
  const replyToName = firstDefined(body, ['reply_to_name', 'replyToName', 'quote_sender_name', 'quoted_sender_name']);
  const replyToUserId = firstDefined(body, ['reply_to_user_id', 'replyToUserId', 'quote_sender_id', 'quoted_sender_id']);
  const mentions = firstDefined(body, ['mentioned_names', 'mentionedNames', 'mention_names', 'mentions']);
  const noReply = toBool(firstDefined(body, ['no_reply', 'noReply']));

  return {
    platform,
    chatId: String(rawChatId ?? firstDefined(body, ['sender_id', 'user_id', 'from', 'sender']) ?? 'unknown'),
    chatType: isGroup ? 'group' : 'private',
    senderId: String(firstDefined(body, ['sender_id', 'user_id', 'userId', 'sender', 'from', 'wxid', 'author_id']) ?? 'unknown'),
    senderName: String(firstDefined(body, ['nickname', 'sender_name', 'senderName', 'user_name', 'userName', 'name', 'display_name', 'from_name']) ?? '群友'),
    text: typeof text === 'string' ? text : JSON.stringify(text),
    atMe,
    replyToBot,
    replyToName: String(replyToName || ''),
    replyToUserId: String(replyToUserId || ''),
    mentionedNames: Array.isArray(mentions) ? mentions : [],
    msgId: String(firstDefined(body, ['msg_id', 'msgId', 'message_id', 'messageId', 'id']) ?? ''),
    chatTitle: String(firstDefined(body, ['chat_title', 'chatTitle', 'room_name', 'roomName', 'group_name', 'groupName', 'title']) ?? ''),
    noReply,
  };
}

function postJson(urlString, payload, headers = {}, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch {
      return reject(new Error('outboundUrl 不是合法地址：' + urlString));
    }
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: text.slice(0, 500) });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('发送超时')));
    req.on('error', reject);
    req.end(body);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Gateway {
  constructor({ platform, options = {}, bot, logger }) {
    this.platform = platform;
    this.options = {
      enabled: true,
      inboundToken: '',
      outboundUrl: '',
      outboundHeaders: {},
      sendBubbles: false,
      ...options,
    };
    this.bot = bot;
    this.logger = logger;
    this.stats = { received: 0, replied: 0, sent: 0, failed: 0, lastMessageAt: 0, lastError: '' };
    // 本地桥接的存活信息：桥接每 20 秒来一次心跳，网页据此显示「桥接在线 / 离线」
    this.bridge = { lastSeen: 0, uia: null, rest: false, listener: null, ffmpeg: null, account: '' };
  }

  /** 桥接心跳：带 UIA / ffmpeg 状态，方便在网页上一眼看出「能不能发出去」 */
  heartbeat(info = {}) {
    const now = Date.now();
    this.bridge = {
      lastSeen: now,
      uia: typeof info.uia === 'boolean' ? info.uia : (info.uia === null ? null : this.bridge.uia),
      rest: typeof info.rest === 'boolean' ? info.rest : Boolean(this.bridge.rest),
      listener: typeof info.listener === 'boolean' ? info.listener : this.bridge.listener,
      ffmpeg: typeof info.ffmpeg === 'boolean' ? info.ffmpeg : this.bridge.ffmpeg,
      account: String(info.account || this.bridge.account || ''),
    };
    return { ok: true, online: true, serverTime: now };
  }

  verifyToken(req, body) {
    const expected = String(this.options.inboundToken || '');
    if (!expected) return true; // 没设置 token 就不校验（只建议本机测试时这样）
    const header = req.headers['x-bot-token'] || req.headers['x-bot-signature'];
    const query = req.url && req.url.includes('token=')
      ? new URL(req.url, 'http://localhost').searchParams.get('token')
      : null;
    const fromBody = body && (body.token || body.verify_token || body.signature);
    return [header, query, fromBody].some((v) => String(v || '') === expected);
  }

  async handleInbound(payload, { local = false } = {}) {
    const msg = normalizeInbound(payload, this.platform);
    if (local) {
      // 桥接来取消息也算一次心跳（它一定是活着的）
      this.bridge.lastSeen = Date.now();
    }
    this.stats.received += 1;
    this.stats.lastMessageAt = Date.now();
    if (msg.noReply) return { ok: true, skipped: 'no_reply_flag' };
    this.logger &&
      this.logger.info(
        `[${this.platform}] 收到 ${msg.chatType === 'group' ? '群' : '私聊'}消息 ${msg.senderName}：${String(msg.text).slice(0, 40)}`
      );
    const result = await this.bot.handle(msg);
    if (result.action !== 'reply' || !result.reply) {
      return { ok: true, action: 'ignore', reason: result.reason || 'ignored' };
    }
    const out = await this.send({
      chatId: msg.chatId,
      chatType: msg.chatType,
      text: result.reply,
      bubbles: result.bubbles || [result.reply],
      replyTo: msg.msgId,
      senderName: msg.senderName,
      local,
    });
    return {
      ok: true,
      action: 'reply',
      reply: result.reply,
      bubbles: result.bubbles || [result.reply],
      // 群里要真的 @ 某人时，桥接据此调 at_member
      mention: result.mention || '',
      // 演示模式（没配 Key，说的是内置台词）：桥接据此在日志里提醒一次，
      // 不然用户会以为「没填 Key 居然也能真聊」。
      mock: Boolean(this.bot && this.bot.llm && this.bot.llm.isMock),
      outbound: out,
    };
  }

  async send({ chatId, chatType, text, bubbles = [text], replyTo = '', senderName = '', local = false }) {
    const payload = {
      platform: this.platform,
      chat_id: chatId,
      chat_type: chatType,
      text,
      bubbles,
      reply_to: replyTo,
      reply_to_name: senderName,
      bot: '鲸鲸',
      ts: Date.now(),
    };
    const lines = this.options.sendBubbles && Array.isArray(bubbles) && bubbles.length > 1 ? bubbles : [text];
    if (!this.options.outboundUrl) {
      // 本地桥接（examples/wechatauto_bridge.py）模式下，回复是通过这个 HTTP 响应交还给桥接、
      // 由桥接用 UIA 发出去的 —— 没配 outboundUrl 属于正常。以前这里一律打 WARN「只打印在控制台」，
      // 害得用户以为没发出去（实际发了，或者根本没开桥接）。
      if (local) {
        this.logger && this.logger.info(`[${this.platform}] 回复已交给本地桥接发送（${lines.length} 条）`);
      } else {
        this.logger &&
          this.logger.warn(
            `[${this.platform}] 这条回复不会到微信：既没有 gateway.outboundUrl，也不是本地桥接请求。` +
            `本地用法请另开「启动微信桥接.bat」；自建中转才需要 outboundUrl。内容：${String(text).slice(0, 40)}`
          );
      }
      return { ok: true, dryRun: true, local };
    }
    const results = [];
    for (let i = 0; i < lines.length; i++) {
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const r = await postJson(
            this.options.outboundUrl,
            i === 0 ? payload : { ...payload, text: lines[i], bubbles: [lines[i]] },
            this.options.outboundHeaders || {}
          );
          results.push(r);
          if (r.ok) {
            this.stats.sent += 1;
            this.stats.lastError = '';
            lastErr = null;
            break;
          }
          lastErr = new Error(`HTTP ${r.status} ${r.body}`);
        } catch (err) {
          lastErr = err;
        }
        if (attempt === 0) await sleep(500);
      }
      if (lastErr) {
        this.stats.failed += 1;
        this.stats.lastError = lastErr.message;
        this.logger && this.logger.error(`[${this.platform}] 发送失败：${lastErr.message}`);
      }
      if (lines.length > 1 && i < lines.length - 1) await sleep(400);
    }
    return { ok: results.some((r) => r.ok), results };
  }

  status() {
    const ageSec = this.bridge.lastSeen ? Math.round((Date.now() - this.bridge.lastSeen) / 1000) : null;
    // 20 秒一次心跳，45 秒没动静就算掉线（给一点网络抖动余量）
    const online = ageSec !== null && ageSec <= 45;
    return {
      platform: this.platform,
      enabled: Boolean(this.options.enabled),
      outboundConfigured: Boolean(this.options.outboundUrl),
      inboundPath: `/webhook/${this.platform}`,
      // 网页据此显示「桥接在线 · UIA 正常 / 桥接离线」
      bridge: {
        online,
        lastSeenSec: ageSec,
        uia: online ? this.bridge.uia : null,
        rest: online ? Boolean(this.bridge.rest) : false,
        listener: online ? this.bridge.listener : null,
        ffmpeg: online ? this.bridge.ffmpeg : null,
        account: this.bridge.account,
      },
      ...this.stats,
    };
  }
}

function createGateways({ config, bot, logger }) {
  const gateways = new Map();
  for (const platform of PLATFORMS) {
    const options = config.gateway?.[platform];
    if (!options) continue;
    const gateway = new Gateway({ platform, options, bot, logger });
    gateways.set(platform, gateway);
  }
  return gateways;
}

module.exports = { Gateway, createGateways, normalizeInbound, postJson, PLATFORMS };
