'use strict';

const path = require('node:path');
const { json } = require('../util');
const { isLoopbackRequest } = require('../security');
const migrate = require('../../memory/migrate');

/**
 * 旧版（3.x）记忆的检测 / 转换。
 *
 * 启动时 Store 构造已经会自动迁移；这里额外提供：
 *   GET  /api/memory/import/status   只读检测：有没有旧格式、会补多少（dry-run）
 *   GET  /api/memory/import/notice   启动器用：有没有「刚导入完、还没提示过」的报告
 *   POST /api/memory/import/ack      提示展示完，标记已读（幂等）
 *   POST /api/memory/import          手动执行转换（幂等：签名已记录就什么都不做）
 *
 * 不提供任何记忆正文；只回计数。只允许本机调用。
 */

let running = false;

function memoryDirOf(runtime) {
  return path.join(runtime.config.paths.dataDir, 'memory');
}

module.exports = function register(router) {
  router.get('/api/memory/import/status', (runtime, req, res) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '旧记忆检测只允许在本机操作' });
    try {
      const status = migrate.legacyStatus({ memoryDir: memoryDirOf(runtime), chatStore: runtime.store.chatStore });
      return json(res, 200, { ok: true, ...status });
    } catch (err) {
      runtime.logger.warn('旧记忆检测失败：' + ((err && err.message) || err));
      return json(res, 500, { ok: false, error: '检测失败：' + ((err && err.message) || err) });
    }
  });

  router.get('/api/memory/import/notice', (runtime, req, res) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '旧记忆提示只允许在本机操作' });
    return json(res, 200, { ok: true, notice: migrate.readImportNotice(memoryDirOf(runtime)) });
  });

  router.post('/api/memory/import/ack', (runtime, req, res) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '旧记忆提示只允许在本机操作' });
    try {
      return json(res, 200, { ok: true, ...migrate.ackImportNotice(memoryDirOf(runtime)) });
    } catch (err) {
      return json(res, 500, { ok: false, error: (err && err.message) || String(err) });
    }
  });

  router.post('/api/memory/import', (runtime, req, res) => {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: '旧记忆转换只允许在本机操作' });
    if (running) return json(res, 409, { ok: false, error: '已经有一次转换在进行，稍等几秒再试' });
    running = true;
    try {
      const memoryDir = memoryDirOf(runtime);
      const result = migrate.migrateIfNeeded({
        memoryDir,
        chatStore: runtime.store.chatStore,
        logger: runtime.logger,
      });
      if (!result.report) {
        return json(res, 200, { ok: true, idle: true, pending: false, message: '没有发现待转换的旧版记忆' });
      }
      // 新建的 chat 要出现在 sessions 视图里；不重建对象，避免打断进行中的回复
      try { runtime.store.refreshSessions(); } catch { /* 视图同步失败不影响已落盘的数据 */ }
      const report = result.report;
      runtime.logger.info(
        `手动转换旧记忆：新增 ${report.imported} / 合并 ${report.merged} 个聊天、补 ${report.messages} 条消息、${report.notes} 条偏好`
      );
      return json(res, 200, {
        ok: true,
        idle: false,
        pending: false,
        sources: result.sources,
        imported: report.imported,
        merged: report.merged,
        unchanged: report.unchanged,
        skipped: report.skipped,
        messages: report.messages,
        notes: report.notes,
        chats: report.chats.length,
      });
    } catch (err) {
      runtime.logger.warn('手动转换旧记忆失败：' + ((err && err.message) || err));
      return json(res, 500, { ok: false, error: '转换失败：' + ((err && err.message) || err) });
    } finally {
      running = false;
    }
  });
};
