'use strict';

/**
 * 表情包（实验性）。
 *
 * 只负责「挑哪张、什么时候挑」；真正发出去在桥接
 * （examples/wechatauto_bridge.py 的 send_sticker）。
 *
 * 目录：
 *   data/stickers/开心/*.gif       ← 文件夹名就是情绪（中英文都认）
 *   data/stickers/angry/*.png
 *   data/stickers/通用/*.gif        ← 兜底（情绪文件夹没图时用）
 *   data/stickers/*.gif            ← 随便丢在根目录也认
 *
 * 总闸在 features.stickers（调试台「表情包（实验性）」），关掉时这里
 * 一道都不该被调用；调用方必须先判断 isOn(config, 'stickers')。
 */

const fs = require('fs');
const path = require('path');

const EXTS = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];

/** 5 类情绪：键 → 中文文件夹名 */
const EMOTIONS = {
  happy: '开心',
  angry: '炸毛',
  cute: '撒娇',
  meh: '嫌弃',
  bored: '敷衍',
};
const EMOTION_LABELS = {
  happy: '开心',
  angry: '炸毛',
  cute: '撒娇',
  meh: '嫌弃',
  bored: '敷衍',
};
const GENERIC = '通用';

/** 情绪判定：纯关键词，快、可预期，不花钱 */
const RULES = [
  ['angry', /(傻逼|蠢货|废物|垃圾|滚|你妈|妈的|弱智|脑残|智障|去死|闭嘴|别烦|走开|胖|肥|笨|丑|菜鸡|菜鸟)/],
  ['cute', /(乖|宝贝|抱抱|摸摸|喜欢你|想你|对不起|抱歉|好啦|别气)/],
  ['happy', /(可爱|厉害|好棒|牛逼|牛啊|爱了|绝了|哈哈|笑死)/],
  ['meh', /(？{2,}|什么鬼|离谱|无语|服了|呵呵|行吧|就这)/],
];

function stickerDir(config, root) {
  const raw = (config && config.sticker && config.sticker.dir) || 'data/stickers';
  return path.isAbsolute(raw) ? raw : path.join(root || process.cwd(), raw);
}

function listImages(dir) {
  let out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      out = out.concat(listImages(full));
      continue;
    }
    if (EXTS.includes(path.extname(ent.name).toLowerCase())) out.push(full);
  }
  return out.sort();
}

/** 某个情绪可用的图：先找情绪文件夹（中文名/英文键），再找「通用」 */
function imagesFor(dir, emotion) {
  const candidates = [];
  if (emotion && EMOTIONS[emotion]) candidates.push(path.join(dir, emotion));
  if (emotion && EMOTIONS[emotion]) candidates.push(path.join(dir, EMOTIONS[emotion]));
  for (const d of candidates) {
    const hit = listImages(d);
    if (hit.length) return hit;
  }
  const generic = listImages(path.join(dir, GENERIC));
  if (generic.length) return generic;
  return listImages(dir); // 连通用都没有，就在根目录里随便挑（不含子目录已递归包含）
}

function isOn(config) {
  // 延迟 require，避免 features↔stickers 循环依赖
  const features = require('./features');
  return features.isOn(config, 'stickers');
}

/**
 * 判情绪（5 类）。
 * @returns {string} happy|angry|cute|meh|bored
 */
function detectEmotion(text, hour) {
  const t = String(text || '');
  const h = typeof hour === 'number' ? hour : new Date().getHours();
  if (!t) return 'happy';
  for (const [emotion, re] of RULES) {
    if (re.test(t)) return emotion;
  }
  if (h >= 23 || h < 6) return 'bored';
  return 'happy';
}

function chanceFor(config, emotion) {
  const cfg = (config && config.sticker) || {};
  const chances = cfg.chances || {};
  if (emotion && chances[emotion] !== undefined) return Number(chances[emotion]) || 0;
  return Number(cfg.genericChance) || 0;
}

/**
 * 这条回复要不要补一张表情包。
 * @param {object} p { config, root, key, text, request, state, now, rng }
 * @returns {{emotion: string, path: string}|null}
 */
function pick(p) {
  const {
    config,
    root,
    key = '',
    text = '',
    request = '',
    state = null,
    now = Date.now(),
    rng = Math.random,
  } = p || {};
  if (!isOn(config)) return null;
  const cfg = (config && config.sticker) || {};
  const dir = stickerDir(config, root);
  const emotion = detectEmotion(`${request || ''} ${text || ''}`.trim());
  const pool = imagesFor(dir, emotion);
  if (!pool.length) return null;

  // 「发个表情」这类明确指令 → 必发，不再掷骰子
  const want = /(发|来|甩|扔|给|丢)(个|一个|张)?\s*(表情|表情包|动图|贴纸)/.test(String(request || ''));
  const cooldownMs = Math.max(0, Number(cfg.cooldownMinutes) || 0) * 60 * 1000;
  if (!want) {
    if (cooldownMs > 0 && state && state.get(key) && now - state.get(key) < cooldownMs) return null;
    const p2 = chanceFor(config, emotion);
    if (!(p2 > 0) || !(rng() < Math.min(1, p2))) return null;
  }
  const file = pool[Math.floor(rng() * pool.length)] || pool[0];
  if (state) state.set(key, now);
  return { emotion, path: file };
}

module.exports = {
  EMOTIONS,
  EMOTION_LABELS,
  GENERIC,
  EXTS,
  stickerDir,
  listImages,
  imagesFor,
  detectEmotion,
  chanceFor,
  isOn,
  pick,
};
