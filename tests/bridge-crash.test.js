'use strict';

/**
 * 「长时间挂着不管，桥接偶尔报 Bridge exited with code -1073741819」的回归测试。
 *
 * 那个码在 Windows 上就是 0xC0000005（STATUS_ACCESS_VIOLATION，访问违规）：
 * 原生代码直接崩了，Python 的 try/except 拦不住。罪魁是微信长时间挂着时窗口被
 * 回收/自更新，uiautomation 还攥着旧窗口的 COM 指针/句柄，心跳每 20 秒碰一下
 * 就被炸死。修法分两层：
 *   1. 预防：每次碰 UIA 前先现查微信主窗还在不在，没了就先把引擎丢掉、别去碰；
 *   2. 兜底：启动脚本变成守护循环，真崩了（负数错码）3 秒内自动拉起，不用人工。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');
const launcher = fs.readFileSync(path.join(root, '启动微信桥接.bat'), 'utf8');
const loop = fs.readFileSync(path.join(root, 'scripts', 'bridge_loop.bat'), 'utf8');
const deploy = fs.readFileSync(path.join(root, 'scripts', 'deploy.ps1'), 'utf8');

function count(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n += 1;
    i += needle.length;
  }
  return n;
}

test('有「微信主窗现在还活着吗」的即查即用判断，不缓存句柄', () => {
  assert.match(bridge, /def wechat_window_alive\(\)/);
  assert.match(bridge, /win32gui\.IsWindow\(h\)/, '要用 IsWindow 现查，不是缓存句柄');
  assert.match(bridge, /find_weixin_hwnd\(\)/, '窗口句柄每次现找');
  assert.match(bridge, /0xC0000005/, '注释要把那个崩溃码讲清楚，否则后人不知道为啥加这层');
  // 坑：main() 里没有 user32 这个变量（那几处 user32 都是函数局部变量），
  // 直接写 user32.IsWindow(h) 会 NameError → 被 except 吞成 False，挡板天天误判。
  const fn = bridge.slice(bridge.indexOf('def wechat_window_alive('));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  assert.doesNotMatch(body, /user32\.IsWindow/, 'wechat_window_alive 里不能引用不存在的 user32');
});

test('碰 UIA 前先问窗口在不在（心跳 / 发送 / 热激活 三处）', () => {
  // 心跳每 20 秒碰一次 UIA，是最主要的「挂着不管就崩」来源
  const hb = bridge.slice(bridge.indexOf('def bridge_heartbeat'));
  const hbBody = hb.slice(0, hb.indexOf('\n    def ', 10));
  assert.match(hbBody, /if not wechat_window_alive\(\):/, '心跳要先用窗口存活判断挡一下');
  assert.match(hbBody, /gui = None/, '窗口没了要先把缓存引擎丢掉');
  assert.match(hbBody, /UIA_CACHE\["u"\] = None/, '缓存引擎一起清掉');

  const send = bridge.slice(bridge.indexOf('def uia_send'));
  const sendBody = send.slice(0, send.indexOf('\n    def ', 10));
  assert.match(sendBody, /if not wechat_window_alive\(\):/, '发送前也要挡');
  assert.match(sendBody, /return False/, '窗口没了直接走键盘/OCR 兜底');

  const rec = bridge.slice(bridge.indexOf('def recover_uia'));
  const recBody = rec.slice(0, rec.indexOf('\n    def ', 10));
  assert.match(recBody, /if not wechat_window_alive\(\):/, '热激活前也要挡');

  assert.ok(count(bridge, 'if not wechat_window_alive():') >= 3, '三处都要埋上挡板');
});

test('看门狗重启用 code 7，把 2 让给「找不到数据库」这类优雅报错', () => {
  assert.match(bridge, /os\._exit\(7\)/, '看门狗重启要用 7');
  assert.doesNotMatch(bridge, /os\._exit\(2\)/, '2 是优雅报错，不能再被看门狗占用');
  assert.match(bridge, /return 2/, '找不到数据库目录的优雅报错仍然存在');
  assert.match(bridge, /用 7 而不是 2/, '注释要说明 7 和 2 的分工');
});

test('原生崩溃尽量在死前留下当时在跑哪句（bridge-crash.log）', () => {
  assert.match(bridge, /faulthandler\.enable\(file=_crash_file/, '要开 faulthandler 兜底记录');
  assert.match(bridge, /bridge-crash\.log/, '崩溃堆栈写进独立日志');
});

test('启动脚本是守护循环：崩溃后 3 秒自动拉起', () => {
  assert.match(launcher, /scripts\\bridge_loop\.bat/, '根目录启动脚本要把循环交给 bridge_loop');
  assert.match(launcher, /自动守护/, '要告诉用户崩溃会自动拉起来');
  assert.match(loop, /:loop/, '要有循环标签');
  assert.match(loop, /goto loop/, '要真的回头重跑');
  assert.match(loop, /runtime\\python\\python\.exe/, '循环脚本要用包里的 Python，不是系统里的');
  assert.match(loop, /-1073741819/, '要解释那个负数崩溃码，用户才看得懂');
  assert.match(loop, /"%CODE%"=="7"/, 'code 7（看门狗要求重启）要自动重启');
  assert.match(loop, /"%CODE%"=="2"/, 'code 2（配置问题）不要无限重启，得停下来看日志');
});

test('一键部署（deploy.ps1）重启桥接也走守护循环，而不是裸跑 python', () => {
  assert.match(deploy, /bridge_loop\.bat/, '部署重启要启动守护循环');
  assert.doesNotMatch(deploy, /examples\\wechatauto_bridge\.py"\)/, '不能再裸跑 python（崩了没人拉）');
});