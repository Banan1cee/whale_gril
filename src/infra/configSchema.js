'use strict';

/**
 * 配置校验：一张纯数据的表 + 两个函数。
 *
 * 为什么需要它：`config.json` 现在是 20 多个顶层组的深合并，非法值会在各处
 * 被 `Number(x) || 默认` 静默吃掉 —— 用户在调试台把「历史轮数」填成 `abc`，
 * 界面上显示保存成功，实际还是旧值，只能靠猜。
 *
 * 这里只做三件事：
 *   1. 类型对不对（int / float / bool / string / enum）
 *   2. 范围对不对（min / max）
 *   3. 报错带字段路径，人能看懂
 *
 * 不改行为：合法值原样通过；非法值只报错，不偷偷改。
 */

const FIELDS = {
  // ---- 服务 ----
  'server.port': { type: 'int', min: 0, max: 65535 },
  'server.host': { type: 'string', maxLen: 255 },
  'server.allowRemote': { type: 'bool' },
  'server.openBrowser': { type: 'bool' },

  // ---- 对话 ----
  'chat.historyTurns': { type: 'int', min: 2, max: 800 },
  'chat.groupHistoryTurns': { type: 'int', min: 2, max: 800 },
  'chat.privateMaxChars': { type: 'int', min: 20, max: 4000 },
  'chat.groupMaxChars': { type: 'int', min: 20, max: 4000 },
  'chat.maxBubbles': { type: 'int', min: 1, max: 12 },

  // ---- 采样参数 ----
  'deepseek.temperature': { type: 'float', min: 0, max: 2 },
  'deepseek.maxTokens': { type: 'int', min: 16, max: 32768 },
  'deepseek.frequencyPenalty': { type: 'float', min: -2, max: 2 },
  'deepseek.presencePenalty': { type: 'float', min: -2, max: 2 },

  // ---- 群聊 ----
  'group.requireAt': { type: 'bool' },
  'group.freeChat': { type: 'bool' },
  'group.freeChatChance': { type: 'float', min: 0, max: 1 },
  'group.cooldownSec': { type: 'int', min: 0, max: 3600 },
  'group.maxRepliesPerHour': { type: 'int', min: 0, max: 10000 },
  'group.silentMinutes': { type: 'int', min: 1, max: 10080 },
  'group.engagedMinutes': { type: 'int', min: 1, max: 1440 },
  'group.masterAlwaysReply': { type: 'bool' },

  // ---- 记忆（旧键，运行时只读 constants.js）----
  'memory.maxSessions': { type: 'int', min: 1, max: 10000 },
  'memory.maxMessages': { type: 'int', min: 2, max: 2000 },
  'memory.maxNotesPerUser': { type: 'int', min: 0, max: 200 },

  // ---- 管理员 / 主动搭话 ----
  'admin.minutes': { type: 'int', min: 1, max: 1440 },
  'care.enabled': { type: 'bool' },
  'care.everyMinutes': { type: 'int', min: 1, max: 1440 },

  // ---- 联网 / 链接 ----
  'links.enabled': { type: 'bool' },
  'links.timeoutMs': { type: 'int', min: 1000, max: 60000 },
  'websearch.enabled': { type: 'bool' },
  // ---- 提醒（规则字段和 care 对齐，配置独立）----
  'reminder.enabled': { type: 'bool' },
  'reminder.maxPerDay': { type: 'int', min: 0, max: 200 },
  'reminder.quietAfterMinutes': { type: 'int', min: 0, max: 1440 },

  // ---- 存储 ----
  'storage.mediaKeepDays': { type: 'int', min: 1, max: 365 },
  'storage.mediaMaxMB': { type: 'int', min: 10, max: 100000 },

  // ---- 微信桥接（bridge/engine.py 直接读这几个）----
  'wechat.backgroundSend': { type: 'bool' },
  'wechat.keyboardFallback': { type: 'bool' },
  'wechat.quoteReply': { type: 'bool' },
  'wechat.accountGuard': { type: 'bool' },
  'wechat.bgSend.enabled': { type: 'bool' },
  'wechat.bgSend.charGapMs': { type: 'int', min: 20, max: 80 },
  'wechat.bgSend.verify': { type: 'bool' },
  'wechat.bgSend.fallbackToForeground': { type: 'bool' },
  'wechat.bgSend.stripUnencodable': { type: 'bool' },
  'wechat.bgSend.unhideWindow': { type: 'bool' },
  'wechat.pipelineWorkers': { type: 'int', min: 1, max: 16 },
  'wechat.pipelineQueueLimit': { type: 'int', min: 1, max: 32 },
};

const BOOLISH = new Set(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', '开', '关']);

function getByPath(obj, dotted) {
  let cur = obj;
  for (const key of String(dotted).split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function describe(expected) {
  switch (expected.type) {
    case 'int':
    case 'float':
      return `${expected.type === 'int' ? '整数' : '数字'}${expected.min !== undefined ? `（${expected.min}~${expected.max}）` : ''}`;
    case 'bool':
      return 'true / false';
    case 'string':
      return '字符串';
    default:
      return expected.type;
  }
}

/** 校验单个值；返回错误文字，或 null 表示通过。 */
function checkValue(value, spec) {
  if (spec.type === 'bool') {
    if (typeof value === 'boolean') return null;
    // 老配置里有写成字符串的 "false"；只要值本身合法就放行
    if (typeof value === 'string' && BOOLISH.has(value.trim().toLowerCase())) return null;
    if (value === 1 || value === 0) return null;
    return `应该是 ${describe(spec)}，实际是 ${JSON.stringify(value)}`;
  }
  if (spec.type === 'int') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n) || !Number.isInteger(n)) return `应该是整数，实际是 ${JSON.stringify(value)}`;
    if (spec.min !== undefined && n < spec.min) return `不能小于 ${spec.min}（实际 ${n}）`;
    if (spec.max !== undefined && n > spec.max) return `不能大于 ${spec.max}（实际 ${n}）`;
    return null;
  }
  if (spec.type === 'float') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (!Number.isFinite(n)) return `应该是数字，实际是 ${JSON.stringify(value)}`;
    if (spec.min !== undefined && n < spec.min) return `不能小于 ${spec.min}（实际 ${n}）`;
    if (spec.max !== undefined && n > spec.max) return `不能大于 ${spec.max}（实际 ${n}）`;
    return null;
  }
  if (spec.type === 'string') {
    if (typeof value !== 'string') return `应该是字符串，实际是 ${JSON.stringify(value)}`;
    if (spec.maxLen && value.length > spec.maxLen) return `太长（最多 ${spec.maxLen} 个字符）`;
    return null;
  }
  return null;
}

/**
 * 校验整份配置（只看表里列出的字段，没列的不管）。
 * @returns {{path:string, message:string, value:any}[]}
 */
function validate(config) {
  const errors = [];
  for (const [dotted, spec] of Object.entries(FIELDS)) {
    const value = getByPath(config, dotted);
    if (value === undefined) continue;          // 缺省 = 用默认值，不算错
    const message = checkValue(value, spec);
    if (message) errors.push({ path: dotted, message, value });
  }
  // 功能开关：以 features 注册表为准，动态校验（新开关自动纳入）
  try {
    const features = require('./features');
    for (const entry of features.REGISTRY || []) {
      const value = getByPath(config, entry.path);
      if (value === undefined) continue;
      const message = checkValue(value, { type: 'bool' });
      if (message) errors.push({ path: entry.path, message, value });
    }
  } catch { /* features 表读不到就不校验这一块 */ }
  return errors;
}

function formatErrors(errors) {
  return errors.map((e) => `${e.path}：${e.message}`).join('；');
}

module.exports = { FIELDS, validate, checkValue, formatErrors, getByPath };
