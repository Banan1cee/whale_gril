'use strict';

/**
 * 桥接「无限重启」的刹车回归。
 *
 * 现场：微信里发/收视频号卡片或第三方链接分享后，UIA 的 Name/Exists 会卡在
 * 一次调用里不返回（data/bridge-hang.log 的栈在 uiautomation.Name →
 * bg_sender.read_ui → send_text）。发送看门狗 40 秒后 os._exit(7)，
 * 于是「杀掉 → 3 秒重启 → 又卡住」永远停不下来。
 *
 * 现在桥接的拉起与重启都归启动器（RuntimeSupervisor），所以刹车也在这里：
 *   · 单轮连续异常退出有硬上限（_restartCount）；
 *   · 更关键的是「最近 10 分钟退出几次」的滑动窗口，跟单次活了多久无关
 *     （曾经的「活过 60 秒就清零」会把 3 秒崩一次也当成健康，别把那套写法固化回来）。
 * 另外 engine.py 对视频号卡片直接装死不接话，从源头少一个卡死触发器。
 *
 * 这里只做文本级断言，不启动桥接。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '');

test('RuntimeSupervisor：单轮连续异常退出有硬上限', () => {
  const cs = read('launcher/RuntimeSupervisor.cs');
  assert.match(cs, /private int _restartCount;/, '要有连续退出计数');
  assert.match(cs, /\+\+_restartCount > 3/, '连续第 4 次就停，不能无限重试');
  assert.match(cs, /_bridgeWanted = false/, '停下来要真的停止拉起');
  assert.match(cs, /桥接连续异常退出/, '停下来时要给一句人话，别静默');
});

test('RuntimeSupervisor：按 10 分钟窗口内的重启次数刹车（不能靠「存活满 60 秒」清零）', () => {
  const cs = read('launcher/RuntimeSupervisor.cs');
  assert.match(cs, /BridgeRestartCap\s*=\s*5/, '要有重启上限常量');
  assert.match(cs, /BridgeRestartWindow\s*=\s*TimeSpan\.FromMinutes\(10\)/, '刹车窗口是 10 分钟');
  assert.match(cs, /_bridgeRestarts\.RemoveAll/, '要先剔除窗口外的旧记录（滑动窗口）');
  assert.match(cs, /_bridgeRestarts\.Count >= BridgeRestartCap/, '窗口内到上限要停');
  assert.match(cs, /已停止自动重启（不是无限重启）/, '停下来时要说清楚不是无限重启');
});

test('RuntimeSupervisor：桥接起来/重启都由它负责（不再有外部守护脚本）', () => {
  const cs = read('launcher/RuntimeSupervisor.cs');
  assert.match(cs, /public void StartBridge\(\)/, '要有启动桥接的入口');
  assert.match(cs, /StartBridge\(\);/, '崩溃恢复要真的重新拉起');
  assert.match(cs, /例程|重启|自动恢复/, '要有恢复动作的说明');
});

test('engine.py：视频号卡片装死不接话（UIA 卡死的触发面）', () => {
  const py = require('./helpers/bridge-source');
  assert.match(py, /finderfeed/, '要认视频号卡片的 XML');
  assert.match(py, /收到视频号卡片，装死/, '视频号卡片不识别不回，避免拉起视频号窗口');
  // 仍要保留普通链接分享的处理
  assert.match(py, /分享了一个链接/);
});
