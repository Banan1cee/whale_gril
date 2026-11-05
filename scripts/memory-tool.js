'use strict';

/**
 * 命令行记忆工具（不依赖服务是否在跑）：
 *
 *   node scripts/memory-tool.js list              列出已有快照
 *   node scripts/memory-tool.js backup            立刻备份一份到 data\backups
 *   node scripts/memory-tool.js export <文件>     导出到指定位置（比如桌面）
 *   node scripts/memory-tool.js restore <文件>    从备份文件恢复（会先备份当前记忆）
 *   node scripts/memory-tool.js import <文件>     把 3.x 旧记忆（store.json / memory.json / 旧备份包）灌进 v2
 *   node scripts/memory-tool.js info              看一眼现在有多少记忆
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const backup = require('../src/memory/backup');
const migrate = require('../src/memory/migrate');
const { ChatStore } = require('../src/memory/chatStore');

const root = path.resolve(__dirname, '..');
const [cmd = 'info', arg = '', ...rest] = process.argv.slice(2);
const withSecrets = rest.includes('--secrets') || arg === '--secrets';
const asJson = rest.includes('--json') || arg === '--json';
const dryRun = rest.includes('--dry-run') || arg === '--dry-run';

/** 服务在跑的时候写记忆会被内存里的旧状态盖回去，导入前先探一下端口 */
async function serverRunning() {
  const serverUp = await new Promise((resolve) => {
    let port = 8787;
    try {
      const saved = Number(fs.readFileSync(path.join(root, 'data', 'server-port.txt'), 'utf8'));
      if (Number.isInteger(saved) && saved > 0 && saved < 65536) port = saved;
    } catch { /* 默认端口 */ }
    const probe = net.connect({ host: '127.0.0.1', port });
    probe.setTimeout(600, () => { probe.destroy(); resolve(false); });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  return serverUp;
}


function fmtTime(d) {
  const t = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`;
}

async function main() {
  if (cmd === 'list') {
    const items = backup.listBackups(root);
    if (asJson) {
      // 给启动器「恢复记忆」读的：只给元数据，不带正文
      console.log(JSON.stringify(items.map((it) => ({
        name: it.name, file: it.file, size: it.size, mtime: it.mtime,
        sessions: it.sessions, messages: it.messages, notes: it.notes,
      }))));
      return 0;
    }
    if (!items.length) {
      console.log('还没有快照。先跑一次 backup，或者启动一次服务（会自动留一份）。');
      return 0;
    }
    console.log('已有快照（新 → 旧）：');
    for (const it of items) {
      console.log(`  ${it.name}  ${fmtTime(it.mtime)}  ${it.sessions} 个聊天 / ${it.messages} 条消息 / ${it.notes} 条偏好`);
    }
    return 0;
  }

  if (cmd === 'info') {
    const b = backup.collect(root);
    const s = backup.summarize(b);
    console.log(`当前记忆：${s.sessions} 个聊天 / ${s.messages} 条消息 / ${s.notes} 条偏好`);
    console.log(`数据目录：${path.join(root, 'data', 'memory')}`);
    return 0;
  }

  if (cmd === 'backup') {
    const file = backup.writeSnapshot(root, 'manual');
    if (!file) {
      console.log('还没有任何记忆，不用备份。');
      return 0;
    }
    console.log('已备份：' + file);
    return 0;
  }

  if (cmd === 'export') {
    if (!arg) {
      console.error('用法：node scripts/memory-tool.js export <目标文件>');
      return 1;
    }
    const target = arg === '--secrets' ? (rest.find((x) => x !== '--secrets') || '') : arg;
    if (!target) {
      console.error('用法：node scripts/memory-tool.js export <目标文件> [--secrets]');
      return 1;
    }
    const dest = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    const info = backup.exportTo(root, dest, { withSecrets });
    console.log(`已导出：${info.file}`);
    console.log(`内容：${info.sessions} 个聊天 / ${info.messages} 条消息 / ${info.notes} 条偏好`);
    console.log(withSecrets ? '（这次连 Key 一起导出了，别发给别人）' : '（已自动去掉 API Key，可以放心发人；要连 Key 一起带走加 --secrets）');
    console.log('换电脑或重装后，用 restore 把这个文件放回去就行。');
    return 0;
  }

  if (cmd === 'import') {
    const target = arg === '--dry-run' ? (rest.find((x) => x !== '--dry-run') || '') : arg;
    if (!target) {
      console.error('用法：node scripts/memory-tool.js import <store.json|memory.json|旧备份包> [--dry-run]');
      return 1;
    }
    const file = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    if (!fs.existsSync(file)) {
      console.error('找不到文件：' + file);
      return 1;
    }
    const loaded = migrate.readSessionsFile(file);
    if (!loaded) {
      console.error('认不出这个文件（要 3.x 的 store.json / memory.json，或旧版备份包）：' + file);
      return 1;
    }
    if (!dryRun && await serverRunning()) {
      console.log('提示：服务在跑，直接写记忆会被内存里的旧状态盖回去。');
      console.log('      请先停止服务（关掉启动器，或运行 scripts\\stop-all.ps1）再导入。');
      return 1;
    }
    let chatStore = null;
    let report = null;
    try {
      // 导入会合并/重排原文，先给当前记忆留一份快照（空记忆时返回 null）
      if (!dryRun) backup.writeSnapshot(root, 'before-import');
      chatStore = new ChatStore({ dir: path.join(root, 'data', 'memory') });
      report = migrate.migrateSessions({
        chatStore,
        sessions: loaded.sessions,
        sourceName: `${loaded.name}（${loaded.format}）`,
        dryRun,
      });
    } finally {
      // dry-run 不落盘，连 flush 都省掉
      if (chatStore && !dryRun) chatStore.close();
    }
    if (asJson) {
      console.log(JSON.stringify({ file, format: loaded.format, dryRun, ...report }, null, 2));
      return 0;
    }
    const verb = dryRun ? '将导入' : '已导入';
    console.log(`${verb}：${report.imported} 个新聊天 / ${report.merged} 个已有聊天合并 / ${report.unchanged} 个没有变化 / ${report.skipped} 个跳过`);
    console.log(`实际${dryRun ? '会补' : '补进'}：${report.messages} 条消息 / ${report.notes} 条偏好`);
    for (const item of report.plan.slice(0, 20)) {
      const tag = item.imported ? '新增' : item.unchanged ? '无变化' : '合并';
      const detail = `+${item.messages} 条消息 / +${item.notes} 条偏好`;
      console.log(`  ${tag}  ${item.chatId}  ${detail}  现在共 ${item.totalMessages} 条`);
    }
    if (report.plan.length > 20) console.log(`  …还有 ${report.plan.length - 20} 个聊天`);
    if (dryRun) console.log('这是 dry-run：什么都没写。去掉 --dry-run 才会真的导入。');
    else console.log('导入前的记忆已另存到 data\\backups\\（当时没有记忆就跳过）；旧文件本身没有改动。');
    return 0;
  }

  if (cmd === 'restore') {
    // 服务在跑，直接改文件的话，内存里的旧记忆会在下次写盘时把文件盖回去
    const serverUp = await serverRunning();
    if (serverUp) {
      console.log('提示：服务在跑，直接改文件的话，内存里的旧记忆可能把文件盖回去。');
      console.log('      请先停止服务再恢复；记忆 v2 不提供网页或启动器正文恢复入口。');
      return 1;
    }
    if (!arg) {
      console.error('用法：node scripts/memory-tool.js restore <备份文件>');
      return 1;
    }
    const file = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
    if (!fs.existsSync(file)) {
      console.error('找不到文件：' + file);
      return 1;
    }
    const info = backup.restoreFromFile(root, file);
    console.log('已恢复：' + info.restored.join('、'));
    console.log(`现在有 ${info.sessions} 个聊天 / ${info.messages} 条消息 / ${info.notes} 条偏好`);
    console.log('恢复前的旧记忆已另存到 data\\backups\\，后悔了可以再 restore 回去。');
    console.log('如果服务正在运行，重启一下（关掉启动器再打开）才生效。');
    return 0;
  }

  console.error('未知命令：' + cmd);
  console.error('可用：list / info / backup / export <文件> / restore <文件> / import <文件> [--dry-run]');
  return 1;
}

main().then((code) => { process.exitCode = code; }).catch((err) => {
  console.error('出错了：' + (err && err.message ? err.message : err));
  process.exitCode = 1;
});
