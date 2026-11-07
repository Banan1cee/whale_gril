[English](README.md) | [中文](README.zh-CN.md)

# 🐋 鲸鲸 · DeepSeek 鲸鱼娘聊天机器人

[![GitHub release](https://img.shields.io/github/v/release/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/releases/latest)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-339933)](https://nodejs.org/)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4)
[![GitHub stars](https://img.shields.io/github/stars/Banan1cee/whale_girl)](https://github.com/Banan1cee/whale_girl/stargazers)

> **想直接跑？点右边的 [Releases](https://github.com/Banan1cee/whale_girl/releases/latest)，下 `whale-girl-*-setup.exe`（约 168 MB）。**
> 安装包里带好 Node、Python 3.12 和随包的 .NET 10 桌面运行时，**装完不用再联网**。安装本身不弹 UAC，
> 只有系统缺 .NET 10 桌面运行时才会单独提权装一次；装完桌面上有快捷方式，双击就是启动器。
>
> ## 升级怎么不丢记忆（记住这一句就够）
>
> **在启动器里点「检查更新」。** 它会下载官方安装包、校验 SHA256、静默覆盖安装：
> `data\`（聊天记忆 / Key / 称呼）和 `config.json`（主人名单 / token）全程不动，上一版留下的
> `personas\`、`resources\`、旧位置的 `runtime\vb-cable` 会顺手清掉，不会越装越大。
>
> 想手动备份也行：`node scripts\memory-tool.js export <文件>` 导出 json，`restore <文件>` 放回去（启动器诊断页「数据维护」也是同一套）。详见下面的「更新到新版本」。
>
> **旧版（3.x）的 `data\store.json` 会被自动识别并转成 4.0 格式**：直接把旧 `data\` 合并进来启动即可，
> 导入完启动器会弹一次「记忆已导入并转换格式」（原文件留在 `data\memory\legacy\`）。也可以随时在
> 「设置 → 高级 → 旧版记忆」点「一键识别转换记忆」，重复点不会重复导入。
>
> ---
>
> 这里的 `Code → Download ZIP` 只有源码树（不含运行时，也不含你本地的 Key 和聊天记录）。正常使用请从 Releases 安装；构建和开发说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。

一个能真正聊天的「鲸鱼娘」：**微信群自动回复 + B 站热搜/视频信息 + 联网查资料**，设置与诊断全在启动器里。

人设是一个蓝发鲸鱼娘，说话短、有情绪、会撒娇也会毒舌；接 OpenAI 兼容的大模型（DeepSeek / 智谱 GLM / 通义 / Ollama 本地等），零 npm 依赖。

---

## 实验性表情包

「表情包」页的「自动收集收到的表情包」开关默认关闭，开启后桥接约 5 秒内应用。原图单独保存到 `data/收集的表情包/`，按内容去重，GIF 保留动画，不自动加入发送图库；可点「打开收集文件夹」查看。收集的是桥接实际接收到并处理的表情消息，不扫描历史记录。获取依赖微信本地缓存或消息里的可用下载地址，失败时跳过；保存不依赖模型识图成功。

随包提供 27 张鲸鲸预设 PNG（傲娇、炸毛、开心各 9 张）。首次启动内核并开启表情包功能后，后台导入当前图库，不覆盖已有图片；删除的预设不会在重启后自动补回。总开关仍默认关闭。

在启动器「表情包」页打开总闸（默认关闭）。分类由模型在回复末尾写 `[[sticker:分类]]` 决定：写哪个分类就发那一类，标记会被剥掉，用户看不到；没写标记、分类不存在或该分类没有图就**不发**，程序不猜情绪、不按概率配图。内置傲娇 / 炸毛 / 开心三类，也可以自己新增分类；启动器里管理分类、上传/删除图片、打开文件夹，支持 GIF、PNG、JPEG、WebP（单张不超过 4 MB）。上传只保存原图，不发送微信消息，不转码 GIF。

自定义分类**按名字理解**：名字起得越具体越好用（例如「阴阳怪气」「委屈」），模型会从当前有图的分类里挑；名字看不出用途的分类它不会硬选。没有图的分类不会出现在提示词里。

启动器「表情包」页可以直接调频率（0–100%）和「没写标记也补一张（必发）」；也可以改 `config.json` 的 `sticker.demandChance`（默认 0.7）和 `sticker.ensureSend`（默认关）。`demandChance` 决定这一轮要不要在尾部提醒她带一张，0 = 只靠模型自觉，1 = 每轮都提醒；只开它时，1.0 也不保证真发，因为模型仍可能不写标记。打开 `ensureSend` 后，命中提醒的轮次即使模型没写标记，程序也会按回复语气补一张（炸毛/傲娇/开心，挑不到用开心）——所以 **1.0 + 必发才约等于每轮都发**。对方在难过、求助、说正事时，严肃窗口仍然不发（15 分钟 / 连续 4 条普通消息 / 说“没事了”“哈哈”提前恢复）。明确索要仍然 100% 发。

可选的「排队测试发送」是真实微信操作，**排队不代表送达**。桥接可能短暂切换到目标微信会话，完成后还原；请先清空输入框。证据不足时跳过，不盲按回车、不自动重试。结果显示「未确认」时不要重复点发送；如果出现附件草稿，请手动清空后继续使用，不会自动删除你的草稿。同会话同一时间只有一个待处理任务，确认后无冷却，超过 90 秒的任务失效而不重放。

只有数据库出现新的本人发送图片记录才记为「确认」；数据库不可用或没有新记录一律记为「未确认」，不是成功。关闭无法撤回已经按下发送的消息。重启服务后不会重放旧任务。

更新记录见 [CHANGELOG.md](CHANGELOG.md)。

## 功能

- **一个入口**：界面只有启动器（WPF + .NET 10），浏览器不再有控制台；`8787` 只留 HTTP API。
- **微信群自动回复**：只认 @ / 叫名字；被叫到后接着聊，冷场或换话题自动闭嘴；叫名字被骂也会回怼，但别人互骂不插嘴。
- **像真人**：一句话拆成 2~3 条短消息发，不带波浪号和句号；任何人单发一个 `？` 她也回一个 `？`。
- **会记事**：私聊自报的事实自动记下，更早的群聊压成一句摘要；图片/表情包识别失败时保持沉默。
- **不学舌**：模型复读（原样重复、只加问号、「你才X」）会自动重写一次。
- **懂缩写**：`kskbl` → 回 `zdjd`，`xswl` → `我也xswl`；词表在 `assets/abbrev.txt`。
- **会回怼**：被骂或主人被骂时按「贴吧老哥」火力回，台词库 `assets/clapback.txt` 分 9 档可自己加；说软话会被换掉，但不碰性/家人/歧视/线下威胁。
- **小助手**：主人私聊问「我微信多少」回自己的号；授权「可以损我」后可点名损三句。
- **听得懂语音**：别人发语音先转文字再接话；她自己只发文字。
- **联网**：模型判断该不该查，Bing + B站/微博热搜（按站点分流）+ 头条热榜 + 链接正文抓取，有总超时，提示词自带当前日期。
- **群管理**：禁言群、解禁、改模型、切语气、清记忆、低电量自动发晚安。
- **一键终止所有**：`scripts\stop-all.ps1` 或启动器「停止」，服务与桥接全停并写暂停标记。
- **微信桥接**：`examples/wechatauto_bridge.py`，只读数据库 + 窗口操作，不注入微信。
- **零 npm 依赖**：不用 `npm install`；发行包自带运行时，本仓库是源码树。

---

## 安装（Windows · 安装包）

> 本仓库只有**源码，不含 `runtime\`**。想直接用请到 [Releases](https://github.com/Banan1cee/whale_girl/releases/latest) 下 `whale-girl-*-setup.exe`。
> **装到纯英文路径**（例如 `D:\whale-girl-4.0`）。放在带中文的目录里，微信那侧的自动发送会失败并一直报「拒绝访问」，原因见下面「接入微信群」里的说明。

1. 双击 `whale-girl-4.0.7-setup.exe`，一路下一步（不需要管理员权限）
2. 装完双击桌面上的 **鲸鲸**，点右上角「启动」——内核和桥接都由它拉起（`8787` 只给启动器与桥接调用，没有网页界面）
3. 在「状态」页看到内核、桥接都亮起就能用

安装包已经带了 **Node 运行时**（`runtime\node.exe`）、**Python 运行时**（`runtime\python`）和 **.NET 10 桌面运行时安装包**，三个都不需要你装。启动器优先用包内的，找不到才回退系统 PATH；本机已有 .NET 10 时，随包那个 57 MB 的安装器会在装完后自动删掉，不在你的安装目录里留垃圾。

桥接同理：启动器点「启动」时会一起拉起，用的是包内那套 Python（已经装好 wechatauto、pywin32、uiautomation、Pillow、cryptography、pysilk 等依赖）。

唯一还需要你的东西：**一个登录着的微信小号**，和**一个模型 API Key**（DeepSeek / 智谱 / 千问任选）。支持的 provider：`deepseek` / `zhipu` / `siliconflow` / `qwen` / `ollama`（本地）/ `custom`（任何 OpenAI 兼容接口）。

## 更新到新版本

### 安装版（setup.exe 装的）

在启动器里点「检查更新」：它会读 `release-manifest.json`、下载官方安装包、**校验 SHA256** 后静默覆盖安装。

- 覆盖前会先关掉正在运行的鲸鲸，不卡在「拒绝访问」
- 沿用原安装目录，`data\`（聊天记忆）和 `config.json`（Key）全程不动
- 下载允许走系统代理；断网时用本地缓存，从没拉成功过就放行，不挡你启动
- 强制更新分四档（正常 / 提示 / 强制 / 拦截），由清单远程调参

## 没有图形入口时怎么办

先用启动器「诊断」页。命令行自救步骤见 [docs/维护手册.md](docs/维护手册.md)，不属于正常安装流程。

---

## 接入微信群（Windows）

前提：Windows + 已登录的微信 4.x + 管理员权限。双击 `WhaleLauncher.exe` 点「启动」，内核与桥接一起拉起。
详细说明（UIA 提权、多开、纯英文路径、故障码）见 [docs/接入微信.md](docs/接入微信.md)。

### 一键终止所有（`scripts\stop-all.ps1`）

先关掉启动器，再跑 `powershell -File scripts\stop-all.ps1`，它会停掉：

- 鲸鲸服务（占用 8787 的进程）
- 微信桥接（`wechatauto_bridge.py`）

脚本**不会关闭启动器窗口**，启动器要你自己先关。它会写 `data\PAUSED` 防止自动重启，停止前先保存最新记忆；因为杀父进程时可能正好有子进程在启动，会多扫三遍，最后打印结果，停干净了显示绿色，没停干净会列出残留 pid。

恢复：重新打开 `WhaleLauncher.exe` 点「启动」（启动器会清掉 `PAUSED`）。

---

## 谁可以当管理员

项目不写死任何人的微信 ID，部署者自己决定：

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

管理员命令在私聊里发；完整列表（状态 / 语气 / 长度 / 禁言 / 改模型 / 重置记忆…）见 [docs/设置说明.md](docs/设置说明.md)。

### 上下文怎么给模型

- 群聊历史按「事件」喂给千问：每条带发言人、时间和 @ 对象，不再把多个群友的话捏成一条，也不会把别人之间的「你」当成在叫鲸鲸。
- 显式 @ 了别人（没 @ 鲸鲸）之后接着说「你」，鲸鲸不会抢答；同时 @ 鲸鲸 和另一个人时，会记下另一个人作为提及对象。
- 私聊默认 100 条、群聊 60 条消息（`chat.historyTurns` / `chat.groupHistoryTurns`，上限 120/100）；`memory.maxMessages` 必须 ≥ 最大窗口，否则存不下。面板里的「条数」指消息条数，不是问答轮数。

### 人设预设（一个版本一个文件）

`assets/personas/` 一版一个文件，升级新增、不覆盖旧版；在启动器「人设」页底部导入。目录约定与隐私红线见 [assets/personas/README.md](assets/personas/README.md)。

### 日记（Markdown）

启动器「主动与提醒」页可开启「每天自动写日记」，设置生成时间（电脑本地时间，默认 `23:00`），也可点「立即写一篇」手动生成。自动开关默认关闭；保存后立即生效，需保持内核运行并配置聊天模型。

日记沿用当前人设和模型，依据当天截至生成时的聊天素材（最多最近 300 条、约 24,000 字符）写成，按年份保存到 `data/diary/YYYY/MM-DD.md`，例如 `data/diary/2026/11-06.md`。手动与自动合计每天最多一篇；发现当天已有文件（包括旧格式日记）就跳过，不再调用模型，也不覆盖。重启不会重复；当天晚启动会补写，过去日期不补写。当天无聊天不生成，失败五分钟后重试。「打开日记文件夹」可直接查看文件。配置对应 `diary.enabled` 和 `diary.time`。

---

## 一键终止 / 继续

先在启动器点「停止」并关闭启动器；需要清理残留时，再跑 `scripts\stop-all.ps1`，停掉服务 + 桥接（不发任何消息）并写 `data/PAUSED`；
重新打开 `WhaleLauncher.exe` 点「启动」即恢复（它会清掉暂停标记）。

## 配置

安装版在启动器「设置」页配置。高级用户可以直接编辑 `config.json`；模板是 `config.example.json`，`config.json` 已被 `.gitignore` 忽略。

| 字段 | 说明 |
| --- | --- |
| `provider` / `deepseek.apiKey` | 模型服务商与 Key |
| `persona.master.names` / `wxids` | 谁是主人 |
| `gateway.wechat.inboundToken` | 桥接 token，务必改 |
| `group.requireAt` | 群里是否必须先 @ |
| `chat.privateMaxChars` | 回复长度上限 |

其余配置见 [docs/设置说明.md](docs/设置说明.md)。

---

## 目录结构

```
whale-girl/                        # 与仓库一致，运行数据不入库
├─ server.js                       # HTTP + webhook
├─ WhaleLauncher.exe               # 唯一图形入口
├─ package.json
├─ release-manifest.json
├─ requirements.txt
├─ config.example.json
├─ README.md
├─ CHANGELOG.md
├─ BUGS.md
├─ CONTRIBUTING.md
├─ AGENTS.md
├─ LICENSE
├─ .gitignore
├─ .gitattributes
├─ .github/                        # CI 与发布
├─ src/                            # 内核
│  ├─ adapters/                    # 对外适配层
│  ├─ core/                        # 判定与解析
│  ├─ http/                        # 路由与安全闸
│  ├─ infra/                       # 配置与基础设施
│  ├─ llm/                         # 模型客户端
│  ├─ memory/                      # 记忆与预算
│  ├─ persona/                     # 人设
│  ├─ pipeline/                    # 消息编排
│  └─ services/                    # 状态型服务
├─ bridge/                         # Python 桥接
├─ launcher/                       # 启动器源码
├─ installer/                      # Inno Setup（自带编译器）
├─ scripts/                        # 构建/维护（tools/ 放 UIA 诊断）
├─ assets/                         # 人设预设与词库
├─ examples/                       # 桥接入口与媒体兜底
├─ docs/                           # 文档
├─ vendor/                         # 固定版 wechatauto
├─ tests/                          # 测试
```

以下不入库，运行期自动生成：`data/`（Key、记忆、日志）、`runtime/`（自带 Node 与 Python）、
`artifacts/`（构建产物）、`config.json`（本地配置）。

---

## 开发与测试

开发、测试和构建说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。普通用户按上面的安装包使用即可。

---

## 安全与合规

- 默认只监听 `127.0.0.1:8787`，**不要直接暴露到公网**（没有登录鉴权）
- `data/`、`config.json` 已被 `.gitignore` 忽略；**不要把自己的 API Key、聊天记录提交到仓库**
- 微信桥接是 UI 自动化，不改微信客户端、不注入、不读内存，但**仍可能违反微信使用条款**，账号风险自负
- 机器人说的话由大模型生成，请在公开群谨慎开启 `admin.allowAll` 和自动分享

---

## 下载（Download）

安装包只从 **GitHub Releases** 下载：<https://github.com/Banan1cee/whale_girl/releases>。
校验值与验证命令见 [docs/DOWNLOAD.md](docs/DOWNLOAD.md)。

## 代码签名（Code signing policy）

当前发行包**尚未签名**，Windows 会提示「未知发布者」；安装前请核对 Release 里 `SHA256SUMS.txt` 的校验值。
签名申请与策略见 [docs/CODE_SIGNING_POLICY.md](docs/CODE_SIGNING_POLICY.md)；隐私政策见 [PRIVACY.md](PRIVACY.md)。

## 致谢

微信收发完全站在前人的肩膀上，特别感谢：

- **图标原创角色作者：上善无形** —— 本项目使用的鲸鲸图标是在其原创角色基础上的**二创作品**；角色原创版权归原作者，本项目仅按授权范围使用并署名。详见 [NOTICE.md](NOTICE.md)。
- **[wechatauto-replica](https://github.com/fanyuantaier/wechatauto-replica)**（v1.2.9，**Apache-2.0**，作者 fanyuantaier，[PyPI](https://pypi.org/project/wechatauto-replica/)）
  —— 微信 4.x Windows 客户端自动化库（wxauto 复刻版）：SQLCipher 数据库解密读取 + UIA / 坐标-OCR 混合发送。
  本项目的微信桥接（`examples/wechatauto_bridge.py`）直接建立在它之上。
  - 源码以固定副本入库：`vendor/wechatauto/`（含 `dist-info/licenses/LICENSE` 原始许可证），清单与校验值见 `vendor/MANIFEST.sha256`，说明见 `vendor/README.md`
  - 构建时按清单逐文件校验后复制进 `runtime/`，**不手改**上游源码；需要调整行为时改构建期补丁 `scripts/prepare-sticker-runtime.py`，运行期的兼容补丁走 `examples/uia_compat.py`
  - 上游 README 写的是「仅供个人学习与自动化研究」，那是作者的期望而不是许可证条款；实际权利以 Apache-2.0 为准（见下）
- **[wxauto](https://github.com/cluic/wxauto)**（Apache-2.0）—— Windows 微信自动化库的先行者，`wechatauto-replica` 是它的 4.x 复刻版，思路与接口设计都源自这里。
- **[VB-CABLE](https://vb-audio.com/Cable/)**（VB-Audio，Donationware）—— 自动语音发送用的虚拟声卡，安装包只附带官方安装程序。

### 第三方许可证与再分发

- `wechatauto-replica` 采用 **Apache-2.0**：允许私人使用、修改、再分发乃至商用，**前提是保留许可证与版权声明、标注你对它的修改、不暗示上游为本项目背书**。
- 本项目满足的方式：许可证原文随源码放在 `vendor/wechatauto/dist-info/licenses/LICENSE`；`vendor/MANIFEST.sha256` 与构建脚本保证上游源码未被手改、改动只发生在构建期补丁里；致谢与仓库地址写在这里和 `vendor/README.md`。
- 本项目原创代码、文档和原创素材采用 **AGPL-3.0-only**（见 [LICENSE](LICENSE)）。这是 OSI 认可的开源许可证：允许商业使用，但分发修改版、或让用户通过网络使用修改版时，必须按 AGPL-3.0 提供完整对应的源代码。第三方组件仍适用各自许可证，详见 [NOTICE.md](NOTICE.md)。

## License

**AGPL-3.0-only**，见 [LICENSE](LICENSE)。欢迎使用、修改和分发（包括商业使用），但修改版分发或网络服务必须按 AGPL-3.0 提供源代码；请保留 [NOTICE.md](NOTICE.md) 中的署名。
