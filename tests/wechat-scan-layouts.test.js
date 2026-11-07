'use strict';

/**
 * 启动器「列账号」和桥接 `find_account_dirs` 必须是同一套口径。
 *
 * 真实事故（2026-11-07 用户日志包）：dbDir = `E:\WeChat Files`，真实库在它下面
 * 一层 `xwechat_files\<wxid>\db_storage`，于是内核
 *   `[accounts] 列账号完成：0 个（无） {"dbDir": "E:\\WeChat Files", "accounts": []}`
 * 启动器里账号下拉框是空的，桥接也报「找不到账号（一个都没有）」。
 *
 * 桥接侧的修复在 tests/db-dir.test.js，这里盯内核侧同一个函数，免得两边又跑岔。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { scanWechatAccounts } = require('../src/services/wechat');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-accounts-'));
  // newestDbMtime 只数 .db 文件，空目录给 0 —— fixture 里放一个真库文件
  const lib = (accountDir) => {
    const storage = path.join(accountDir, 'db_storage');
    fs.mkdirSync(storage, { recursive: true });
    fs.writeFileSync(path.join(storage, 'msg.db'), 'x', 'utf8');
  };
  const nested = path.join(dir, 'outer', 'WeChat Files');
  lib(path.join(nested, 'xwechat_files', 'wxid_testnested_abcd'));
  lib(path.join(dir, 'xwechat_files', 'wxid_testroot_efgh'));
  lib(path.join(dir, 'flat', 'wxid_testflat_ijkl'));
  lib(path.join(dir, 'xwechat_files', 'wxid_self_mnop'));
  fs.mkdirSync(path.join(dir, 'empty'), { recursive: true });
  return {
    dir,
    nested,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }),
  };
}

function accountsOf(list) {
  return list.map((a) => a.account).sort();
}

test('标准布局：<dbDir>/<账号>/db_storage', () => {
  const fx = makeFixture();
  try {
    const list = scanWechatAccounts(path.join(fx.dir, 'xwechat_files'));
    assert.deepEqual(accountsOf(list), ['wxid_self_mnop', 'wxid_testroot_efgh']);
    const one = list.find((a) => a.account === 'wxid_testroot_efgh');
    assert.equal(one.wxid, 'wxid_testroot', '目录名末尾 4 位哈希要去掉');
    assert.ok(one.lastActive > 0, '要给出库的最近修改时间');
  } finally {
    fx.cleanup();
  }
});

test('数据根填高了一层：dbDir 下面还嵌着 xwechat_files', () => {
  const fx = makeFixture();
  try {
    const list = scanWechatAccounts(fx.nested);
    assert.deepEqual(accountsOf(list), ['wxid_testnested_abcd'], '嵌套一层也要列出来（这就是事故现场）');
  } finally {
    fx.cleanup();
  }
});

test('直填账号目录 / 直填 db_storage', () => {
  const fx = makeFixture();
  try {
    const account = path.join(fx.dir, 'xwechat_files', 'wxid_self_mnop');
    assert.deepEqual(accountsOf(scanWechatAccounts(account)), ['wxid_self_mnop'], 'dbDir 直接填账号目录');
    assert.deepEqual(
      accountsOf(scanWechatAccounts(path.join(account, 'db_storage'))),
      ['wxid_self_mnop'],
      'dbDir 直接填 db_storage'
    );
  } finally {
    fx.cleanup();
  }
});

test('空目录 / 没填 → 空列表，不抛', () => {
  const fx = makeFixture();
  try {
    assert.deepEqual(scanWechatAccounts(path.join(fx.dir, 'empty')), []);
    assert.deepEqual(scanWechatAccounts(path.join(fx.dir, 'not-exist')), []);
    assert.deepEqual(scanWechatAccounts(''), []);
    assert.deepEqual(scanWechatAccounts(null), []);
  } finally {
    fx.cleanup();
  }
});
