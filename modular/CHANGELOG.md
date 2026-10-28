# 更新记录

## 3.60

**同步上游 3.60：表情包功能重做 + 人设预设修复。**

### 1) 表情包（实验性，默认关）

- 控制台可按五类情绪拖拽上传（每次 1~5 张、单张 ≤4MB，校验文件头/尺寸/格式）、删除单张、打开文件夹、看缩略图
- 五类概率在页面上直接改成百分比；保存只写这五项，不碰总开关
- 分类**严格匹配**：开心不会发成炸毛；这一类没图才回落「通用」
- 上传防目录逃逸 / 符号链接 / 同名覆盖
- 发送改成**一次性、fail-closed** 的通道：只对已打开的目标会话操作，不切会话、不猜；
  读不到输入框状态就不按发送
- 关闭总闸立即取消未发任务：不轮询、不回包带字段、管理接口 404

### 2) 人设预设

- 导入预设不再把她的名字改成预设标题；只有 `personaName` 才改名
- 人设页选到哪版就直接填进表单（新增 GET 预览接口），保存才生效
- `deepMerge` 改成深拷贝：一次导入不再污染模块级默认值

### 3) 桥接同步

- 新增 `bridge/sticker_transport.py`（零依赖、mock 可测）
- 桥接新增表情包 worker：`pending → claim → 发送 → ack`，关闭时完全休眠
- `send_text` 增加草稿隔离：表情包留下不确定草稿时，普通文字发送先停下等人清理

### 4) 基础设施

- `readBody` 超过上限不再 `destroy` 连接（调用方能收到 413 而不是连接被重置）
- 版本号支持两段式（`3.60`），`bump-version` 两段/三段都能用

## 3.57.0

**这一版是「把地基补上」：分层有检查、配置有校验、记忆不再每次全量重写、发送通道能自动提权。**

### 1) 分层检查（`scripts/check-layers.js`）

把「谁可以 require 谁」写成规则，`node --test` 里也会跑：

```
core      ✗ adapters / services / http / pipeline / memory / llm / persona
adapters  ✗ pipeline / services / http
memory    ✗ pipeline / services / http / adapters
llm       ✗ pipeline / services / http / adapters
persona   ✗ pipeline / services / http
pipeline  ✗ http
services  ✗ http 服务器实现（协议工具 http/protocol 允许）
```

顺手修掉两处真的反向依赖：

- `core/mentions.js` 不再 require persona，别名由调用方传（core 又纯了一点）
- `services/chat.js` 改 require `http/protocol`，把「HTTP 协议工具」和「HTTP 服务器」分开

### 2) 配置校验（`src/infra/configSchema.js`）

40+ 个常用字段有了类型/范围表。以前把「历史轮数」填成 `abc`，界面上显示保存成功，
实际还是旧值。现在：

- 启动时日志里报一次（不阻断）
- 调试台保存时整批拒绝，报错带字段路径，**一个字节都不写**（不会改一半）

### 3) 记忆落盘：快照 + 增量日志

以前每次落盘都把所有会话重新序列化一遍，会话越多写一次越慢。现在：

- `data/store.json` 还是快照（格式没变，老文件直接能读）
- 动过的会话追加一行到 `data/store.json.journal`
- 日志超过 512KB / 程序退出 / prune 时压回快照
- 读的时候自动合并；备份、导出、`reloadFromDisk` 都走同一个 `readStoreFile()`

### 4) `decide()` 开始拆分

第一批把「不需要模型、一条正则就能决定」的分支搬到 `src/pipeline/stages/canned.js`：
群成员名录 / 查微信号 / 同意被损 / 主人点名吐槽 / 退场 / 休息模式。

判断顺序和正则原样保留，现有 429 个测试全绿。剩下的（触发判定、引用、拼 prompt）
还在 `decide()` 里，后续按同样方式一批一批搬。

### 5) 安全小修

- 静态文件防穿越：`startsWith` 改成 `path.relative`（`web-evil/` 这种前缀逃逸挡掉了）
- token 比较改成恒定时间（`crypto.timingSafeEqual`）
- 所有响应加 `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` / CSP

### 6) 桥接自动提权

微信以管理员运行时，普通权限的桥接读不到控件树（UIPI），零焦点发送会全部退回旧通道。
`启动微信桥接.bat` 现在会先检查令牌完整性级别，不是管理员就自己用 UAC 重新拉起
（工作目录不变）。不想每次弹 UAC：设 `WHALE_NO_ELEVATE=1`。

### 7) 桥接消息调度：同一会话串行、跨会话并发

以前是 `ThreadPoolExecutor(max_workers=1)` —— 所有消息挤一条队。群里连发 3 张长截图时，
第一张的 OCR 要几分钟，后面全堵着（收消息、识别、等模型、发送全在一条线上）。

现在拆成三段（新文件 `bridge/msg_pipeline.py`）：

```
Listener（DB 轮询 0.4s） → MessagePipeline（按会话串行，跨会话并发） → send_text（send_lock 串行）
```

- 同一会话严格保序（不会出现「回复顺序乱」「两条回复抢同一个上下文」）
- 不同会话并行，一个慢群不会拖住私聊
- 单会话积压超过 4 条丢最早的（服务端的 `STALE_AFTER` 还有一层兜底）
- 配置：`wechat.pipelineWorkers` / `wechat.pipelineQueueLimit`；
  `WHALE_PIPELINE_WORKERS=1` 可立刻退回旧行为
- 并发安全：`requests.Session` 换成每线程一个（`_ThreadLocalHTTP`），
  媒体下载器创建加锁（不会同时 new 两个往同一目录落文件）
- 自检：`python scripts/bridge-pipeline-selftest.py`（10 项，不需要微信）

## 3.56.0

**这一版把「发消息」改成真正不抢前台。**

### 1) 新增零焦点发送通道（`bridge/bg_sender.py`）

按 `docs/微信消息后台发送.md` 实现，三条腿全部走窗口消息：

- **物化** `SPI_SETSCREENREADER`（微信 4.2 上单独不够，自动退到 wechatauto 的 gate 热激活）
- **读控件** UIA `FindAll(Descendants)`，认 `AutomationId=chat_input_field` 和 `Name=发送`
- **写** `WM_SETFOCUS` 伪焦点 + GBK 字节逐个 `WM_CHAR` + `PostMessage` 点发送按钮

全程不调用 `SetForegroundWindow` / `SetWindowPos` / `SetFocus` / `SendInput` / `keybd_event`，
所以是**结构上不碰前台**，不是「碰完再还原」。发消息时你可以继续用电脑。

发送顺序变成：**零焦点 → UIA → 键盘 → OCR**，前一条失败才试下一条。
副作用：首次发送不再需要构造 `WeChatGUI`（那一步本身会抢 5~10 秒焦点），
所以开机后第一条回复也不会打断你。

### 2) 新配置 `wechat.bgSend`

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `charGapMs` | `40` | 每个 GBK 字节的间隔；太小会丢字，20~80 之间 |
| `verify` | `true` | 发完回读输入框是否清空；关掉省约 0.5 秒 |
| `fallbackToForeground` | `true` | 失败时退回旧通道；`false` = 绝不抢前台，失败就不发 |
| `stripUnencodable` | `true` | emoji 等 GBK 编不了的字符跳过；`false` = 整条退回旧通道 |

### 3) 命令行自检（不需要动主流程）

```bat
python -m bridge --bg-probe
python -m bridge --bg-send "测试" --to 文件传输助手
python examples\wechat_bg.py --probe
python scripts\bg-selftest.py        :: 纯逻辑，不需要微信在线
```

`--bg-probe` 会打印节点数、当前会话、发送按钮坐标，以及**前后前台窗口号**，
用来确认到底有没有抢前台。

### 4) 实测（微信 4.2.0.9 / Windows 11 / 150% 缩放 / 提权）

| 项 | 结果 |
| --- | --- |
| 发送一条 10 字中文 | 2.0 秒 |
| 发送前后前台窗口 | 200612 → 200612（**没抢**） |
| 发送后输入框 | 清空（回读确认） |
| 物化节点数 | 150（聊天页）/ 81（未打开会话） |

复现：`python -m bridge --bg-probe` / `python -m bridge --bg-send "测试"`

本机踩到并已修掉的四个坑，详见 `docs/微信消息后台发送.md` §12：
DPI 不感知导致点偏 1.5 倍、gate 字节必须 0→1、窗口隐藏时树会萎缩、
点会话后控件树会重建。

### 5) 已知限制

- **必须提权**：非管理员进程读 4.2 的控件树是 0 个节点（UIPI）
- 微信缩在托盘时会用「显示但不激活」拉出来（不抢前台）；不想要这个行为可以把
  `bgSend.unhideWindow` 设成 `false`，那样隐藏状态直接退回旧通道
- emoji 等 GBK 覆盖不到的字符：默认跳过并记日志
- 群聊真 @（`send_at`）和引用回复仍走旧通道（要用 UIA 选人 / 点引用）
- 系统代码页必须是 936（中文）。英文/日文系统需要另做编码适配

## 3.55.1

**这一版去掉表情包，加了一键更新。**

- **移除**：表情包功能（data/stickers、按情绪挑 gif、两个开关、桥接里相关代码）——上线前评估风险偏高，先不带了
- **新增**：`一键更新.bat`（社区 PR @xmuzhou）：查最新 release → 下载 → sha256 校验 → 备份 → 只覆盖代码 → 自检 → 失败自动回滚。`data\` 和 `config.json` 一个字节不动
- 保留：微信双开钉账号（PR #1）那次修复


## 3.55.0

### 1) Windows Server 报「需要 pip 装包」，其实是缺 VC++ 运行库
任何导入异常都会被附上「pip install wechatauto-replica」这句话。Windows Server 默认不带 MFC/vcruntime，原生模块加载失败却让人去 pip，等于把用户带沟里。现在按 `OSError / DLL load failed / WinError 126` 判定，改成引导装 [vc_redist.x64](https://aka.ms/vs/17/release/vc_redist.x64.exe)，并说明 Server 的情况。

### 2) 看图要 ffmpeg —— 现在包里自带
微信 4.x 的图片是 wxgf/HEVC 容器，必须 ffmpeg 才能转成 jpg。以前只在找不到时打一行警告。现在 `runtime\ffmpeg\bin\ffmpeg.exe` 随包分发（ffmpeg 7.1 essentials，含 HEVC 解码），启动日志会写「找到 ffmpeg：（包里自带…）」，`data\bridge-ready.json` 里也有 `ffmpeg: true/false`。

⚠️ 代价：发行包从 86.7MB 涨到约 117MB。

### 3) 「重启了但不监听」——打开数据库卡死
发送卡住 40 秒 → 看门狗自杀 → 守护 3 秒重启 → 新进程卡在 `WeChatDB()`（内部找微信进程/取密钥偶发不返回）→ 永远走不到监听。现在：

- 打开数据库加 **90 秒超时**，超时明确说「卡住不是崩溃」，`code=2` 优雅退出（不触发无限重启）
- 起来后写 `data\bridge-ready.json`（pid / 时间 / ffmpeg 状态），启动脚本每次启动前先删掉它，据此判断「起来了但没监听」
- 守护循环加**重启上限**：连续 4 次起来就退出就停下来并提示看日志，不再每 3 秒刷屏

### 4) 「由于目标计算机积极拒绝，无法连接」
三个真原因，逐个修：

- **启动顺序**：桥接启动前先 `wait_for_server`（最多等 30 秒），不再抢在服务 listen 之前；等不到会明确提示「先双击 启动鲸鱼娘.bat」
- **代理残留**：Clash 之类留下的 `HTTP_PROXY` 会让连 `127.0.0.1` 的请求也走代理 → 报积极拒绝。本机请求改走 `trust_env=False` 的 session
- **端口不一致**：服务把实际端口写进 `data\server-port.txt`，桥接优先读它；手动 `--port=8788` 也不会再连错
- 连接失败改成 10 分钟一条（不再每条消息刷屏），恢复时打一条「已连上鲸鲸服务」

### 5) 新增「先点启动鲸鱼娘再点启动桥接」文件夹
里面两个编号启动器：`1 先点这个 启动鲸鱼娘.bat` / `2 再点这个 启动微信桥接.bat`。把最容易错的顺序写进文件夹名。

### 6) 主动找话题默认只找主人
群里突然来一句「今天累不累啊」很社死（日志实测 158 条主动搭话，包括群聊）。现在默认只私聊主人，开关在调试台可调：

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| 主动找话题 | 开 | 总开关 |
| 只找主人 | 开 | 不找别人 |
| 允许进群 | 关 | 打开才可能发群 |
| 找非主人私聊 | 关 | 打开才会主动找别人 |

顺带修掉「发送失败每分钟重试」和「配置写成字符串 false 关不掉」两个问题。

### 7) 砍掉全局热键
删除 `启动热键.bat` 和 `tools\hotkey_daemon.py`（PageUp 终止 / PageDown 恢复）。它要常驻、还和浏览器翻页冲突，实际用的人不多。

**主动找话题默认关闭，而且永远不进群。**

原因很直接：有人在群里收到她突然来一句「今天累不累啊」，非常社死。日志里实测有 158 条「主动搭话」，其中就有群聊（比如「某个会员群」）。

- `care.enabled` 默认 `false`：不主动找你说话了，想开在调试台「功能开关 → 主动找话题」打开
- `care.allowGroups` 默认 `false`：就算开了，也只私聊，桥接挑目标时直接跳过 `@chatroom` 的群；服务端 `/api/care/due` 也会再拦一次
- 修掉「每分钟重试」：发送失败以前不写状态，于是每 60 秒重发一次（日志刷屏的元凶之一），现在失败也记时间
- 开关解析兼容字符串：老配置里写成 `"false"` 字符串也会被正确当成关（以前 `Boolean("false")` 是 true）

## 3.53
### 群里「分不清宾语」修复（L1 + L3）

以前：A 叫过她，A 转头骂 B「你个傻逼」，她冲 A 开火；别人聊「你吃饭没」，她插嘴；群里说「这破机器人」也算叫她。

- **L1 触发层**：`@ 了别人`（用桥接传来的 mentioned_names）、出现第三人称（他/她/楼上…）、出现其他成员昵称 → 判定「在跟别人说话」，不接话、不记接话窗口
- **L1 触发层**：`engaged_group`（她 90 秒内说过话 + 有人发「你」）不再无条件唤醒，必须是在叫她
- **L1 触发层**：「机器人」不再裸算点名，要带指代（这个/那个/你/破/臭/傻/烂/死）
- **L3 模型层**：群聊提示词要求「先说清楚在跟谁说话」，且会把她被 @ 的名单直接写进提示词
- **L3 兜底**：只在「连她名字都没提」的自动开火时校验原话依据，说不清就降级成「？」，不再乱喷

### 功能开关体系（新功能必须有开关）

新增 `src/features.js` 登记表 + `/api/features` + 调试台「功能开关」卡片：

| 开关 | 默认 | 说明 |
| --- | --- | --- |
| groupAddressGuard | 开 | 群里先分清「你」在说谁 |
| fightQuoteCheck | 开 | 开怼前必须引用对方原话 |
| mediaCleanup | 开 | 启动时清理媒体缓存 |
| memorySnapshot | 开 | 自动记忆快照 |
| quoteReply | 关 | 引用回复（慢） |

关掉任意开关 = 回到旧行为；开关写进 config.json，重启后还在。

新增 `tests/group-l1l3.test.js` 8 条。

### 引用回复默认关闭

**引用回复默认关闭。** 有人反馈「一开就回复巨慢」——这是真的：引用回复要多走一遍「悬停消息 → 点回复 → 输入」，每条多出数秒。现在默认关（`QUOTE_REPLY=False`），需要时在 config.json 把 `wechat.quoteReply` 设 `true`；桥接启动时会打一行「引用回复：开/关」，改完重启就能确认生效。

### 三件顺手的事

三件顺手的事：

- **C1 日志节流**：没配看图 Key 时，以前每张图都刷一条「第 N 段识别失败」，几百行把真问题淹掉。现在同类错误 10 分钟只记一行，并汇总「还有 N 条被折叠」。
- **C2 媒体缓存清理**：`data/media-cache`（微信图片、表情包转码、语音 wav）以前永不清理。启动时按「7 天」+「总量 500MB」清一次，可用 `storage.mediaKeepDays` / `storage.mediaMaxMB` 调。
- **C3 搜索时效过滤**：问「最新 / 现在出到几」时，把明显过期的结果剔掉（实测原来会把 2010 年的「iPhone 全系回顾」当现状，导致她答 iPhone 16）。**注意没有简单给查询加年份**——实测加了反而把「1 天前」的新结果挤掉，所以按摘要里的日期判断。

新增 `tests/c1c2c3.test.js` 8 条。

**安全：本地控制台的 CSRF 洞。** 实测：任何网站都能向 `127.0.0.1:8787` 发 POST（哪怕 `Content-Type: text/plain`，浏览器不会预检），于是「打开一个恶意页面」就足以改她的称呼、模型地址、主人名单，甚至把 `apiKey` 指到攻击者服务器。现在：

- 浏览器发起的跨站写请求一律 403
- 同源写操作必须是 `application/json`（挡住表单式 CSRF）
- 不带 `Origin` 的客户端（微信桥接 / curl）不受影响

**联网：口语式「最新」问题不触发搜索。** 以前只认「查一下/最新/多少钱」，用户问「苹果现在出到几了」匹配不上，她就拿训练数据答年份（实测说成 iPhone 16，而实际已经是 iPhone 18）。现在触发词扩到「出到几 / 第几代 / 什么型号 / 哪个版本 / 今年 / 发布会」+ 品牌词，并在提示词里要求：涉及最新/价格/型号时，没有联网资料就直说记的是旧的。

新增 `tests/security-csrf.test.js` 5 条。

## 3.52

**更新不再丢记忆，也不用手动导出。** 以前丢记忆不是程序删的，是因为大家把新版本解压到一个**新文件夹**，新目录里没有 `data\`，看起来就是记忆全没了。

这一版做了两件事：

1. **发行包里不再带 `config.json`**：更新时解压到**原来那个文件夹**、选「覆盖」，`data\`（聊天记忆 / Key / 称呼）和 `config.json`（主人名单 / token）都不会被动，记忆自然就还在。第一次运行时服务会自己生成 config.json。
2. **新增 `升级到新版本.bat`**：万一已经解压到新文件夹了，双击它会自动在同级目录里找旧版本、把 `data\` 和 `config.json` 搬过来（迁移前先把当前数据另存到 `backup\before-migrate-时间\`）。

所以正确姿势只有一句：**解压到同一个文件夹，选覆盖。**

## 3.51

**记忆终于能带走了。** 有人反馈「每次更新记忆就没了」——根因是更新方式是把整个文件夹换成新版本，新目录里没有 `data\`，看起来就是记忆全丢。现在三道保障：

1. **每次启动自动快照**：存到 `data\backups\memory-时间-startup.json`，只留最近 20 份，误重置 / 换目录 / 重装都能捞回来；
2. **一键导出**：双击 `备份记忆.bat`，或者网页 `GET /api/memory/export` 直接下载 `whale-memory-日期.json`（含聊天记忆、称呼设置、调教台人设）；
3. **一键恢复**：`恢复记忆.bat` 选一份快照，或者 `node scripts/memory-tool.js restore <你的.json>`；**恢复前会先把当前记忆另存一份**（`before-restore`），手滑也能回去。

另外加了 `/api/memory/info` 看得到「几段会话、几条消息、几条笔记」，调试台也能一眼确认记忆还在不在。新增 `tests/memory-backup.test.js` 5 条。

## 3.50

从 3.4.x 直接跳到 3.50，作为**第一个完整发行版**（带 Node + Python 运行时，解压双击即用）。

这一版包含 3.4.10 → 3.4.13 的全部修复：称呼双入口统一（网页设置 / 调试台写同一份 `persona.ownerName`）、状态播报降权（不再句句「我刚泡完脚」）、`restore_win_state` 缺 `import ctypes` 导致窗口不还原、控制台非回环监听的安全闸、称呼迁移只做一次且清空可重置、看图接口支持 http/自定义端口、语音配置热更新、数据库目录兼容直填/拍平/L 盘与网络盘。

## 3.4.13

审计出来的三个功能性问题。①**看图接口不再是 https 专属**：`postJson` 以前写死 `https.request` 且不传端口，本地/自建视觉服务（`http://127.0.0.1:11434`、`https://host:8443`）一律连不上；现在按协议选 http/https 并显式传端口。②**语音配置可热更新**：`reload_config()` 以前漏刷 `VOICE_API_KEY/TIMEOUT/MAX_SECONDS`，网页里换 Key 必须重启桥接；Key 查找链也补上了 `config.deepseek.apiKey`（注释承诺了却没实现）。③**数据库目录更抗折腾**：`looks_like_db_root` 补上「直填账号目录 / 拍平的 db_storage」，盘符不再写死 C..K，改用真实盘符 + psutil 挂载点（L: 盘、网络盘都能找到），媒体兜底同步。

新增 `tests/audit-fixes.test.js` 5 条（含真的起一个本地 http 视觉服务验证打通）。

## 3.4.12

两个安全/一致性修复。①**控制台不再对局域网裸奔**：以前只要把 `server.host` 改成 `0.0.0.0`，同网段的人打开网页就能改 Key、改人设、注入聊天（`/api/settings`、`/api/config`、`/api/persona`、`/api/debug/reset` 都没鉴权）。现在非回环监听必须显式 `server.allowRemote=true`，否则强制回退 `127.0.0.1` 并告警；远程写操作还要求 `x-bot-token` 且不能是默认的 `change-me-wechat`，否则 403。②**称呼迁移只做一次**：以前 `migrateOwnerName()` 每次启动都拿老的 `settings.userName` 覆盖 config，把称呼改回「主人」重启又被盖回来，清空也没用（`if (patch.userName)` 把空串当「不改」）。现在迁移完清掉老字段，清空按「恢复默认称呼」处理。

新增 `tests/security-and-owner-reset.test.js` 5 条。

## 3.4.11

降「状态播报」权重：以前每条消息的 `【此刻】` 都带一句「你${activity}」，她就句句拿这个开场（「我刚泡完脚，手还湿着呢」「在收拾房间」），人机感很重。现在 `【此刻】` 只给时间；「在干嘛」按小时抽样，约两成的小时才作为背景给出，并明确要求**不要主动说出来**、别拿它开场；心情也从「今天的心情：X」改成「语气底子」，禁止说「我今天心情…」。核心性格新增两条：别汇报状态、别把话题拽回自己。新增 `tests/status-mention.test.js` 4 条（含「24 小时里只有少数几小时给背景」）。

## 3.4.10

修「网页设置里把「怎么称呼你」改成「爸爸」，私聊里她还是叫「主人」」：两个入口各存各的，而且提示词根本没读它。①`persona.buildSystem` 从头到尾没读过 `config.persona.ownerName`，主人那段写死了「主要叫「主人」」；②网页存进 `data/settings.json` 的 `userName` 只拿去 `/api/state` 显示，从没写回 `config.persona.ownerName`，调试台改 `persona.ownerName` 又不会更新网页设置——两边看到的值可以完全不一样。

现在**两个入口写同一份数据**：网页设置保存时通过 `applyConfigPatch` 写进 `config.json` 的 `persona.ownerName`；调试台改完同一个字段，`/api/settings` 读到的就是新值；老数据（只有 `settings.userName`）启动时由 `migrateOwnerName()` 自动搬进 config.json。提示词按 `ownerName` 生成「你叫 TA「X」，就这一个称呼，别用微信昵称也别混着叫主人」，保存后立刻生效，不用重启。

新增 `tests/owner-name.test.js` 4 条（提示词必须带称呼、默认仍是「主人」、非主人不会被错叫）和 `tests/owner-name-sync.test.js` 3 条（网页设置落盘、调试台与网页互相同步、老数据迁移）。

## 3.4.9

修「明明查到了天气，她还说看不到、说自己连不了网」：3.4.6 的联网资料只塞进了「自定义人设」那条分支，而出厂配置的 `persona.customPrompt` 是空的，绝大多数人走的是默认人设——于是 `msg.webText` 根本没进提示词。实测日志里「天气查询：北京」成功返回了实时温度，她照样回「我这边看不到天气啊，得你自己查查」「不能，我连不了网，就一个聊天框」。现在默认人设也带上资料块，并明确告诉她确实能联网、不许回「我连不了网」。新增 1 条行为测试（直接调 buildSystem 验提示词里有资料，不再只拿正则看源码）

## 3.4.8

修「表情包被当成图片去认」：以前收到表情包会按 md5 找本地缓存、截聊天窗口、转码后送视觉模型，认出来还硬接一句，群里经常接岔。现在整条识别链（`describe_sticker` / `screenshot_sticker` / `_find_sticker_file` / `_sticker_label` / `_account_root`）全部删掉，表情包一律装死：不识别、不回话，只留一条日志。另外补一条兜底：有的微信版本把表情包报成「图片」，正文里仍是 `<emoji md5=...>`，这种消息在进图片识别之前就按表情包装死，绝不再送视觉模型。新增 tests/bridge-recovery.test.js 2 条断言（装死 + 被标成图片也装死）

## 3.4.7

修「群里说让她滚之后她还在说话，没人@她也插嘴」：三个问题叠加。①「让她滚」是第三人称，dismiss 正则只认「你滚/滚」这种直接命令，根本没进静默；②INSULT_RE 里就有「滚」，而两处判定都是裸匹配（不管在说谁）——群里任何人抱怨「这天气真垃圾」「股票跌了滚蛋吧」，她都当成在骂自己，跳出来对喷；③静默期优先级低于 masterAlwaysReply，主人说完「让她滚」下一句又把她叫起来。修法：①dismiss 增加第三人称（让/叫/把+她/它/鲸鲸/机器人+滚/闭嘴…），群里别人说也算；②骂人判定必须先确认骂的是她：点名她/叫机器人，或正在跟她对话（@她、回复她、同一个人的接话窗口）——「张三你个傻逼」里的「你」指张三，不算；③静默判断提到 masterAlwaysReply 之前；④静默期内 @ 她仍能唤醒，不变成永久失联。新增 tests/silence.test.js 7 条

## 3.4.6

修「问她天气她不知道」：两个问题叠加。①联网搜到的东西**从没送进提示词** —— bot.js 里 webText 只赋给局部变量、写了个日志就完事，msg 上从没挂过它，而 persona 读的正是 msg.webText，于是「【刚联网搜到的资料】」永远是空，搜索白跑。②就算送进去，天气靠 Bing 摘要也答不准（常只有多云没温度，还串城市，实测人在A 城市却答B 城市今天晴）。修法：① msg.webText 真的挂上去；②天气改走 open-meteo（免费/无 key/中文地名），给当前温度、体感、湿度、风、今明两天、降水概率，天气代码翻成人话；③话里没提城市用配置 websearch.city，都没配就按本机公网 IP 猜；④加 websearch.enabled 开关和超时。新增 tests/weather.test.js 6 条

## 3.4.5

修「图片识别只认默认微信文件地址，改了保存位置就不行」：根因是 wechatauto 把图片缓存路径写死在当前账号目录（db.account_dir/msg/attach），微信改「文件保存位置」后数据库搬到新目录、账号目录名还换新哈希后缀，但图片缓存不保证跟着搬——于是消息正常、图片永远找不到。新增 examples/media_fallback.py：给 MediaDownloader 打一层只读兜底，当前账号目录找不到就按「会话 md5 + 图片 md5」去其它账号目录/其它盘的 xwechat_files 找，密钥反推的探针/模板也接同样兜底（否则新目录一张图都没有时连密钥校验都过不去）；桥接 _get_media() 创建下载器时自动装。真机回归 6/6 成功（默认路径不受影响）。新增 tests/image-dir.test.js 4 条

## 3.4.4

修「长时间挂着不管就报 Bridge exited with code -1073741819」：那个码就是 0xC0000005（访问违规，微信窗口被回收/自更新时 UIA 碰了失效句柄，原生崩溃，Python 拦不住）。① 碰 UIA 前先现查微信主窗还在不在（IsWindow），没了就把缓存引擎丢掉、别碰，心跳/发送/热激活三处都埋挡板；② 开 faulthandler，崩溃前把「当时在跑哪句」留到 data/bridge-crash.log；③ 启动脚本改守护循环，真崩了 3 秒内自动拉起，不用人工；④ 看门狗重启码 2→7，跟「找不到数据库」的优雅报错分开，避免无限重启刷屏。新增 tests/bridge-crash.test.js 6 条

## 3.4.3

修「聊久了乱说话」：① 罪魁是采样参数 —— frequency_penalty 0.35 + presence_penalty 0.25 会强迫模型避开常用词，再叠加 temperature 1.15/1.25 的高随机性，它就去挑生僻搭配：语法还是中文、语义全散了，越说越长最后被 max_tokens 截断。默认改成温度 0.95、两个惩罚项归零、max_tokens 700；② 老配置自动迁移（只改恰好等于旧默认值的，用户自己调过的绝不动），并把结果写回 config.json 和 data/settings.json，别让人打开文件看到的还是旧值；③ 设置面板「俏皮程度」滑块默认 1.25 → 0.95，上限 1.6 → 1.4；④ 输出侧兜底：识别出「凑字/无标点/复读」或撞上长度上限时，换保守参数（无惩罚项、温度 0.7）重试一次，还不行就退到最后一个完整句子。新增 tests/sampling.test.js 12 条

## 3.4.2

修「每小时回复上限」偶发漏拦：判断上限用的是 state.replyTimes，会话状态被重建时这个数组会丢条目，于是两条消息挨得很近时上限被绕过（实测并发下有约 1/4 概率漏拦）。现在用同源的 lastReplyAt 兜底：replyTimes 里一小时内的条目为 0 但 lastReplyAt 在一小时内时，至少算 1 条。全量测试连跑 4 次不再复现

## 3.4.1

修「未找到微信数据库目录，Bridge exited with code 1」：微信文件存在别的盘（E:\xwechat_files 这类很常见）时，wechatauto 自带的 auto_detect 只查文档/用户目录/注册表，永远找不到，桥接启动即崩、只甩一大段 Traceback。现在桥接自己找：① config 的 wechat.dbDir 优先；② 反射正在运行的微信进程打开的文件（最准）；③ 扫各盘根目录的 xwechat_files / WeChat Files；④ 仍然找不到就给「照着一二三做」的中文提示并以退出码 2 结束，不再 traceback。调试台和 config.example.json 都加了「微信文件保存位置」字段。新增 tests/db-dir.test.js 5 条

## 3.4.0

调试台系统性修复（用户反馈调了没用）：① 桥接以前只在启动时读一次 config.json，wechat.* / share.enabled / care.enabled 等 12 个字段在 /debug 改完毫无反应，只能重启桥接——现在每 5 秒对比 config.json 修改时间并热更新，实测 2 秒生效；② group.requireAt（群里必须@她才接）业务代码里根本没读，纯摆设——现在关掉=群里不@也回；③ group.maxRepliesPerHour（每小时上限）同样没被读——现在按最近一小时实际回复数拦截，超了返回 hourly_cap；④ share.sources 写什么都硬抓 B 站——现在填别的会明确返回 no_source。全量审计 88 个调试台字段：0 个死字段。新增 tests/debug-console.test.js 5 条

## 3.3.6

默认必须是正常人格：① personaStore 的 DEFAULTS 补上 customPrompt / sourcePreset，否则「恢复默认」清不掉自定义提示词，旧提示词继续盖住控件人设（点了恢复默认还是没变化）；② 人设页「整体语气」的默认档改标「正常（默认）」，别再让人以为默认是别的人格；③ 明确出厂不带自定义提示词（测试断言）。补 2 条测试

## 3.3.5

修「人格预设调完没区别」，三处叠加：① 人设页 save() 根本没提交 customPrompt，自定义提示词里写什么都静默丢弃；② fill() 也不回填，导入 v1/v2/v3 后框里还是空的（而三版差异只在 customPrompt 里）；③ personaStore.save() 把空字符串统一删掉导致 apply() 读不到，自定义提示词一旦写入就永远清不掉，之后改性格/外貌/整体语气全部无效——这是主因。现在：读写都接上、清空真的生效、生效时明确提示「下面的控件不生效」、新增「清空自定义提示词」按钮、导入时记 sourcePreset 并在页面显示「当前生效：persona-v3（自定义提示词 1056 字）」。新增 tests/persona-preset.test.js 7 条

## 3.3.4

安全修复：键盘兜底通道在粘贴正文前先核对「打开的是不是目标会话」（用 UIA 只读能力读 current_chat，假死时读仍然可用），核对不了就放弃这条，宁可晚回也不发错人。起因是 10-25 12:21 的生产日志出现过「键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话）」。补 1 条回归测试

## 3.3.3

修 UIA 自愈缺口：桥接启动时微信正好在托盘里（主窗隐藏）时，gui 一直定位不到主窗，之后把微信拉出来也不会自愈，心跳永远报 uia:false。现在心跳连续 3 次拿不到引擎就重建窗口驱动（补 nonlocal gui，否则赋值无效）。补 1 条回归测试

## 3.3.2

修「边用边聊」被打断的 bug：前台全屏判定把「最大化窗口」也当成了全屏（2560x1440 实测最大化浏览器 rect=(-8,-8,2568,1448)，旧逻辑直接算全屏），表现为窗口一最大化她就不回消息，全在排队。改成按显示器矩形（MonitorFromWindow rcMonitor）+ 必须无标题栏无边框（WS_CAPTION/WS_THICKFRAME）判定。A/B 实测：修后浏览器最大化时 care 正常发送；真全屏（无边框盖满显示器，模拟游戏）130 秒内一条不发，保持安静。补 1 条回归测试

## 3.3.1

修隐私泄漏：出包时把三处个人信息带进了源码包（BUGS.md 写了本机真实用户目录、维护手册把禁用串原文列出、build-release.ps1 默认输出目录写死用户名）。三处已改；release-check 新增第 24 项「没有个人信息（密钥 / 真实 wxid / 本机用户名）」，按本机 USERNAME/USERPROFILE 精确判定（不误伤张三这类占位示例），命中即不许出包；补 1 条测试

## 3.3.0

新功能：后台发送（wechat.backgroundSend，默认开）——不再长期占用电脑。实测微信最小化/被遮挡/前台全屏时 UIA 都能发（18/18），所以发送前不再主动抢前台；万一失败才把微信拉到前台重试。关键是**发完把窗口状态还原**：该最小化的重新最小化、前台还给原来那个窗口（带 ALT 解锁 + 重试 + SwitchToThisWindow 兜底）。真机实测一次发送会占用前台约 4 秒，之后微信回到最小化、前台交还。新增 snapshot/restore_win_state、install_quiet_uia（让引擎别自己 `_activate` 抢前台）、1 条回归测试、docs/接入微信.md 实测表格与「要不要上虚拟机」对比

## 3.2.1

主动搭话修复：抖动不再盖过用户设的间隔（原来 everyMinutes=1 + jitterMinutes=25 会变成等 22 分钟，像是设置没生效），抖动上限收窄到间隔的一半；新增 2 条端到端测试（闸门全流程、调试台保存后立刻生效）与 1 条抖动回归测试

## 3.2.0

新功能：主动搭话（care）——没事时她自己来问一句「在干啥 / 累不累」，机制同主动分享；调试台可圈定时间窗（支持跨零点）与频率（平均间隔 + 随机浮动 + 每日上限 + 刚聊过就跳过）；判断逻辑在 src/care.js，新增 /api/care 与 /api/care/due 两个接口，桥接新增 care_watch 定时器

## 3.1.0

版本号在台面上可见：包名带完整版本（whale-girl-X.Y.Z.zip），启动横幅和网页标题栏显示 vX.Y.Z，避免新旧包混用

## 3.0.16

### 版本流程：一次改动 = 一个版本号

- 新增 `scripts/bump-version.js`（`npm run bump -- "这次改了什么"`）：一条命令完成「版本号 +1」和「CHANGELOG 顶部插一条」，支持 `--level=minor|major`；同一个版本号已存在会直接报错。
- `release-check.js` 新增 3 项强制校验：版本号**不重复**、当前版本线**不跳号**、每个版本**必须有说明内容**（外加原有的 `package.json` = CHANGELOG 首条）。
- `docs/维护手册.md` 写明固定五步：bump → test → release-check → deploy → 出包。
- 新增 1 条测试：工具存在、支持 level、release-check 确实包含这三项检查。

## 3.0.15

### 别再把「演示模式」当成真的会聊天

没配 API Key 时，她会用 `persona.mockReply()` 的**内置台词**回话 —— 看着跟真模型一模一样，很多用户以为是「邪门，没 Key 也能聊」。现在三处都会说清楚：

- **桥接日志**（首次回复时提醒一次）：
  `[!] 服务端现在是「演示模式」：没配置 API Key，她回的是内置台词，不是真模型。`
  （服务端 webhook 响应新增 `mock` 字段，桥接据此提醒）
- **网页聊天区**：进演示模式时插一条系统提示，说明现在说的是内置台词。
- 已有的状态胶囊 / 设置页提示保持不变。

另外这次部署顺手修了一个版本漂移：`F:` 里的程序被旧包覆盖成了 **3.0.9**，导致 3.0.10~3.0.14 的修复（颜文字、键盘兜底、恢复出厂）都不在里面。
## 3.0.14

### 「重置全部.bat」改成真正的恢复出厂

以前这个脚本只是**重启**（杀进程再拉起来），data\、config.json 一点没动，所以「重置了怎么还认着旧主人/旧 Key」。

现在它按顺序做（逻辑在 `scripts/factory-reset.ps1`）：

1. 停掉所有进程（复用 `stop-all.ps1`）
2. **备份** `data\` + `config.json` 到 `backup\reset-<时间戳>\`（Key、聊天记忆还能捞回来）
3. 删除 `data\`、`config.json`、`wechatauto_db\`、`wechatauto_logs\`、`debug.log`、临时截图
4. 用 `config.example.json` **重建** `config.json` —— 主人名单为空、令牌是 `change-me-*`，和刚解压一模一样
5. 重新启动服务 + 桥接（`-NoStart` 可跳过）

要点：
- 需要输入 `RESET` 二次确认；`-Yes` 可用于脚本化。
- 只删运行数据，`src` / `web` / `examples` / `scripts` / `runtime` 都保留。
- 重置后需要：重新填 API Key（主模型 + 看图）、主人名单为空时去 `/debug` 抄自己的 wxid。
- 新增 3 条测试：bat 必须调用 factory-reset.ps1、脚本必须备份+清空+重建且不碰程序本体、维护手册写明备份位置。
## 3.0.13

### 键盘兜底通道（UIA 彻底挂掉时也能发）

- 新增 `keyboard_send()`：`Ctrl+F` 搜索会话 → 剪贴板粘贴正文 → 回车发送，发完**回读数据库确认**。完全不碰 accessibility gate，所以微信把 gate byte 归零时它照样能用。
- 抢前台用的是「先按一下 ALT 再 SetForegroundWindow」这个经典解锁手法（实测单独 SetForegroundWindow / AttachThreadInput 都会被系统拒绝，ALT 解锁后才成功）。
- 只在 UIA 连强制重激活都失败时才触发；抢不到前台会明确放弃并写日志，绝不瞎按键。
- 开关：`config.json` → `wechat.keyboardFallback`（默认 true）。
- 顺带修：颜文字/emoji 额外气泡以前会无视 `chat.maxBubbles` 偷偷多发一条（群聊 2 条上限时变 3 条）。现在满了就并进最后一条。
## 3.0.12

- **心跳不再只读缓存**：以前心跳只看 `UIA_CACHE`，引擎没被唤醒时就一直报 `uia:false`，网页显示「UIA 不可用」——实测此时 `tools/uia-diag.py --probe` 明明能激活成功（桥接预热时撞上瞬时失败，之后就再也没人唤它）。现在心跳每 20 秒主动问一次引擎（库内部 30 秒节流、会自动重新热激活），状态真实，也顺手把假死的引擎救回来。
## 3.0.11

### 「挂一会儿就不理人，要重启桥接」

日志实证（23:41 预热显示 UIA 可用 → 23:42 发送失败 → 23:57 预热变成 UIA 不可用，之后一直不回）：

- **根因一：UIA 引擎被缓存后不再自愈。** 微信跑久了会把 `Weixin.dll` 里的 accessibility gate byte 归零，引擎变成「能读消息、发不出消息」的假死状态；而 `uia_send` 只在缓存为空时才去问库，于是永远不会重新热激活 —— 只有重启桥接（会重新打补丁）才好。现在**每次发送都过一遍库里的引擎**（库内部 30 秒节流、自带「子控件不可见→重新热激活」），并在发送失败时**强制 `_get_uia(refresh=True)` 后重试一次**，成功会记一行「重新激活 UIA 后发送成功」。
- **根因二：收消息线程悄悄退出时没人管。** 新增 `listener_watch`：线程不在 30 秒内就被重新拉起（`listener.start()`），并写日志；心跳里新增 `listener` 字段，网页会显示「收消息线程已停（重启桥接）」。
- **附带：表情包转码写死 `imageio_ffmpeg`**（这个包没装）→ 每张表情刷一条 `ModuleNotFoundError`。现在复用 `ensure_ffmpeg_env()` 找到的 ffmpeg，找不到就只提示一次「装到 C:\ffmpeg」。
- 新增 `tests/bridge-recovery.test.js` 4 条：每次发送都刷新引擎、失败后强制重激活并重试、收消息线程看门狗、表情包转码不再依赖 imageio_ffmpeg。
## 3.0.10

### 颜文字控制器真的能控制颜文字了

以前调教台的「颜文字用量」**只改了提示词里的半句话**；真正决定要不要加料的是 `config.chat.emojiChance`，而它默认是 **0** —— 所以四档选什么都没用，她也几乎从不带颜文字。而且加料池里只有 emoji，没有颜文字。

- 「颜文字用量」四档现在直接换算成概率：**关 0 / 少 12% / 正常 30% / 多 65%**；`chat.emojiChance` 留 0 就跟着档位走，手动填 >0 才覆盖（「关」始终是硬关）。
- 概率命中时**一半颜文字、一半 emoji**；新增颜文字池 `(๑•̀ㅂ•́)و✧`、`(´･_･\`)`、`qwq`、`(╯°□°)╯` 等 10 个。
- 提示词里补了「颜文字长这样……想用就直接写出来，不要用『颜文字』三个字代替」。
- 调试台「颜文字用量」后面直接显示当前实际概率（例如 `正常（实际概率 30%）`），调不动时一眼能看出是配置没读到。
- `docs/设置说明.md` 的 `emojiChance` 说明同步更新。
- 新增 `tests/emoji.test.js` 8 条：四档概率、关档压过手动、手动覆盖、颜文字池内容、「多」档真的产出颜文字、已带 emoji 不重复加。
## 3.0.9

### 千问（DashScope）连不上/报 429

实测同一把 Key、同一个接口：

| 模型 | 结果 |
| --- | --- |
| `qwen-turbo` | **429** You have exceeded your current request limit（这个账号的免费额度用完了） |
| `qwen-flash` | 200 ✅ |
| `qwen-plus` / `qwen-plus-latest` | 200 ✅ |
| `qwen-max-latest` / `qwen3-max` | **404**（模型名不可用） |

也就是说 Key 和地址都没问题，是**默认模型选错了**，加上预设里混了两个 404 的名字。

- 千问预设默认模型改为 **`qwen-flash`**；候选列表只保留实测可用的 `qwen-flash / qwen-plus / qwen-plus-latest / qwen-turbo / qwen-max`；hint 里写明「429 = 该模型额度用完」。
- 报错文案说人话：429 → 「额度/频率用完，千问换成 qwen-flash / qwen-plus」；404 且提到 model → 「这个模型名服务商用不了，换成 …」。
- **429 / 模型 404 现在也会自动切备用服务商**（以前只有 401 才切），千问额度用完时不会再整个哑掉。
- 测试 +2 条：预设默认值必须可用且不在 404 名单里；429/404 文案必须给出可替换的模型名。
## 3.0.8

### 休息模式不再被误报成「UIA 不可用」

- 游戏在跑时桥接会跳过预热、进休息模式，`UIA_CACHE` 还是空的 —— 3.0.7 的心跳会把它报成 `uia:false`，网页就显示「UIA 不可用（消息发不出去）」，属于假警报。
- 现在心跳区分 `rest`：休息模式下报 `uia:null` + `rest:true`，网页显示「游戏运行中 · 休息模式（回复先排队）」；离线/预热中/正常分别有各自的文案。
- `/api/status` 的 `bridge` 增加 `rest` 字段。
## 3.0.7

### 微信侧：桥接在不在、能不能发，网页上一眼看到

以前服务端只知道「我收到了消息」，不知道回复有没有能力发出去 —— 用户只能靠两个黑窗口猜（今晚那张截图就是这种困惑）。

- **桥接心跳**：桥接每 20 秒 `POST /api/bridge/heartbeat`，带 `uia` / `ffmpeg` 状态；45 秒没心跳算离线。
- `/api/status` 的每个网关新增 `bridge: { online, lastSeenSec, uia, ffmpeg }`。
- 网页设置面板那一行改成说人话：
  - `wechat：桥接在线 · UIA 正常`
  - `wechat：桥接在线 · UIA 不可用（消息发不出去…）`
  - `wechat：桥接离线 ← 微信里收不到回复（要另开「启动微信桥接.bat」）`
- `docs/接入微信.md` 补了这张对照表 + `curl /api/status` 的读法。
- 测试 225/225；新增「桥接心跳」用例（离线→在线→45 秒后掉线、token 校验、uia/ffmpeg 透传）与「桥接会定时发心跳」的源码断言。
## 3.0.6

### 「未配置 outboundUrl」不再误导人

- 这句 WARN 以前每条回复都打一次，字面意思是「回复只打印在控制台」，但本地桥接模式下**回复是正常发出去的**（服务端把回复写在 HTTP 响应里，桥接取走再发）。用户看到它就以为坏了。
- 桥接现在会带 `x-whale-bridge: 1` 请求头：
  - 本地桥接 → INFO `回复已交给本地桥接发送（N 条）`
  - 不是桥接、也没配 `outboundUrl` → WARN `这条回复不会到微信：…本地用法请另开「启动微信桥接.bat」…`
- 启动横幅新增一行 `回复发送：本地桥接（要另开一个「启动微信桥接.bat」窗口…）`，一眼看出还差哪个窗口。
- `docs/接入微信.md` 补了这两种日志的对照表。
- 测试：新增「本地桥接请求不会被误报」用例（校验 `outbound.local` 的区分）。
## 3.0.5

### 维护流程工具化（为长期修 bug 准备）

今晚两次事故都是「多副本手工同步」造成的（3.0.3 包里丢了看图字段、运行目录 `data\` 被清空）。这次把它做成流程：

- **`scripts/deploy.ps1`**：把源码同步到运行目录。robocopy 只同步代码，**永不**覆盖 `data\` / `config.json` / `runtime\`；同步后用 MD5 逐文件校验 12 个关键文件，不一致就报错并且不重启；`-Restart` 会按顺序重启服务与桥接并打印桥接日志结论。
- **`scripts/build-release.ps1`**：测试 → 发布自检 → 打两个 zip → **从 zip 里读文件复核**（看图字段/接口、主人判定、UIA 诊断）。测试或自检不过直接中断，不再产出坏包。
- **`BUGS.md`**：bug 台账，一行一个问题（现象/根因/修复/版本/回归测试），已补上今晚的 9 个。
- **`docs/维护手册.md`**：目录分工、两个命令、版本号规则、8 条「已知的坑」、发版自查清单。
- `npm run deploy` / `npm run release` 可直接调起两个脚本。
- 新增 4 条测试：两个 `.ps1` 必须是带 BOM 的 UTF-8（否则 PowerShell 5.1 解析中文会崩）、部署脚本的排除项与哈希校验、出包脚本的自检与 zip 复核、台账与手册存在。
## 3.0.4

### 修「设置里找不到看图 API」

- **3.0.3 的包里 `web/index.html` / `web/assets/app.js` 是旧版**：改了源目录但打包时从一份没同步全的副本取，于是设置面板里根本没有「看图 API Key」，接口也没接上。以源码目录 `src/`、`web/` 同时打包为准，已修正。
- 字段改名为 **「图片识别 · 看图 API Key」**，紧跟在主 API Key 下面（设置面板可滚动，`max-height:88dvh`）。
- 新增 **`scripts/release-check.js`**：打包前跑一遍，逐项检查用户能看到的功能是否真在包里 —— 看图字段/接口、主人识别、UIA 诊断、隐私目录、版本号与 CHANGELOG 一致性。这次的事故就是它能当场拦下的。
- `npm run release-check` 可直接跑。
## 3.0.3

### 「热激活 UIA 失败」可诊断了

- **桥接预热失败时会自动说明原因**：`explain_uia_failure()` 会打印 `UIA 诊断（原因A/B/C）` 加一条下一步建议 —— 以前只有一句「UIA 不可用」，分不清是枚举不到 `Weixin.dll`、版本不支持、还是补丁校验失败。
- **新增只读诊断工具 `tools/uia-diag.py`**：
  ```
  runtime\python\python.exe tools\uia-diag.py           # 只报告：路径/位数/ffmpeg/主窗/版本/候选 RVA/当前 mmui 状态
  runtime\python\python.exe tools\uia-diag.py --probe   # 真的热激活一次并计时
  runtime\python\python.exe tools\uia-diag.py --all     # 列出所有微信进程哪个才有 Weixin.dll
  ```
  实测在 4.1.15.56（库内置版本表只到 4.1.15.53）上会显示「特征扫描命中 0xB39C9D8」，能直接看出是扫描兜底还是版本不支持。
- 文档补了「热激活 UIA 失败」三类原因的排查表（含中文路径、微信缩在托盘这两个必然失败的坑）。
- 顺手修：`tools` 里的诊断脚本会复用桥接的 ffmpeg 查找逻辑，不再误报「没有 ffmpeg」。
## 3.0.2

### 看图：微信图片根本没被转码（「有时能认、有时不能」的真凶）

- **`wxgf` 是 HEVC 容器，不是 jpeg。** 微信 4.x 把普通图片也存成 `.wxgf`；桥接只看扩展名，于是把原始容器当 `image/jpeg` 发给视觉模型，接口回「图片输入格式/解析错误」。能认的那几次，是图片本来就存成了 jpg/png。现在桥接按**文件头**判格式：`wxgf` 先用 `_wxgf_to_jpg()` 转 JPEG；转不出来就明确提示「本机 ffmpeg 没装」并跳过，不再把垃圾数据发出去。
- **自动找 ffmpeg。** `ensure_ffmpeg_env()` 启动时把 `C:\ffmpeg\bin`、`runtime\ffmpeg\bin`、`%LOCALAPPDATA%\Programs\ffmpeg\bin` 等塞进 PATH —— 很多机器装了 ffmpeg，只是没加环境变量。
- **长截图分段识别。** 高宽比 > 2.2 的截图切成 2~3 段（带 8% 重叠）分别转写再拼起来，小字不再被整张缩糊。
- **服务端按文件头校正 mime**，遇到 wxgf 直接给可操作的报错，并顺手清掉 base64 里的 data URI 前缀/空白。
- **max_tokens 修正**：智谱 GLM-4V 系列上限是 **1024**，超了直接 400。现在按服务商区分（智谱 1024、其它 1600），可用 `vision.maxTokens` 覆盖。
- 提示词放宽到 900 字，并要求「每条消息都写到：不要省略、不要合并、不要只写大意」。
- 新增 4 条测试：wxgf 嗅探、wxgf 直发拦截、智谱 max_tokens 上限、桥接的 ffmpeg/wxgf/长截图。
## 3.0.1

### 看图（视觉模型）修好了

- **网页里根本没有看图 Key 的输入项**：`/api/settings` 不收 `visionApiKey`，`src/vision.js` 也只读 `config.json` 的 `vision.apiKey` —— 注释里承诺的「留空则用 data/settings.json 里的 Key」从来没实现，所以在网页里填了也永远提示「未配置视觉模型 Key」。现在：
  - 网页「设置」新增「看图 API Key」+「测试看图」按钮（可以先测再保存）；
  - Key 查找顺序：`config.vision.apiKey` → `settings.visionApiKey` → `settings.keys.vision` → `settings.keys.zhipu` → 环境变量 `ZHIPU_API_KEY` / `VISION_API_KEY`；
  - 新增 `POST /api/vision/test`：用内置的 64×64 PNG 试一次，只回颜色，能确认 Key 与网络都通。
- **报错更像人话**：没配 Key 时直接说明去哪儿填；401/403 时提示「这里要 open.bigmodel.cn 的智谱 Key，DeepSeek 的 Key 不支持看图」。
- 新增 6 条测试：Key 优先级、掩码不回显、报错文案、内置测试图是合法 PNG。

## 3.0.0

这一次主要修「主人识别」（`persona.master`）—— 之前就算在调试台把名单填对，微信里她仍然不认。

### 主人识别

- **统一判定**：新增 `src/master.js`，`matchMaster()` / `masterWarnings()` 是全项目唯一的主人与非主人判定。
  - 微信里只认不可修改的 `senderId`（`wxid_xxx`）；
  - 网页 / 抖音这类没有稳定 id 的渠道才允许按昵称认；
  - `wxids` 里有真 `wxid_` 值时昵称不能用来提权（防止改昵称冒充）。
- **修掉「填微信号静默失效」**：`master.wxids` 写成自己设的微信号（`abc12345` 这种）时，旧逻辑会连昵称兜底一起关掉，导致谁都不算主人。现在会识别出「这不像 wxid」并告警，同时在没有任何真 wxid 时退回昵称认。
- **调试台和真实链路一致**：`server.js` 的提示词预览改用同一个 `matchMaster()`，不会再出现「调试台说认了、微信里没认」。
- **认了之后要认账**：新增提示词段 `IDENTITY_FIX`（`src/persona.js`），让「名单还没配好时她说的否认」作废；`bot.js` 的 `stripMasterDispute()` 在**主人本人**说话时，把历史里「我是你主人吗 / 我是谁 / 你的主人是谁」这类追问连同她的否认整段剔掉（只影响本轮喂给模型的内容，记忆文件不动）；`finalize()` 再兜一层：模型若仍说出「别自封了 / 就一个名字罢了 / 冒充没用」，直接改成认下来。
- **可观测**：每条微信私聊在 `data/whale.log` 写一行 `[master] 私聊 昵称（wxid）→ 主人/非主人（原因）`；昵称在名单里但 id 对不上时额外 WARN 一次，直接告诉你该把哪串填进 `master.wxids`。
- 调试台「身份 / 主人」卡片新增：主人名单告警、「最近说过话的人（真实 senderId）」，以及提示词预览里的「按 wxid 认的 / 按昵称认的 / 昵称对得上但被挡住」。

### 测试与工具链

- `npm test` 改为 `node --test "tests/*.test.js"`：原来会扫进 `runtime/python/Lib/site-packages` 里 Python 包自带的 3 个 `.js`，一直报假失败。
- 修 `tests/providers.test.js` 把 `loadConfig({ root, env })` 写成 `loadConfig(root, {})`：`root` 落到真实项目目录，**跑一次测试就会把用户的 `data/settings.json` 覆盖成测试用的假 Key**。现在只用临时目录。
- 修 `saveSettings()` 用自算的 `keys` 覆盖调用方显式传入的 `keys`，导致「别的服务商的 Key 存不住、主 Key 失效时切不到备用」。
- `tests/voice.test.js` 不再要求 `data/persona.json` 一定存在（运行时才生成的文件）。
- `一键修复并自检.bat` 由 LF 改为 CRLF（cmd 才不报语法错）。
- 新增测试：`tests/master-match.test.js`（13 条）+ `tests/master.test.js` 里 6 条（身份纠错、剔除争执段、无关历史保留、普通人不受影响、否认兜底）。

### 仓库整理

- `.gitignore` 增加 `wechatauto_db/`（微信数据库快照，含隐私）；不再忽略 `tools/`（`hotkey_daemon.py` 是项目自己的热键脚本，被 `启动热键.bat` 调用）。
- 版本号 `3.0.0`。

## 2.9.2

上一个分发包的基线版本，无单独记录。
