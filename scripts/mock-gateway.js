#!/usr/bin/env node
'use strict';

/**
 * 模拟微信 / 抖音的网关，往本机的鲸鲸发消息，验证接入链路是否通。
 * 不需要真的微信/抖音账号，专门用来联调。
 *
 * 用法：
 *   node scripts/mock-gateway.js                                   # 模拟微信群里被 @
 *   node scripts/mock-gateway.js --platform=douyin                 # 模拟抖音群消息
 *   node scripts/mock-gateway.js --text="鲸鲸在吗" --user=海胆酱     # 自定义内容
 *   node scripts/mock-gateway.js --demo                            # 连发几条，看群聊规则
 *   node scripts/mock-gateway.js --private                         # 私聊消息
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { platform: 'wechat', user: '阿螈', text: '@鲸鲸 在吗', group: true, demo: false, token: '', url: '', port: 0 };
  for (const raw of argv.slice(2)) {
    const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2] === undefined ? true : m[2];
    if (key === 'private') out.group = false;
    else if (key === 'group') out.group = true;
    else if (key === 'demo') out.demo = true;
    else if (key === 'platform' || key === 'user' || key === 'text' || key === 'token' || key === 'url') out[key] = String(val);
    else if (key === 'port') out.port = Number(val) || 0;
  }
  return out;
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function postJson(urlString, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'http:' ? http : require('node:https');
    const body = JSON.stringify(payload);
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
        timeout: 60000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, data: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, data: { raw: text } });
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const config = readJson(path.join(ROOT, 'config.json'), {});
  const port = opts.port || (config.server && config.server.port) || 8787;
  const baseUrl = opts.url || `http://127.0.0.1:${port}`;
  const gw = (config.gateway && config.gateway[opts.platform]) || {};
  const token = opts.token || gw.inboundToken || '';

  if (!gw.enabled) {
    console.log('');
    console.log(`⚠️  config.json 里 gateway.${opts.platform}.enabled 还是 false，服务端会直接跳过。`);
    console.log(`   把 gateway.${opts.platform}.enabled 改成 true，再重启服务。`);
    console.log('');
  }

  const send = async (text, user = opts.user) => {
    const payload = {
      chat_id: opts.group ? `room_${opts.platform}_demo` : `dm_${opts.platform}_demo`,
      chat_type: opts.group ? 'group' : 'private',
      user_id: 'u_' + user,
      nickname: user,
      text,
      msg_id: 'mock_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    };
    const label = opts.group ? `群消息 ${user}` : `私聊 ${user}`;
    console.log(`\n🐋 [${opts.platform}] ${label}：${text}`);
    try {
      const { status, data } = await postJson(`${baseUrl}/webhook/${opts.platform}`, payload, token ? { 'x-bot-token': token } : {});
      if (status !== 200) {
        console.log(`   ❌ HTTP ${status}：${JSON.stringify(data)}`);
        return null;
      }
      if (data.skipped) {
        console.log(`   ⏭  服务端跳过：${data.skipped}`);
        return data;
      }
      if (data.action === 'ignore') {
        console.log(`   💤 鲸鲸没接话（${data.reason}）`);
        return data;
      }
      const bubbles = data.bubbles && data.bubbles.length ? data.bubbles : [data.reply || ''];
      for (const b of bubbles) {
        if (b) console.log(`   💬 鲸鲸：${b}`);
      }
      if (data.outbound && data.outbound.dryRun) {
        console.log('   （没配 outboundUrl，所以回复只在你这边显示，不会真的发回微信/抖音）');
      }
      return data;
    } catch (err) {
      console.log(`   ❌ 连接失败：${err.message}`);
      console.log(`      先确认服务开着：双击 启动鲸鱼娘.bat，或 node server.js`);
      return null;
    }
  };

  if (opts.demo) {
    console.log(`\n=== 鲸鲸接入联调（${baseUrl}，平台 ${opts.platform}）===`);
    await send('今天加班到十点，人已经麻了', '阿螈');
    await send('@鲸鲸 你说人为什么要上班啊', '海胆酱');
    await send('哈哈哈哈哈哈哈', '小丑鱼');
    await send('鲸鲸，安慰我一下', '阿螈');
    await send('/memory', '海胆酱');
    console.log('\n=== 联调结束 ===\n');
    return;
  }

  await send(opts.text, opts.user);
  console.log('');
}

main().catch((err) => {
  console.error('出错了：', err);
  process.exit(1);
});
