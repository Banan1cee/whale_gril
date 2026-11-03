'use strict';

/**
 * 实测「system 静态化」前后的前缀缓存命中情况（私聊 / 群聊各 3 轮）。
 *
 * 为什么要单独跑：cacheHitTokens 只有服务商返回的 usage 才有，本地估算看不出前缀
 * 到底命没命中。这个脚本走真实接口，两种开关各跑一遍，结果可以直接贴进 PR。
 *
 * 用法（Key 只从环境变量 / 参数读，不落盘）：
 *   set OPENCODE_API_KEY=oc_sk_xxx      # OpenCode Go
 *   node scripts/measure-cache-hit.js --provider opencode --rounds 3
 *
 *   set DEEPSEEK_API_KEY=sk-xxx         # 官方 DeepSeek
 *   node scripts/measure-cache-hit.js --rounds 3
 *
 *   node scripts/measure-cache-hit.js --key=sk-xxx --model deepseek-chat --out measure.md
 *
 * 说明：
 *   - 3 轮 × 2 种开关 × 私聊/群聊，max_tokens 给 40，成本可忽略；
 *   - 每个场景加一个随机「测试会话」标记，避免 4 个场景互相吃到对方的缓存；
 *   - 轮间默认等 15 秒：前缀缓存是异步建立的，贴太近会测出假的 0；
 *   - 缓存命中口径依次取 `prompt_cache_hit_tokens`（DeepSeek 原生）、
 *     `prompt_tokens_details.cached_tokens`（OpenAI 兼容 / OpenCode Go）、
 *     `opencode.tokens.cache_read`（OpenCode Go 的账单字段）。
 */

const path = require('node:path');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const crypto = require('node:crypto');

const persona = require('../src/persona');
const { buildTurns } = require('../src/core/context');
const { loadConfig, resolveRuntime } = require('../src/infra/config');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = '') {
  const hit = process.argv.slice(2).find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] || fallback;
}

const ROUNDS = Math.max(1, Math.min(10, Number(arg('rounds', 3)) || 3));
const GAP_MS = Math.max(0, Math.min(60000, Number(arg('gap', 15000)) || 0));
const MODEL = String(arg('model', '') || '').trim();
const OUT = String(arg('out', '') || '').trim();
const PROVIDER = String(arg('provider', '') || '').trim();
const KEY = String(arg('key', '') || process.env.OPENCODE_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim();

const TEXTS = {
  private: ['在吗', '今天有点累，老板又加活了', '你说我要不要换个工作'],
  group: ['@鲸鲸 今天加班好累', '@鲸鲸 你说我该不该换工作', '@鲸鲸 那你觉得呢'],
};
const MEMORY = '【这个聊天里的 TA】小海：怕黑、在写毕业论文。\n【相关事件】昨天聊过加班。\n【这段之前聊过】加班、论文、周末去哪。';

function configFor(staticSystem) {
  const config = loadConfig({ root: ROOT, env: process.env });
  config.features = { ...(config.features || {}), staticSystem };
  if (PROVIDER) config.provider = PROVIDER;
  // Key 只挂内存里，不写 settings.json
  config.llm = { ...(config.llm || {}), apiKey: KEY };
  if (MODEL) config.llm.model = MODEL;
  return config;
}

function postJson(urlString, payload, headers, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Accept: 'application/json',
        ...headers,
      },
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}：${raw.slice(0, 300)}`));
          return;
        }
        try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('返回不是 JSON：' + raw.slice(0, 200))); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(body);
  });
}

function cachedTokens(usage = {}) {
  // 取第一个 >0 的字段：OpenCode Go 账单 > OpenAI 兼容 cached_tokens > DeepSeek 原生。
  // 不能用 ?? 链：有些服务商会把 prompt_cache_hit_tokens 显式填 0，会把后面的字段短路掉。
  const n = Number(usage.opencode && usage.opencode.tokens && usage.opencode.tokens.cache_read)
    || Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens)
    || Number(usage.prompt_cache_hit_tokens)
    || 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function runScenario({ runtime, chatType, staticSystem, sessionId }) {
  const config = configFor(staticSystem);
  const resolved = resolveRuntime(config);
  const isGroup = chatType === 'group';
  const nonce = crypto.randomBytes(4).toString('hex');
  const now = new Date();
  const history = [];
  const rows = [];

  const headers = { Authorization: 'Bearer ' + resolved.apiKey };
  if (/(^|\.)opencode\.ai$/i.test(new URL(resolved.baseUrl).hostname)) {
    headers['x-opencode-session'] = sessionId;
    headers['User-Agent'] = 'whale-girl/' + (require('../package.json').version || '4.0');
  }
  const endpoint = resolved.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  for (let round = 1; round <= ROUNDS; round += 1) {
    const ts = now.getTime() + round * 60000;
    const msg = {
      platform: 'wechat',
      chatId: isGroup ? 'g-measure' : 'p-measure',
      chatType,
      chatTitle: isGroup ? '深海鱼塘' : '',
      senderId: isGroup ? 'u-' + round : 'u-measure',
      senderName: isGroup ? ['阿螈', '小海', '阿螈'][round - 1] || '阿螈' : '小海',
      text: TEXTS[chatType][round - 1] || TEXTS[chatType][TEXTS[chatType].length - 1],
      ts,
      atMe: isGroup,
      addressedToBot: isGroup,
      mentionedNames: [],
      groupParticipants: isGroup ? ['阿螈', '小海'] : [],
      model: resolved.model,
    };
    const parts = persona.buildPromptParts({ config, msg, profile: { count: round }, notes: [], now: new Date(ts) });
    // 独立标记：4 个场景的 system 前缀互不相同，免得互相吃缓存
    const system = `【测试会话 ${nonce}】\n` + parts.system;
    const turns = buildTurns(msg, history, MEMORY, parts.tail);
    const body = await postJson(endpoint, {
      model: resolved.model,
      messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.content }))],
      max_tokens: 40,
      stream: false,
    }, headers);
    const usage = body.usage || {};
    const prompt = Number(usage.prompt_tokens) || 0;
    const cached = cachedTokens(usage);
    rows.push({ round, prompt, cached, systemChars: system.length, tailChars: parts.tail.length });
    history.push({ role: 'user', name: msg.senderName, uid: msg.senderId, text: msg.text, ts });
    history.push({ role: 'assistant', text: '嗯，我在听。' });
    if (round < ROUNDS && GAP_MS) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return { rows, model: resolved.model, provider: resolved.provider };
}

async function main() {
  if (!KEY) {
    console.log('没有 Key，跳过实测。用法：');
    console.log('  set OPENCODE_API_KEY=oc_sk_xxx   （或 DEEPSEEK_API_KEY）');
    console.log('  node scripts/measure-cache-hit.js --provider opencode --rounds 3');
    return;
  }
  const sessionId = 'whale-girl-' + crypto.randomBytes(8).toString('hex');
  const lines = ['# 前缀缓存实测（私聊 / 群聊各 ' + ROUNDS + ' 轮）', ''];
  lines.push('| 场景 | 轮次 | prompt_tokens | cacheHitTokens | cache_miss | 命中率 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  let meta = '';

  for (const staticSystem of [false, true]) {
    for (const chatType of ['private', 'group']) {
      const label = (chatType === 'private' ? '私聊' : '群聊') + (staticSystem ? '（静态 system）' : '（旧行为）');
      const { rows, model, provider } = await runScenario({ chatType, staticSystem, sessionId });
      if (!meta) meta = `模型：${model}（${provider}）　口径：usage 里的缓存命中数\n`;
      for (const r of rows) {
        const rate = r.prompt ? ((r.cached / r.prompt) * 100).toFixed(1) + '%' : '-';
        lines.push(`| ${label} | 第 ${r.round} 轮 | ${r.prompt} | ${r.cached} | ${r.prompt - r.cached} | ${rate} |`);
      }
    }
  }

  lines.splice(2, 0, meta, '');
  const text = lines.join('\n');
  console.log(text);
  if (OUT) fs.writeFileSync(path.resolve(ROOT, OUT), text + '\n', 'utf8');
}

main().catch((err) => {
  console.error('实测失败：' + ((err && err.message) || err));
  process.exitCode = 1;
});
