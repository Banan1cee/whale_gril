'use strict';

/**
 * 双开认窗 + 账号缓存 + WM_CHAR 编码这三件事的源码级回归。
 *
 * 为什么指针级/源码级：这几段代码都长在 `engine.main()` 的闭包和 Windows 消息
 * 投递里，离线没法真的开两个微信窗口。这里守住「修复的关键判断还在」：
 *   - 不再用 pick_window() 的单个结果把候选窗口砍成一个；
 *   - 预热阶段不会把未确认的窗口写进 ACCOUNT；
 *   - data/accounts.json 缺失时桥接会自己补写；
 *   - auto 模式真的会打一个字回读实测编码，且清不干净就不发送。
 * 真机行为由 BUGS.md 里记录的现场日志（锁定 hwnd / 编码实测 → utf16）兜底。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'bridge/engine.py'), 'utf8');
const BG = fs.readFileSync(path.join(ROOT, 'bridge/bg_sender.py'), 'utf8');

test('双开认窗：候选窗口不再被 pick_window() 砍成一个', () => {
  // 旧实现：good = pick_window(0).hwnd; if good and h != good: continue
  assert.doesNotMatch(ENGINE, /if\s+good\s+and\s+h\s*!=\s*good/, '候选窗口又被单个 pick_window 结果过滤了');
  assert.match(
    ENGINE,
    /pinned = int\(ACCOUNT\.get\("hwnd"\) or 0\) if ACCOUNT\.get\("verified"\) else 0/,
    '只有已确认的账号窗口才允许当过滤器'
  );
  // 每个候选窗口单独校验 Weixin.dll
  assert.match(ENGINE, /_cpid = int\(win32process\.GetWindowThreadProcessId\(h\)\[1\] or 0\)/);
  assert.match(ENGINE, /probe\._weixin_dll_module\(_cpid\)/);
});

test('双开认窗：已锁定的窗口失效就重新认，不顺手换成大号', () => {
  assert.match(ENGINE, /ACCOUNT\.update\(hwnd=0, verified=False\)/, '锁定窗口失效时必须清掉，交给会话反查重认');
  assert.match(ENGINE, /账号窗口：锁定的 hwnd=%s 已失效，重新认窗口/);
});

test('UIA 预热不会把未确认的窗口写进 ACCOUNT', () => {
  assert.match(
    ENGINE,
    /if h and h != prefer and ACCOUNT\.get\("verified"\):\s*\n\s*ACCOUNT\["hwnd"\] = h/,
    '预热阶段会把按面积挑中的大号窗口钉成账号窗口'
  );
});

test('data/accounts.json 缺失时桥接自己补写（删 data 也能自愈）', () => {
  assert.match(ENGINE, /def write_accounts_cache\(db_dir/, '缺 write_accounts_cache');
  assert.match(ENGINE, /def _heal_accounts_cache\(\):/, '缺启动自愈线程');
  assert.match(ENGINE, /write_accounts_cache\(db\.db_dir or db_dir, db\.account, _self_nick\)/);
  assert.match(ENGINE, /"accounts\.json"/);
  assert.match(ENGINE, /find_account_dirs\(db_dir\)/, '补写时必须扫全部账号目录，不能只写当前号');
});

test('WM_CHAR 编码：auto 模式真的打一个字回读实测', () => {
  assert.match(BG, /def sniff_char_mode\(hwnd, log=None, chat=None\):/, '缺检测试函数');
  assert.match(BG, /sender\.type_text\("鲸"/, '探测必须真的往输入框打字');
  assert.match(BG, /if got == "鲸":/, '必须回读比对');
  assert.match(BG, /GetValuePattern\(\)\.SetValue\(""\)/, '探测后必须用 UIA 清空输入框');
  assert.match(BG, /_DETECT_DIRTY/, '清不干净要能拦住发送');
  assert.match(
    BG,
    /if _DETECT_DIRTY:\s*\n(?:\s*#.*\n)*\s*_DETECT_DIRTY\.clear\(\)\s*\n\s*return False, "input_dirty"/
  );
});

test('WM_CHAR 编码：探测只对明确传入的窗口做，离线脚本不碰真实微信', () => {
  assert.match(BG, /if not int\(hwnd or 0\):\s*\n\s*return mode/);
  assert.match(BG, /_DETECTED_MODES/, '探测结果要缓存，避免每条消息都测');
});
