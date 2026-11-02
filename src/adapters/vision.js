'use strict';

/**
 * 图片理解：把图片交给视觉模型（默认智谱 GLM-4.6V-Flash，免费）。
 * 返回详细描述（截图会逐条转写文字），交给聊天模型接着聊。
 *
 * Key 的查找顺序（以前只认第一个，导致「网页里填了却一直说没配」）：
 *   1. config.json 的 vision.apiKey
 *   2. data/settings.json 的 visionApiKey（网页「设置」里填的就是这个）
 *   3. data/settings.json 的 keys.vision
 *   4. data/settings.json 的 keys.zhipu（用智谱聊天时同一把 Key 也能看图）
 *   5. 环境变量 ZHIPU_API_KEY / VISION_API_KEY
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { resolveVisionConfig, resolveRuntime, isLocalUrl, PROVIDERS } = require('../infra/config');

/** OpenCode Go 要求的稳定会话号（和 src/llm/client.js 用同一套规则） */
const VISION_SESSION = 'whale-girl-' + crypto.randomBytes(12).toString('hex');

/** 64x64 纯色 PNG，用来做「测试看图」（不联网也能构造，不依赖外部资源） */
const TEST_IMAGE = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfRYAYzliH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBzStBhzKy9ToAAAAASUVORK5CYII=';

function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 10) return s.slice(0, 2) + '****';
  return s.slice(0, 5) + '****' + s.slice(-4);
}

/** 读 data/settings.json 里可能存 Key 的几个地方 */
function settingsKeys(config) {
  try {
    const file = config && config.paths && config.paths.settingsFile;
    if (!file) return {};
    const st = JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, '')) || {};
    const keys = st.keys || {};
    const provider = String(st.provider || '').trim();
    return {
      keys,
      visionApiKey: String(st.visionApiKey || '').trim(),
      visionProvider: String(st.visionProvider || '').trim(),
      vision: String(keys.vision || '').trim(),
      zhipu: String(keys.zhipu || '').trim(),
      provider,
      providerKey: provider ? String(keys[provider] || '').trim() : '',
      // visionAuto=true：看图模型是自动跟随聊天模型的，Key 也该用同一家的
      auto: st.visionAuto === true,
    };
  } catch {
    return {};
  }
}

/** 真正生效的看图 Key（本地/内网看图服务可以没有 Key） */
function resolveKey(config) {
  const v = (config && config.vision) || {};
  const st = settingsKeys(config);
  const vc = resolveVisionConfig(config);
  // 自动模式（跟随聊天模型 / 用本服务商默认看图模型）时，用聊天那把 Key：
  // 用户的 provider 可能只写在 config.json 里、settings.json 没有 provider 字段，
  // 只看 keys[provider] 会误报「没有填 API Key」——这正是「自动后测试还失败」的根因。
  if (vc.auto) {
    try {
      const runtimeKey = String(resolveRuntime(config).apiKey || '').trim();
      if (runtimeKey) return runtimeKey;
    } catch { /* 取不到运行时再退回下面的查找链 */ }
    if (st.providerKey) return st.providerKey;
  }
  const fromConfig = String(v.apiKey || '').trim();
  if (fromConfig) return fromConfig;
  if (st.visionApiKey) return st.visionApiKey;
  if (st.vision) return st.vision;
  // 手动指定了服务商（或从模型名能认出是哪家）时，用那家已存过的 Key：
  // 否则「只有 DeepSeek Key、手动选 deepseek-flash」还会报没 Key。
  if (!vc.auto) {
    // 自定义看图接口：地址和聊天模型完全一样时，直接复用聊天那把 Key ——
    // 「从聊天复制」只搬地址和模型，不用把同一把密钥在 settings.json 里再存一份；
    // 只有同一家（地址一致）才这样，免得把聊天 Key 发给别的服务。
    if (String(vc.provider || '').trim() === 'custom') {
      try {
        const rt = resolveRuntime(config);
        const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
        if (rt.apiKey && norm(rt.baseUrl) === norm(vc.baseUrl)) return rt.apiKey;
      } catch { /* 取不到运行时配置就继续按下面的一般查找链走 */ }
    }
    const wanted = String(vc.provider || st.visionProvider || '').trim();
    if (wanted && st.keys) {
      const key = String(st.keys[wanted] || '').trim();
      if (key) return key;
    }
    const owner = Object.entries(PROVIDERS || {}).find(([, p]) => (p.visionModels || []).includes(vc.model));
    if (owner) {
      const key = String((st.keys && st.keys[owner[0]]) || '').trim();
      if (key) return key;
    }
  }
  const env = (config && config.env) || process.env || {};
  const fromEnv = String(env.ZHIPU_API_KEY || env.VISION_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return st.zhipu || '';
}

/** 给网页/状态接口看的摘要（绝不返回明文 Key） */
function status(config) {
  const v = resolveVisionConfig(config);
  const key = resolveKey(config);
  const baseUrl = String(v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4');
  const model = String(v.model || 'glm-4.6v-flash');
  const local = isLocalUrl(baseUrl);
  const provider = String(v.provider || (v.auto ? (() => {
    try { return resolveRuntime(config).provider || ''; } catch { return ''; }
  })() : '') || '');
  const custom = provider === 'custom';
  const hint = custom
    ? '自定义接口：' + baseUrl + ' · ' + model + (local ? '（本机/内网，免 Key）' : '')
    : v.manual
      ? '已手动指定：' + model + '（用这个模型对应服务商的 Key）'
      : v.auto
        ? '自动：用当前服务商的看图模型 ' + model + '（复用同一把 Key）'
        : '默认智谱 ' + model + '（在 open.bigmodel.cn 申请的 Key）';
  return {
    configured: Boolean(key) || local,
    keyMasked: maskKey(key),
    model,
    baseUrl,
    // manual=false：没手动选过，正在自动挑本服务商的看图模型。
    manual: Boolean(v.manual),
    auto: Boolean(v.auto),
    // 自定义接口：启动器据此显示「接口地址」输入框（而不是只读的预设地址）
    custom,
    provider,
    local,
    hint,
  };
}

const DEFAULT_PROMPT = [
  '把这张图看清，用纯文本回答（不要 JSON、不要 markdown 代码块）：',
  '1. 如果是微信截图：只看气泡位置判断说话人——左边气泡一律写「对方：」，右边绿色气泡一律写「本人：」，不要根据内容猜谁是谁，也不要把气泡里的「主人」「鲸鲸」当成说话人标签。',
  '2. 逐条转写文字，顺序从上到下；顶部的群名、时间、未读数、电量也写出来。',
  '3. 如果是其他截图：把界面上的按钮、数字、标题按位置简单说清。照片或表情包：说清主体、场景、动作、画面里的字。',
  '最后一行用一句话总结这张图在说什么。',
  '看不清的字写「模糊」，绝对不要编造。截图里每一条消息都要写到：不要省略、不要合并、不要只写大意。',
  '总长度控制在 900 字以内；宁可条目短一点，也不要漏掉人和话。',
].join('\n');

/**
 * OpenCode Go（opencode.ai）的请求要求客户端自报身份 + 一个稳定会话号：
 *   不带 UA → Cloudflare 直接拦（HTTP 403 error code 1010）；
 *   带 UA 但缺会话头 → HTTP 400 "Request is missing x-opencode-session"。
 * 聊天链路 src/llm/client.js 早就加了这两个头，看图这边漏了——表现就是
 * 「聊天正常，但图片/表情包一直识别失败」。其它服务商（智谱 / DeepSeek /
 * Ollama / 自建）原样返回，一个额外头都不加。
 */
function requestHeaders(url, headers) {
  const next = { ...headers };
  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    return next;
  }
  if (/(^|\.)opencode\.ai$/i.test(hostname)) {
    next['x-opencode-session'] = VISION_SESSION;
    next['User-Agent'] = 'whale-girl/3.54';
  }
  return next;
}

function postJson(url, body, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(new Error('看图接口地址不合法：' + url));
      return;
    }
    // 以前写死 https.request 也不传端口：本地 http 视觉服务（127.0.0.1:11434）
    // 和自定义端口（https://host:8443）都会连到 443 上失败。
    const isHttps = u.protocol === 'https:';
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: requestHeaders(url, {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        }),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(raw) });
          } catch {
            // 不是 JSON（填错地址指到网页、被网关拦下返回 HTML、代理回错误页…）：
            // 以前直接把 JSON.parse 的英文异常抛出去，界面上就是一串看不懂的字符。
            const snippet = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
            const err = new Error(
              '看图接口返回的不是 JSON（HTTP ' + res.statusCode + '）' +
              (snippet ? '：' + snippet : '；检查一下「接口地址」是不是填成了网页地址')
            );
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * 按文件头判断真实图片格式。
 * 微信 4.x 的图片常是 HEVC(wxgf) 或 webp，桥接里扩展名/mime 经常和真实内容对不上，
 * 智谱那边就会回「图片输入格式/解析错误」——所以以字节为准。
 */
function sniffMime(imageBase64) {
  const b64 = String(imageBase64 || '').replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  let buf;
  try {
    buf = Buffer.from(b64.slice(0, 32), 'base64');
  } catch {
    return '';
  }
  if (!buf || buf.length < 12) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.slice(0, 4).toString('ascii') === 'wxgf') return 'image/wxgf'; // 微信私有容器，视觉接口不收
  return '';
}

async function describe(config, { imageBase64, mime = 'image/jpeg', prompt = '' } = {}) {
  const v = resolveVisionConfig(config);
  const baseUrl = String(v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const apiKey = resolveKey(config);
  const model = String(v.model || 'glm-4.6v-flash').trim();
  if (!imageBase64) throw new Error('没有图片数据');
  // 本机/内网的看图服务（Ollama、LM Studio、自建）不需要 Key；云端仍然必须有
  const local = isLocalUrl(baseUrl);
  if (!apiKey && !local) {
    throw new Error(
      '看图没有 Key：在「模型与 Key」里把聊天模型换成能看图的（deepseek-flash / glm-4.6v-flash / ' +
      'qwen3.8-max 等），或者到网页设置里填「看图 API Key」' +
      '（默认智谱 GLM-4.6V-Flash，Key 在 open.bigmodel.cn 申请，免费额度够用）'
    );
  }
  // 以真实文件头为准；wxgf（微信 HEVC 容器）视觉接口不认，提前说清楚
  const realMime = sniffMime(imageBase64) || mime || 'image/jpeg';
  if (realMime === 'image/wxgf') {
    throw new Error('这张图是微信的 wxgf/HEVC 私有格式，需要本机有 ffmpeg 才能转成图片；请检查桥接启动日志里有没有「找到 ffmpeg」');
  }
  const cleanB64 = String(imageBase64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${realMime};base64,${cleanB64}` } },
          { type: 'text', text: prompt || DEFAULT_PROMPT },
        ],
      },
    ],
    temperature: 0.1,
    // 智谱 GLM-4V 系列 max_tokens 上限就是 1024（超了直接 400），
    // 别的服务商可以给多一些；要改也可以写 config.json 的 vision.maxTokens
    max_tokens: Number(v.maxTokens) || (/bigmodel\.cn/i.test(baseUrl) ? 1024 : 1600),
  };

  const headers = apiKey ? { Authorization: 'Bearer ' + apiKey } : {};
  const resp = await postJson(baseUrl + '/chat/completions', body, headers, Number(v.timeoutMs) || 30000);
  if (resp.status !== 200) {
    const msg = (resp.json && resp.json.error && (resp.json.error.message || resp.json.error.code)) || ('HTTP ' + resp.status);
    // 401/403 基本都是 Key 不对：跟随模式下要用聊天模型那家服务商的 Key
    const hint = resp.status === 401 || resp.status === 403
      ? '（Key 无效或没有看图权限：跟随聊天模型时要用同一家服务商的 Key；手动指定智谱视觉模型则要 open.bigmodel.cn 的 Key）'
      : resp.status === 402
        ? '（账户余额不足：看图用的是同一家服务商的额度，充值后重试，或换成有免费额度的智谱 GLM-4.6V-Flash）'
        : resp.status === 404
        ? '（模型名这家服务商不认：自动模式下用的是当前聊天服务商的看图模型，可以手动换一个）'
        : resp.status === 400
          ? '（可能是这个模型不支持图片输入：在「看图」里手动换成本服务商支持看图的模型再试）'
          : '';
    throw new Error('视觉模型返回：' + msg + hint);
  }
  const text =
    resp.json &&
    resp.json.choices &&
    resp.json.choices[0] &&
    resp.json.choices[0].message &&
    resp.json.choices[0].message.content;
  return String(text || '').trim();
}

module.exports = { describe, resolveKey, status, TEST_IMAGE, maskKey, sniffMime, requestHeaders };
