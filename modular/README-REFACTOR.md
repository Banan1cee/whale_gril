# 模块化重构说明

这个目录是从仓库根目录的旧版本**原样迁移 + 分层重构**出来的独立项目。
根目录的原有文件没有做任何修改，新旧两套可以并存、对比、回滚。

- 技术栈不变：Node.js + CommonJS，**零 npm 依赖**
- 对外契约不变：REST 路径、`/webhook/{platform}`、`/api/bridge/heartbeat`、`server.js` 入口、`--doctor`、
  根目录 `.bat` 启动器、`config.json` / `data/` 布局
- 测试：`node --test`（480 个用例；缺便携 Python 时 4 条跳过。`execFileSync` 管道、`explorer` 打开文件夹、
  Windows 目录联接这 3 条依赖真实桌面环境，受限沙箱里会失败，不是代码回归）

## 一、目录结构

```
modular/
├─ server.js              # 薄入口：CLI / 启动 / 自检，只有装配和进程生命周期
├─ src/
│  ├─ app.js              # 唯一的依赖注入点：createRuntime()
│  ├─ core/               # 纯逻辑（无 IO），最容易单测
│  ├─ pipeline/           # 对话主流程（Bot：判断 → 组 prompt → 生成 → 落记忆）
│  │  └─ stages/          # 固定话术分支（canned.js，从 decide() 拆出的第一批）
│  ├─ persona/            # 人设、语料、预设、主人调教结果
│  ├─ memory/             # 会话存储 + 备份/恢复
│  ├─ llm/                # 模型客户端（DeepSeek / OpenAI 兼容 / Ollama / 演示模式）
│  ├─ services/           # 面向用例的业务服务（HTTP 层直接调用）
│  ├─ adapters/           # 外部世界：网关、链接、B站、联网搜索、视觉、媒体缓存
│  ├─ http/               # HTTP 基础设施 + 按领域拆分的路由
│  └─ infra/              # 配置、日志、功能开关、配置热更新、配置校验
├─ bridge/                # Python 微信桥接（`python -m bridge`）
├─ examples/              # 兼容入口与媒体兜底模块
├─ scripts/               # 运维脚本（版本号、发布、部署、桥接守护）
├─ tests/                 # 测试（导入路径已切到新布局）
├─ web/ personas/ resources/ docs/ tools/
├─ *.bat                  # 原有启动器
└─ config.example.json
```

## 二、旧文件 → 新位置

### Node

| 旧路径 | 新路径 | 说明 |
| --- | --- | --- |
| `server.js` | `server.js` + `src/app.js` + `src/http/**` + `src/services/**` | 入口只保留装配；端点按领域拆开 |
| `src/bot.js` | `src/pipeline/chat.js` | `Bot` 主流程；纯函数已抽到 `src/core/` |
| `src/config.js` | `src/infra/config.js` | 配置加载 / 预设 provider / 路径 |
| `src/logger.js` | `src/infra/logger.js` | 日志 |
| `src/features.js` | `src/infra/features.js` | 功能开关 |
| `src/persona.js` | `src/persona/index.js` | 人设与语料 |
| `src/personaStore.js` | `src/persona/store.js` | 主人调教结果持久化 |
| `src/presets.js` | `src/persona/presets.js` | `personas/` 预设加载 |
| `src/memory.js` | `src/memory/store.js` | 会话存储 |
| `src/memoryBackup.js` | `src/memory/backup.js` | 记忆快照 / 导出 / 恢复 |
| `src/llm.js` | `src/llm/client.js` | 模型客户端 |
| `src/care.js` | `src/services/care.js` | 主动搭话的时间窗 / 频率 / 台词 |
| `src/master.js` | `src/core/master.js` | 主人识别 |
| `src/links.js` | `src/adapters/links.js` | 链接抓取与 SSRF 防护 |
| `src/websearch.js` | `src/adapters/websearch.js` | 联网搜索 / 天气 |
| `src/bilibili.js` | `src/adapters/bilibili.js` | B 站视频 |
| `src/vision.js` | `src/adapters/vision.js` | 看图 |
| `src/mediaCache.js` | `src/adapters/mediaCache.js` | 媒体缓存清理 |
| `src/stickers.js` | `src/adapters/stickers.js` | 表情包图库 + 上传校验（3.60 重写版） |
| `src/stickerService.js` | `src/services/stickerService.js` | 表情包一次性任务队列（3.60 新增） |
| `src/adapters/gateway.js` | `src/adapters/gateway.js` | 未改名 |

### 从 `bot.js` 抽出的纯逻辑（`src/core/`）

| 模块 | 内容 |
| --- | --- |
| `text.js` | 敏感词清洗、群名匹配、时间格式化、文本归一化、整数收敛 |
| `identity.js` | 剔除「她否认主人」的历史片段 |
| `echo.js` | 复读检测 |
| `facts.js` | 从「我…」自述里抽取长期事实 |
| `mentions.js` | 提取 @ 对象 |
| `commands.js` | `/reset`、`/mute`、`记住…` 等小命令解析 |
| `trigger.js` | 群聊触发判断（@、接话窗口、静默期、限流、自由接话） |
| `context.js` | 历史消息 → 模型 turns（群聊事件化、长度控制、压缩摘要） |

### 从 `server.js` 拆出的服务与路由

| 新文件 | 负责 |
| --- | --- |
| `src/services/status.js` | `/api/status`、最近发言人、消息汇总、回复通道说明 |
| `src/services/settings.js` | 读写设置、切换 provider、称呼同步 |
| `src/services/debug.js` | 调试台状态 / 会话 / 提示词预览 |
| `src/services/persona.js` | 人设调教保存与恢复 |
| `src/services/wechat.js` | 多账号扫描、缓存、选账号、刷新 |
| `src/services/share.js` | 主动分享视频 |
| `src/services/careChat.js` | 主动搭话文案生成 |
| `src/services/chat.js` | 网页 SSE 聊天 |
| `src/http/router.js` | 声明式路由、安全闸、静态文件兜底 |
| `src/http/routes/*.js` | 每个领域一个文件，见 `routes/index.js` |
| `src/infra/configPatch.js` | 调试台写 `config.json`、清 `settings.json` 覆盖、热更新 |
| `src/infra/ownerName.js` | `settings.userName` → `persona.ownerName` 一次性迁移 |

## 三、Python 桥接

`examples/wechatauto_bridge.py` 的完整实现已迁到 `bridge/engine.py`，两种入口都可以用：

```bat
python -m bridge
python examples\wechatauto_bridge.py
```

`examples/wechatauto_bridge.py` 现在是薄壳，只负责补齐 `sys.path` 后转交 `engine.main()`。
`bridge/engine.py` 内部的 `main()` 仍是大型闭包，后续拆分计划写在 `bridge/README.md`。
所有运维脚本、`.bat`、文档里的旧命令都仍然有效。

3.60 起桥接多了一个纯 Python 模块 `bridge/sticker_transport.py`（上游同名文件），
负责表情包的一次性、fail-closed 发送；它有 57 项 mock 测试
（`tests/test_sticker_transport.py`，不需要微信）。

### 发送通道（3.56 起）

```
send_text()
  ├─ 0. bg_sender.py      零焦点：伪焦点 + GBK 字节 WM_CHAR + PostMessage 点发送
  ├─ 1. uia_send()        wechatauto 的 UIA 驱动
  ├─ 2. keyboard_send()   Ctrl+F 搜会话 + 剪贴板 + 回车
  └─ 3. OCR              截图找发送按钮
```

- 0 是新增的**真正的后台通道**，见 `examples/wechat_bg.py`、`docs/微信消息后台发送.md`；
  它可以独立单测（`scripts/bg-selftest.py`）和实机自检（`python -m bridge --bg-probe`）。
- 0 不依赖 `WeChatGUI`，所以首次发送不会触发「初始化窗口驱动（抢 5~10 秒焦点）」。
- 1~3 是原有链路，只在 0 失败时使用。

## 四、常用命令

```bash
node server.js            # 启动
node server.js --doctor   # 环境自检
node --test               # 全部测试
```

## 五、有意为之的行为差异

只有一处：旧 `server.js` 里 `/api/vision`、`/api/share`、`/api/digest`、`GET /api/persona`
各有重复注册的死代码，新路由表每个路径只保留一份，行为一致。

## 六、分层与校验（3.57 起）

规则写在 `scripts/check-layers.js`，`node --test` 里也会跑：

| 层 | 不允许依赖 |
| --- | --- |
| `core` | adapters / services / http / pipeline / memory / llm / persona |
| `adapters` | pipeline / services / http |
| `memory` | pipeline / services / http / adapters |
| `llm` | pipeline / services / http / adapters |
| `persona` | pipeline / services / http |
| `pipeline` | http |
| `services` | `http/router`、`http/security`、`http/static`、`http/util`（协议工具走 `http/protocol`） |

例外只写了一条：`core → infra/features`（只是读配置里的布尔值，没有 IO）。

**配置校验**：`src/infra/configSchema.js`。启动时警告、调试台保存时整批拒绝。

**记忆落盘**：`data/store.json` 是快照，`data/store.json.journal` 是增量；
`readStoreFile()` 负责合并，备份/导出/重载都用它。对外格式没变。

**还没拆完的**：`pipeline/chat.js::decide()` 仍有约 450 行（触发判定、引用、拼 prompt）。
下一步按 `stages/` 的方式继续一批一批搬，每批跑一次全量测试。

## 七、桥接的消息调度（3.57 起）

```
Listener（DB 轮询 0.4s）          收
    ▼ on_message
MessagePipeline                    判：按会话串行、跨会话并发
    ▼ on_message_inner（图片/OCR/webhook）
send_text()                        发：send_lock 串行
```

- `bridge/msg_pipeline.py` 不依赖 wechatauto，能单独自检
- `wechat.pipelineWorkers`（默认 4）/ `pipelineQueueLimit`（默认 4）
- `WHALE_PIPELINE_WORKERS=1` 退回旧的全串行


