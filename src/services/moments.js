'use strict';

const { randomUUID } = require('node:crypto');
const { clean } = require('../infra/text');

function fail(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

// 朋友圈含第三方隐私：只保留一份短期内存结果，不落盘、不进聊天记忆。
class MomentsService {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.job = null;
    this.expiry = null;
  }
  current(id) {
    const job = this.job;
    if (job && this.now() - job.at > 5 * 60000) this.job = null;
    if (!this.job || job.id !== id) throw fail('读取任务已失效，请重新读取', 404);
    if (['queued', 'reading'].includes(job.status) && this.now() - job.at > 90000) {
      job.status = 'failed';
      job.error = '朋友圈读取超时，请确认桥接正在运行、微信已登录';
    }
    return job;
  }
  request(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail('读取参数格式无效');
    if (this.job) {
      try {
        if (['queued', 'reading'].includes(this.current(this.job.id).status)) throw fail('已有读取任务，请稍候', 409);
      } catch (err) { if (err.statusCode !== 404) throw err; }
    }
    const limit = body.limit === undefined ? 20 : Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw fail('读取条数应为 1～50');
    this.job = { id: randomUUID(), at: this.now(), status: 'queued', error: '', items: [], account: '',
      query: { limit, keyword: clean(body.keyword, 100), username: clean(body.username, 120), own: body.own === true } };
    clearTimeout(this.expiry);
    this.expiry = setTimeout(() => { this.job = null; }, 5 * 60000);
    this.expiry.unref?.();
    return this.result(this.job.id);
  }
  claim(account) {
    if (!account || !this.job) return null;
    if (this.now() - this.job.at > 5 * 60000) { this.job = null; return null; }
    const job = this.current(this.job.id);
    if (job.status !== 'queued') return null;
    job.status = 'reading';
    job.account = clean(account, 120);
    return { id: job.id, query: job.query, action: job.action || 'read' };
  }
  action(body = {}) {
    if (!body || !['like', 'unlike', 'comment', 'reply'].includes(body.action)) throw fail('不支持的朋友圈操作');
    const publisher = clean(body.publisher, 120), keyword = clean(body.keyword, 100);
    const content = clean(body.content, 1000), replyTo = clean(body.replyTo, 120);
    if (!publisher || !keyword) throw fail('请同时填写发布者昵称和动态正文关键词');
    if (['comment', 'reply'].includes(body.action) && !content) throw fail('评论内容不能为空');
    if (body.action === 'reply' && !replyTo) throw fail('请填写被回复者昵称');
    this.request();
    this.job.action = body.action;
    this.job.query = { publisher, keyword, content, replyTo };
    return this.result(this.job.id);
  }
  complete(body = {}) {
    if (!body || typeof body !== 'object') throw fail('朋友圈结果格式无效');
    const job = this.current(body.id);
    if (job.status !== 'reading' || body.account !== job.account) throw fail('任务或账号已变化，拒绝写入结果', 409);
    if (body.error) {
      job.status = 'failed';
      // 桥接只传固定错误码，原始异常/本机路径不进入接口结果。
      job.error = body.error === 'unsupported' ? '当前微信依赖不支持读取朋友圈' : '读取失败：请确认当前账号存在朋友圈缓存、微信已登录且权限一致';
    } else if (job.action) {
      job.status = body.performed === true ? 'unconfirmed' : 'failed';
      job.error = body.performed === true ? '已执行界面操作，未核验微信服务器结果，请在微信中确认；不要重复点击。' : '操作未完成，请在微信中检查目标动态和可能留下的评论草稿。';
    } else {
      if (!Array.isArray(body.items)) throw fail('朋友圈结果格式无效');
      job.items = body.items.slice(0, job.query.limit).filter(x => x && typeof x === 'object').map(x => ({
        id: clean(x.id, 120), username: clean(x.username, 120), nickname: clean(x.nickname, 120),
        text: clean(x.text, 6000), create_time: Number.isFinite(Number(x.create_time)) ? Number(x.create_time) : 0,
        imageCount: Math.max(0, Math.min(100, Number(x.imageCount) || 0)),
        videoCount: Math.max(0, Math.min(100, Number(x.videoCount) || 0)),
      }));
      job.status = 'done';
    }
    return this.result(job.id);
  }
  result(id) {
    const j = this.current(id);
    return { ok: true, id: j.id, status: j.status, error: j.error, account: j.account, items: j.items };
  }
}

module.exports = { MomentsService };
