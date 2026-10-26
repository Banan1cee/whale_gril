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
  "name": "显示用的人设名",
  "description": "这版改了什么",
  "preset": "正常",
  "age": 20,
  "privateMaxChars": 140,
  "groupMaxChars": 70,
  "historyTurns": 100,
  "groupHistoryTurns": 60,
  "text": "一句话补充，优先级高",
  "customPrompt": "完整人设提示词"
}
```

只认上面这些字段，其他字段会被忽略。`id` 只能是小写字母、数字、点、横线、下划线。

## 怎么用

三种方式，任选：

1. **网页面板**：`/persona` 页面底部「导入人设预设」，选一个点导入
2. **接口**：`POST /api/persona/preset`，body `{"id":"persona-v1"}`
3. **手动**：把人设内容粘进面板的「自定义提示词」

导入只会改人设相关设置，不动模型、Key、群配置和记忆。

> 注意：`personas/` 里只能放通用内容。**不要**写主人的微信号、群成员真名、API Key——这个目录是跟着发行包发出去的。
