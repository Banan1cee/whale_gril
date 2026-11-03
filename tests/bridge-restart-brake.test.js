'use strict';

/**
 * 桥接「无限重启」的刹车回归。
 *
 * 现场：微信里发/收视频号卡片或第三方链接分享后，UIA 的 Name/Exists 会卡在
 * 一次调用里不返回（data/bridge-hang.log 的栈在 uiautomation.Name →
 * bg_sender.read_ui → send_text）。发送看门狗 40 秒后 os._exit(7)，
 * 而 scripts/bridge_loop.bat 以前对 code=7 直接 goto retry、不算 FAILS，
 * 于是「杀掉 → 3 秒重启 → 又卡住」永远停不下来。
 *
 * 这里只做文本级断言，不启动桥接：
 *   1. bridge_loop.bat：code=7 自己也有次数上限（递增 + 比较 + 停住）；
 *   2. RuntimeSupervisor：按「最近 10 分钟重启几次」刹车，而不是「活过 60 秒就清零」；
 *   3. engine.py：视频号卡片直接装死不接话，避免把 UIA 拖进卡死循环。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');

test('bridge_loop.bat：code=7 重启有自己的上限，到顶会停下来', () => {
  const bat = read('scripts/bridge_loop.bat');
  assert.match(bat, /setlocal EnableDelayedExpansion/i, '要在 if 块里用 !R7! 计数，必须开延迟展开');
  assert.match(bat, /set "R7=0"/, '要有 code=7 的重启计数');
  assert.match(bat, /if "%CODE%"=="7" \(/, 'code=7 分支要单独处理');
  const exit7 = bat.slice(bat.indexOf('if "%CODE%"=="7" ('), bat.indexOf(') else ('));
  assert.match(exit7, /set \/a R7\+=1/, '每次 code=7 要计数');
  assert.match(exit7, /GEQ 5/, '计数到上限要比较');
  assert.match(exit7, /pause/, '到上限要停住等人处理，而不是继续无限重启');
  assert.match(exit7, /exit \/b 1/, '停住后返回失败码');
  assert.doesNotMatch(bat, /if "%CODE%"=="7" goto retry/, '不能再无条件 goto retry');
});

test('RuntimeSupervisor：按 10 分钟窗口内的重启次数刹车（不能靠「活过 60 秒」清零）', () => {
  const cs = read('launcher/RuntimeSupervisor.cs');
  assert.match(cs, /BridgeRestartCap\s*=\s*5/, '要有重启上限常量');
  assert.match(cs, /BridgeRestartWindow\s*=\s*TimeSpan\.FromMinutes\(10\)/, '刹车窗口是 10 分钟');
  assert.match(cs, /_bridgeRestarts\.RemoveAll/, '要先剔除窗口外的旧记录');
  assert.match(cs, /_bridgeRestarts\.Count >= BridgeRestartCap/, '到上限要停');
  assert.match(cs, /已停止自动重启（不是无限重启）/, '停下来时要说清楚不是无限重启');
});

test('engine.py：视频号卡片装死不接话（UIA 卡死的触发面）', () => {
  const py = read('bridge/engine.py');
  assert.match(py, /finderfeed/, '要认视频号卡片的 XML');
  assert.match(py, /收到视频号卡片，装死/, '视频号卡片不识别不回，避免拉起视频号窗口');
  // 仍要保留普通链接分享的处理
  assert.match(py, /分享了一个链接/);
});
