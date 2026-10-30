# UIA 在微信 4.2 上失效：原因与修复

> 适用：微信 4.2.x（实测 4.2.0.9）+ wechatauto-replica 1.2.8.1
> 相关文件：`bridge/uia_boot.py`、`bridge/engine.py`、`launcher/app.manifest`

## 症状

桥接日志每 4 秒刷一遍，然后整场退回 OCR：

```
热激活 UIA 失败：PID 22092 未找到 Weixin.dll。
UIA 树不可用，本次会话使用 OCR 驱动
[!] UIA 连续 7 次拿不到，重建窗口驱动再试…
```

## 真原因（两条）

1. **窗口句柄过期。** 微信更新/重启会重开窗口。桥接手里攥着旧 hwnd，照它取到的
   PID 可能是被回收后复用给别的进程的号——那个进程里当然没有 `Weixin.dll`。
   日志里的 `PID 22092` 就是这么来的（当时真主窗是另一个 PID）。
2. **第三方的成功判据太弱。** `_mmui_present()` 只看根窗口类名是不是 `mmui::`，
   而 4.2 的根窗口类名**本来就叫** `mmui::MainWindow`（空壳也是）。于是「写错字节
   也判成功」，字节留在 1，后面再也不重试。

第三条是老问题，不是 4.2 引入的：**微信缩在托盘时会销毁主窗的 UI 子树**，
句柄还在但 `GetChildren()` 返回 0，UIA 必然拿不到。

## 修复

`bridge/uia_boot.py` 三件事：

| 做什么 | 怎么判 |
| --- | --- |
| 挑窗口 | 只保留 PID 里真的加载了 `Weixin.dll` 的主窗；优先钉住的 → 标题「微信」→ 前台 → 面积 |
| 判物化 | 树里必须出现 `mmui::ChatSessionList` / `XTableView` / `ChatSessionCell`，只看根类名不算 |
| 托盘态恢复 | 树是空壳时**再执行一次 Weixin.exe**（单实例转发，等同用户点托盘图标）→ 1 秒内建树 → 把窗口摆回可见位置并**留在屏幕上**（不缩回托盘） |

`engine.py` 的改动：

- 预热前跑 `ensure_uia_ready()`（结果缓存 30 秒），日志改成一句人话：
  `UIA 可用（树本来就在）` / `UIA 可用（微信窗口原本在托盘里，已自动唤起并重建控件树）`。
- `_probe_wechat_windows()` 只把有效窗口交给热激活；主窗换了会自动重新定位并写回 `ACCOUNT["hwnd"]`。
- 心跳线程在 `_u is None` 时先 `ensure_uia_ready(force=True)`，成功就重建 GUI 驱动。

## 提权

`launcher/app.manifest` 从 `asInvoker` 改成 `requireAdministrator`：

- 微信多数情况下是管理员运行的，桥接必须同级才能 `OpenProcess(VM_WRITE)`、读它的模块；
- 代价：每次启动弹一次 UAC；
- 拖拽上传不受影响（`ChangeWindowMessageFilterEx` 已放行三条消息）。

## 两个容易踩的坑（都写在代码注释里了）

1. **不要改微信窗口的尺寸**：`SetWindowPos` 改大小时 mmui 控件树会塌回空壳，
   而且那个实例里之后隐藏/显示、再拉起 exe 都重建不回来，只能重启微信。
   → `_keep_visible()` 只改位置，带 `SWP_NOSIZE`。
2. **拉起 exe 偶尔会多开一个实例**留下登录小窗（约 300×400、控件树空）。
   `close_stray_login_windows()` 按「标题微信 + 空壳 + 小于 480×520」三条同时满足才关，
   不会误杀第二个真账号。

## 自查

```bat
:: 只读体检：窗口 / 版本 / 树状态 / 候选 / 权限
runtime\python\python.exe -B tools\uia_probe.py

:: 提权跑一遍完整启动并把结果落盘（会弹一次 UAC）
runtime\python\python.exe -B tools\elev_uia_check.py
```

## 已知

- 托盘态恢复依赖「再拉起一次 Weixin.exe」这一行为；如果哪天微信改成完全单实例
  且不再响应转发，需要换别的唤醒方式。
- 桥接进程内轮询有时 15 秒内看不到树（同为托盘场景，独立进程跑同样代码却 1 秒成功），
  原因未定；后续 `WeChatGUI()` 自身的唤醒路径会把 UIA 救回来。
- 发送仍然受窗口几何影响：微信被别的窗口挡住时，库算出的点击坐标会落到别的进程上，
  会被「落点窗口不属于微信」拦掉——这是保护，不是 bug；发送前需要保证微信在前台。
