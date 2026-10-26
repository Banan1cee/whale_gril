# 🐋 鲸鲸 · DeepSeek 鲸鱼娘聊天机器人

一个能真正聊天的「鲸鱼娘」：**网页私聊 + 微信群自动回复 + B 站视频分享 + 联网查资料**。

人设是一个蓝发鲸鱼娘，说话短、有情绪、会撒娇也会毒舌；接 OpenAI 兼容的大模型（DeepSeek / 智谱 GLM / 通义 / Ollama 本地等），零 npm 依赖。

![鲸鲸](web/assets/jingjing.jpg)

---

## 3.0 更新

**「主人识别」这一块基本重写了。** 之前典型症状是：在调试台改了主人名单，微信里她还是不认你。三个原因现在都修掉了：

1. **判定只有一份。** 以前 `src/bot.js`（真正跑消息）和调试台预览各写一套规则 —— 调试台显示「识别为主人」，微信里却当陌生人。现在统一走 `src/master.js` 的 `matchMaster()`，两边不会再打架。
2. **只填微信号会静默失效。** `master.wxids` 填成自己设的微信号（比如 `abc12345`，不是 `wxid_xxx`）时，旧逻辑会顺带关掉昵称兜底，等于谁都认不出来。现在会认出「这不像 wxid」并在调试台/日志告警；没有任何真 wxid 时退回按昵称认。
3. **认了之后还得「认账」。** 认证成功了，但那个会话历史里已经有几十条「你不是主人」，模型会顺着历史继续否认（实测 51 轮历史连问两遍都还是「不是」）。现在提示词里加【身份纠错】，并且**喂给模型的历史会剔除这些身份争执**（记忆文件不动）；万一回复仍然是否认，`finalize()` 兜底改成认下来。
4. 每条微信私聊在 `data/whale.log` 留一行 `[master] … → 主人（wxid）`，排查不用猜。
5. 调试台「身份 / 主人」卡片新增：名单告警 +「最近说过话的人（真实 senderId）」—— 不知道自己的 wxid，照着抄就行。

其他修复：`npm test` 只跑 `tests/`（不再把 `runtime/python` 里 Python 包自带的 `.js` 当测试）；修 `providers.test.js` 误写真实 `data/settings.json` 的问题；`saveSettings` 不再丢掉别的服务商的 Key；`一键修复并自检.bat` 换成 CRLF。

### 3.0.2 看图

- **微信图片是 wxgf（HEVC）容器**，以前桥接按扩展名当 JPEG 发出去，视觉接口一直回「图片输入格式/解析错误」—— 所以会出现「有时能认、有时不能」。现在按文件头判格式，wxgf 先转 JPEG 再发。
- 桥接启动时自动找 fmpeg（C:\ffmpeg\bin、untime\ffmpeg\bin 等）；**没有 ffmpeg 就看不了图**，日志里会写清楚。
- 长截图（高宽比 > 2.2）自动切成 2~3 段识别再拼接。
- 修正智谱 max_tokens 上限（1024），提示词放宽到 900 字并要求逐条转写不省略。

完整列表见 [CHANGELOG.md](CHANGELOG.md)。

---

## 功能

- **网页聊天**：流式吐字、多气泡、调教台（`/persona`）和调试台（`/debug`）
- **微信群自动回复**：只认 @ / 叫名字；被叫到后接着聊，冷场 6 分钟或换话题自动闭嘴
- **像真人**：一句话拆成 2~3 条短消息发，不带波浪号和句号；任何人单发一个 `？` 她也回一个 `？`
- **会记事**：私聊里自报的事实（名字、住哪、喜欢什么、忌口）自动记下，之后不用重说；更早的群聊会被压成一句摘要，不会凭空丢失`n- **不学舌**：不会把别人刚说的话原样发回去；发现模型复读（原样重复、只加问号、「你才X」偷懒句）会自动重写一次，还复读就换成正常回应
- **叫名字也算叫她**：群里不一定非要 @，「你好响呀鲸鲸」「鲸鲸你别装了」这种带名字的都会接话；被人骂了但没 @，只要她刚说过话也会回怼（别人之间互骂她不插嘴）
- **看不懂就不说**：图片/表情包识别失败时保持沉默，不瞎编
- **懂缩写**：`kskbl` → 回 `zdjd`，`xswl` → `我也xswl`；词表在 `resources/abbrev.txt`
- **会回怼**：被骂或主人被骂时按「贴吧老哥」火力回：对方爆粗就带脏字、自称你爹、扣帽子（急了/破防/贵物/收收味/典），六成概率打两连击（先反问或扣帽子，再补一刀），连骂三轮自动收尾走人。台词库 `resources/clapback.txt` 分 9 档：`重`、`爹味`、`反问`、`典`、`急了`、`轻`、`叫滚`、`收尾`、`一般`，可自己加
- **回怼不认输**：模型要是说「别生气」「我理解你」「没必要吵」这类软话，会被直接换成库里的狠话
- **回怼有底线**：不碰性、不咒对方家人死、不搞地域性别疾病歧视、不威胁线下现实；主人被骂豁免，不会反打主人
- **小助手**：问「群里都有谁」列活跃成员；主人私聊问「我微信多少」回自己的号；说「可以损我」授权后，主人才可以点名让他被损三句
- **听得懂语音**：别人发语音会先转成文字再正常接话（`config.json` 的 `voice`，默认 qwen3-asr-flash）；她自己只发文字，不发语音条
- **主动分享**：每 2 小时刷 B 站，按群聊热点或鲸鱼娘相关视频挑一个发到群里，附一句自己的吐槽
- **联网**：新闻热榜、Bing 搜索、链接正文抓取；提示词自带当前时间，不会活在 2024 年
- **群管理**：禁言群、解禁、改模型、切语气、清记忆、低电量自动发晚安
- **全局热键**：PageUp 一键终止服务和桥接，PageDown 恢复（`启动热键.bat`）
- **一键终止所有**：`一键终止.bat`，服务、桥接、守护、热键全部停掉并写暂停标记
- **微信桥接**：`examples/wechatauto_bridge.py`，基于 `wechatauto-replica` 的 UI 自动化（只读数据库 + 窗口操作，**不注入微信**）
- **零 npm 依赖**：不用 `npm install`；带 `runtime\` 的发行包连 Node 都不用装（本仓库是源码版，不带 `runtime\`）

---

## 快速开始（Windows · 带 `runtime\` 的发行包）

> 本仓库是**源码版，不含 `runtime\`**，请直接看下一节。只有带 `runtime\` 的发行包才用这一节（解压即用，不需要装 Node / Python）。
>
> **解压到纯英文路径**（例如 `D:\whale-girl-3.0`）。放在带中文的目录里，微信那侧的自动发送会失败并一直报「拒绝访问」，原因见下面「接入微信群」里的说明。

1. 解压压缩包
2. 双击 `启动鲸鱼娘.bat`
3. 打开 http://127.0.0.1:8787

包里已经带了 **Node 运行时**（`runtime\node.exe`）和 **Python 运行时**（`runtime\python`），两个都不需要你装。启动脚本优先用包内的，找不到才回退系统 PATH。

微信桥接同样双击 `启动微信桥接.bat` 就行，用的是包内那套 Python（已经装好 wechatauto-replica、pywin32、uiautomation、Pillow、cryptography、pysilk 等依赖）。

唯一还需要你的东西：**一个登录着的微信小号**，和**一个模型 API Key**（DeepSeek / 智谱 / 千问任选）。

## 快速开始（源码版 / 命令行 / macOS / Linux）

```bash
# 1. 需要 Node.js 18+
node -v

# 2. 直接启动（不需要 npm install）
npm start
```

没填 API Key 时会用内置台词演示；在页面右上角「设置」里选服务商、填 Key 即可接真模型。

首次启动会自动把 `config.example.json` 复制成 `config.json`；**`config.json` 和 `data/` 里是你的 Key、聊天记录和主人名单，已在 `.gitignore` 里排除，别提交**。

支持的 provider：`deepseek` / `zhipu` / `siliconflow` / `qwen` / `ollama`（本地）/ `custom`（任何 OpenAI 兼容接口）。

---

## 接入微信群（Windows）

微信桥接是独立的 Python 脚本，需要 Windows + 已登录的微信 4.x：

```bash
py -3.12 -m pip install -r requirements.txt
python examples/wechatauto_bridge.py
```

然后：

1. 在 `config.json` 里配置 `gateway.wechat.inboundToken`（桥接和服务器共用的密钥）
2. 启动 `启动微信桥接.bat`（带守护循环，异常自动拉起）
3. 用你的微信给机器人账号发一句话，网页里能看到回复

> 详细说明见 [docs/接入微信.md](docs/接入微信.md)。桥接依赖 `wechatauto-replica` 的 UI 自动化能力，微信升级可能导致失效，请自行评估风险。

> **⚠ 装到纯英文路径，否则微信发送一定是坏的。**
> 微信的 Qt accessibility 只能在纯 ASCII 路径下热激活成功。整个文件夹放在
> `C:\Users\张三\Desktop\whale-girl-3.0`（含中文用户名）、`D:\我的程序\…` 这类路径下时，
> 桥接会 `ensure_window() = False`，之后每条回复都报
> `error(5, 'SetWindowPos', '拒绝访问')`、退到 OCR 兜底、发不出去，日志一直刷。
> 正确做法：**`D:\whale-girl-3.0`、`C:\whale-girl-3.0` 这种纯英文路径**。

### 一键终止所有（`一键终止.bat`）

双击 `一键终止.bat`，会依次停掉：

- 鲸鲸服务（占用 8787 的进程）
- 微信桥接（`wechatauto_bridge.py`）
- 桥接守护循环和启动器窗口（否则它 3 秒后又把桥接拉起来）
- 快捷键守护（`hotkey_daemon.py`，加 `-KeepHotkey` 可保留）

同时会写 `data\PAUSED`，防止任何自动重启。脚本会多扫三遍，因为杀父进程时可能正好有子进程在启动；最后会打印结果，停干净了显示绿色，没停干净会列出残留 pid。

恢复只要重新双击 `启动鲸鱼娘.bat` 和 `启动微信桥接.bat`（桥接启动时自动清掉 `PAUSED`）。

---

## 谁可以当管理员

开源版不写死任何人的微信 ID，部署者自己决定：

```json
"persona": {
  "master": { "names": ["你的昵称"], "wxids": ["wxid_xxx"] }
},
"admin": {
  "spell": "设一个只有你知道的暗号",
  "minutes": 30,
  "allowAll": false
}
```

- `master.names` / `master.wxids`：填谁，谁就是主人（可以填多个）
- `admin.spell`：私聊发这个暗号获得 30 分钟管理员权限；留空则关闭
- `admin.allowAll: true`：**任何人不发暗号也能直接用管理员命令**（适合自己人小群，公开群慎用）

### 管理员命令（私聊机器人）

```
状态
上下文 30
人味 高|中|低
情绪 开|关 / 主动 开|关 / 观点 开|关
语气 温柔|活泼|高冷|毒舌|正经
语态 <一句话描述>
长度 私聊 120 / 回复 短一点
颜文字 少|多|关
能力 链接 开|关 / 能力 主动接话 开|关
禁言 鼠标 / 别在鼠标群说话 / 解除禁言 鼠标
改模型 deepseek-reasoner
演示模式 开|关
重置记忆 / 清空所有记忆 / 恢复默认
退出管理
```

群里被叫到后，她会接着聊 6 分钟；听到「没你事了 / 滚 / 走吧 / 闭嘴」会回一句「好的主人，我走了」然后闭嘴。时长在 `config.json` 的 `group.engagedMinutes` 调。

### 上下文怎么给模型

- 群聊历史按「事件」喂给千问：每条带发言人、时间和 @ 对象，不再把多个群友的话捏成一条，也不会把别人之间的「你」当成在叫鲸鲸。
- 显式 @ 了别人（没 @ 鲸鲸）之后接着说「你」，鲸鲸不会抢答；同时 @ 鲸鲸 和另一个人时，会记下另一个人作为提及对象。
- 私聊默认 100 条、群聊 60 条消息（`chat.historyTurns` / `chat.groupHistoryTurns`，上限 120/100）；`memory.maxMessages` 必须 ≥ 最大窗口，否则存不下。面板里的「条数」指消息条数，不是问答轮数。

### 人设预设（一个版本一个文件）

`personas/` 下每一版人设单独一个文件，**升级时新增、不覆盖旧的**：

```
personas/persona-v1.json   # 通用版，已去掉主人的微信号和群里的人名
personas/persona-v2.json   # 下一版
```

三种用法：

- 网页 `/persona` 页面底部「人设预设」→ 选一个 → 导入
- 接口：`POST /api/persona/preset`，body `{"id":"persona-v1"}`
- 直接把人设内容粘进面板的「自定义提示词」

导入只改人设和上下文条数，不动模型、Key、群配置和记忆。`personas/` 会跟着发行包发出去，所以里面不能写任何私密信息。

---

## 一键终止 / 继续（PageUp / PageDown）

双击 `启动热键.bat` 启动一个常驻的小守护（Python，无需管理员）：

- **PageUp**：一键终止服务 + 微信桥接（不发任何消息），写 `data/PAUSED`
- **PageDown**：清掉 `data/PAUSED`，重新拉起服务和桥接

日志在 `data/hotkey.log`。注意这是**全局热键**，浏览器/编辑器里按 PageUp 翻页也会触发——建议只在准备打游戏时开这个守护。
## 配置

复制示例配置再改（`config.json` 已被 `.gitignore` 忽略）：

```bash
cp config.example.json config.json
```

常用字段：

| 字段 | 说明 |
| --- | --- |
| `provider` / `deepseek.apiKey` | 模型服务商与 Key（也可在网页设置里改） |
| `persona.master.names` / `wxids` | 主人名单，决定谁有特权 |
| `admin.spell` / `admin.allowAll` | 管理员暗号 / 是否人人可管理 |
| `chat.privateMaxChars` / `groupMaxChars` | 回复长度上限 |
| `group.requireAt` | 群里是否必须先 @ 才回 |
| `group.engagedMinutes` | 被叫到后继续接话的分钟数 |
| `group.cooldownSec` | 群回复冷却（0 = 不冷却） |
| `share.everyMinutes` | 主动分享 B 站视频的间隔（分钟） |
| `wechat.lowBatteryPercent` | 电量低于多少自动发晚安 |
| `gateway.wechat.inboundToken` | 桥接与服务器共享的 token，务必改掉 |

---

## 目录结构

```
whale-girl/
├─ server.js                 # HTTP + SSE + webhook + 静态页面
├─ src/
│  ├─ bot.js                 # 触发判断、管理员命令、回复编排
│  ├─ persona.js             # 人设提示词、词库注入、语气规则
│  ├─ llm.js                 # OpenAI 兼容客户端
│  ├─ memory.js              # 会话/记忆存储
│  ├─ presets.js             # 人设预设的读取与导入
│  ├─ links.js               # 链接正文抓取
│  ├─ websearch.js           # Bing 搜索 + 头条热榜
│  ├─ bilibili.js            # B 站搜索/热门/评论
│  └─ config.js / personaStore.js
├─ web/                      # 聊天页、调教台、调试台
├─ personas/                 # 人设预设，一个版本一个文件（persona-v1.json…）
├─ examples/
│  ├─ wechatauto_bridge.py   # 微信桥接（UI 自动化）
│  └─ wechaty-bridge.js      # 另一种桥接示例
├─ scripts/                  # 启动/守护脚本
├─ tests/                    # node:test 单元测试
├─ config.example.json
└─ data/                     # 运行时数据（Key、记忆、词库、日志）— 不入库
```

---

## 开发与测试

```bash
npm test          # node --test "tests/*.test.js"（只跑 tests 目录，别扫到 runtime\python 里自带的 .js）
node server.js --doctor   # 自检
```

- 人设 / 词库：`data/persona.json`、`data/slang.txt`（网页调教台也可改）
- 想改触发逻辑：`src/bot.js` 的 `computeTrigger`
- 想改提示词：`src/persona.js` 的 `buildSystem`

---

## 安全与合规

- 默认只监听 `127.0.0.1:8787`，**不要直接暴露到公网**（没有登录鉴权）
- `data/`、`config.json` 已被 `.gitignore` 忽略；**不要把自己的 API Key、聊天记录提交到仓库**
- 微信桥接是 UI 自动化，不改微信客户端、不注入、不读内存，但**仍可能违反微信使用条款**，账号风险自负
- 机器人说的话由大模型生成，请在公开群谨慎开启 `admin.allowAll` 和自动分享

---

## License

MIT，见 [LICENSE](LICENSE)。欢迎 fork、改人设、接自己的模型。
