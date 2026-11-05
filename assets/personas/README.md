# 人设预设（一个风格一个文件）

这里放**可以直接导入的人设**。按**攻击力从低到高**排列，启动器下拉里也是这个顺序（由每个文件里的 `order` 决定）。

| order | 文件 | 风格 | 攻击力 |
|---|---|---|---|
| 10 | `persona-standard.json` | 鲸鲸标准版：像群友一样聊天 | 低 |
| 20 | `persona-baili.json` | 群友版：白璃（一张白纸，群里教什么学什么） | 低 |
| 30 | `persona-zhainan.json` | 群友版：宅女鲸鲸（普通群友，去人机感） | 中低 |
| 40 | `persona-dafeiyu.json` | 群友版：大肥鱼（串子 + 锐评） | 中 |
| 50 | `persona-jingjing.json` | 群友版：鲸鲸有性子版（人味规则 + 贴吧老哥模式） | 高 |
| 60 | `persona-tieba.json` | 群友版：贴吧老油子（嘴硬心软） | 很高（本地娱乐，不进发行包） |
| 70 | `persona-fight.json` | 吵架大赛：火力全开 | 极高（本地娱乐，不进发行包） |

## 文件格式

```json
{
  "id": "persona-standard",
  "order": 10,
  "name": "预设标题（只用于列表展示，不会改她的名字）",
  "description": "这版是什么风格、适合什么时候用",
  "preset": "正常",
  "age": 20,
  "privateMaxChars": 140,
  "groupMaxChars": 70,
  "historyTurns": 100,
  "groupHistoryTurns": 60,
  "maxBubbles": 2,
  "text": "一句话补充，优先级高",
  "customPrompt": "完整人设提示词"
}
```

只认上面这些字段，其他字段会被忽略。`id` 只能是小写字母、数字、点、横线、下划线。

- `order` 决定启动器下拉里的**排列位置**（数字小的排前面），按攻击力从低到高；没写 `order` 的排在最后，再按 `version` 比。
- `name` 是**预设标题**（列表里显示的那一行），**不会改她的名字**；真要改名用 `personaName`。但现有预设有测试钉着「预设标题不能当她的名字」，所以都不要写 `personaName`。
- 其余可写字段：`appearance` / `personality` / `background`、`maxBubbles`（最多分几条消息，1-8）。

## 怎么用

1. **启动器**：左栏「人设」→「人设预设」下拉选一版 →【导入这版】
2. **接口**：`POST /api/persona/preset`，body `{"id":"persona-standard"}`
3. **手动**：把人设内容粘进「人设 → 身份 → 自定义提示词」

导入只会改人设相关设置，不动模型、Key、群配置和记忆。

> 注意：`assets/personas/` 里只能放通用内容。**不要**写主人的微信号、群成员真名、API Key——这个目录是跟着发行包发出去的。

## 写新预设的约定

1. **`customPrompt` 最多 6000 字**（`src/persona/presets.js` 的 `toPatch` 会截断）。超长的原文要么精简后再放，要么指出要保留的部分。
2. **必须写「可以发语音」**：默认写「默认发文字；对方明确要你发语音时，直接正常答应……别自称没有麦克风」。少这一句她会回「我没麦克风，发不了语音」。
3. 群友原文里的 `QQ` 之类平台名改成本项目的「微信」，其余措辞尽量别动——那是人家的风格。
4. 群友发来的原创，`description` 里注明「群友自定义」，不要改人家的人设内核。
5. 攻击力高的预设：`description` 里写明「本地娱乐，不进发行包」，并同时加进 `installer/whale.iss` 的 `Excludes` 和 `scripts/build-release.ps1` 的 `localOnly`。

## 本地活动预设（不进发行包）

- `persona-fight.json`：吵架大赛（火力全开），允许脏话和人身攻击，只留四条硬边界。
- `persona-tieba.json`：贴吧老油子，先怼后办、阴阳怪气，只怼逻辑不碰人身。

两个都**不打进发行包**，只在作者本机用；要试的话把文件拷进 `assets/personas/` 再在启动器人设页导入。