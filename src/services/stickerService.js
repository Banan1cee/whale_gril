'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const stickers = require('../adapters/stickers');
const probe = require('../infra/probe');
const ACTIVE = new Set(['queued', 'reserved', 'sending']);
const TERMINAL = new Set(['confirmed', 'unconfirmed', 'failed', 'cancelled']);
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

/** Ephemeral, one-shot delivery jobs. Never replay a persisted queue after restart. */
class StickerService {
  constructor(config, { now = Date.now, rng = Math.random, store = null, logger = null } = {}) {
    this.config = config;
    this.now = now;
    this.rng = rng;
    // 动作账本：把「发了哪张、成没成」写回会话，模型下一轮才知道自己干过什么
    this.store = store || null;
    this.logger = logger || null;
    this.enabled = false;
    this.generation = '';
    this.jobs = new Map();
    this.recent = new Map();
    this.libraryDir = '';
    this.migration = { moved: 0, deduplicated: 0, errors: [] };
    // 探针：这一行直接量「构造函数里的同步磁盘工作」，也就是 listen 之前被堵住的时长
    const t0 = probe.now();
    this.reconcile();
    // 总闸关着时一行日志都不许有（既有测试就是这么约定的），所以只在启用时打
    if (this.enabled) probe.emit(logger, 'info', `构造/reconcile 耗时=${probe.ms(probe.now() - t0)}ms`);
  }
  reconcile() {
    const t0 = probe.now();
    const enabled = stickers.isOn(this.config);
    if (enabled !== this.enabled) {
      // Invalidates fetched/inflight jobs even if the feature is switched off and back on.
      this.generation = crypto.randomUUID();
      this.enabled = enabled;
      if (!enabled) for (const job of this.jobs.values()) {
        if (ACTIVE.has(job.status)) {
          job.status = 'cancelled'; job.error = '总开关已关闭，任务已取消';
          this._note(job, 'cancelled');
        }
      }
    }
    for (const job of this.jobs.values()) {
      // 卡住的任务 90 秒就释放：以前是 5 分钟，失败一次就把这个会话堵 5 分钟，
      // 用户感觉「25% 概率压根没生效」。
      if (ACTIVE.has(job.status) && this.now() - job.at > 90 * 1000) {
        job.status = job.status === 'sending' ? 'unconfirmed' : 'cancelled';
        job.error = '任务超时，未自动重试';
        // 不许再静默改状态：超时作废也要留一行，方便回查为什么那张图没发出去
        if (this.logger && enabled) {
          this.logger.warn(`表情包任务超时作废：会话=${job.chat || job.key || '-'} 状态=${job.status}`);
        }
        this._note(job, job.status);
      }
    }
    if (enabled) {
      const dir = stickers.stickerDir(this.config, this.config.root);
      // 内置分类（傲娇 / 炸毛 / 开心）的文件夹被删了要补回来；自定义分类不碰
      try {
        const created = stickers.ensureBuiltinDirs(this.config, this.config.root);
        if (created.length) {
          this.restored = (this.restored || []).concat(created);
          if (this.logger) this.logger.info('表情包内置分类文件夹已补回：' + created.join('、'));
        }
      } catch { /* 目录建不出来不影响其它逻辑 */ }
      // Migrate once per enabled library; never move a file held by an active job.
      if (this.libraryDir !== dir && ![...this.jobs.values()].some((j) => ACTIVE.has(j.status))) {
        this.migration = stickers.migrateLegacy(this.config, this.config.root);
        this.libraryDir = dir;
        const m = this.migration;
        if (m && (m.moved || m.deduplicated) && this.logger) {
          this.logger.info(`表情包旧分类已并入「开心」：迁移 ${m.moved} 张、去重 ${m.deduplicated} 张`
            + (m.rootImages ? `（含根目录 ${m.rootImages} 张）` : '')
            + (m.errors && m.errors.length ? `、${m.errors.length} 张失败（原图保留）` : ''));
        } else if (m && this.logger) {
          // 根目录的图只有并进「开心」才会被发出去；没搬成要明确告诉用户，别让它们静默失效
          const left = stickers.listImages(dir, { root: dir, recursive: false })
            .filter((file) => path.dirname(file) === path.resolve(dir)).length;
          if (left) this.logger.warn(`data/stickers 根目录还有 ${left} 张图没并进「开心」，它们不会被发送`);
        }
      }
    } else this.libraryDir = '';
    // Preserve active jobs, but bound terminal history and session caches.
    const completed = [...this.jobs.values()].filter((j) => !ACTIVE.has(j.status));
    for (const job of completed.slice(0, Math.max(0, completed.length - 50))) this.jobs.delete(job.id);
    while (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value);
    // 探针：热路径（status/plan 都会调 reconcile）只在真的慢时留一行
    const cost = probe.now() - t0;
    if (cost > 20) probe.emit(this.logger, cost > 200 ? 'warn' : 'debug', `reconcile 耗时=${probe.ms(cost)}ms 启用=${enabled}`);
    return enabled;
  }
  requireEnabled() { if (!this.reconcile()) throw fail('表情包功能未开启', 404); }
  add(hit, chat, chatUsername = '', key = '', status = 'queued') {
    if ([...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length >= 20) throw fail('表情包任务已满，请先等待现有任务结束', 429);
    const job = { id: crypto.randomUUID(), ...hit, chat, chatUsername, key, status, generation: this.generation, at: this.now(), error: '' };
    this.jobs.set(job.id, job);
    return { ...job };
  }
  /** 记一条动作账：模型看不见「发出去了」这件事，只能靠这里回读 */
  _note(job, status) {
    if (!this.store || !job || !job.sessionKey) return;
    const name = job.path ? path.basename(job.path) : '';
    // 用中文分类名，别把 cute/x:猫猫 这种内部 key 写进提示词
    const label = stickers.EMOTIONS[job.emotion] || String(job.emotion || '').replace(/^x:/, '');
    // 模型原话和实际发的不一致时写清楚，否则模型下一轮会以为自己发的是原来那类
    const fallback = job.fallbackFrom ? `（原写「${job.fallbackFrom}」）` : '';
    const detail = ([label, name].filter(Boolean).join('/') || '表情包') + fallback;
    try {
      // 回执到了就改写排队那条，一次发送只占一行
      if (job.eventTs && typeof this.store.updateEvent === 'function'
        && this.store.updateEvent(job.sessionKey, job.eventTs, { status })) return;
      const entry = this.store.appendEvent(job.sessionKey, { type: 'sticker', detail, status });
      if (entry) job.eventTs = entry.ts;
    } catch { /* 记账失败不影响发送 */ }
  }
  /** category 由模型在回复里用 [[sticker:分类]] 指定；没给就什么都不发 */
  plan(msg, category = '') {
    if (!this.reconcile() || msg?.platform !== 'wechat' || !msg.chatId) return null;
    const key = `wechat:${msg.chatId}`;
    const chatName = msg.chatTitle || msg.chatId;
    // No cooldown after a completed send. An in-flight job remains exclusive until
    // ACK or the 90s expiry; the old 45s bypass could queue two sends for one chat.
    // 同一会话只允许一条在飞任务：既比会话 key，也比会话名。
    // 手动排队的测试任务 key 为空，只比 key 挡不住它。
    if ([...this.jobs.values()].some(
      (j) => ACTIVE.has(j.status) && (j.key === key || j.chat === chatName))) return null;
    const hit = stickers.pick({ config: this.config, root: this.config.root, category,
      recent: this.recent.get(key) || [], rng: this.rng });
    if (!hit) {
      if (category && this.logger) this.logger.warn(`表情包分类「${category}」没有对应图片，这次没发`);
      return null;
    }
    if (hit.fallbackFrom && this.logger) {
      const to = stickers.EMOTIONS[hit.emotion] || String(hit.emotion || '').replace(/^x:/, '');
      this.logger.warn(`表情包分类「${hit.fallbackFrom}」不存在或无图，改发「${to}」`);
    }
    const added = this.add(hit, chatName, msg.chatId, key, 'reserved');
    const job = this.jobs.get(added.id);
    // 会话 key 和聊天记录一致（wechat:u:/wechat:g:），ack 回来才写得到同一段上下文
    if (job) job.sessionKey = `wechat:${msg.chatType === 'group' ? 'g' : 'u'}:${String(msg.chatId).slice(0, 120)}`;
    this._note(job, 'queued');
    return { ...added };
  }
  enqueue(emotion, chat) {
    this.requireEnabled();
    emotion = stickers.normalizeEmotion(emotion);
    if (!emotion) throw fail('请选择有效的情绪');
    chat = String(chat || '').trim();
    if (!chat || chat.length > 160 || /[\r\n\x00-\x1f]/.test(chat)) throw fail('请输入明确的目标会话名称');
    const existing = [...this.jobs.values()].find(j => ACTIVE.has(j.status) && (j.chat === chat || j.chatUsername === chat));
    if (existing) return { ...existing, deduplicated: true };
    const file = stickers.choose(stickers.imagesFor(stickers.stickerDir(this.config, this.config.root), emotion), this.rng);
    if (!file) throw fail('这一类还没有图片（也没有「通用」图），先往这个分类里拖几张');
    return this.add({ emotion, path: file }, chat);
  }
  pending() {
    this.requireEnabled();
    return [...this.jobs.values()].filter((j) => j.status === 'queued').map((j) => ({ ...j }));
  }
  claim(id) {
    this.requireEnabled();
    const job = this.jobs.get(String(id || ''));
    if (!job) throw fail('找不到这个任务', 404);
    if (!['queued', 'reserved'].includes(job.status) || job.generation !== this.generation) throw fail('任务已领取、取消或过期，不能重复发送', 409);
    if (!stickers.regularFile(job.path, stickers.stickerDir(this.config, this.config.root))) {
      job.status = 'failed'; job.error = '表情包文件已删除或不安全'; this._note(job, 'failed'); throw fail(job.error);
    }
    job.status = 'sending';
    return { ...job };
  }
  ack(id, status, error = '') {
    this.requireEnabled();
    const job = this.jobs.get(String(id || ''));
    if (!job) throw fail('找不到这个任务', 404);
    if (job.status !== 'sending') throw fail('任务已结束或还未领取', 409);
    if (!TERMINAL.has(status)) throw fail('无效的发送状态');
    job.status = status;
    job.error = String(error || '').slice(0, 500);
    if (job.key && ['confirmed', 'unconfirmed'].includes(status)) {
      this.recent.set(job.key, [...(this.recent.get(job.key) || []), job.path].slice(-10));
    }
    this._note(job, status);
    return { ...job };
  }
  gate(id = '') {
    this.requireEnabled();
    return { ok: true, enabled: true, generation: this.generation,
      jobs: [...this.jobs.values()].filter(j => ACTIVE.has(j.status) && (!id || j.id === id))
        .map(({ id, status, generation }) => ({ id, status, generation })) };
  }
  status(queueOnly = false) {
    const t0 = probe.now();
    this.requireEnabled();
    const queue = this.queueStatus();
    if (queueOnly) return { ok: true, ...queue };
    const dir = stickers.stickerDir(this.config, this.config.root);
    const list = (key, label, extra) => {
      const items = stickers.categoryImages(dir, key).map((file) => ({
        name: path.basename(file), id: path.relative(dir, file).split(path.sep).join('/'),
      }));
      return { key, label, extra: Boolean(extra), files: items.map((item) => item.name), items,
        count: items.length };
    };
    const emotions = Object.keys(stickers.EMOTIONS).map((key) => list(key, stickers.EMOTIONS[key], false));
    for (const cat of stickers.readExtraCategories(this.config, this.config.root)) {
      const label = stickers.cleanCategoryLabel(cat && cat.label);
      const key = stickers.extraKey(label);
      if (!key) continue;
      emotions.push(list(key, label, true));
    }
    // 探针：status 的 RTT（启动器每 2s、网页每 3s 拉一次，这条就是它们等的时间）
    const total = emotions.reduce((sum, e) => sum + e.count, 0);
    const cost = probe.now() - t0;
    probe.emit(this.logger, cost > 300 ? 'warn' : 'debug',
      `status RTT=${probe.ms(cost)}ms 分类=${emotions.length} 张数=${total}`);
    return { ok: true, enabled: true, generation: this.generation, dir, migration: this.migration,
      testChat: this.config.sticker?.testChat || '文件传输助手', emotions, ...queue };
  }
  queueStatus() {
    return { pending: [...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length,
      jobs: [...this.jobs.values()].filter((j) => ACTIVE.has(j.status))
        .concat([...this.jobs.values()].filter((j) => !ACTIVE.has(j.status)).slice(-20).reverse())
        .map(({ id, status, error, chat, emotion, path: file }) =>
        ({ id, status, error, chat, emotion, filename: path.basename(file) })) };
  }
}
module.exports = { StickerService };
