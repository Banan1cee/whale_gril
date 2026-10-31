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
    key: 'stickers',
    path: 'features.stickers',
    label: '表情包（实验性）',
    desc: '默认关闭。开启后可按傲娇、炸毛、其他三类上传表情包；关闭立即取消未发送任务，不挑图、不带回包字段、不轮询，管理接口停用。实验发送只在已打开的目标微信会话前台校验通过时进行，不自动切会话。',
    default: false,
    experimental: true,
  },
  {
    key: 'memorySemantic',
    path: 'memory.semantic',
    label: '语义检索（让模型挑记忆）',
    desc: '默认开。回复前把 6~10 条候选记忆和对方这句话一起给模型，让它判断哪几条真的有关，只留相关的。关掉=只按字面重合挑，快但会漏（比如「医院挂号」想不起「明天体检」）。',
    default: true,
  },
  {
    key: 'memoryDigest',
    path: 'memory.digest',
    label: '自动整理记忆（摘要 + 抽事实）',
    desc: '默认开。每攒够 12 条新消息，用一次模型把这段对话压成摘要，并顺便抽出 1~3 条关于对方的事实。关掉=回到「只有手动记住才写记忆」，可省一点 token。',
    default: true,
  },
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
    key: 'wechatAccountGuard',
    path: 'wechat.accountGuard',
    label: '微信双开时钉死账号（认不出就不发）',
    desc: '同时登着大号小号时，只从指定账号的窗口发消息；认不出窗口宁可不发，避免用小号读、从大号发出去。',
    default: true,
  },
  {
    key: 'careOnlyMaster',
    path: 'care.onlyMaster',
    label: '主动搭话只找主人',
    desc: '开着就是「只私聊你」；关掉才会主动找别人（配合下面两个开关）。',
    default: true,
  },
  {
    key: 'careGroups',
    path: 'care.allowGroups',
    label: '主动搭话允许进群',
    desc: '默认关：群里突然来一句「早安」很社死。打开也只是「可以发群」，不会主动挑群。',
    default: false,
  },
  {
    key: 'careOthers',
    path: 'care.allowOthers',
    label: '主动搭话找非主人的私聊',
    desc: '默认关。打开后她会主动私聊别人（不只是你）。',
    default: false,
  },
  {
    key: 'proactiveCare',
    path: 'care.enabled',
    label: '主动找话题（群聊里绝不主动）',
    desc: '没聊的时候她自己来一句「在干啥」。默认关：群里突然说早安很容易社死。开着也只私聊，不会进群。',
    default: false,
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
function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', '开'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', '关', ''].includes(s)) return false;
  return fallback;
}

function isOn(config, key) {
  const f = BY_KEY.get(key);
  if (!f) return false;
  return toBool(getByPath(config, f.path), f.default);
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
    experimental: Boolean(f.experimental),
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

module.exports = { REGISTRY, isOn, list, defaults, getByPath, toBool };
