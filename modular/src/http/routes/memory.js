'use strict';

const fs = require('node:fs');
const path = require('node:path');
const memoryBackup = require('../../memory/backup');
const { storeSummary } = require('../../services/status');
const { json, readBody, sanitizeId } = require('../util');

module.exports = function register(router) {
  // ---- 记忆备份 / 恢复 ----
  router.get('/api/memory/info', (runtime, req, res) => {
    const bundle = memoryBackup.collect(runtime.config.root);
    const backups = memoryBackup.listBackups(runtime.config.root);
    return json(res, 200, {
      ok: true,
      current: memoryBackup.summarize(bundle),
      backups: backups.map((b) => ({ name: b.name, mtime: b.mtime, ...{ sessions: b.sessions, messages: b.messages, notes: b.notes } })),
      dir: memoryBackup.backupDir(runtime.config.root),
    });
  });

  router.get('/api/memory/export', (runtime, req, res) => {
    // 先把内存里的记忆落盘，再打包下载
    try { runtime.store.flush(); } catch { /* ignore */ }
    // 默认脱敏：导出文件经常被发人 / 传 U 盘，不能把 Key 一起带出去
    const includeSecrets = /(?:^|[?&])secrets=1(?:&|$)/.test(String(req.url || ''));
    const bundle = memoryBackup.collect(runtime.config.root, { withSecrets: includeSecrets });
    const name = 'whale-memory-' + new Date().toISOString().slice(0, 10) + '.json';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(bundle, null, 2));
    return true;
  });

  router.post('/api/memory/backup', (runtime, req, res) => {
    try { runtime.store.flush(); } catch { /* ignore */ }
    const file = memoryBackup.writeSnapshot(runtime.config.root, 'manual');
    if (!file) return json(res, 200, { ok: true, file: '', message: '还没有记忆，不用备份' });
    runtime.logger.info('手动记忆快照：' + file);
    return json(res, 200, { ok: true, file });
  });

  router.post('/api/memory/restore', async (runtime, req, res) => {
    const body = await readBody(req);
    try {
      let info;
      if (body && body.bundle) {
        info = memoryBackup.restoreFrom(runtime.config.root, body.bundle);
      } else if (body && body.name) {
        const safeName = path.basename(String(body.name)); // 防 ../ 穿越：只认备份目录里的文件名
        const target = path.join(memoryBackup.backupDir(runtime.config.root), safeName);
        if (!fs.existsSync(target)) {
          return json(res, 400, { ok: false, error: '找不到这个快照：' + safeName });
        }
        info = memoryBackup.restoreFromFile(runtime.config.root, target);
      } else {
        return json(res, 400, { ok: false, error: '要带 name（快照文件名）或 bundle（导出的内容）' });
      }
      // 让内存里的记忆立刻跟上文件，不然下一次写盘会把恢复的内容盖回去
      let reloaded = 0;
      try { reloaded = runtime.store.reloadFromDisk(); } catch (err) { runtime.logger.warn('恢复后重载记忆失败：' + err.message); }
      runtime.logger.info('记忆已恢复：' + info.restored.join('、') + `（重载 ${reloaded} 个会话）`);
      return json(res, 200, { ok: true, restored: info.restored, current: { sessions: info.sessions, messages: info.messages, notes: info.notes }, needRestart: false });
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message });
    }
  });

  // ---- 网页当前会话的记忆 ----
  router.get('/api/memory', (runtime, req, res, info) => {
    const sessionId = sanitizeId(info.url.searchParams.get('sessionId') || 'default');
    const mode = info.url.searchParams.get('mode') === 'group' ? 'group' : 'private';
    const key = `web:${mode === 'group' ? 'g' : 'u'}:${sessionId}:${mode}`;
    const sessions = {
      private: runtime.store.listNotes(`web:u:${sessionId}:private`),
      group: runtime.store.listNotes(`web:g:${sessionId}:group`),
    };
    return json(res, 200, { ok: true, key, notes: sessions[mode], all: sessions, summary: storeSummary(runtime) });
  });
};
