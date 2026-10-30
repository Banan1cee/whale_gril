# 微信桥接（Python）模块图

当前状态：`engine.py` 是原 `examples/wechatauto_bridge.py` 的完整迁移，
入口已经拆成 `python -m bridge` / `examples/wechatauto_bridge.py` 薄壳。
`engine.py` 内部的 `main()` 仍然是巨型函数（约 2100 行闭包），下一步按下面的顺序拆：

```
bridge/
├─ __main__.py      # python -m bridge 入口（已完成）
├─ bg_sender.py     # 零焦点发送通道（已完成，见 docs/微信消息后台发送.md）
├─ msg_pipeline.py  # 消息调度：同一会话串行、跨会话并发（已完成）
├─ sticker_transport.py  # 表情包一次性发送（fail-closed，mock 可测）
├─ engine.py        # 当前完整实现（待拆）
├─ config.py        # TODO reload_config / read_config / build_bot_url / wait_for_server
├─ wechat_db.py     # TODO looks_like_db_root / resolve_db_dir / find_account_dirs / list_accounts_cli
├─ logging.py       # TODO log / log_throttled / boot / log_window_problem
├─ guards.py        # TODO is_system_notice / duplicate_guard / rate_guard
├─ window.py        # TODO hwnd 探测 / 前台切换 / 窗口状态快照还原
├─ sender.py        # TODO ensure_window / UIA 发送 / OCR 兜底 / 键盘通道
├─ receiver.py      # TODO 数据库轮询 / 消息归一化 / 去重
├─ media.py         # TODO ffmpeg / wxgf 转码 / 媒体缓存
├─ voice.py         # TODO ASR 转写
└─ loop.py          # TODO 主循环 / 心跳 / 守护（消息调度已拆到 msg_pipeline.py）
```

## `msg_pipeline.py`（已完成）

收 / 判 / 发三段里的「判」：

```
Listener（DB 轮询，0.4s）          收
    │  on_message(msg)
    ▼
MessagePipeline                    判（按会话串行、跨会话并发）
    │  on_message_inner：下载图片 / OCR / 调用 /webhook
    ▼
send_text()                        发（send_lock 串行，UIA 只能一个线程碰）
```

- `wechat.pipelineWorkers`（默认 4）：同时处理几个会话
- `wechat.pipelineQueueLimit`（默认 4）：单个会话最多积压几条，超出丢最早的
- `WHALE_PIPELINE_WORKERS=1`：立刻退回旧的全串行行为（排查用）
- 自检：`python scripts/bridge-pipeline-selftest.py`（10 项，不需要微信）

以前是 `ThreadPoolExecutor(max_workers=1)`：一张长截图的 OCR 要几分钟，
后面所有消息全堵着。现在不同会话并行，同一个会话仍然严格保序。

## `bg_sender.py`（已完成）

按 `docs/微信消息后台发送.md` 实现的**零焦点**发送通道：`PostMessage` 伪焦点 +
GBK 字节 `WM_CHAR` + `PostMessage` 点发送按钮，全程不碰前台。

- 对外只有 `send(text, chat, hwnd, log, ...) -> (ok, reason)` 和 `probe()`
- `reason` 是稳定枚举（`sent` / `minimized` / `chat_not_found` / `uipi_denied` …），
  `engine.py` 据此决定要不要退回旧通道
- 不依赖 `wechatauto` 的 GUI 驱动，所以 UIA 引擎假死时它照样能用
- 纯逻辑自检：`python scripts/bg-selftest.py`（不需要微信在线）
- 实机自检：`python -m bridge --bg-probe`（会打印前后前台窗口号）

拆解 `engine.py` 时，`window.py` 只保留「会抢前台」的那部分（`force_foreground` /
`snapshot_win_state` / `restore_win_state`），零焦点的部分不要再往那边搬。

拆解原则（避免行为漂移）：

1. 先拆无副作用模块：`config` → `wechat_db` → `logging` / `guards`；
2. 再拆有副作用的 `window` / `sender` / `receiver`，**只挪位置、不改函数体**；
3. 每步用 `python -m py_compile` + `scripts/smoke.ps1` + `scripts/mock-gateway.js` 验证；
4. 入口与 HTTP 协议（`/webhook/wechat`、`/api/bridge/heartbeat`）保持不变。
