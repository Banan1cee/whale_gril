'use strict';

/**
 * Wechaty 微信桥接示例（模板）
 *
 * 作用：用 Wechaty 扫码登录一个微信账号，把消息转给本机的鲸鲸，
 *       再把她的回复发回微信（群聊会 @ 提问的人）。
 *
 * 准备：
 *   npm install wechaty qrcode-terminal
 *   set WECHATY_PUPPET=wechaty-puppet-padlocal
 *   set WECHATY_PUPPET_PADLOCAL_TOKEN=你的 token
 *   node examples/wechaty-bridge.js
 *
 * 注意：
 *   - 这是一个「模板」，不同 puppet 的 API 细节可能不同，需要微调。
 *   - 微信个人号自动化不是官方接口，有封号风险，请用小号测试。
 *   - 群里所有消息都会转给鲸鲸「旁听」，由她自己的规则决定回不回；
 *     如果你流量大，可以把 SEND_ALL_GROUP_MESSAGES 改成 false，只转被叫到的。
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');
const SEND_ALL_GROUP_MESSAGES = true;

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

const config = readJson(path.join(ROOT, 'config.json'), {});
const gateway = (config.gateway && config.gateway.wechat) || {};
const PORT = (config.server && config.server.port) || 8787;
const BOT_URL = `http://127.0.0.1:${PORT}/webhook/wechat`;
const TOKEN = gateway.inboundToken || '';
const BOT_NAME = (config.persona && config.persona.name) || '鲸鲸';
const ALIASES = ((config.persona && config.persona.aliases) || []).concat([BOT_NAME]);

function postJson(urlString, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const mod = url.protocol === 'http:' ? http : https;
    const body = JSON.stringify(payload);
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
        timeout: 90000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('鲸鲸返回了非 JSON：' + text.slice(0, 200)));
          }
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求鲸鲸超时')));
    req.on('error', reject);
    req.end(body);
  });
}

function mentionsBot(text) {
  return ALIASES.some((a) => a && text.includes(a));
}

async function main() {
  let WechatyBuilder;
  try {
    ({ WechatyBuilder } = require('wechaty'));
  } catch {
    console.error('缺少依赖，请先运行：npm install wechaty qrcode-terminal');
    process.exit(1);
  }
  let qrcodeTerminal = null;
  try {
    qrcodeTerminal = require('qrcode-terminal');
  } catch {
    /* 没装也能用，只是二维码打印得丑 */
  }

  const bot = WechatyBuilder.build({
    name: 'whale-girl-wechat',
    puppet: process.env.WECHATY_PUPPET || undefined,
  });

  bot.on('scan', (qrcode, status) => {
    console.log(`\n请用微信扫码登录（status=${status}）：`);
    if (qrcodeTerminal) qrcodeTerminal.generate(qrcode, { small: true });
    else console.log(qrcode);
  });

  bot.on('login', (user) => console.log(`✅ 已登录：${user}（这是测试号吗？记得用小号）`));
  bot.on('logout', (user) => console.log(`👋 已登出：${user}`));
  bot.on('error', (err) => console.error('Wechaty 出错：', err.message));

  bot.on('message', async (msg) => {
    try {
      if (msg.self()) return;
      const text = (msg.text() || '').trim();
      if (!text) return;

      const room = msg.room();
      const talker = msg.talker();
      const isGroup = Boolean(room);
      const mentioned = isGroup ? await msg.mentionSelf().catch(() => false) : false;
      const addressed = mentioned || mentionsBot(text);

      // 群里无关消息默认也转过去（让她旁听），由她自己的规则决定回不回
      if (isGroup && !addressed && !SEND_ALL_GROUP_MESSAGES) return;

      const nickname = talker.name() || '群友';
      const payload = {
        chat_id: isGroup ? await room.id : talker.id,
        chat_type: isGroup ? 'group' : 'private',
        user_id: talker.id,
        nickname,
        text,
        msg_id: msg.id,
        at_me: addressed,
        chat_title: isGroup ? (await room.topic()).slice(0, 40) : '',
      };

      const result = await postJson(BOT_URL, payload, TOKEN ? { 'x-bot-token': TOKEN } : {});
      if (!result || result.action !== 'reply' || !result.reply) {
        console.log(`  · 群${isGroup ? '' : '私'}聊 ${nickname}：${text.slice(0, 30)} → 鲸鲸没接话（${result && result.reason}）`);
        return;
      }

      const bubbles = Array.isArray(result.bubbles) && result.bubbles.length ? result.bubbles : [result.reply];
      for (const line of bubbles) {
        if (!line) continue;
        if (isGroup) await room.say(line, talker.id); // 群里 @ 提问的人
        else await talker.say(line);
        await new Promise((r) => setTimeout(r, 500)); // 多条气泡的间隔，别刷屏
      }
      console.log(`  · ${BOT_NAME} 回复了 ${nickname}：${bubbles.join(' / ').slice(0, 60)}`);
    } catch (err) {
      console.error('处理消息失败：', err.message);
    }
  });

  await bot.start();
  console.log(`🐋 桥接已启动，鲸鲸地址：${BOT_URL}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
