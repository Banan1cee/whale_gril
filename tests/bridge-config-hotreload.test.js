'use strict';

/**
 * 桥接配置热更新：改 config.json 不用重启桥接。
 *
 * 这条以前放在 tests/debug-console.test.js 里（和网页调试台的用例混在一起）。
 * 调试台删了，但「配置改了桥接不重读」这个回归只靠源码断言守着，所以留在这里：
 * 只读 bridge/engine.py，不碰网页。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'bridge', 'engine.py'), 'utf8');

test('桥接会热更新配置（改完不用重启）', () => {
  assert.match(bridge, /def reload_config/, '要有热更新函数');
  assert.match(bridge, /def config_watch/, '要有盯 config.json 的线程');
  assert.match(bridge, /Thread\(target=config_watch/, '线程要真的启动');
  assert.match(bridge, /配置已热更新/, '要写日志，让人知道生效了');
  // 基线必须在进程启动时（模块导入）取：开库 + 预热要十几秒，这期间切的账号
  // 要是等到线程起来才取基线，就会被当成「初始值」吞掉，桥接一直连着旧号。
  assert.match(bridge, /CONFIG_MTIME_AT_START\s*=\s*os\.path\.getmtime\(CONFIG_PATH\)/, '基线要在导入时取');
  assert.match(bridge, /last = CONFIG_MTIME_AT_START/, 'config_watch 要用启动时的基线');
  assert.match(bridge, /if mt == last:/, 'mtime 一变就要重载（用 == 判，别只认变新）');
  // 关键开关必须在热更新里被重新赋值（global 声明）
  const fn = bridge.slice(bridge.indexOf('def reload_config'));
  const body = fn.slice(0, fn.indexOf('\n# 系统 / 公众号'));
  for (const k of ['CARE_ENABLED', 'KEYBOARD_FALLBACK', 'BACKGROUND_SEND']) {
    assert.match(body, new RegExp('global[^\\n]*' + k + '|' + k + ' = '), k + ' 要在热更新里刷新');
  }
  // 「打游戏就休息 / 离开回来打招呼 / 忙时排队」整组已删除，守住反向约束：别再加回来
  for (const gone of ['GAME_TOKENS', 'AWAY_NOTICE', 'RETURN_NOTICE', 'QUEUED_MAX_AGE', 'QUEUED_MAX_CHATS']) {
    assert.doesNotMatch(body, new RegExp(gone), gone + ' 已删除，不应再出现');
  }
  assert.match(body, /SYSTEM_SENDER_NAMES/, '忽略名单也要刷新');
});
