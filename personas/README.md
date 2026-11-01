# 人设预设（一个版本一个文件）

这里放**给所有人用的通用人设**。规则只有一条：**每次升级人设就新增一个文件，不覆盖旧的**。

```
personas/
  persona-v1.json      # 第一版
  persona-v2.json      # 下一版，改了什么写进 description
  persona-v3.json
```

## 为什么不覆盖

- 新版不好用可以直接切回旧版，不用凭记忆重写
- 群里出问题能对上「当时用的是哪一版」
- 别人问「你这版跟上一版差在哪」，文件 diff 一目了然

## 文件格式

```json
{
  "id": "persona-v2",
  "version": "2.0.0",
  "name": "预设标题（只用于列表展示，不会改她的名字）",
  "personaName": "鲸鲸",
  "description": "这版改了什么",
  "preset": "正常",
  "age": 20,
  "appearance": "外观描述",
  "personality": "性格描述",
  "background": "背景设定",
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

- `name` 是**预设标题**（导入后列表里显示的那一行），**不会改她的名字**；真要改名用 `personaName`。
- 其余可写字段：`appearance` / `personality` / `background`（对应人设页的外观、性格、背景）、`maxBubbles`（最多分几条消息，1–8）。

## 怎么用

三种方式，任选：

1. **启动器**：左栏「人设」→「人设预设」下拉选一版 →【导入这版】
2. **接口**：`POST /api/persona/preset`，body `{"id":"persona-v1"}`
3. **手动**：把人设内容粘进「人设 → 身份 → 自定义提示词」

导入只会改人设相关设置，不动模型、Key、群配置和记忆。

> 注意：`personas/` 里只能放通用内容。**不要**写主人的微信号、群成员真名、API Key——这个目录是跟着发行包发出去的。

## 本地活动预设（不进发行包）

`persona-v4-fight.json` 是「吵架大赛（火力全开）」用的，允许任何脏话、人身攻击。
它**不打进发行包**（`scripts/build-release.ps1` 里有排除规则），只在作者本机用；要试的话把文件自己拷进 `personas/` 再在启动器人设页导入。
