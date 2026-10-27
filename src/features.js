'use strict';

/**
 * 功能开关登记表。
 *
 * 约定（从现在开始每个新功能都要遵守）：
 *   1. 功能必须有开关，默认值写在这里，并进 DEFAULT_CONFIG；
 *   2. 开关必须能在控制台里改（调试台「功能开关」卡片 / POST /api/features）；
 *   3. 开关写回 config.json，重启/热重载都还在；
 *   4. 关掉开关 = 回到旧行为，不能关了就崩。
 */

const REGISTRY = [
  {
    key: 'groupAddressGuard',
    path: 'features.groupAddressGuard',
    label: '群里先分清「你」在说谁',
    desc: '别人之间互相骂、@ 了别人、或在说第三人称时，不去插嘴。关掉=回到以前「她一说过话就接」的旧行为。',
    default: true,
  },
  {
    key: 'fightQuoteCheck',
    path: 'features.fightQuoteCheck',
    label: '开怼前必须引用对方原话',
    desc: '开火时要求回复里带上对方原话的片段（证明她真读懂了）；找不到就降级成一句「？」，不再乱喷。',
    default: true,
  },
  {
    key: 'mediaCleanup',
    path: 'features.mediaCleanup',
    label: '启动时清理媒体缓存',
    desc: '清 data/media-cache 里 7 天前的图片/语音（storage.mediaKeepDays 可调）。关掉=永不清理。',
    default: true,
  },
  {
    key: 'memorySnapshot',
    path: 'features.memorySnapshot',
    label: '自动记忆快照',
    desc: '启动和每 30 分钟备份一次记忆到 data/backups（最多 20 份）。关掉=只保留手动备份。',
    default: true,
  },
  {
    key: 'quoteReply',
    path: 'wechat.quoteReply',
    label: '引用回复（慢，默认关）',
    desc: '开启后每条回复都带「引用原消息」，视觉上更清楚，但每条要多走一遍 UI，实测慢好几秒。',
    default: false,
  },
];

const BY_KEY = new Map(REGISTRY.map((f) => [f.key, f]));

function getByPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted || '').split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 开关是否打开（读配置；没配就用默认值） */
function isOn(config, key) {
  const f = BY_KEY.get(key);
  if (!f) return false;
  const v = getByPath(config, f.path);
  return v === undefined || v === null ? f.default : Boolean(v);
}

/** 给控制台看的：所有开关 + 当前值 */
function list(config) {
  return REGISTRY.map((f) => ({
    key: f.key,
    path: f.path,
    label: f.label,
    desc: f.desc,
    value: isOn(config, f.key),
    default: f.default,
  }));
}

/** 默认值对象，塞进 DEFAULT_CONFIG */
function defaults() {
  const out = { features: {} };
  for (const f of REGISTRY) {
    if (!f.path.startsWith('features.')) continue;
    out.features[f.path.slice('features.'.length)] = f.default;
  }
  return out.features;
}

module.exports = { REGISTRY, isOn, list, defaults, getByPath };
