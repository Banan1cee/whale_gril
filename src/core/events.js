'use strict';

/**
 * 外部动作账本。
 *
 * 模型只会吐文字，所有副作用（发表情包、把文字交给桥接、读链接、联网查资料）
 * 都是后端在它出完字之后做的。这些结果以前只在日志里，模型下一轮完全看不见，
 * 于是「发了张图」它不知道，「刚才搜的天气」它想不起来，被问到只能编或者装傻。
 *
 * 这里把每件事记成一条简短事实（type + detail + status + ts），由 store 挂在会话上，
 * 每轮组装提示词时回读成【最近做过的事】。它既不是她说的话，也不进聊天记录。
 */

/** 动作类型 → 说人话的名字 */
const TYPE_LABEL = new Map([
  ['sticker', '表情包'],
  ['send', '文字发送'],
  ['link', '读取链接'],
  ['web', '联网查询'],
]);

/** 状态 → 说人话的结果（必须诚实：没有回执就说没有回执） */
const STATUS_LABEL = new Map([
  ['queued', '已排队，还没发出去'],
  ['sending', '正在发'],
  ['confirmed', '桥接确认发出'],
  ['unconfirmed', '桥接没回执，不确定是否发出'],
  ['failed', '失败'],
  ['cancelled', '已取消'],
  ['dropped', '跳过，没有发'],
  ['blocked', '没有发出去（没配中转，也不是本地桥接）'],
  ['ok', '完成'],
  ['empty', '没有结果'],
]);

const MAX_TYPE = 20;
const MAX_DETAIL = 200;
const MAX_STATUS = 20;

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * 规范化一条动作记录；不认识类型或没内容就返回 null（宁可不记，也不写垃圾进提示词）。
 */
function clampEvent(event, ts = Date.now()) {
  if (!event || typeof event !== 'object') return null;
  const type = clean(event.type, MAX_TYPE).toLowerCase();
  if (!TYPE_LABEL.has(type)) return null;
  const detail = clean(event.detail, MAX_DETAIL);
  if (!detail) return null;
  const status = clean(event.status, MAX_STATUS).toLowerCase() || 'ok';
  return {
    ts: Number(event.ts) || ts,
    type,
    detail,
    status: STATUS_LABEL.has(status) ? status : 'ok',
  };
}

function timeLabel(ts) {
  const d = new Date(Number(ts) || Date.now());
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 距今多久。只给绝对时间（14:02）模型没法判断「刚发的」还是「一小时前的」，
 * 被追问时容易说错，所以每条都带上相对时间。
 */
function relativeLabel(ts, now = Date.now()) {
  const diff = Math.max(0, Number(now) - Number(ts));
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  return `${Math.floor(hour / 24)} 天前`;
}

/** 单条记录 → 一行事实，例：`14:02（2 分钟前） 发表情包「开心/wave.gif」—— 桥接确认发出` */
function describe(event, now = Date.now()) {
  const status = STATUS_LABEL.get(event.status) || '完成';
  return `${timeLabel(event.ts)}（${relativeLabel(event.ts, now)}）${TYPE_LABEL.get(event.type)}「${event.detail}」—— ${status}`;
}

/**
 * 组装【最近做过的事】段落。没有记录返回空串，调用方直接跳过。
 * @param {Array} events store.events() 的顺序（旧 → 新）
 * @param {{max?: number, now?: number|Date}} opts now 用于算「距今多久」
 */
function formatBlock(events, { max = 12, now = Date.now() } = {}) {
  const list = (Array.isArray(events) ? events : [])
    .filter((e) => e && TYPE_LABEL.has(e.type) && e.detail)
    .slice(-max);
  if (!list.length) return '';
  return [
    '【最近做过的事（系统记录，不是你说的话）】',
    ...list.map((e) => '- ' + describe(e, now)),
    '- 这些是程序记下的真实结果，和你嘴上说什么无关。',
    '- 括号里是距今多久：写着「刚刚」「几分钟前」的就是刚发生的事，被问起时照实承认即可；几小时前、几天前的别当成刚做的。',
    '- 记录里写着发出/完成的，可以顺着承认（「给你发了」「刚发了张图」），但别添油加醋描述画面内容。',
    '- 记录里写着失败、没回执、跳过、已取消的，就照实说没发成，不要编造送达，也不要假装没这回事。',
    '- 记录里根本没有的事，一律不要声称自己做过。',
  ].join('\n');
}

module.exports = { clampEvent, describe, formatBlock, timeLabel, relativeLabel, TYPE_LABEL, STATUS_LABEL };
