# UIA 在微信 4.2 上失效：原因与修复

> 适用：微信 4.2.x（本机实测 4.2.0.9）+ wechatauto-replica 1.2.8.1
> 相关文件：`bridge/uia_boot.py`（新增）、`bridge/engine.py`、`launcher/app.manifest`

## 症状

桥接日志每 4 秒刷一遍，然后整场退回 OCR：

```
热激活 UIA 失败：PID 22092 未找到 Weixin.dll。
UIA 树不可用，本次会话使用 OCR 驱动
[!] UIA 连续 7 次拿不到，重建窗口驱动再试…
```

## 三个真原因（都不是「微信更新后加了权限校验」）

1. **窗口句柄过期。** 微信更新会重启进程、重开窗口。桥接（和第三方库）手里攥着
   旧 hwnd，照着它取 PID，得到的可能是被回收后复用给别的进程的号 —— 那个进程里
   当然没有 `Weixin.dll`。日志里的 `PID 22092` 就是这么来的：当时的真主窗是另一个 PID。
2. **第三方的成功判据太弱。** `AccessibilityGate._mmui_present()` 只看根窗口类名
   是不是 `mmui::`，而 4.2 的根窗口类名**本来就叫** `mmui::MainWindow`（空壳也是）。
   于是「写错字节也判成功」，把字节留在 1，后面再也不重试。
3. **版本表没有 4.2.0.9。** `QACCESSIBLE_ACTIVE_RVA_BY_VERSION` 只到 4.1.15.53，4.2 只能靠
   特征扫描；扫出来的候选不一定是真的 gate，需要「写进去 → 看会话列表有没有出来 →
   不对就还原」地逐个验证。

## 修复

新增 `bridge/uia_boot.py`，做三件事：

| 做什么 | 怎么判 |
| --- | --- |
| 挑窗口 | 枚举所有 `Weixin.exe` 的主窗，**只保留 PID 里真的加载了 `Weixin.dll` 的**；优先钉住的窗口 → 标题「微信」→ 前台 → 面积 |
| 判物化 | 树里必须出现 `mmui::ChatSessionList` / `mmui::XTableView` / `mmui::ChatSessionCell`，只看根类名不算 |
| 写 gate | 候选顺序：版本表 → 本文件 `KNOWN_GATE_RVA` → 库的特征扫描；写完等 1.2 秒看树，不成还原原字节；成功就写进库缓存 `~/.wechatauto/gate_cache.json` |

`engine.py` 里的改动：

- 启动预热先跑 `ensure_uia_ready()`（结果缓存 30 秒），日志从「UIA 拿不到」变成一句人话：
  `发送通道预热：UIA 可用（树本来就在）` / `…已物化，微信 4.2.0.9，RVA 0xb4f7c08` /
  `…没有权限改微信进程标志位（桥接要以管理员运行）`。
- `_probe_wechat_windows()` 只把「PID 里带 Weixin.dll」的窗口交给热激活，并且发现主窗换了会自动重新定位、写回 `ACCOUNT["hwnd"]`。
- `explain_uia_failure()` 先用新判据给结论，老的 A/B/C 分支分析保留为兜底。

## 提权

`launcher/app.manifest` 从 `asInvoker` 改成 `requireAdministrator`：

- 微信多数情况下是管理员运行的，桥接必须同级才能 `OpenProcess(VM_WRITE)` 改 gate 字节、读它的模块；
- 代价：每次启动弹一次 UAC；
- 拖拽上传不会失效（`ChangeWindowMessageFilterEx` 已放行 `WM_DROPFILES` / `WM_COPYGLOBALDATA` / `WM_COPYDATA`）；
- 副作用：提权后的启动器不能再被普通权限的脚本/任务管理器常规结束，开发时用管理员终端。

## 自查命令

```bat
:: 非提权也能跑，只看窗口/树/候选
runtime\python\python.exe -B -c "import sys;sys.path.insert(0,'.');from bridge import uia_boot;w=uia_boot.pick_window();print(w);print(uia_boot.tree_state(w['hwnd']));print(uia_boot.describe(uia_boot.ensure()))"

:: 提权跑一遍完整启动并落盘结果（会弹一次 UAC）
runtime\python\python.exe -B tools\elev_uia_check.py
```
