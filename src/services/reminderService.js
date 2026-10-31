'use strict';

/**
 * 提醒的存储与状态机。
 *
 * 为什么状态机这么绕：微信发送没有可靠回执，桥接把消息交给微信后只能看 send 返回的 bool。
 * 所以这里坚持「先领任务（sending）→ 回执（done/failed）」两段式，避免重复发；
 * 并且**过点就不补发**：过了提醒时间 5 分钟还没成功，直接标 expired —— 关机一晚上
 * 再打开，不会突然弹出一堆昨天的提醒。
 *
 * 状态流转：
 *   pending ──到期被领取──▶ sending ──ok──▶ done
 *     │                      │
 *     │                      └──失败──▶ retrying（5 分钟后重试一次）
 *     │                                   │
 *     │                                   └──再失败──▶ failed
 *     └──过了 dueAt + 5 分钟还没发──▶ expired
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { toBool } = require('../infra/features');

const MAX_TOTAL = 500;
const MAX_ACTIVE_PER_CHAT = 20;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const CLAIM_TIMEOUT_MS = 2 * 60 * 1000;
const ACTIVE = new Set(['pending', 'retrying', 'sending']);
const DONE = new Set(['done', 'failed', 'expired', 'cancelled']);

function clean(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

/**
 * 提醒的「规则」：和主动搭话同语义（每天上限 / 刚聊过先跳过），但配置独立
 * （config.reminder.*），界面也是独立的一页。
 *
 * 提醒**没有时间段限制**：它是用户指定的准点事件，卡时间窗只会让提醒发不出去。
 * 0 = 不限制。
 */
function normalizeRules(config) {
  const r = (config && config.reminder) || {};
  const maxPerDay = Number(r.maxPerDay);
  const quiet = Number(r.quietAfterMinutes);
  return {
    // 老配置里可能是字符串 "false"（configSchema 允许），Boolean("false") 会当成开
    enabled: toBool(r.enabled, true),
    dailyCap: Number.isFinite(maxPerDay) && maxPerDay > 0 ? Math.floor(maxPerDay) : 0,
    quietAfterMinutes: Number.isFinite(quiet) && quiet > 0 ? Math.floor(quiet) : 0,
  };
}

class ReminderService {
  constructor(config, { logger = null, now = () => Date.now(), lastActiveAt = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.now = now;
    // 可选：某个会话最后一次说话的时间（用来实现「刚聊过先跳过」）
    this.lastActiveAt = typeof lastActiveAt === 'function' ? lastActiveAt : null;
    this.file = config && config.paths && config.paths.dataDir
      ? path.join(config.paths.dataDir, 'reminders.json')
      : '';
    this.items = [];
    this.load();
  }

  load() {
    let damaged = false;
    for (const file of [this.file, this.file + '.bak']) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (!raw || !Array.isArray(raw.items) || raw.items.some(it =>
          !it || !it.id || !Number.isFinite(Number(it.dueAt)) || !Number(it.dueAt)
          || (!ACTIVE.has(it.status) && !DONE.has(it.status)))) throw new Error('提醒文件格式不正确');
        this.items = raw.items.slice(-MAX_TOTAL);
        this.loadFailed = false;
        if (file !== this.file && this.logger) this.logger.warn('提醒主文件不可用，已从 .bak 恢复');
        return this;
      } catch (err) {
        if (err.code !== 'ENOENT') {
          damaged = true;
          if (this.logger) this.logger.warn('提醒读取失败：' + file + '：' + err.message);
        }
      }
    }
    // 两份都损坏时保留原件，不能用一次新建操作把可恢复的数据覆盖掉。
    this.loadFailed = damaged;
    this.items = [];
    return this;
  }

  save() {
    if (!this.file || this.loadFailed) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = JSON.stringify({ version: 1, savedAt: this.now(), items: this.items });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, body, 'utf8');
      fs.renameSync(tmp, this.file);
      // 镜像最新已提交状态，避免备份仍是 pending 而主文件已经 done。
      try {
        fs.writeFileSync(this.file + '.bak.tmp', body, 'utf8');
        fs.renameSync(this.file + '.bak.tmp', this.file + '.bak');
      } catch (err) {
        if (this.logger) this.logger.warn('提醒备份写入失败：' + err.message);
      }
      return true;
    } catch (err) {
      if (this.logger) this.logger.warn('提醒写入失败：' + err.message);
      return false;
    }
  }

  // 落盘失败就还原内存，不能向桥接交付没有持久化的任务。
  commit(previous) {
    if (this.save()) return;
    this.items = previous;
    throw Object.assign(new Error('提醒保存失败，请检查数据目录权限或磁盘空间'), { statusCode: 503 });
  }

  activeOf(wxid) {
    return this.items.filter((it) => it.wxid === wxid && ACTIVE.has(it.status));
  }

  /** 当前时刻的规则状态（时间段 / 今天还能发几条） */
  rules(now = this.now()) {
    const rules = normalizeRules(this.config);
    const d = new Date(now);
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    // 已发送 + 在途（sending/retrying）都占当日额度：
    // 只数 done 的话，桥接还没回执时连续领取能突破每日上限。
    const sentToday = this.items.filter((it) => {
      if (it.status === 'done') return Number(it.finishedAt) >= dayStart;
      if (it.status === 'sending' || it.status === 'retrying') {
        const at = Number(it.claimedAt || it.dueAt || 0);
        return at >= dayStart;
      }
      return false;
    }).length;
    return {
      ...rules,
      sentToday,
      remaining: rules.dailyCap ? Math.max(0, rules.dailyCap - sentToday) : Infinity,
    };
  }

  /**
   * 新建提醒。任何人都能用（群友也行），但限流：同一会话最多 20 条未发、全局 500 条。
   * 规则和主动搭话一致：总开关、时间段、每天上限（这些都能在「提醒」页里单独改）。
   */
  add({ wxid, name = '', chatType = 'private', text, at, atName = '', createdAt } = {}) {
    const chatId = clean(wxid, 120);
    const what = clean(text, 200);
    const dueAt = at instanceof Date ? at.getTime() : Number(at);
    if (!chatId) throw Object.assign(new Error('缺少会话'), { statusCode: 400 });
    if (!what) throw Object.assign(new Error('没说提醒什么事'), { statusCode: 400 });
    if (!Number.isFinite(dueAt) || dueAt <= this.now()) throw Object.assign(new Error('提醒时间已经过了'), { statusCode: 400 });
    const rules = this.rules();
    if (!rules.enabled) throw Object.assign(new Error('提醒功能关着（启动器「提醒」页可以开）'), { statusCode: 403 });
    if (rules.dailyCap && rules.sentToday >= rules.dailyCap) {
      throw Object.assign(new Error(`今天提醒次数已用完（${rules.dailyCap} 次），明天再来`), { statusCode: 429 });
    }
    if (this.activeOf(chatId).length >= MAX_ACTIVE_PER_CHAT) {
      throw Object.assign(new Error('这个会话未发送的提醒太多（20 条），先取消几条'), { statusCode: 429 });
    }
    if (this.items.filter((it) => ACTIVE.has(it.status)).length >= MAX_TOTAL) {
      throw Object.assign(new Error('提醒太多了，先清理一些'), { statusCode: 429 });
    }
    const item = {
      id: crypto.randomUUID(),
      wxid: chatId,
      name: clean(name, 80) || chatId,
      chatType: chatType === 'group' ? 'group' : 'private',
      atName: clean(atName, 60),
      text: what,
      dueAt,
      status: 'pending',
      attempts: 0,
      error: '',
      createdAt: Number(createdAt) || this.now(),
      claimedAt: 0,
      retryAt: 0,
      finishedAt: 0,
    };
    const previous = JSON.parse(JSON.stringify(this.items));
    this.items.push(item);
    this.trim();
    this.commit(previous);
    return { ...item };
  }

  /** 只保留最近 500 条（先丢已结束的，再丢最老的） */
  trim() {
    if (this.items.length <= MAX_TOTAL) return;
    const finished = this.items.filter((it) => DONE.has(it.status));
    const alive = this.items.filter((it) => !DONE.has(it.status));
    const drop = this.items.length - MAX_TOTAL;
    const keptFinished = finished.slice(Math.min(drop, finished.length));
    const stillOver = drop - (finished.length - keptFinished.length);
    this.items = [...(stillOver > 0 ? alive.slice(stillOver) : alive), ...keptFinished]
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * 过期清理。
   *
   * 两套门槛，因为要求本身分两层：
   *  - 运行中（strict=false）：留给「5 分钟后重试一次」的时间，重试时刻本身不能被判过期；
   *  - 启动时（strict=true）：过了提醒时间 + 5 分钟还没发，一律标过期、永不补发
   *    （「重启后超过提醒时间、又没标结束的，不要发」）。
   */
  expire(now = this.now(), { strict = false } = {}) {
    let expired = 0;
    const previous = JSON.parse(JSON.stringify(this.items));
    for (const item of this.items) {
      if (!ACTIVE.has(item.status)) continue;
      if (strict && now > Number(item.dueAt) + RETRY_DELAY_MS) {
        item.status = 'expired';
        item.error = '过了提醒时间，未发送（不补发）';
        item.finishedAt = now;
        expired += 1;
        continue;
      }
      if (item.status === 'sending') {
        if (now - Number(item.claimedAt || 0) > CLAIM_TIMEOUT_MS) {
          item.attempts = Number(item.attempts || 0) + 1;
          // 宽限期（dueAt + 5 分钟）之后一律不再放回去重发：
          // 否则桥接卡很久再回来，会把早就过点的提醒重新发出去。
          const overdue = now > Number(item.dueAt) + RETRY_DELAY_MS;
          if (overdue || item.attempts >= 2) {
            item.status = overdue ? 'expired' : 'failed';
            item.error = overdue ? '过了提醒时间，未发送（不补发）' : '发送回执超时，停止重试';
            item.finishedAt = now;
            expired += 1;
            continue;
          }
          item.status = 'retrying';
          item.retryAt = now;
        } else {
          continue;
        }
      }
      const deadline = item.status === 'retrying'
        ? Number(item.retryAt || 0) + (strict ? 0 : 60 * 1000)
        : Number(item.dueAt) + RETRY_DELAY_MS;
      if (now > deadline) {
        item.status = 'expired';
        item.error = item.error || '过了提醒时间，未发送（不补发）';
        item.finishedAt = now;
        expired += 1;
      }
    }
    if (JSON.stringify(previous) !== JSON.stringify(this.items)) this.commit(previous);
    return { expired };
  }

  /** 启动时扫一遍：严格的过期（没有重试宽限） */
  sweepStale(now = this.now()) {
    return this.expire(now, { strict: true });
  }

  /**
   * 桥接来领任务：返回此刻该发的（pending，或到了重试时间的 retrying）。
   * 领取即置 sending，防止同一条被两个轮次同时发出去。
   *
   * 规则和主动搭话一致：总开关、时间段、每天上限。和主动搭话不同的是——
   * 提醒是准点事件，所以超出规则时**不推迟**，直接标 expired 并写明原因
   * （推迟就变成「不是那个点提醒了」，跟没提醒差不多）。
   */
  due(now = this.now(), { limit = 10 } = {}) {
    this.expire(now, { strict: false });
    const rules = this.rules(now);
    const out = [];
    const previous = JSON.parse(JSON.stringify(this.items));
    // 已领取但尚未回执的任务也占用每日额度，防止多轮领取超限。
    const reserved = this.items.filter(it => it.status === 'sending').length;
    for (const item of this.items) {
      if (out.length >= limit) break;
      if (item.status !== 'pending' && item.status !== 'retrying') continue;
      if (Number(item.dueAt) > now) continue;
      if (item.status === 'retrying' && Number(item.retryAt) > now) continue;
      if (!rules.enabled) {
        item.status = 'expired';
        item.error = '提醒功能已关闭';
        item.finishedAt = now;
        continue;
      }
      if (rules.quietAfterMinutes && this.lastActiveAt) {
        let last = 0;
        try { last = Number(this.lastActiveAt(item.wxid)) || 0; } catch { last = 0; }
        if (last && now - last < rules.quietAfterMinutes * 60000) {
          item.status = 'expired';
          item.error = `刚聊过（${rules.quietAfterMinutes} 分钟内），按规则不打扰，不补发`;
          item.finishedAt = now;
          continue;
        }
      }
      if (rules.dailyCap && rules.sentToday + reserved + out.length >= rules.dailyCap) {
        item.status = 'expired';
        item.error = `今天提醒次数已满（${rules.dailyCap} 次），不补发`;
        item.finishedAt = now;
        continue;
      }
      item.status = 'sending';
      item.claimedAt = now;
      out.push({ ...item });
    }
    if (JSON.stringify(previous) !== JSON.stringify(this.items)) this.commit(previous);
    return out;
  }

  /** 下一条还没发的提醒什么时候到（桥接据此睡到点，别 10 秒轮询） */
  nextDueAt(now = this.now()) {
    let next = 0;
    for (const item of this.items) {
      if (item.status === 'pending') {
        const at = Number(item.dueAt);
        const wakeAt = Math.max(now, at);
        if (!next || wakeAt < next) next = wakeAt;
      } else if (item.status === 'retrying') {
        const at = Math.max(Number(item.dueAt), Number(item.retryAt) || 0);
        const wakeAt = Math.max(now, at);
        if (!next || wakeAt < next) next = wakeAt;
      } else if (item.status === 'sending') {
        const at = Math.max(now, Number(item.claimedAt || 0) + CLAIM_TIMEOUT_MS + 1);
        if (!next || at < next) next = at;
      }
    }
    return next;
  }

  /** 回执：成功 → done；失败 → 还允许重试就 retrying（+5 分钟），否则 failed */
  ack(id, { ok = false, error = '' } = {}) {
    const item = this.items.find((it) => it.id === String(id || ''));
    if (!item) return { ok: false, error: '找不到这条提醒', statusCode: 404 };
    if (item.status === 'done' && ok) return { ok: true, item: { ...item } };
    if (item.status !== 'sending') return { ok: false, error: '提醒已结束或尚未领取，不能更新回执', statusCode: 409 };
    const previous = JSON.parse(JSON.stringify(this.items));
    const now = this.now();
    item.attempts = Number(item.attempts || 0) + 1;
    if (ok) {
      item.status = 'done';
      item.error = '';
      item.finishedAt = now;
    } else if (item.attempts < 2 && now <= Number(item.dueAt) + RETRY_DELAY_MS) {
      item.status = 'retrying';
      item.retryAt = now + RETRY_DELAY_MS;
      item.error = clean(error, 200) || '发送失败，5 分钟后重试';
    } else {
      item.status = 'failed';
      item.error = clean(error, 200) || '发送失败';
      item.finishedAt = now;
    }
    this.commit(previous);
    return { ok: true, item: { ...item } };
  }

  cancel(id) {
    const item = this.items.find((it) => it.id === String(id || ''));
    if (!item) return { ok: false, error: '找不到这条提醒', statusCode: 404 };
    if (item.status === 'sending') return { ok: false, error: '提醒正在发送，已无法保证撤回，请等待发送结果', statusCode: 409 };
    if (!ACTIVE.has(item.status)) return { ok: false, error: '这条提醒已经结束了', statusCode: 409 };
    const previous = JSON.parse(JSON.stringify(this.items));
    item.status = 'cancelled';
    item.finishedAt = this.now();
    this.commit(previous);
    return { ok: true, item: { ...item } };
  }

  /** 给启动器看的列表（新的在前） */
  list({ limit = 100 } = {}) {
    return this.items.slice(-limit).reverse().map(({ id, wxid, name, chatType, text, dueAt, status, attempts, error, createdAt, finishedAt }) => ({
      id, wxid, name, chatType, text, dueAt, status, attempts, error, createdAt, finishedAt,
    }));
  }

  /** 某个会话自己的未发提醒（「我设过哪些提醒」用） */
  pendingFor(wxid) {
    return this.items.filter((it) => it.wxid === String(wxid || '') && ACTIVE.has(it.status));
  }
}

module.exports = { ReminderService, normalizeRules, RETRY_DELAY_MS, CLAIM_TIMEOUT_MS, MAX_TOTAL, MAX_ACTIVE_PER_CHAT };
