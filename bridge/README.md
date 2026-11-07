# 微信桥接（Python）模块图

当前状态：桥接已从单个 `engine.py` 拆成 **组合根 + 领域 mixin**。

- `engine.py` 只保留模块级配置、兼容函数（`read_config` / `reload_config` /
  `list_accounts_cli` / `write_accounts_cache` / `_bg_cli`）和 `main()` 转发，约 470 行。
- `app.py` 是真正的启动入口：`BridgeRuntime.start()` 负责单实例锁、导入微信库、
  创建 DB/GUI、启动收发与心跳线程，然后进入主循环。
- `*_mixin.py` 按领域放运行时方法；共享状态统一挂在 `BridgeRuntime` 实例上
  （`self.db` / `self.gui` / `self.ACCOUNT` / 锁和队列），不再靠 300 多个闭包变量。

```
bridge/
├─ __main__.py           # python -m bridge 入口
├─ app.py                # 组合根：BridgeRuntime.start() / 生命周期
├─ account_mixin.py      # 数据库打开、账号识别、账号切换、发送闸
├─ window_mixin.py       # 窗口探测、前台/置顶、快照还原、UIA 静默
├─ sender_mixin.py       # bg / UIA / 键盘 / OCR 通道与 send_text/send_at
├─ receiver_mixin.py     # on_message / 合批 / 图片/表情/语音识别
├─ sticker_mixin.py      # 表情包 gate / claim / send_sticker / 测试轮询
├─ voice_mixin.py        # 语音回复发送与测试轮询
├─ loop_mixin.py         # 心跳、listener 守护、UIA 自愈、care/电量/提醒
├─ bg_sender.py          # 零焦点发送通道（见 docs/微信消息后台发送.md）
├─ msg_pipeline.py       # 消息调度：同一会话串行、跨会话并发
├─ sticker_transport.py  # 表情包一次性发送（fail-closed，mock 可测）
├─ config_values.py      # 配置布尔/整数/小数、wechat.bgSend
├─ wechat_db.py          # 微信数据目录 / 多账号解析
├─ bridge_log.py         # 日志级别/轮转/boot/窗口问题节流
├─ guards.py             # 系统通知 / 重复消息 / 每分钟限流
├─ config.py            # read_config / build_bot_url / wait_for_server / ffmpeg
├─ voice.py              # 语音识别 Key / ASR 调用 / 转写清洗
├─ http_client.py        # 每线程一个 requests.Session，不读系统代理
├─ send_state.py         # SEND_STATE / 发送看门狗 / 会话身份错误
└─ engine.py             # 模块级配置 + 兼容函数 + main() 转发
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
  `sender_mixin.py` 据此决定要不要退回旧通道
- 不依赖 `wechatauto` 的 GUI 驱动，所以 UIA 引擎假死时它照样能用
- 纯逻辑自检：`python scripts/bg-selftest.py`（不需要微信在线）
- 实机自检：`python -m bridge --bg-probe`（会打印前后前台窗口号）

维护边界：

1. 窗口/UIA/剪贴板 → `window_mixin.py`；发送通道 → `sender_mixin.py`；
   账号识别 → `account_mixin.py`；收消息/媒体 → `receiver_mixin.py`。
2. 新的共享状态挂 `BridgeRuntime` 实例（`self.xxx`），不要再往模块级加闭包变量。
3. 改动后至少跑：`python -m py_compile bridge/*.py`、`python -B -m unittest discover -s tests -p "test_*.py"`、
   `node --test "tests/*.test.js"`、`node scripts/release-check.js`。
4. 入口与 HTTP 协议（`/webhook/wechat`、`/api/bridge/heartbeat`）保持不变；
   `engine.py` 只做兼容转发，不再往里加业务逻辑。
