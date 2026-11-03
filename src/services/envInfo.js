'use strict';

/**
 * 环境信息 → 提示词里的 <env> 块。
 *
 * 机器那半（系统/架构/CPU/内存/时区/Node）只读本机，`src/core/env.js` 采一次。
 * 地点那半按优先级取：手填 → 城市配置 → 自动探测（`services/location.js`）。
 * 拼好的字符串只交给模型看：不写日志、不落盘、不上报。
 *
 * 地点精度是硬红线：最多到区。
 *   - `env.location` 是手工填的，可以精确到区；
 *   - `websearch.city` 是天气搜索用的城市名，本来就是城市级；
 *   - 自动探测只到市（区县容易错），并在括注里写明来源，免得模型往下补；
 *   - 三样都没有就不写「所在地」这一行。
 */

const env = require('../core/env');
const features = require('../infra/features');
const locationProbe = require('./location');

// 同一配置下要求逐字节稳定（前缀缓存），所以按 key 记忆化。
// 不需要无限增长：key 里只有系统信息 + 地点 + 版本，一个进程里通常就一两个。
const BLOCK_CACHE = new Map();
const CACHE_MAX = 8;

// 比「区/县」更细的层级：路、街、门牌、小区、楼栋…出现这些就把地址砍回区级
const FINER_THAN_DISTRICT = /路|街|道|巷|弄|号|栋|幢|楼|室|小区|花园|家园|大厦|广场|苑|村|镇|乡/;
const DISTRICT_CHARS = '区县市旗';

function lastDistrictIndex(text) {
  let idx = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (DISTRICT_CHARS.includes(text[i])) idx = i;
  }
  return idx;
}

/**
 * 把用户填的地点收窄到「区」为止。
 * 有人可能直接粘完整收货地址，这里兜住，不让门牌号进提示词。
 */
function clampLocation(raw) {
  let text = String(raw == null ? '' : raw).replace(/[\r\n\t]+/g, ' ').trim();
  if (!text) return '';
  // 经纬度这种精确定位不进来
  text = text.replace(/[-+]?\d{2,3}\s*\.\s*\d{3,}\s*[,，]\s*[-+]?\d{1,3}\s*\.\s*\d{3,}/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();
  const finerAt = text.search(FINER_THAN_DISTRICT);
  if (finerAt > 0) {
    // 砍在最后一个「区/县/市/旗」后面；前面没有更粗的层级就整段丢掉细地址
    const head = text.slice(0, finerAt);
    const district = lastDistrictIndex(head);
    text = district > 0 ? head.slice(0, district + 1) : head;
  }
  return text.replace(/[，,、;；\s]+$/, '').trim().slice(0, 40);
}

/**
 * 地点从哪来（按优先级）：
 *   1. `env.location`：人手填的，最准，可以精确到区；
 *   2. `websearch.city`：也是人填的，城市级；
 *   3. 自动探测（`services/location`）：系统定位优先（不看公网 IP，挂 VPN 也准），
 *      拿不到才退回出口 IP。探测只到市（区县容易错，要区就手填）；异步的，这里只读缓存。
 * 返回 `{ text, note }`，note 是「系统定位，精度约 50 公里，只到市」这类括注；都没有返回 null。
 */
function resolvePlace(config) {
  const manual = clampLocation(config && config.env && config.env.location);
  if (manual) return { text: manual, note: '' };
  const city = clampLocation(config && config.websearch && config.websearch.city);
  if (city) return { text: city, note: '' };
  if (!features.isOn(config, 'envContext')) return null;
  if (config && config.env && config.env.autoDetect === false) return null;
  const hit = locationProbe.cached();
  if (hit && hit.text) {
    // 探测结果同样过一遍「最多到区」的截断，别让接口回的地名带街道
    const text = clampLocation(hit.text);
    if (text) return { text, note: locationProbe.noteFor(hit.source, hit.accuracyM) };
  }
  // 还没探过（刚启动 / 刚清掉手工地点）：补一次，不阻塞这一轮
  locationProbe.ensureProbe();
  return null;
}

/** 只要字符串的旧入口（日志/调试用） */
function resolveLocation(config) {
  const place = resolvePlace(config);
  return place ? place.text : '';
}

/** 配置里可以覆盖时区（换个时区跑同一台机器时用）；非法时区就按系统自己的来 */
function snapshotFor(config) {
  const snap = env.snapshot();
  const tz = String((config && config.env && config.env.timezone) || '').trim();
  if (!tz || tz === snap.tz) return snap;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return snap;
  }
  return { ...snap, tz };
}

/**
 * 生成提示词里的 <env> 块。
 * @param {object} config 整份配置
 * @param {string} version 程序版本（app.js 的 VERSION）
 * @returns {string} 关掉 features.envContext 时返回空串
 */
function systemBlock(config, version) {
  if (!features.isOn(config, 'envContext')) return '';
  const snap = snapshotFor(config);
  const place = resolvePlace(config);
  const location = place ? place.text : '';
  const locationNote = place ? place.note : '';
  const ver = String(version == null ? '' : version).trim();
  const key = JSON.stringify([
    snap.osName, snap.osVersion, snap.arch, snap.cpuCores, snap.memGB, snap.tz, snap.node,
    location, locationNote, ver,
  ]);
  const hit = BLOCK_CACHE.get(key);
  if (hit !== undefined) return hit;
  const block = env.formatBlock(snap, { location, locationNote, version: ver });
  if (BLOCK_CACHE.size >= CACHE_MAX) BLOCK_CACHE.clear();
  BLOCK_CACHE.set(key, block);
  return block;
}

/**
 * 桥接状态拼一行：能不能发出去是「这一轮」的事实，不属于静态环境。
 * 没有 bridgeStatus（网页通道、测试）就返回空串，一个字都不加。
 * @param {object} msg 统一消息对象（gateway 会挂 msg.bridgeStatus = {online, uia, ffmpeg}）
 */
function bridgeLine(msg) {
  const b = msg && msg.bridgeStatus;
  if (!b || typeof b !== 'object') return '';
  const online = b.online === true;
  const parts = [online ? '桥接在线' : '桥接离线'];
  if (online) {
    if (b.uia === true) parts.push('UIA 可用');
    else if (b.uia === false) parts.push('UIA 不可用，暂时发不出去');
    // 明确 true / false 才说；null 表示桥接自己还没报，不猜
    if (b.ffmpeg === true) parts.push('ffmpeg 已找到');
    else if (b.ffmpeg === false) parts.push('ffmpeg 没找到，语音和动图会受影响');
  }
  return '【桥接】' + parts.join(' · ');
}

module.exports = { systemBlock, bridgeLine, resolvePlace, resolveLocation, clampLocation };
