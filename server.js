'use strict';

/**
 * 鲸鲸 HTTP 服务：
 *   网页聊天界面（SSE 流式）
 *   /api/*  设置、状态、记忆
 *   /webhook/{wechat|douyin}  给微信/抖音中转服务回调
 *
 * 用法：node server.js            启动
 *       node server.js --doctor   环境自检
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');

const { loadConfig, ensureConfigFile, loadSettings, saveSettings, resolveRuntime, maskKey, projectRoot, PROVIDERS } = require('./src/config');
const { createLogger } = require('./src/logger');
const { Store } = require('./src/memory');
const { DeepSeekClient, LlmError } = require('./src/llm');
const { Bot } = require('./src/bot');
const { createGateways } = require('./src/adapters/gateway');
const persona = require('./src/persona');
const care = require('./src/care');
const { matchMaster, masterWarnings } = require('./src/master');
const personaStore = require('./src/personaStore');
const presets = require('./src/presets');
const links = require('./src/links');
const bilibili = require('./src/bilibili');
const vision = require('./src/vision');

const VERSION = require('./package.json').version;
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体太大'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('JSON 格式错误'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (res.flushHeaders) res.flushHeaders();
}

function sseSend(res, obj) {
  if (res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  return true;
}

function sanitizeId(id) {
  return String(id || 'default').replace(/[^\w\-.:]/g, '').slice(0, 80) || 'default';
}

/* ------------------------------------------------------------------ */
/* 运行时组装                                                          */
/* ------------------------------------------------------------------ */

function createRuntime({ root = projectRoot(), env = process.env, loggerLevel } = {}) {
  ensureConfigFile(root);
  const config = loadConfig({ root, env });
  // 加载主人在微信里调过的语态 / 能力（data/persona.json）
  personaStore.apply(config, personaStore.load(config));
  const logger = createLogger({ level: loggerLevel || config.log.level, file: config.paths.logFile });
  const store = new Store({ file: config.paths.storeFile, limits: config.memory, logger });
  const llm = new DeepSeekClient({ config, logger });
  const bot = new Bot({ config, store, llm, logger });
  const gateways = createGateways({ config, bot, logger });
  const runtime = { config, logger, store, llm, bot, gateways, startedAt: Date.now(), version: VERSION };
  watchConfigFile(runtime);
  return runtime;
}

/**
 * 把新读到的配置合并进**原来那个 config 对象**。
 *
 * bot / llm / gateways 都是拿着 config 的引用构造的，只有原地改才不会出现
 *「配置文件改了、某些模块还拿着旧值」的半新半旧状态。
 */
function mergeConfigInPlace(target, src) {
  for (const [key, value] of Object.entries(src || {})) {
    if (key === 'paths' || key === 'env' || key === 'root' || key === 'configExists') continue;
    const cur = target[key];
    const both = isPlainObject(value) && isPlainObject(cur);
    if (both) mergeConfigInPlace(cur, value);
    else target[key] = value;
  }
  return target;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 监听 config.json：手动改完存盘就生效，不用再重启服务。 */
function watchConfigFile(runtime) {
  const file = runtime.config.paths.configFile;
  let timer = null;
  try {
    const watcher = fs.watch(file, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        try {
          const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
          JSON.parse(raw); // 先确认是合法 JSON，写坏了就别覆盖内存里的好配置
          mergeConfigInPlace(runtime.config, loadConfig({ root: runtime.config.root, env: runtime.config.env }));
          if (runtime.llm && typeof runtime.llm.reload === 'function') runtime.llm.reload();
          runtime.logger.info('config.json 已重新加载（改动已生效，不用重启）');
        } catch (err) {
          runtime.logger.warn(`config.json 改了但没读成功，先按老配置跑：${err && err.message}`);
        }
      }, 250);
    });
    watcher.unref?.();
    runtime.configWatcher = watcher;
  } catch (err) {
    runtime.logger.warn(`监听 config.json 失败（手动改完记得重启服务）：${err && err.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* 调试台：直接读写 config.json（改完立刻生效，不用重启）              */
/* ------------------------------------------------------------------ */

// 这些路径网页「⚙️ 设置」会写进 data/settings.json，而它的优先级高于 config.json
const SETTINGS_SHADOW = {
  provider: ['provider'],
  'deepseek.provider': ['provider'],
  'deepseek.apiKey': ['apiKey'],
  'deepseek.baseUrl': ['baseUrl'],
  'deepseek.model': ['model'],
  'deepseek.temperature': ['temperature'],
  'deepseek.mock': ['mock'],
  'persona.ownerName': ['userName'],
};

// 密钥类：网页只显示「已设置 / 没配」，留空提交表示「不改」
const SECRET_PATHS = new Set([
  'deepseek.apiKey',
  'vision.apiKey',
  'voice.apiKey',
  'gateway.wechat.inboundToken',
  'gateway.douyin.inboundToken',
]);

function getByPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

function setByPath(obj, dotted, value) {
  const parts = String(dotted).split('.').filter(Boolean);
  if (!parts.length) throw new Error('空的字段名');
  for (const p of parts) {
    if (p.startsWith('_') || p === '__proto__' || p === 'constructor' || p === 'prototype') {
      throw new Error('不允许改这个字段：' + dotted);
    }
  }
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 按现有配置的类型把网页送来的值转成正确类型（数字/开关/数组/JSON） */
function coerceValue(config, dotted, value) {
  const cur = getByPath(config, dotted);
  if (typeof cur === 'number') {
    const n = typeof value === 'number' ? value : Number(String(value == null ? '' : value).trim());
    if (!Number.isFinite(n)) throw new Error('「' + dotted + '」要填数字');
    return n;
  }
  if (typeof cur === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
  if (Array.isArray(cur)) {
    if (Array.isArray(value)) return value.map((x) => String(x).trim()).filter(Boolean);
    return String(value == null ? '' : value).split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
  }
  if (isPlainObject(cur)) {
    if (isPlainObject(value)) return value;
    try {
      return JSON.parse(String(value));
    } catch {
      throw new Error('「' + dotted + '」要填合法的 JSON');
    }
  }
  if (value === null || value === undefined) return '';
  return String(value);
}

/** 给网页看的配置：去掉内部字段，密钥留空但告诉它「配没配」 */
function publicConfig(config) {
  const internal = new Set(['env', 'paths', 'root', 'configExists']);
  const out = JSON.parse(JSON.stringify(config, (k, v) => (internal.has(k) ? undefined : v)));
  const secrets = {};
  for (const path of SECRET_PATHS) {
    const v = getByPath(config, path);
    secrets[path] = Boolean(v && String(v).trim());
    try { setByPath(out, path, ''); } catch { /* 没有这段就算了 */ }
  }
  return { config: out, secrets };
}

/** 把 settings.json 里会「盖住」刚改的字段清掉，否则网页上改了 config.json 却不生效 */
function clearSettingsShadow(runtime, paths) {
  const file = runtime.config.paths.settingsFile;
  let cur;
  try {
    cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return [];
  }
  const cleared = [];
  for (const path of paths) {
    for (const key of SETTINGS_SHADOW[path] || []) {
      if (Object.prototype.hasOwnProperty.call(cur, key)) {
        delete cur[key];
        cleared.push('settings.' + key);
      }
    }
    if (path.startsWith('group.')) {
      const gk = path.slice('group.'.length);
      if (isPlainObject(cur.group) && Object.prototype.hasOwnProperty.call(cur.group, gk)) {
        delete cur.group[gk];
        cleared.push('settings.group.' + gk);
        if (!Object.keys(cur.group).length) delete cur.group;
      }
    }
  }
  if (cleared.length) {
    try { fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8'); } catch { /* 写不了就算了 */ }
  }
  return cleared;
}

/** 把网页提交的 { "persona.name": "新名字" } 写进 config.json 并立刻生效 */
function applyConfigPatch(runtime, patch) {
  if (!isPlainObject(patch)) throw new Error('patch 要是 { 字段名: 新值 } 这样的对象');
  const file = runtime.config.paths.configFile;
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    raw = {};
  }
  const changed = [];
  for (const [dotted, value] of Object.entries(patch)) {
    const path = String(dotted || '').trim();
    if (!path) continue;
    // 密钥留空 = 不改（网页上看不到已存的 Key，不能一保存就把它清了）
    if (SECRET_PATHS.has(path) && (value === '' || value === null || value === undefined)) continue;
    setByPath(raw, path, coerceValue(runtime.config, path, value));
    changed.push(path);
  }
  if (!changed.length) return { changed, cleared: [] };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  const cleared = clearSettingsShadow(runtime, changed);
  mergeConfigInPlace(runtime.config, loadConfig({ root: runtime.config.root, env: runtime.config.env }));
  if (runtime.llm && typeof runtime.llm.reload === 'function') runtime.llm.reload();
  runtime.logger.info(`调试台保存了设置：${changed.join('、')}${cleared.length ? `（同时清了 ${cleared.join('、')}，让改动真的生效）` : ''}`);
  return { changed, cleared };
}

function statusPayload(runtime) {
  const { config, llm, bot, gateways } = runtime;
  const rt = resolveRuntime(config);
  return {
    ok: true,
    name: config.persona.name,
    version: runtime.version,
    node: process.version,
    uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
    mock: llm.isMock,
    provider: llm.provider,
    providerLabel: llm.providerLabel,
    needsKey: llm.needsKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    temperature: llm.temperature,
    memory: storeSummary(runtime),
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerHour: config.group.maxRepliesPerHour,
    },
    gateways: [...gateways.values()].map((g) => g.status()),
    webhookPaths: [...gateways.keys()].map((p) => `/webhook/${p}`),
  };
}

function storeSummary(runtime) {
  const s = runtime.store.summary();
  return { sessions: s.sessions, messages: s.messages, notes: s.notes, totalMessages: s.totalMessages, totalReplies: s.totalReplies };
}

/* ---------------- 主动分享：从群聊热点找视频 ---------------- */

async function shareForChat(runtime, chatId) {
  const key = chatId ? `wechat:g:${chatId}` : '';
  let texts = [];
  if (key) {
    try {
      texts = runtime.store
        .messages(key, 30)
        .filter((m) => m.role === 'user' && m.text)
        .map((m) => String(m.text).slice(0, 120));
    } catch {
      texts = [];
    }
  }
  let topic = '';
  if (texts.length >= 3) {
    try {
      const out = await runtime.llm.complete({
        system: '你只输出 1 个适合去视频网站搜的中文话题词，不超过 8 个字，不要解释、不要标点。',
        turns: [{ role: 'user', content: texts.slice(-20).join('\n').slice(0, 1500) }],
      });
      topic = String(out).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 12);
    } catch {
      topic = '';
    }
  }
  // 来源：以前这个配置项没人读，写什么都是硬抓 B 站。现在至少让它真的能关。
  const sources = Array.isArray(runtime.config.share && runtime.config.share.sources)
    ? runtime.config.share.sources.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
    : ['bilibili'];
  if (!sources.includes('bilibili')) {
    return { ok: true, video: null, topic, reason: 'no_source', sources };
  }
  let video = topic ? await bilibili.pickByKeyword(runtime.config, topic) : null;
  if (!video) video = await bilibili.pickVideo(runtime.config);
  if (!video) return { ok: true, video: null, topic };
  const comments = await bilibili.fetchComments(video.bvid, 5);
  let comment = '';
  try {
    const sys = '你叫鲸鲸，爱刷视频的女生。看完这个视频，用第一人称说一句自己的感悟或吐槽（跟自己的生活、心情有关），10~20 字；不要复述标题、不要解释、不要提 AI/模型/token/提示词。';
    const user = `话题：${topic || '随便'}\n标题：${video.title}\n评论：${comments.slice(0, 3).join(' / ')}`;
    comment = String(await runtime.llm.complete({ system: sys, turns: [{ role: 'user', content: user }] }))
      .trim()
      .slice(0, 60);
  } catch {
    comment = '';
  }
  return { ok: true, video, topic, comments: comments.slice(0, 3), comment };
}

/**
 * 主动搭话的内容：问她一句「在干啥 / 累不累」。
 * 演示模式（没 Key）直接用内置台词，省得等模型；有 Key 就带着最近聊天生成，避免每次同一句。
 */
async function careForChat(runtime, chatId) {
  const personaCfg = runtime.config.persona || {};
  const name = String(personaCfg.ownerName || '主人');
  const hour = new Date().getHours();
  let recent = [];
  if (chatId) {
    // 会话 key 可能是私聊（wechat:u:<id>）也可能是群（wechat:g:<id>），两边都试
    for (const key of [`wechat:u:${chatId}`, `wechat:g:${chatId}`, chatId]) {
      try {
        const msgs = runtime.store.messages(key, 12) || [];
        if (msgs.length) {
          recent = msgs
            .filter((m) => m && m.text)
            .map((m) => `${m.role === 'user' ? '对方' : (personaCfg.name || '我')}：${String(m.text).slice(0, 60)}`);
          break;
        }
      } catch {
        recent = [];
      }
    }
  }
  if (runtime.llm.isMock) {
    return { ok: true, text: care.pickTemplate(), mock: true, hour };
  }
  try {
    const { system, user } = care.buildCarePrompt({ persona: personaCfg, recent, name, hour });
    const raw = await runtime.llm.complete({ system, turns: [{ role: 'user', content: user }] });
    const text = care.cleanCareText(raw) || care.pickTemplate();
    return { ok: true, text, mock: false, hour };
  } catch (err) {
    runtime.logger.warn('搭话模型失败，用内置台词：' + (err && err.message));
    return { ok: true, text: care.pickTemplate(), mock: true, fallback: true, hour };
  }
}

/* ---------------- 消息汇总 ---------------- */

function buildDigest(items) {
  if (!items.length) return { ok: true, count: 0, text: '' };
  const map = new Map();
  for (const it of items) {
    const key = (it.chatType === 'group' ? '群 ' : '私聊 ') + (it.chat || it.sender || '');
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  const lines = [`📥 消息汇总（${items.length} 条）`];
  let n = 0;
  for (const [key, arr] of map) {
    lines.push(`【${key}】${arr.length} 条`);
    for (const it of arr.slice(-5)) {
      lines.push(`- ${String(it.sender || '对方')}：${String(it.text || '').replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    n += 1;
    if (n >= 10) { lines.push('……还有更多会话未列出'); break; }
  }
  return { ok: true, count: items.length, text: lines.join('\n') };
}

/* ---------------- 人设调教（浏览器表单用） ---------------- */

function applyPersonaPatch(runtime, body) {
  if (body && body.reset) {
    personaStore.clear(runtime.config);
    runtime.logger.info('人设调教：恢复默认');
    return { ok: true, persona: personaStore.summary(runtime.config) };
  }
  const patch = {};
  const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
  if (body.name !== undefined) patch.name = str(body.name, 40) || '鲸鲸';
  if (body.job !== undefined) patch.job = str(body.job, 80) || '自由职业';
  if (body.appearance !== undefined) patch.appearance = str(body.appearance, 400);
  if (body.personality !== undefined) patch.personality = str(body.personality, 500);
  if (body.background !== undefined) patch.background = str(body.background, 500);
  if (body.customPrompt !== undefined) patch.customPrompt = str(body.customPrompt, 6000);
  if (body.age !== undefined) patch.age = Math.max(1, Math.min(120, Number(body.age) || 23));
  if (body.preset !== undefined) patch.preset = str(body.preset, 20);
  if (body.text !== undefined) patch.text = str(body.text, 300);
  if (body.emoji !== undefined) patch.emoji = ['关', '少', '正常', '多'].includes(body.emoji) ? body.emoji : '正常';
  if (body.historyTurns !== undefined) patch.historyTurns = Math.max(4, Math.min(400, Number(body.historyTurns) || 200));
  if (body.groupHistoryTurns !== undefined) patch.groupHistoryTurns = Math.max(2, Math.min(300, Number(body.groupHistoryTurns) || 150));
  if (body.privateMaxChars !== undefined) patch.privateMaxChars = Math.max(40, Math.min(800, Number(body.privateMaxChars) || 140));
  if (body.groupMaxChars !== undefined) patch.groupMaxChars = Math.max(20, Math.min(300, Number(body.groupMaxChars) || 70));
  for (const k of ['emotions', 'proactive', 'opinions', 'links', 'freeChat']) {
    if (body[k] !== undefined) patch[k] = Boolean(body[k]);
  }
  if (Array.isArray(body.mutedGroups)) patch.mutedGroups = body.mutedGroups.map((x) => String(x).trim()).filter(Boolean).slice(0, 30);
  personaStore.save(runtime.config, patch);
  if (body.model) {
    try {
      saveSettings(runtime.config, { model: String(body.model).slice(0, 80), mock: false });
      runtime.llm.reload();
    } catch (err) {
      runtime.logger.warn('人设调教：切模型失败 ' + (err && err.message));
    }
  }
  runtime.logger.info('人设调教：已保存 ' + Object.keys(patch).join(','));
  return { ok: true, persona: personaStore.summary(runtime.config), llm: { provider: runtime.llm.provider, providerLabel: runtime.llm.providerLabel, model: runtime.llm.model, mock: runtime.llm.isMock } };
}

/** 调试台（本机自查用）：主人判定与告警见 src/master.js */

/** 最近的发言者：昵称 + 真实 senderId（主人名单照着这个填） */
function recentSenders(store, limit = 8) {
  const seen = new Map();
  if (!store || !store.sessions) return [];
  for (const sess of store.sessions.values()) {
    for (const m of sess.messages || []) {
      if (m.role !== 'user' || !m.uid) continue;
      const uid = String(m.uid);
      const ts = Number(m.ts || 0);
      const cur = seen.get(uid);
      if (cur && cur.ts >= ts) continue;
      seen.set(uid, {
        uid,
        name: String(m.name || ''),
        platform: sess.platform || '',
        chatType: sess.chatType || 'private',
        ts,
      });
    }
  }
  return [...seen.values()].sort((a, b) => b.ts - a.ts).slice(0, limit);
}

function debugState(runtime) {
  const { config, llm, gateways, store } = runtime;
  const rt = resolveRuntime(config);
  const now = new Date();
  const mood = persona.moodFor(now);
  const master = (config.persona && config.persona.master) || {};
  return {
    ok: true,
    nowLabel: `${persona.timeLabel(now)} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`,
    mood: { name: mood.name, hint: mood.hint },
    activity: persona.activityFor(now),
    persona: {
      name: config.persona.name,
      aliases: config.persona.aliases || [],
      ownerName: config.persona.ownerName || '',
      master: {
        names: master.names || [],
        wxids: master.wxids || [],
        // 填错了（比如把微信号当 wxid）的时候，调试台直接说出来，别让人瞎猜
        warnings: masterWarnings(config),
      },
    },
    // 最近在微信里说过话的人 + 各自的真实 senderId：主人名单该填哪一串，照着抄就行
    senders: recentSenders(store),
    llm: {
      mock: llm.isMock,
      mockSetting: typeof rt.settings.mock === 'boolean' ? rt.settings.mock : null,
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      model: llm.model,
      baseUrl: llm.baseUrl,
      apiKeyMasked: maskKey(rt.apiKey),
      needsKey: llm.needsKey,
      temperature: llm.temperature,
      frequencyPenalty: llm.frequencyPenalty,
      presencePenalty: llm.presencePenalty,
    },
    chat: {
      privateMaxChars: config.chat.privateMaxChars,
      groupMaxChars: config.chat.groupMaxChars,
      historyTurns: config.chat.historyTurns,
      groupHistoryTurns: config.chat.groupHistoryTurns,
      maxBubbles: config.chat.maxBubbles,
      // 「颜文字用量」档位换算出来的真实概率（面板上看起来「没生效」时看这个）
      emojiChance: persona.emojiChanceFor(config),
      emojiLevel: (config.persona && config.persona.emojiLevel) || '正常',
    },
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
      maxRepliesPerHour: config.group.maxRepliesPerHour,
    },
    links: {
      enabled: !config.links || config.links.enabled !== false,
      timeoutMs: (config.links && config.links.timeoutMs) || 6000,
    },
    personaStyle: personaStore.summary(config),
    admin: {
      configured: Boolean(config.admin && config.admin.spell),
      minutes: (config.admin && config.admin.minutes) || 30,
      spellMasked: (() => {
        const s = String((config.admin && config.admin.spell) || '');
        return s ? s.slice(0, 2) + '****' + s.slice(-2) : '';
      })(),
    },
    gateways: [...gateways.values()].map((g) => g.status()),
    memory: store.summary(),
    paths: {
      storeFile: config.paths.storeFile,
      configFile: config.paths.configFile,
      settingsFile: config.paths.settingsFile,
    },
  };
}

function debugSessions(runtime) {
  const list = [];
  for (const [key, sess] of runtime.store.sessions) {
    list.push({
      key,
      platform: sess.platform,
      chatType: sess.chatType,
      title: sess.title,
      lastActiveAt: sess.lastActiveAt,
      messageCount: sess.messages.length,
      adminUntil: sess.state.adminUntil || 0,
      profiles: Object.values(sess.profiles).map((p) => ({ uid: p.uid, name: p.name, nickname: p.nickname, notes: p.notes || [] })),
      messages: sess.messages.slice(-8).map((m) => ({ role: m.role, name: m.name, text: m.text, ts: m.ts })),
    });
  }
  list.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return list.slice(0, 50);
}

async function debugPrompt(runtime, body) {
  const config = runtime.config;
  const senderName = String(body.senderName || '').trim() || '朋友';
  const senderId = String(body.senderId || '').trim();
  const chatType = body.chatType === 'group' ? 'group' : 'private';
  const chatTitle = String(body.chatTitle || '').trim();
  const text = String(body.text || '');
  // 和微信里真正跑消息时用同一个判定（src/master.js），否则调试台会「说认了、实际没认」
  const masterHit = matchMaster(config, { platform: 'wechat', senderId, senderName });
  const isMaster = masterHit.isMaster;

  let linkText = '';
  if (body.readLink && text) {
    const urls = links.extractUrls(text);
    if (urls.length) {
      try {
        linkText = links.formatForPrompt(await links.describeLink(urls[0]));
      } catch {
        linkText = `对方发了一个链接（${urls[0]}），但读取失败。`;
      }
    }
  }

  const system = persona.buildSystem({
    config,
    msg: { chatType, senderName, chatTitle, isMaster, linkText },
    profile: { count: 1, notes: [] },
    notes: [],
    now: new Date(),
  });
  return {
    ok: true,
    isMaster,
    master: { isMaster, reason: masterHit.reason, warnings: masterWarnings(config) },
    system,
    linkText: Boolean(linkText),
    length: system.length,
  };
}

/* ------------------------------------------------------------------ */
/* 接口处理                                                            */
/* ------------------------------------------------------------------ */

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

function handleSettingsGet(runtime, res) {
  const { config, llm } = runtime;
  const rt = resolveRuntime(config);
  const saved = loadSettings(config);
  const providers = {};
  for (const [key, p] of Object.entries(PROVIDERS)) {
    providers[key] = {
      label: p.label,
      baseUrl: p.baseUrl,
      model: p.model,
      needsKey: p.needsKey,
      hint: p.hint,
      models: p.models || [],
    };
  }
  return json(res, 200, {
    ok: true,
    mock: llm.isMock,
    provider: llm.provider,
    providerLabel: llm.providerLabel,
    needsKey: llm.needsKey,
    model: llm.model,
    baseUrl: llm.baseUrl,
    temperature: llm.temperature,
    keyMasked: maskKey(rt.apiKey),
    hasKey: Boolean(rt.apiKey),
    userName: String(saved.userName || config.persona.ownerName || ''),
    // 看图（视觉）状态：网页设置里要能看出「填没填、填的是哪把」
    vision: vision.status(config),
    providers,
    group: {
      requireAt: config.group.requireAt,
      freeChat: config.group.freeChat,
      freeChatChance: config.group.freeChatChance,
      cooldownSec: config.group.cooldownSec,
    },
    configFile: config.paths.configFile,
    dataDir: config.paths.dataDir,
  });
}

async function applySettings(runtime, body) {
  const { config, llm } = runtime;
  const patch = {};
  const current = resolveRuntime(config);

  // 切换模型服务：没显式给地址/模型时，用该服务的预设值
  if (typeof body.provider === 'string' && body.provider.trim()) {
    const provider = body.provider.trim();
    if (!PROVIDERS[provider]) throw new Error('不认识的模型服务：' + provider);
    if (provider !== current.provider) {
      patch.provider = provider;
      const preset = PROVIDERS[provider];
      if (typeof body.baseUrl !== 'string' || !body.baseUrl.trim()) patch.baseUrl = preset.baseUrl;
      if (typeof body.model !== 'string' || !body.model.trim()) patch.model = preset.model;
      if (preset.needsKey === false) patch.mock = false;
    }
  }

  if (typeof body.baseUrl === 'string') {
    const baseUrl = body.baseUrl.trim().slice(0, 300);
    if (baseUrl && !/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('接口地址要以 http:// 或 https:// 开头');
    patch.baseUrl = baseUrl;
  }
  if (typeof body.apiKey === 'string') {
    const key = body.apiKey.trim();
    if (key && (/\s/.test(key) || key.length < 8 || key.length > 300)) {
      throw new Error('API Key 看起来不太对：不能有空格，长度 8~300');
    }
    patch.apiKey = key;
    if (key) patch.mock = false;
  }
  if (typeof body.model === 'string' && body.model.trim()) {
    const model = body.model.trim().slice(0, 80);
    if (!/^[a-zA-Z0-9._\-\/:]{1,80}$/.test(model)) throw new Error('模型名只能包含字母、数字和 . _ - / :');
    patch.model = model;
  }
  // 看图（视觉模型）的 Key：单独一把，存在 data/settings.json 的 visionApiKey，
  // 留空表示「不改」；以前网页没有这个字段，填了也没地方存，于是永远提示未配置
  if (typeof body.visionApiKey === 'string') {
    const vk = body.visionApiKey.trim();
    if (vk && (/\s/.test(vk) || vk.length < 8 || vk.length > 300)) {
      throw new Error('看图 API Key 看起来不太对：不能有空格，长度 8~300');
    }
    if (vk) patch.visionApiKey = vk;
  }
  if (typeof body.mock === 'boolean') patch.mock = body.mock;
  // 「怎么称呼你」：以前只存在浏览器 localStorage 里，换设备就丢；现在写进 data/settings.json
  if (typeof body.userName === 'string') patch.userName = body.userName.trim().slice(0, 24);
  // 只要这次填了 Key，就默认关闭演示模式（防止「有 Key 还在说内置台词」）
  if (patch.apiKey) patch.mock = false;
  if (typeof body.temperature === 'number' && Number.isFinite(body.temperature)) {
    patch.temperature = Math.max(0, Math.min(2, body.temperature));
  }
  if (body.group && typeof body.group === 'object') {
    if (typeof body.group.requireAt === 'boolean') config.group.requireAt = body.group.requireAt;
    if (typeof body.group.freeChat === 'boolean') config.group.freeChat = body.group.freeChat;
    if (Number.isFinite(body.group.freeChatChance)) {
      config.group.freeChatChance = Math.max(0, Math.min(1, Number(body.group.freeChatChance)));
    }
  }
  saveSettings(config, patch);
  llm.reload();
  const mode = llm.isMock ? '演示' : `${llm.providerLabel} · ${llm.model}`;
  runtime.logger.info(`设置已更新：${mode}`);
  return {
    ok: true,
    status: statusPayload(runtime),
    settings: {
      mock: llm.isMock,
      provider: llm.provider,
      providerLabel: llm.providerLabel,
      needsKey: llm.needsKey,
      model: llm.model,
      baseUrl: llm.baseUrl,
      keyMasked: maskKey(resolveRuntime(config).apiKey),
      userName: String(loadSettings(config).userName || ''),
      // 保存后前端立刻能把「看图 Key 已存」显示出来
      vision: vision.status(config),
    },
  };
}



/* ------------------------------------------------------------------ */
/* 静态文件                                                            */
/* ------------------------------------------------------------------ */

function serveStatic(runtime, req, res, urlPath) {
  const { config, logger } = runtime;
  const webDir = config.paths.webDir;
  const rel = urlPath === '/' ? 'index.html' : urlPath === '/debug' ? 'debug.html' : urlPath === '/persona' ? 'persona.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.resolve(webDir, rel);
  if (!filePath.startsWith(webDir)) {
    return json(res, 403, { ok: false, error: 'forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (urlPath === '/favicon.ico') {
        res.writeHead(204);
        return res.end();
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ------------------------------------------------------------------ */
/* 主处理函数                                                          */
/* ------------------------------------------------------------------ */

function createHandler(runtime) {
  const { config, logger, gateways } = runtime;

  return async function handler(req, res) {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch {
      return json(res, 400, { ok: false, error: 'bad url' });
    }
    const pathname = decodeURIComponent(url.pathname);
    const method = req.method || 'GET';

    try {
      if (pathname === '/healthz') return json(res, 200, { ok: true, up: true });

      if (pathname === '/api/status' && method === 'GET') {
        return json(res, 200, statusPayload(runtime));
      }

      if (pathname === '/api/settings') {
        if (method === 'GET') return handleSettingsGet(runtime, res);
        if (method === 'POST') {
          const body = await readBody(req);
          try {
            const data = await applySettings(runtime, body);
            return json(res, 200, data);
          } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
          }
        }
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (pathname === '/api/settings/test' && method === 'POST') {
        const body = await readBody(req);
        if (body && Object.keys(body).length) {
          try {
            await applySettings(runtime, body);
          } catch (err) {
            return json(res, 400, { ok: false, error: err.message });
          }
        }
        const probe = await runtime.llm.probe();
        return json(res, 200, { ok: probe.ok, probe });
      }

      // 「测试看图」：拿内置的 64x64 PNG 试一下 Key 通不通。
      // body.apiKey 可选 —— 网页里可以先测再保存。
      if (pathname === '/api/vision/test' && method === 'POST') {
        let vbody = {};
        try { vbody = await readBody(req); } catch { vbody = {}; }
        const override = vbody && typeof vbody.apiKey === 'string' ? vbody.apiKey.trim() : '';
        const cfg = override
          ? { ...runtime.config, vision: { ...(runtime.config.vision || {}), apiKey: override } }
          : runtime.config;
        try {
          const text = await vision.describe(cfg, {
            imageBase64: vision.TEST_IMAGE,
            mime: 'image/png',
            prompt: '这张图是什么颜色？只回答颜色。',
          });
          return json(res, 200, { ok: true, sample: String(text || '').slice(0, 60), vision: vision.status(runtime.config) });
        } catch (err) {
          return json(res, 500, { ok: false, error: String((err && err.message) || err), vision: vision.status(runtime.config) });
        }
      }

      if (pathname === '/api/vision' && method === 'POST') {
        try {
          const body = await readBody(req);
          const text = await vision.describe(runtime.config, {
            imageBase64: body && body.image,
            mime: (body && body.mime) || 'image/jpeg',
            prompt: (body && body.prompt) || '',
          });
          return json(res, 200, { ok: true, text });
        } catch (err) {
          runtime.logger.warn('图片识别失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/share' && method === 'GET') {
        try {
          const share = await shareForChat(runtime, url.searchParams.get('chat') || '');
          return json(res, 200, share);
        } catch (err) {
          runtime.logger.warn('挑视频失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/digest' && method === 'GET') {
        const q = new URL(req.url, 'http://localhost');
        const since = Number(q.searchParams.get('since') || 0);
        const items = runtime.store.listDigest(since).slice(-120);
        return json(res, 200, buildDigest(items));
      }

      if (pathname === '/api/persona' && method === 'GET') {
        return json(res, 200, { ok: true, persona: personaStore.summary(runtime.config), llm: { provider: runtime.llm.provider, providerLabel: runtime.llm.providerLabel, model: runtime.llm.model, mock: runtime.llm.isMock } });
      }
      if (pathname === '/api/persona' && method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, applyPersonaPatch(runtime, body));
      }
      // 人设预设：personas/ 下每个版本一个文件
      if (pathname === '/api/persona/presets' && method === 'GET') {
        return json(res, 200, { ok: true, presets: presets.list(runtime.config) });
      }
      if (pathname === '/api/persona/preset' && method === 'POST') {
        const body = await readBody(req);
        const preset = presets.load(runtime.config, body && body.id);
        if (!preset) return json(res, 404, { ok: false, error: '没有这个人设预设' });
        const patch = presets.toPatch(preset);
        if (!patch) return json(res, 400, { ok: false, error: '这个人设预设是空的' });
        // 记下来源，页面上能直接看到「现在用的是哪一版」
        patch.sourcePreset = preset.id;
        personaStore.save(runtime.config, patch);
        runtime.logger.info(`人设预设：已导入 ${preset.id}（${preset.version || '无版本号'}）`);
        return json(res, 200, {
          ok: true,
          applied: { id: preset.id, version: preset.version || '', name: preset.name || '' },
          persona: personaStore.summary(runtime.config),
        });
      }

      if (pathname === '/api/config') {
        if (method === 'GET') {
          const pub = publicConfig(runtime.config);
          return json(res, 200, {
            ok: true,
            config: pub.config,
            secrets: pub.secrets,
            configFile: runtime.config.paths.configFile,
            settingsFile: runtime.config.paths.settingsFile,
          });
        }
        if (method === 'POST') {
          const body = await readBody(req);
          try {
            const out = applyConfigPatch(runtime, body && body.patch);
            const pub = publicConfig(runtime.config);
            return json(res, 200, {
              ok: true,
              changed: out.changed,
              clearedSettings: out.cleared,
              config: pub.config,
              secrets: pub.secrets,
              status: statusPayload(runtime),
            });
          } catch (err) {
            return json(res, 400, { ok: false, error: String((err && err.message) || err) });
          }
        }
        return json(res, 405, { ok: false, error: 'method not allowed' });
      }

      if (pathname === '/api/debug/state' && method === 'GET') {
        return json(res, 200, debugState(runtime));
      }
      if (pathname === '/api/debug/sessions' && method === 'GET') {
        return json(res, 200, { ok: true, sessions: debugSessions(runtime) });
      }
      if (pathname === '/api/debug/prompt' && method === 'POST') {
        const body = await readBody(req);
        return json(res, 200, await debugPrompt(runtime, body));
      }
      if (pathname === '/api/debug/reset' && method === 'POST') {
        const body = await readBody(req);
        if (!body.key) return json(res, 400, { ok: false, error: '缺少 key' });
        runtime.store.resetSession(String(body.key));
        runtime.logger.info('调试台清空了会话记忆：' + String(body.key));
        return json(res, 200, { ok: true });
      }

      // 主动搭话：桥接定时来问「现在该不该发」（时间窗 / 频率 / 每日上限都在 src/care.js 里算）
      if (pathname === '/api/care/due' && method === 'GET') {
        const cq = new URL(req.url, 'http://localhost');
        const last = Number(cq.searchParams.get('last') || 0);
        const sentToday = Number(cq.searchParams.get('sentToday') || 0);
        const out = care.careDue(runtime.config, {
          lastSentTs: Number.isFinite(last) && last > 0 ? last : 0,
          sentToday: Number.isFinite(sentToday) ? sentToday : 0,
        });
        return json(res, 200, { ok: true, ...out });
      }

      // 主动搭话：生成那句关心的话（带最近聊天上下文，避免每次同一句）
      if (pathname === '/api/care' && method === 'GET') {
        try {
          const cq = new URL(req.url, 'http://localhost');
          const out = await careForChat(runtime, cq.searchParams.get('chat') || '');
          return json(res, 200, out);
        } catch (err) {
          runtime.logger.warn('生成搭话失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/chat' && method === 'POST') {
        return await handleChat(runtime, req, res);
      }

      if (pathname === '/api/reset' && method === 'POST') {
        const body = await readBody(req);
        const sessionId = sanitizeId(body.sessionId || 'default');
        if (body.all) {
          runtime.store.resetAll();
        } else {
          const mode = body.mode === 'group' ? 'group' : 'private';
          runtime.store.resetSession(`web:${mode === 'group' ? 'g' : 'u'}:${sessionId}:${mode}`);
        }
        return json(res, 200, { ok: true });
      }

      if (pathname === '/api/memory' && method === 'GET') {
        const sessionId = sanitizeId(url.searchParams.get('sessionId') || 'default');
        const mode = url.searchParams.get('mode') === 'group' ? 'group' : 'private';
        const key = `web:${mode === 'group' ? 'g' : 'u'}:${sessionId}:${mode}`;
        const sessions = {
          private: runtime.store.listNotes(`web:u:${sessionId}:private`),
          group: runtime.store.listNotes(`web:g:${sessionId}:group`),
        };
        return json(res, 200, { ok: true, key, notes: sessions[mode], all: sessions, summary: storeSummary(runtime) });
      }

      if (pathname === '/api/vision' && method === 'POST') {
        try {
          const body = await readBody(req);
          const text = await vision.describe(runtime.config, {
            imageBase64: body && body.image,
            mime: (body && body.mime) || 'image/jpeg',
            prompt: (body && body.prompt) || '',
          });
          return json(res, 200, { ok: true, text });
        } catch (err) {
          runtime.logger.warn('图片识别失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/share' && method === 'GET') {
        try {
          const share = await shareForChat(runtime, url.searchParams.get('chat') || '');
          return json(res, 200, share);
        } catch (err) {
          runtime.logger.warn('挑视频失败：' + (err && err.message));
          return json(res, 500, { ok: false, error: String((err && err.message) || err) });
        }
      }

      if (pathname === '/api/digest' && method === 'GET') {
        const q = new URL(req.url, 'http://localhost');
        const since = Number(q.searchParams.get('since') || 0);
        const items = runtime.store.listDigest(since).slice(-120);
        return json(res, 200, buildDigest(items));
      }

      if (pathname === '/api/persona' && method === 'GET') {
        return json(res, 200, {
          ok: true,
          name: config.persona.name,
          aliases: config.persona.aliases,
          moods: persona.MOODS.map((m) => m.name),
          greeting: '在，咋啦？今天想聊点啥',
        });
      }

      // 桥接心跳：让网页知道「桥接在不在、UIA 通不通」。没这个，服务端只能看到
      // 「我收到了消息」，根本不知道回复有没有可能发出去。
      if (pathname === '/api/bridge/heartbeat' && method === 'POST') {
        const hb = await readBody(req);
        const platform = String((hb && hb.platform) || 'wechat').toLowerCase();
        const gw = gateways.get(platform);
        if (!gw) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });
        if (!gw.verifyToken(req, hb)) return json(res, 403, { ok: false, error: 'token 不对' });
        return json(res, 200, gw.heartbeat(hb));
      }

      const webhookMatch = pathname.match(/^\/webhook\/([a-zA-Z]+)$/);
      if (webhookMatch) {
        const platform = webhookMatch[1].toLowerCase();
        const gateway = gateways.get(platform);
        if (!gateway) return json(res, 404, { ok: false, error: `未知平台 ${platform}` });
        if (method === 'GET') {
          if (!gateway.verifyToken(req, null)) return json(res, 403, { ok: false, error: 'token 不对' });
          const challenge = url.searchParams.get('challenge') || url.searchParams.get('echostr');
          if (challenge) {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end(challenge);
          }
          return json(res, 200, gateway.status());
        }
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
        const body = await readBody(req);
        if (!gateway.verifyToken(req, body)) {
          logger.warn(`[${platform}] webhook token 校验失败`);
          return json(res, 403, { ok: false, error: 'token 不对' });
        }
        if (!gateway.options.enabled) {
          return json(res, 200, { ok: true, skipped: 'adapter_disabled' });
        }
        // 本地桥接会带 x-whale-bridge: 1（或 body.local=true）。它靠 HTTP 响应拿回复，
        // 所以「没配 outboundUrl」对它是正常的，不该按「发不出去」报警。
        const isLocalBridge = String(req.headers['x-whale-bridge'] || '') === '1' || Boolean(body && body.local);
        const result = await gateway.handleInbound(body, { local: isLocalBridge });
        return json(res, 200, result);
      }

      if (method === 'GET' || method === 'HEAD') return serveStatic(runtime, req, res, pathname);
      return json(res, 404, { ok: false, error: 'not found' });
    } catch (err) {
      const status = err.statusCode || 500;
      logger.error(`${method} ${pathname} 出错：` + (err && err.stack ? err.stack : err));
      if (status === 500) return json(res, 500, { ok: false, error: '服务器打了个结，请看控制台日志' });
      return json(res, status, { ok: false, error: err.message });
    }
  };
}

/* ------------------------------------------------------------------ */
/* 启动 / 停止                                                         */
/* ------------------------------------------------------------------ */

function openBrowser(url, logger) {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err && logger) logger.warn('没能自动打开浏览器，请手动访问：' + url);
  });
}

async function startServer({ root = projectRoot(), env = process.env, port, host, openBrowser: shouldOpen } = {}) {
  const runtime = createRuntime({ root, env });
  const { config, logger } = runtime;
  const handler = createHandler(runtime);
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((err) => {
      logger.error('未捕获错误：' + (err && err.stack ? err.stack : err));
      try { json(res, 500, { ok: false, error: 'internal error' }); } catch { /* ignore */ }
    });
  });
  server.keepAliveTimeout = 5000;

  // 注意：port = 0 是「让系统分配随机端口」，不能被 || 吞掉
  const requestedPort = port !== undefined && port !== null ? Number(port) : Number(config.server.port);
  const listenPort = Number.isFinite(requestedPort) && requestedPort >= 0 && requestedPort <= 65535 ? requestedPort : 8787;
  const listenHost = host || config.server.host || '127.0.0.1';
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(listenPort, listenHost, resolve);
  });
  const actualPort = server.address().port;
  const url = `http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // SSE / keep-alive 连接会让 server.close() 一直等，先强制断开空闲连接
    try { if (server.closeIdleConnections) server.closeIdleConnections(); } catch { /* ignore */ }
    setTimeout(() => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch { /* ignore */ }
    }, 300).unref?.();
    await new Promise((resolve) => server.close(resolve));
    runtime.store.close();
    logger.close();
  };
  server.on('close', () => {
    runtime.store.close();
  });

  const open = shouldOpen === undefined ? Boolean(config.server.openBrowser) : shouldOpen;
  if (open) setTimeout(() => openBrowser(url, logger), 400);

  return { server, runtime, port: actualPort, host: listenHost, url, close };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

function replyChannelLabel(config) {
  const g = (config.gateway && config.gateway.wechat) || {};
  if (g.outboundUrl) return `中转网关 ${g.outboundUrl}`;
  return '本地桥接（要另开一个「启动微信桥接.bat」窗口，回复才发得出去）';
}

function printBanner(runtime, url) {
  const { llm, config } = runtime;
  const lines = [
    '',
    '  🐋  鲸鲸 · 深海聊天机器人  ',
    `  版本：       v${runtime.version}`,
    '  ────────────────────────────────────────────',
    `  网页聊天：   ${url}`,
    `  运行模式：   ${llm.isMock ? '演示模式（还没配置模型，用内置台词）' : `${llm.providerLabel} · ${llm.model}`}`,
    `  模型服务：   ${llm.providerLabel}${llm.needsKey ? (llm.apiKey ? '（Key 已配置）' : '（未填 Key）') : '（本地/免 Key）'}`,
    `  记忆文件：   ${config.paths.storeFile}`,
    `  回复发送：   ${replyChannelLabel(config)}`,
    `  接入微信：   POST ${url}/webhook/wechat   （见 docs/接入微信.md）`,
    `  接入抖音：   POST ${url}/webhook/douyin   （见 docs/接入抖音.md）`,
    '  ────────────────────────────────────────────',
    '  按 Ctrl+C 停止',
    '',
  ];
  console.log(lines.join('\n'));
}

function runDoctor() {
  const root = projectRoot();
  ensureConfigFile(root);
  const config = loadConfig({ root });
  const rt = resolveRuntime(config);
  const checks = [];
  const push = (name, ok, detail) => checks.push({ name, ok, detail });

  push('Node 版本', parseInt(process.version.slice(1), 10) >= 18, process.version);
  push('web 目录', fs.existsSync(path.join(root, 'web', 'index.html')), path.join(root, 'web', 'index.html'));
  push('config.json', fs.existsSync(config.paths.configFile), config.paths.configFile);
  push(
    '模型服务',
    !rt.mock || !rt.needsKey,
    `${rt.providerLabel} · ${rt.model}${rt.needsKey ? (rt.apiKey ? '（Key 已配置）' : '（未填 Key → 演示模式，可在设置里换免费模型）') : '（本地/免 Key，不需要 Key）'}`
  );
  push('API Key', Boolean(rt.apiKey) || !rt.needsKey, rt.apiKey ? maskKey(rt.apiKey) + '（来自设置/配置/环境变量）' : rt.needsKey ? '未配置' : '不需要');
  try {
    fs.mkdirSync(config.paths.dataDir, { recursive: true });
    const probe = path.join(config.paths.dataDir, '.write-test');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    push('数据目录可写', true, config.paths.dataDir);
  } catch (err) {
    push('数据目录可写', false, err.message);
  }
  push('端口可用', true, `${config.server.host}:${config.server.port}（启动时会再确认）`);
  for (const [platform, gw] of Object.entries(config.gateway || {})) {
    push(
      `${platform} 网关`,
      Boolean(gw && gw.enabled),
      gw && gw.enabled ? (gw.outboundUrl ? `outbound: ${gw.outboundUrl}` : '已启用，但未配置 outboundUrl（只打印不发送）') : '未启用（可在 config.json 里开启）'
    );
  }
  console.log('\n🐋 鲸鲸 · 环境自检\n');
  for (const c of checks) console.log(`  ${c.ok ? '✅' : '⚠️ '} ${c.name.padEnd(12, ' ')} ${c.detail}`);
  console.log('\n提示：没有 Key 也能启动——网页里可以选免费的智谱 GLM-4-Flash，或本地 Ollama，全程不花钱。\n');
  return checks.every((c) => c.ok);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--doctor') || args.includes('doctor')) {
    runDoctor();
    process.exit(0);
  }
  if (args.includes('--debug-info')) {
    const rt = createRuntime({});
    console.log(JSON.stringify({ state: debugState(rt), sessions: debugSessions(rt) }, null, 2));
    rt.store.close();
    process.exit(0);
  }
  const portArg = args.find((a) => /^--port=\d+$/.test(a));
  const port = portArg ? Number(portArg.split('=')[1]) : undefined;
  const noBrowser = args.includes('--no-browser');

  let instance;
  try {
    instance = await startServer({ port, openBrowser: noBrowser ? false : undefined });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n❌ 端口被占用了（${err.port || '默认端口'}）。换个端口：node server.js --port=8788\n`);
    } else {
      console.error('\n❌ 启动失败：', err && err.stack ? err.stack : err, '\n');
    }
    process.exit(1);
  }
  printBanner(instance.runtime, instance.url);
  instance.runtime.logger.info(`服务已启动 ${instance.url}，模式=${instance.runtime.llm.isMock ? '演示' : '真实 API'}`);

  const shutdown = async () => {
    console.log('\n🌊 鲸鲸要潜回深海了…');
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main();
}

module.exports = { startServer, createRuntime, createHandler, statusPayload, applySettings, VERSION };
