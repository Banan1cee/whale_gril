'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const stickers = require('./stickers');
const ACTIVE = new Set(['queued', 'reserved', 'sending']);
const TERMINAL = new Set(['confirmed', 'unconfirmed', 'failed', 'cancelled']);
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

/** Ephemeral, one-shot delivery jobs. Never replay a persisted queue after restart. */
class StickerService {
  constructor(config, { now = Date.now, rng = Math.random } = {}) {
    this.config = config;
    this.now = now;
    this.rng = rng;
    this.enabled = false;
    this.generation = '';
    this.jobs = new Map();
    this.recent = new Map();
    this.libraryDir = '';
    this.migration = { moved: 0, deduplicated: 0, errors: [] };
    this.reconcile();
  }
  reconcile() {
    const enabled = stickers.isOn(this.config);
    if (enabled !== this.enabled) {
      // Invalidates fetched/inflight jobs even if the feature is switched off and back on.
      this.generation = crypto.randomUUID();
      this.enabled = enabled;
      if (!enabled) for (const job of this.jobs.values()) {
        if (ACTIVE.has(job.status)) {
          job.status = 'cancelled'; job.error = '总开关已关闭，任务已取消';
        }
      }
    }
    for (const job of this.jobs.values()) {
      // 卡住的任务 90 秒就释放：以前是 5 分钟，失败一次就把这个会话堵 5 分钟，
      // 用户感觉「25% 概率压根没生效」。
      if (ACTIVE.has(job.status) && this.now() - job.at > 90 * 1000) {
        job.status = job.status === 'sending' ? 'unconfirmed' : 'cancelled';
        job.error = '任务超时，未自动重试';
      }
    }
    if (enabled) {
      const dir = stickers.stickerDir(this.config, this.config.root);
      // Migrate once per enabled library; never move a file held by an active job.
      if (this.libraryDir !== dir && ![...this.jobs.values()].some((j) => ACTIVE.has(j.status))) {
        this.migration = stickers.migrateLegacy(this.config, this.config.root);
        this.libraryDir = dir;
      }
    } else this.libraryDir = '';
    // Preserve active jobs, but bound terminal history and session caches.
    const completed = [...this.jobs.values()].filter((j) => !ACTIVE.has(j.status));
    for (const job of completed.slice(0, Math.max(0, completed.length - 50))) this.jobs.delete(job.id);
    while (this.recent.size > 2000) this.recent.delete(this.recent.keys().next().value);
    return enabled;
  }
  requireEnabled() { if (!this.reconcile()) throw fail('表情包功能未开启', 404); }
  add(hit, chat, chatUsername = '', key = '', status = 'queued') {
    if ([...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length >= 20) throw fail('表情包任务已满，请先等待现有任务结束', 429);
    const job = { id: crypto.randomUUID(), ...hit, chat, chatUsername, key, status, generation: this.generation, at: this.now(), error: '' };
    this.jobs.set(job.id, job);
    return { ...job };
  }
  plan(msg, text, request = '') {
    if (!this.reconcile() || msg?.platform !== 'wechat' || !msg.chatId) return null;
    const key = `wechat:${msg.chatId}`;
    // No cooldown after a completed send. An in-flight job remains exclusive until
    // ACK or the 90s expiry; the old 45s bypass could queue two sends for one chat.
    if ([...this.jobs.values()].some((j) => j.key === key && ACTIVE.has(j.status))) return null;
    const hit = stickers.pick({ config: this.config, root: this.config.root, key, text, request,
      recent: this.recent.get(key) || [], rng: this.rng });
    if (!hit) return null;
    return this.add(hit, msg.chatTitle || msg.chatId, msg.chatId, key, 'reserved');
  }
  enqueue(emotion, chat) {
    this.requireEnabled();
    emotion = stickers.normalizeEmotion(emotion);
    if (!emotion) throw fail('请选择有效的情绪');
    chat = String(chat || '').trim();
    if (!chat || chat.length > 160 || /[\r\n\x00-\x1f]/.test(chat)) throw fail('请输入明确的目标会话名称');
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
      job.status = 'failed'; job.error = '表情包文件已删除或不安全'; throw fail(job.error);
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
    return { ...job };
  }
  status() {
    this.requireEnabled();
    const dir = stickers.stickerDir(this.config, this.config.root);
    const emotions = Object.keys(stickers.EMOTIONS).map((key) => {
      const items = stickers.categoryImages(dir, key).map((file) => ({
        name: path.basename(file), id: path.relative(dir, file).split(path.sep).join('/'),
      }));
      return { key, label: stickers.EMOTIONS[key], files: items.map((item) => item.name), items,
        count: items.length, chance: stickers.chanceFor(this.config, key) };
    });
    return { ok: true, enabled: true, generation: this.generation, dir, migration: this.migration,
      testChat: this.config.sticker?.testChat || '文件传输助手', emotions,
      pending: [...this.jobs.values()].filter((j) => ACTIVE.has(j.status)).length,
      jobs: [...this.jobs.values()].filter((j) => ACTIVE.has(j.status))
        .concat([...this.jobs.values()].filter((j) => !ACTIVE.has(j.status)).slice(-20))
        .map(({ id, status, error, chat, emotion, path: file }) =>
        ({ id, status, error, chat, emotion, filename: path.basename(file) })) };
  }
}
module.exports = { StickerService };
