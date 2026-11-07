'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/* ---------------- 微信多账号：给启动器列账号 / 选账号 ---------------- */

/** 某个账号目录里 .db 的最新修改时间（只 stat，不解密，毫秒级） */
function newestDbMtime(storageDir) {
  let newest = 0;
  const stack = [storageDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.name.endsWith('.db') || /-(wal|shm)$/.test(entry.name)) continue;
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* 读不到就算了 */
      }
    }
  }
  return newest;
}

/** 微信 4.x 数据目录的常见名字（和桥接 bridge/wechat_db.py 的 DB_ROOT_NAMES 保持一致） */
const DB_ROOT_NAMES = ['xwechat_files', 'WeChat Files', 'xwechat_files_data'];

/**
 * 扫 dbDir 下所有账号目录（判定标准：子目录里有 db_storage）。
 *
 * 口径必须和桥接 `looks_like_db_root` / `find_account_dirs` 一致，四种布局都认：
 *   1) <dbDir>/<账号>/db_storage                        标准
 *   2) <dbDir>/xwechat_files/<账号>/db_storage           数据根填高了一层
 *   3) <dbDir>/db_storage                                直填账号目录
 *   4) dbDir 本身就是 …/<账号>/db_storage                 直填 db_storage
 * 以前只数直接子目录，于是用户把 dbDir 填成 `E:\WeChat Files`（真实库在它下面的
 * `xwechat_files` 里）时，启动器列账号 0 个，桥接也报「一个都没有」。
 */
function scanWechatAccounts(dbDir) {
  const out = [];
  if (!dbDir) return out;
  const seen = new Set();
  const push = (account, storage) => {
    if (!account || seen.has(account)) return;
    seen.add(account);
    out.push({
      account,
      // 目录名末尾 4 位是微信加的哈希，去掉就是 wxid（和 wechatauto 的规则一致）
      wxid: account.replace(/_\w{4}$/, ''),
      lastActive: newestDbMtime(storage),
    });
  };
  const bases = [dbDir, ...DB_ROOT_NAMES.map((n) => path.join(dbDir, n))];
  for (const base of bases) {
    let names = [];
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      const dir = path.join(base, name);
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      const storage = path.join(dir, 'db_storage');
      if (fs.existsSync(storage)) push(name, storage);
    }
  }
  const norm = path.normalize(dbDir);
  const direct = path.join(dbDir, 'db_storage');
  if (fs.existsSync(direct)) {
    push(path.basename(norm), direct);
  } else if (path.basename(norm).toLowerCase() === 'db_storage') {
    push(path.basename(path.dirname(norm)), norm);
  }
  out.sort((a, b) => b.lastActive - a.lastActive);
  return out;
}

function readAccountsCache(config) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(config.paths.dataDir, 'accounts.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (raw && Array.isArray(raw.accounts)) return raw;
  } catch {
    /* 没有缓存是正常情况（桥接还没跑过 --list-accounts） */
  }
  return null;
}

/** 把配置里写的账号（目录名 / wxid / 昵称）对上实际目录 */
function matchAccountDir(accounts, wanted) {
  const w = String(wanted || '').trim();
  if (!w) return '';
  const exact = accounts.find((a) => a.account === w);
  if (exact) return exact.account;
  const byWxid = accounts.find((a) => a.wxid === w);
  if (byWxid) return byWxid.account;
  const loose = accounts.filter(
    (a) => a.account.toLowerCase().startsWith(w.toLowerCase()) || (a.nick && a.nick === w)
  );
  return loose.length === 1 ? loose[0].account : '';
}

function wechatAccountsPayload(runtime) {
  const { config, gateways } = runtime;
  const cache = readAccountsCache(config);
  const dbDir = String((config.wechat && config.wechat.dbDir) || (cache && cache.dbDir) || '').trim();
  const nickMap = new Map(((cache && cache.accounts) || []).map((a) => [a.account, a.nick || '']));
  const accounts = scanWechatAccounts(dbDir).map((a) => ({
    ...a,
    nick: nickMap.get(a.account) || '',
    active: false,
  }));
  const wanted = String((config.wechat && config.wechat.account) || '').trim();
  const current = matchAccountDir(accounts, wanted) || (wanted ? '' : '');
  for (const a of accounts) a.active = a.account === current;
  const gw = gateways.get('wechat');
  const bridge = gw ? gw.status().bridge : null;
  return {
    ok: true,
    dbDir,
    wanted,
    current,
    accounts,
    live: bridge
      ? {
        online: bridge.online,
        account: bridge.account,
        nick: bridge.accountNick,
        ok: bridge.accountOk,
        why: bridge.accountWhy,
        guard: bridge.accountGuard,
      }
      : null,
  };
}

/** 让桥接脚本扫一遍账号（会开库读昵称，慢；只在用户点「刷新」时调） */
function refreshWechatAccounts(runtime, timeoutMs = 30000) {
  const { config, logger } = runtime;
  const bundled = path.join(config.root, 'runtime', 'python', 'python.exe');
  const exe = fs.existsSync(bundled) ? bundled : 'python';
  const script = path.join(config.root, 'examples', 'wechatauto_bridge.py');
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, error: '找不到 examples/wechatauto_bridge.py' });
  return new Promise((resolve) => {
    let settled = false;
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
    // 和启动脚本一样：清掉残留代理，否则取数据库密钥那一步会连不上（不影响本机读库，但省得踩坑）
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[k];
    let child;
    try {
      child = spawn(exe, ['-u', script, '--list-accounts'], { cwd: config.root, windowsHide: true, env });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    let tail = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (tail) logger.info('[accounts] ' + tail.replace(/\s+/g, ' ').slice(-300));
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: '扫描账号超时（微信没登录，或读不到数据库密钥）' });
    }, timeoutMs);
    child.stdout.on('data', (d) => { tail = (tail + String(d)).slice(-1200); });
    child.stderr.on('data', (d) => { tail = (tail + String(d)).slice(-1200); });
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('close', (code) => {
      if (code !== 0) return finish({ ok: false, error: '扫描账号失败，请确认微信已登录并查看诊断日志' });
      const cache = readAccountsCache(config);
      finish(cache ? { ok: true, cache } : { ok: false, error: '扫描没拿到账号（看 data/wechat-bridge-4x.log）' });
    });
  });
}

module.exports = {
  newestDbMtime,
  scanWechatAccounts,
  readAccountsCache,
  matchAccountDir,
  wechatAccountsPayload,
  refreshWechatAccounts,
};
