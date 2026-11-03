'use strict';

/**
 * 实测「system 静态化」前后的前缀缓存命中情况（私聊 / 群聊各 3 轮）。
 *
 * 为什么要单独跑：cacheHitTokens 只有服务商（DeepSeek 的 prompt_cache_hit_tokens）
 * 才会给，本地估算看不出前缀到底命没命中。这个脚本走真实接口，两种开关各跑一遍，
 * 结果直接贴进 PR 描述。
 *
 * 用法（Key 可以不落盘，用环境变量）：
 *   set DEEPSEEK_API_KEY=sk-xxx
 *   node scripts/measure-cache-hit.js
 *   node scripts/measure-cache-hit.js --rounds 3 --model deepseek-chat --out measure.md
 *
 * 说明：
 *   - 只跑 3 轮 × 2 种开关 × 私聊/群聊，max_tokens 给 40，成本可忽略；
 *   - 每轮之间用同一个 system（同一天），历史只往后追加，模拟真实聊天；
 *   - staticSystem=false 是旧行为：时间/心情/说话人在 system 里，每轮都变。
 */

const path = require('node:path');
const fs = require('node:fs');

const persona = require('../src/persona');
const { buildTurns } = require('../src/core/context');
const { loadConfig } = require('../src/infra/config');
const { DeepSeekClient } = require('../src/llm/client');

const ROOT = path.resolve(__dirname, '..');

function arg(name, fallback = '') {
  const hit = process.argv.slice(2).find((a) => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return fallback;
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1);
  const idx = process.argv.indexOf(hit);
  return process.argv[idx + 1] || fallback;
}

const ROUNDS = Math.max(1, Math.min(10, Number(arg('rounds', 3)) || 3));
const MODEL = String(arg('model', '') || '').trim();
const OUT = String(arg('out', '') || '').trim();

const PRIVATE_TEXTS = ['在吗', '今天有点累，老板又加活了', '你说我要不要换个工作'];
const GROUP_TEXTS = ['@鲸鲸 今天加班好累', '@鲸鲸 你说我该不该换工作', '@鲸鲸 那你觉得呢'];

function loggedConfig(staticSystem) {
  const config = loadConfig({ root: ROOT, env: process.env });
  config.features = { ...(config.features || {}), staticSystem };
  // 演示模式 / 空 Key 时不要真的去请求
  return config;
}

function usageLine(label, usage) {
  const prompt = Number(usage.promptTokens) || 0;
  const hit = Number(usage.promptCacheHitTokens) || 0;
  const miss = Number(usage.promptCacheMissTokens) || Math.max(0, prompt - hit);
  const rate = prompt ? ((hit / prompt) * 100).toFixed(1) + '%' : '-';
  return `| ${label} | ${prompt} | ${hit} | ${miss} | ${rate} |`;
}

async function runOne({ client, config, chatType, staticSystem }) {
  const isGroup = chatType === 'group';
  const texts = isGroup ? GROUP_TEXTS : PRIVATE_TEXTS;
  const history = [];
  const rows = [];
  const now = new Date();
  const chatId = isGroup ? 'g-demo' : 'p-demo';

  for (let round = 1; round <= ROUNDS; round += 1) {
    const ts = now.getTime() + round * 60000;
    const msg = {
      platform: 'wechat',
      chatId,
      chatType,
      chatTitle: isGroup ? '深海鱼塘' : '',
      senderId: isGroup ? 'u-' + round : 'u-demo',
      senderName: isGroup ? ['阿螈', '小海', '阿螈'][round - 1] || '阿螈' : '小海',
      text: texts[round - 1] || texts[texts.length - 1],
      ts,
      atMe: isGroup,
      addressedToBot: isGroup,
      mentionedNames: [],
      groupParticipants: isGroup ? ['阿螈', '小海'] : [],
    };
    // 时间往前走：旧行为（staticSystem=false）下 system 会跟着变，这正是要对比的点
    const parts = persona.buildPromptParts({
      config,
      msg,
      profile: { count: round },
      notes: [],
      events: [],
      now: new Date(ts),
    });
    const turns = buildTurns(msg, history, '', parts.tail);
    const started = Date.now();
    let reply = '';
    try {
      reply = await client.complete({ system: parts.system, turns, maxTokens: 40 });
    } catch (err) {
      throw new Error(`第 ${round} 轮请求失败：${(err && err.message) || err}`);
    }
    const usage = client.lastUsage || {};
    rows.push({ round, usage, systemChars: parts.system.length, tailChars: parts.tail.length, ms: Date.now() - started });
    // 下一轮的历史 = 之前的对话 + 这一轮的提问和回答（和真实存储一致）
    history.push({ role: 'user', name: msg.senderName, uid: msg.senderId, text: msg.text, ts });
    history.push({ role: 'assistant', text: reply });
  }
  return rows;
}

async function main() {
  const apiKey = String(process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    console.log('没有 DEEPSEEK_API_KEY，跳过实测。用法：');
    console.log('  set DEEPSEEK_API_KEY=sk-xxx');
    console.log('  node scripts/measure-cache-hit.js --rounds 3');
    return;
  }
  const client = new DeepSeekClient({ config: loggedConfig(true), logger: null });
  if (MODEL) client.model = MODEL;

  const lines = [];
  lines.push('# 前缀缓存实测（私聊 / 群聊各 ' + ROUNDS + ' 轮）');
  lines.push('');
  lines.push('模型：' + client.model + '　口径：`usage.prompt_cache_hit_tokens`');
  lines.push('');
  lines.push('| 场景 | 轮次 | prompt_tokens | cache_hit_tokens | cache_miss_tokens | 命中率 |');
  lines.push('| --- | --- | --- | --- | --- | --- |');

  for (const staticSystem of [false, true]) {
    const config = loggedConfig(staticSystem);
    for (const chatType of ['private', 'group']) {
      const label = (chatType === 'private' ? '私聊' : '群聊') + (staticSystem ? '（静态 system）' : '（旧行为）');
      const rows = await runOne({ client, config, chatType, staticSystem });
      for (const row of rows) {
        lines.push(usageLine(`${label} 第 ${row.round} 轮`, row.usage));
      }
    }
  }

  const text = lines.join('\n');
  console.log(text);
  if (OUT) fs.writeFileSync(path.resolve(ROOT, OUT), text + '\n', 'utf8');
}

main().catch((err) => {
  console.error('实测失败：' + ((err && err.message) || err));
  process.exitCode = 1;
});
