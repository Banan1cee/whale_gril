'use strict';

/**
 * 图片理解：把图片交给视觉模型（默认智谱 GLM-4V-Flash，免费）。
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
const https = require('node:https');

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
    return {
      visionApiKey: String(st.visionApiKey || '').trim(),
      vision: String(keys.vision || '').trim(),
      zhipu: String(keys.zhipu || '').trim(),
    };
  } catch {
    return {};
  }
}

/** 真正生效的看图 Key */
function resolveKey(config) {
  const v = (config && config.vision) || {};
  const fromConfig = String(v.apiKey || '').trim();
  if (fromConfig) return fromConfig;
  const st = settingsKeys(config);
  if (st.visionApiKey) return st.visionApiKey;
  if (st.vision) return st.vision;
  const env = (config && config.env) || process.env || {};
  const fromEnv = String(env.ZHIPU_API_KEY || env.VISION_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  return st.zhipu || '';
}

/** 给网页/状态接口看的摘要（绝不返回明文 Key） */
function status(config) {
  const v = (config && config.vision) || {};
  const key = resolveKey(config);
  const baseUrl = String(v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4');
  return {
    configured: Boolean(key),
    keyMasked: maskKey(key),
    model: String(v.model || 'glm-4v-flash'),
    baseUrl,
    // 用 DeepSeek 的 Key 看图是通不了的：DeepSeek 没有视觉接口
    hint: /bigmodel\.cn/i.test(baseUrl)
      ? '默认智谱 GLM-4V-Flash（open.bigmodel.cn 的 Key，免费额度够用）'
      : '按接口地址填对应服务商的 Key',
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

function postJson(url, body, headers, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch (err) {
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
  const v = (config && config.vision) || {};
  const baseUrl = String(v.baseUrl || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
  const apiKey = resolveKey(config);
  const model = String(v.model || 'glm-4v-flash').trim();
  if (!imageBase64) throw new Error('没有图片数据');
  if (!apiKey) {
    throw new Error(
      '看图没有 Key：网页右上角「设置」→ 填「看图 API Key」' +
      '（默认智谱 GLM-4V-Flash，Key 在 open.bigmodel.cn 申请，免费额度够用；' +
      'DeepSeek 的 Key 不能看图）'
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

  const resp = await postJson(baseUrl + '/chat/completions', body, { Authorization: 'Bearer ' + apiKey }, Number(v.timeoutMs) || 30000);
  if (resp.status !== 200) {
    const msg = (resp.json && resp.json.error && (resp.json.error.message || resp.json.error.code)) || ('HTTP ' + resp.status);
    // 401/403 基本都是 Key 不对。很多人把 DeepSeek 的 Key 填到这里——DeepSeek 没有看图接口
    const hint = resp.status === 401 || resp.status === 403
      ? '（Key 无效或没有看图权限：这里要 open.bigmodel.cn 的智谱 Key，DeepSeek 的 Key 不支持看图）'
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

module.exports = { describe, resolveKey, status, TEST_IMAGE, maskKey, sniffMime };
