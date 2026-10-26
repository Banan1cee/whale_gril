'use strict';

/**
 * 「挂一会儿就不理人，要重启桥接才行」的回归测试。
 *
 * 真实原因（2026-10-24 23:42 → 23:57 的日志）：
 *   1. 微信跑久了会把 Weixin.dll 里的 accessibility gate byte 归零，UIA 引擎变成「假死」：
 *      能读消息，但一条也发不出去；
 *   2. 桥接把 UIA 引擎缓存起来，只有缓存为空时才重新获取 —— 于是永远不去自愈，
 *      只能重启桥接（重启会重新热激活）；
 *   3. 附带：表情包转码写死了 imageio_ffmpeg（没装），每张表情都刷一条报错。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const bridge = fs.readFileSync(path.join(root, 'examples', 'wechatauto_bridge.py'), 'utf8');

test('每次发送都会问一次 UIA 引擎，让它有机会自愈', () => {
  assert.match(bridge, /每次发送都问一次库里的引擎/, '要写清为什么每次都问');
  const fn = bridge.slice(bridge.indexOf('def uia_send'), bridge.indexOf('def recover_uia'));
  assert.match(fn, /gui\._get_uia\(\)/, 'uia_send 里要重新获取引擎，而不是只用缓存');
  assert.match(fn, /UIA_CACHE\["u"\] = u/);
});

test('发送失败后会强制重新热激活并重试一次（不用重启桥接）', () => {
  assert.match(bridge, /def recover_uia/);
  assert.match(bridge, /gui\._get_uia\(refresh=True\)/, 'refresh=True 才会重写 gate byte');
  assert.match(bridge, /recover_uia\("发送失败"\)/, '发送失败时要调用它');
  assert.match(bridge, /重新激活 UIA 后发送成功/);
});

test('收消息线程死了会被自动拉起并上报', () => {
  assert.match(bridge, /def listener_alive/);
  assert.match(bridge, /def listener_watch/);
  assert.match(bridge, /listener\.start\(\)/, '死了要重启监听');
  assert.match(bridge, /"listener": listener_alive\(\)/, '心跳要上报收消息线程存活');
  assert.match(bridge, /Thread\(target=listener_watch/, '看门狗要真的启动');
});

test('表情包发了装死：不识别、不回话', () => {
  // 用户要的是「表情包发了装死」，所以整条识别链（找缓存/截图/转码/送视觉模型）都删了
  assert.doesNotMatch(bridge, /def describe_sticker/, '表情包识别函数要删掉');
  assert.doesNotMatch(bridge, /def screenshot_sticker/, '表情包截图兜底要删掉');
  assert.doesNotMatch(bridge, /def _find_sticker_file/, '表情包找缓存要删掉');
  assert.doesNotMatch(bridge, /def _sticker_label/, '表情包取名要删掉');
  assert.match(bridge, /收到表情包，装死/, '要写清是装死');
  const fn = bridge.slice(bridge.indexOf('def on_message_inner'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  assert.match(body, /表情包发了装死/, '处理分支里要说明为什么装死');
  assert.doesNotMatch(body, /describe_sticker\(msg\)/, '不能再调用识别');
});

test('被标成「图片」的表情包也要装死，不能送视觉模型', () => {
  // 有的微信版本把表情包报成「图片」，正文里仍是 <emoji md5=...>。
  // 只删 describe_sticker 不够：那种消息会走 describe_image 被当图片认。
  const fn = bridge.slice(bridge.indexOf('def on_message_inner'));
  const body = fn.slice(0, fn.indexOf('\n    def ', 10));
  assert.match(body, /if "<emoji" in content:/, '要按正文里的 emoji XML 兜底');
  assert.ok(body.indexOf('if "<emoji" in content:') < body.indexOf('describe_image(msg)'),
    '兜底必须排在图片识别之前');
  assert.match(body, /收到表情包（被标成图片），装死/, '要留下日志');
});
test('UIA 彻底不行时有键盘兜底通道（Ctrl+F 搜索会话 → 粘贴 → 回车，并回读确认）', () => {
  assert.match(bridge, /def keyboard_send/);
  assert.match(bridge, /VK_CONTROL/, '要用 Ctrl+F 搜索会话');
  assert.match(bridge, /CF_UNICODETEXT/, '文字走剪贴板，避免输入法/编码问题');
  assert.match(bridge, /db\.get_messages/, '发完要回读数据库确认，防止发错会话');
  assert.match(bridge, /键盘通道：抢不到前台/, '抢不到前台要明确放弃');
  assert.match(bridge, /KEYBOARD_FALLBACK/, '要有开关');
  assert.match(bridge, /keyboardFallback/, '开关读的是配置项');
});

/**
 * 「这玩意一直要放到前台，电脑只能干这个活」——实测推翻了这个前提。
 * 2026-10-25 02:10~02:20 实测（都在文件传输助手上，数据库回读确认）：
 *   正常窗口 6/6、最小化 6/6、最小化+前台被别的窗口占用 1/1、
 *   最小化+前台被最大化窗口占用 1/1、最小化连续 3/3 = 18/18 全成功。
 * 所以「必须占前台」是我们自己的 with_window_on_top 造成的，不是 UIA 的要求。
 */
test('默认后台发送，发完把窗口状态还原（电脑可以正常用）', () => {
  assert.match(bridge, /BACKGROUND_SEND\s*=\s*bool\(_wechat\.get\("backgroundSend", True\)\)/, '默认要开着');
  assert.match(bridge, /def force_send_foreground/, '抢前台要单独抽出来，只在兜底时用');
  assert.match(bridge, /def snapshot_win_state/, '发送前要记下窗口状态');
  assert.match(bridge, /def restore_win_state/, '发完要还原');
  assert.match(bridge, /if BACKGROUND_SEND:/, '要走后台分支');
  assert.match(bridge, /后台发送没成功，把微信拉到前台再试一次/, '失败才抢前台，并说明原因');
  assert.match(bridge, /def install_quiet_uia/, '要让引擎别自己恢复窗口抢前台');
  // 顺序：先记状态 → 试后台 → 失败才抢前台 → finally 里还原
  const win = bridge.slice(bridge.indexOf('def with_window_on_top'));
  const body = win.slice(0, win.indexOf('\n    def ') > 0 ? win.indexOf('\n    def ') : win.length);
  assert.ok(body.indexOf('snapshot_win_state()') < body.indexOf('force_send_foreground(fn)'),
    '必须先记状态，再尝试发送');
  assert.match(body, /finally:\s*\n(\s+.*\n)*?\s+restore_win_state\(snap\)/, '还原要放在 finally，失败也要还回去');
});

/**
 * 「边打游戏边用」相关的第二个坑：最大化窗口被误判成全屏。
 * 3.3.1 实测：2560x1440 屏幕上最大化浏览器的 GetWindowRect 是 (-8,-8,2568,1448)，
 * 旧判定 `r[2] >= sw-2 and r[3] >= sh-2` 直接把它当全屏 → 桥接一直排队不回复
 * （实测 A/B：修前浏览器最大化时 care 一条都不发，修后正常发）。
 * 真全屏要保住安静：无边框盖满显示器的窗口（模拟游戏）实测 130 秒内 care 一条没发。
 */
test('全屏判定不能把「最大化窗口」误判成全屏', () => {
  const fn = bridge.slice(bridge.indexOf('def foreground_is_fullscreen'));
  const body = fn.slice(0, fn.indexOf('\n    def '));
  assert.match(body, /MonitorFromWindow/, '要按显示器矩形判断，不是屏幕尺寸');
  assert.match(body, /rcMonitor/, '真全屏仍要认出来（这时候保持安静）');
  assert.match(body, /WS_THICKFRAME/, '最大化窗口有可调边框，要据此排除');
  assert.match(body, /WS_CAPTION/, '有标题栏就不算全屏');
  assert.doesNotMatch(body, /GetSystemMetrics/, '不能再拿屏幕尺寸和 rect 直接比');
});
/**
 * 桥接启动时微信恰好在托盘里（主窗隐藏）→ gui 一直定位不到主窗，
 * 之后把微信拉出来也不会自愈，心跳永远 uia:false（3.3.2 实测：预热报
 * 「未找到微信主窗口」，60 秒后心跳仍是 false）。
 * 现在连续 3 次拿不到就重建窗口驱动。
 */
test('UIA 连续拿不到会重建窗口驱动（微信在托盘里启动也能自愈）', () => {
  const hb = bridge.slice(bridge.indexOf('def bridge_heartbeat'));
  const body = hb.slice(0, hb.indexOf('\n    def ', 10));
  assert.match(body, /nonlocal gui/, '要能重建并写回外层的 gui，缺了 nonlocal 赋值就是空操作');
  assert.match(body, /misses/, '要有连续失败计数');
  assert.match(body, /重建窗口驱动/, '要给出日志，别静默');
  assert.match(body, /gui = WeChatGUI\(\)/, '重建要真的 new 一个');
  assert.ok(body.indexOf('misses >= 3') < body.indexOf('gui = WeChatGUI()'), '先攒够失败次数再重建');
});
/**
 * 键盘兜底是「Ctrl+F 搜索 → 回车 → 粘贴正文 → 回车」，中间不确认打开的是谁。
 * 2026-10-25 12:21 的生产日志里出现过「按键发了，但数据库里没确认到（可能发到了别的会话）」——
 * 私聊内容一旦发错人，收不回来。现在必须在粘贴正文之前核对当前会话名，
 * 核对不了就宁可这条失败。
 */
test('键盘兜底必须先核对会话，防发错人', () => {
  const fn = bridge.slice(bridge.indexOf('def keyboard_send'));
  const body = fn.slice(0, fn.indexOf('\n    def send_text', 10));
  assert.match(body, /def confirmed_target/, '要有核对函数');
  assert.match(body, /current_chat\(\)/, '用 UIA 的只读能力读当前会话名');
  assert.match(body, /为防发错人/, '不匹配要明确拒绝并写日志');
  // 顺序：先核对，再粘贴正文
  const iCheck = body.indexOf('confirmed_target()');
  const iPasteBody = body.indexOf('set_clip(text)');
  assert.ok(iCheck > 0 && iPasteBody > 0 && iCheck < iPasteBody,
    '必须先核对目标会话，再粘贴正文');
  assert.match(body, /读不到当前会话名/, '读不到会话名时也要放弃，不能盲发');
});