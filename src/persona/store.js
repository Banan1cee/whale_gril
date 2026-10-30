'use strict';

/**
 * 主人通过微信「魔咒」调整的人设/能力，持久化在 data/persona.json。
 * 启动时合并进 config，改完立即生效，重启也保留。
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'persona.json';

function fileFor(config) {
  try {
    return path.join(config.paths.dataDir, FILE_NAME);
  } catch {
    return '';
  }
}

function load(config) {
  const file = fileFor(config);
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch {
    return {};
  }
}

/* ------------------------------------------------------------------ */
/* 归属划分：这几个键以前存在 data/persona.json，但启动时 apply() 会用旧值   */
/* 盖掉 config.json —— 用户在设置页改完、重启又变回去，看着就是「设置无效」。 */
/* 现在它们只归 config.json；persona.json 只留人设本身。                   */
/* ------------------------------------------------------------------ */
const CONFIG_PATHS = {
  privateMaxChars: 'chat.privateMaxChars',
  groupMaxChars: 'chat.groupMaxChars',
  maxBubbles: 'chat.maxBubbles',
  links: 'links.enabled',
  freeChat: 'group.freeChat',
  historyTurns: 'chat.historyTurns',
  groupHistoryTurns: 'chat.groupHistoryTurns',
};

function normalized(key, value) {
  if (key === 'links' || key === 'freeChat') return Boolean(value);
  if (key === 'mutedGroups') return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** config.json 里「明确写过这个键」没有（写过就以 config.json 为准，不再迁移） */
function configHasPath(config, dotted) {
  try {
    const file = config.paths && config.paths.configFile;
    if (!file) return false;
    let cur = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) || {};
    for (const part of String(dotted).split('.')) {
      if (cur === null || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, part)) return false;
      cur = cur[part];
    }
    return true;
  } catch {
    return false;
  }
}

function save(config, patch) {
  const file = fileFor(config);
  const patchObj = patch || {};
  // 把归属 config.json 的那几个键写过去（不再落进 persona.json）
  const configPatch = {};
  for (const [key, dotted] of Object.entries(CONFIG_PATHS)) {
    if (patchObj[key] === undefined) continue;
    const value = normalized(key, patchObj[key]);
    if (value === undefined) continue;
    configPatch[dotted] = value;
  }
  if (Object.keys(configPatch).length) {
    try {
      const { saveConfigPatch } = require('../infra/configPatch');
      saveConfigPatch(config, configPatch);
    } catch (err) {
      // 写不了文件也要让本次生效，不然界面改了却毫无反应
      for (const [dotted, value] of Object.entries(configPatch)) {
        const parts = dotted.split('.');
        let cur = config;
        for (let i = 0; i < parts.length - 1; i += 1) {
          if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
          cur = cur[parts[i]];
        }
        cur[parts[parts.length - 1]] = value;
      }
      if (config.__logger) config.__logger.warn('群聊/长度设置写入 config.json 失败，仅本次生效：' + err.message);
    }
  }
  // 以当前生效值为底，避免“只改了一半”把别的设置冲掉（也兼容没有写文件权限的环境）
  const base = {
    preset: config.persona && config.persona.stylePreset,
    text: config.persona && config.persona.styleText,
    emoji: config.persona && config.persona.emojiLevel,
    mutedGroups: config.group && Array.isArray(config.group.mutedGroups) ? config.group.mutedGroups : undefined,
    emotions: config.persona ? config.persona.emotions !== false : undefined,
    proactive: config.persona ? config.persona.proactive !== false : undefined,
    opinions: config.persona ? config.persona.opinions !== false : undefined,
    masterRoast: config.persona ? Boolean(config.persona.masterRoast) : undefined,
    name: config.persona ? config.persona.name : undefined,
    age: config.persona ? config.persona.age : undefined,
    job: config.persona ? config.persona.job : undefined,
    appearance: config.persona ? config.persona.appearance : undefined,
    personality: config.persona ? config.persona.personality : undefined,
    background: config.persona ? config.persona.background : undefined,
    customPrompt: config.persona ? config.persona.customPrompt : undefined,
    sourcePreset: config.persona ? config.persona.sourcePreset : undefined,
  };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  const next = { ...base, ...load(config), ...patchObj };
  // config 归属的键即使被写进 patch，也不再进 persona.json
  for (const key of Object.keys(CONFIG_PATHS)) delete next[key];
  // patch 里明确给了空字符串的键，语义是「清空」，必须让 apply() 看到；
  // 以前一律「清掉空值」，导致 apply() 读不到这个键，旧值永远删不掉 ——
  // 表现就是：导入过一次人设预设后，自定义提示词永久生效，改性格/语气/外貌全都没反应。
  const explicitClear = new Set(
    Object.entries(patchObj).filter(([, v]) => v === '').map(([k]) => k),
  );
  const forApply = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === null || v === undefined) continue;
    if (v === '' && !explicitClear.has(k)) continue;
    forApply[k] = v;
  }
  if (file) {
    // 落盘时仍然不写空字符串，保持文件干净
    const forFile = { ...forApply };
    for (const [k, v] of Object.entries(forFile)) if (v === '') delete forFile[k];
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(forFile, null, 2), 'utf8');
    } catch {
      /* 测试环境可能没有目录权限，忽略 */
    }
  }
  apply(config, forApply);
  // 保存条数必须覆盖模型窗口及本轮输入/回复，否则面板设了 100 实际只剩 40
  if (config.chat && config.memory) {
    config.memory.maxMessages = Math.min(500, Math.max(
      Number(config.memory.maxMessages) || 160,
      Number(config.chat.historyTurns || 200) + 2,
      Number(config.chat.groupHistoryTurns || 150) + 2,
    ));
  }
  return forApply;
}

const DEFAULTS = {
  preset: '',
  text: '',
  emoji: '正常',
  privateMaxChars: 140,
  groupMaxChars: 70,
  historyTurns: 200,
  groupHistoryTurns: 150,
  links: true,
  freeChat: false,
  mutedGroups: [],
  emotions: true,
  proactive: true,
  opinions: true,
  name: '鲸鲸',
  age: 23,
  job: '自由职业',
  appearance: '深蓝色长卷发，头发上别着一枚鲸尾发夹，常穿深蓝色水手领裙子，怀里或包里总有一只软乎乎的蓝鲸玩偶（你叫它小蓝鲸）。',
  personality: '温柔但有点小倔，嘴硬心软，慢热；熟了话很多，会害羞、会怼人、会犯懒、偶尔 emo。',
  background: '因为头像和玩偶全是鲸鱼，朋友开玩笑叫你「鲸鱼娘」，你也就认了。',
  // 这两个不写进默认值的话，「恢复默认」就清不掉自定义提示词：
  // 旧值会一直盖在控件人设上面，表现出来就是「点了恢复默认还是没变」。
  customPrompt: '',
  sourcePreset: '',
};

function clear(config) {
  const file = fileFor(config);
  if (file) {
    try { fs.unlinkSync(file); } catch { /* ignore */ }
  }
  // 「恢复默认」也要把归 config.json 的那几项一起还原，否则面板显示已经重置、
  // 实际长度/上下文还停在用户改过的值（以前这些都在 persona.json 里才会被一起清掉）。
  const back = {};
  for (const [key, dotted] of Object.entries(CONFIG_PATHS)) {
    const value = normalized(key, DEFAULTS[key]);
    if (value !== undefined) back[dotted] = value;
  }
  try {
    const { saveConfigPatch } = require('../infra/configPatch');
    saveConfigPatch(config, back);
  } catch {
    for (const [dotted, value] of Object.entries(back)) {
      const parts = dotted.split('.');
      let cur = config;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
    }
  }
  apply(config, { ...DEFAULTS });
  return {};
}

/** 把存档合并进 config（提示词 / 人设内容从这里读） */
function apply(config, data) {
  data = data || {};
  if (!config.persona) config.persona = {};
  config.persona.stylePreset = data.preset || '';
  config.persona.styleText = data.text || '';
  config.persona.emojiLevel = data.emoji || '';

  if (!config.group) config.group = {};
  config.group.mutedGroups = Array.isArray(data.mutedGroups) ? data.mutedGroups.slice() : [];
  // 归属 config.json 的键：老版本存过就搬一次（只搬 config.json 里没写过的），
  // 之后就只认 config.json，绝不再用它盖掉用户在设置页选的值。
  const legacy = {};
  for (const [key, dotted] of Object.entries(CONFIG_PATHS)) {
    if (data[key] === undefined || configHasPath(config, dotted)) continue;
    const value = normalized(key, data[key]);
    if (value !== undefined) legacy[dotted] = value;
  }
  if (Object.keys(legacy).length) {
    try {
      const { saveConfigPatch } = require('../infra/configPatch');
      saveConfigPatch(config, legacy);
    } catch { /* 写不了就按默认值跑 */ }
  }
  config.persona.emotions = data.emotions !== false;
  // 主人被骂时她能不能还嘴（默认关；开了就允许毒舌互怼，但不许真脏字）
  if (data.masterRoast !== undefined) config.persona.masterRoast = Boolean(data.masterRoast);
  config.persona.proactive = data.proactive !== false;
  config.persona.opinions = data.opinions !== false;
  for (const k of ['name', 'job', 'appearance', 'personality', 'background']) {
    if (data[k] !== undefined) config.persona[k] = String(data[k] || '');
  }
  if (data.age !== undefined) config.persona.age = Number(data.age) || 23;
  if (data.customPrompt !== undefined) config.persona.customPrompt = String(data.customPrompt || '');
  // 记下「这份人设是从哪个人设文件导入的」，页面上直接显示，免得用户不知道自己现在用的是哪版
  if (data.sourcePreset !== undefined) config.persona.sourcePreset = String(data.sourcePreset || '');
  return config;
}

function summary(config) {
  return {
    preset: config.persona.stylePreset || '',
    text: config.persona.styleText || '',
    emoji: config.persona.emojiLevel || '正常',
    privateMaxChars: config.chat.privateMaxChars,
    groupMaxChars: config.chat.groupMaxChars,
    maxBubbles: config.chat.maxBubbles,
    links: config.links.enabled !== false,
    freeChat: Boolean(config.group.freeChat),
    mutedGroups: Array.isArray(config.group.mutedGroups) ? config.group.mutedGroups.slice() : [],
    historyTurns: config.chat.historyTurns,
    groupHistoryTurns: config.chat.groupHistoryTurns,
    emotions: config.persona.emotions !== false,
    proactive: config.persona.proactive !== false,
    opinions: config.persona.opinions !== false,
    masterRoast: Boolean(config.persona.masterRoast),
    name: config.persona.name,
    age: config.persona.age,
    job: config.persona.job,
    appearance: config.persona.appearance,
    personality: config.persona.personality,
    background: config.persona.background,
    customPrompt: config.persona.customPrompt || '',
    sourcePreset: config.persona.sourcePreset || '',
  };
}

module.exports = { load, save, clear, apply, summary };
