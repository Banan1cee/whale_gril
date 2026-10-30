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

---

## 追加：冷启动实测记录（2026-10-30，微信 4.2.0.9）

上一版把「找到正确 gate RVA」写成了结论，**这是错的**。补做冷启动实验后：

| 实验 | 结果 |
| --- | --- |
| 重启微信后立刻看控件树 | `shell`（只有空壳，没有 `mmui::ChatSessionList`） |
| 等 60 秒，期间完全不碰 UIA | 仍是 `shell` |
| 再持续查询 60 秒（相当于挂着客户端） | 仍是 `shell` |
| `SetForegroundWindow` 把窗口拉到前台，等 8 秒 | 仍是 `shell` |
| 写 `Weixin.dll+0xB4F7C08` 为 1（**该处原值本来就是 1**），等 8 秒 | 仍是 `shell` |
| `SPI_SETSCREENREADER`：普通权限 / 管理员，三种参数写法 | `ret=0`，读回始终 0 —— 这个 API 在当前 Windows 上改不动 |
| 两分钟后随便再查一次 | **`ok`** |

结论：

1. `0xB4F7C08` **不是** 4.2.0.9 的 gate —— 它默认就是 1，写它没有任何作用。
   `~/.wechatauto/gate_cache.json` 里那条 `verified` 记录不可信。
2. `SPI_SETSCREENREADER` 在本机（提权后也一样）改不动，不能当兜底。
3. 控件树**会在启动一两分钟后自己出现**，触发条件还没确认（候选：用户点了一下微信、
   来了新消息触发重绘、微信自己的定时器）。但至少在出现之前，「拉前台 / 写字节 /
   持续查询」都无法提前催出来。

因此现在的正确做法不是「找 RVA」，而是：**别在启动那一刻一锤定音**。
桥接已经有每 20 秒复查 UIA 的线程，树一旦出现就会切回 UIA；
真正要修的是「首次判定失败后，把整场会话钉死在 OCR」这条路径。

待确认：控件树自动出现的触发条件。验证方法见 `tools/uia_cold_experiment.py`
（两段式：纯等 / 持续查询）与 `tools/elev_spi_test.py`（提权测 SPI）。
