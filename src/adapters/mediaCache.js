'use strict';

/**
 * 媒体缓存清理。
 *
 * `data/media-cache` 里会堆：微信图片、表情包转码结果、语音转出来的 wav。
 * 以前从不清理，挂几个月就是几百 MB —— 实测一台机器 131 个文件 / 8.8 MB，只是没到「明显」的程度。
 * 现在启动时清一次：先按天数（默认 7 天），再按总量（默认 500MB）从最旧的删。
 */
const fs = require('node:fs');
const path = require('node:path');

function listFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...listFiles(full));
      continue;
    }
    try {
      const st = fs.statSync(full);
      out.push({ file: full, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* 文件刚好被删，跳过 */
    }
  }
  return out;
}

/**
 * @returns {{removed:number, freedMB:number, kept:number}}
 */
function cleanup(dir, { maxAgeDays = 7, maxTotalMB = 500, now = Date.now() } = {}) {
  const files = listFiles(dir);
  if (!files.length) return { removed: 0, freedMB: 0, kept: 0 };

  let removed = 0;
  let freed = 0;
  const keep = [];

  const maxAgeMs = Math.max(1, Number(maxAgeDays) || 7) * 86400000;
  for (const f of files) {
    if (now - f.mtime > maxAgeMs) {
      try {
        fs.unlinkSync(f.file);
        removed += 1;
        freed += f.size;
        continue;
      } catch {
        /* 删不掉（正被占用）就留着 */
      }
    }
    keep.push(f);
  }

  // 年龄清完还超标，就按最旧优先删
  const capBytes = Math.max(1, Number(maxTotalMB) || 500) * 1024 * 1024;
  let total = keep.reduce((s, f) => s + f.size, 0);
  if (total > capBytes) {
    keep.sort((a, b) => a.mtime - b.mtime);
    for (const f of keep) {
      if (total <= capBytes) break;
      try {
        fs.unlinkSync(f.file);
        removed += 1;
        freed += f.size;
        total -= f.size;
      } catch {
        /* ignore */
      }
    }
  }

  return { removed, freedMB: Math.round((freed / 1024 / 1024) * 10) / 10, kept: keep.length };
}

module.exports = { cleanup, listFiles };
