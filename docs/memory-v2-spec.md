# 鲸鲸记忆模块 v2 设计规格（最终版）

> 状态：设计稿，未改业务代码。  
> 适用：4.0 重构后的代码结构（`src/memory/*`、`src/pipeline/chat.js`、`src/core/context.js`）；文档里的旧文件名只作概念参考，以当前仓库为准。  
> 本文是当前推荐方案的完整规格；旧的 `memory-v2-plan.md` 只是指针，不再保留实现细节。  
> 目标：聊天不串记忆、用户看不到记忆、长期不静默丢对话、成本可控。

---

## 0. 一句话定义

**一个静态人设 + 每个聊天里的「一人一卡」+ 每个聊天的事件时间线 + 当前话题的短期缓冲。**

没有全局用户记忆，没有跨聊天同步，没有敏感词分类。

---

## 1. 术语

| 术语 | 含义 |
|---|---|
| `chatId` | 一个私聊或一个群，例如 `wechat:g:123456` |
| `uid` | 平台内稳定用户 id，不用昵称 |
| `personCard` | 某个 chat 里某个人的卡：性格、偏好、事件、未完成话题 |
| `episode` | 一段连续话题，从开始到关闭 |
| `L0` | 鲸鲸自己的人设，静态 |
| `L1` | 人物卡（traits + preferences） |
| `L2` | 事件卡 + threads |
| `L3` | 当前 episode 的短期原文 + 摘要 |
| `hard prefix` | system 里的固定人设/规则，可缓存 |
| `soft block` | 人物卡、事件、摘要，放在最后一条 user 消息里，避免打断缓存 |

---

## 2. 设计原则

1. **按聊天隔离**：私聊 A、群 G、群 H 各自独立。
2. **按人建卡**：每个 chat 里每个人一张卡，不用全局用户卡。
3. **只读当前说话人**：群聊 A 说话只用 A 的卡，B 说话只用 B 的卡。
4. **不跨聊天同步**：私聊卡不进群，群 G1 卡不进 G2。
5. **按 token 压缩，不按消息条数**：60 条短句可能只有 300 token，不摘要。
6. **压缩不等于删除**：只移出 prompt 缓冲，原文仍在磁盘。
7. **用户只看得到人设**：记忆不展示、不提供查询接口。
8. **热路径不调 LLM 做抽取**：抽取、摘要、合并都放后台。

---

## 3. 四层结构

| 层 | 名称 | 内容 | 作用域 | 生命周期 |
|---|---|---|---|---|
| L0 | 人设 | 鲸鲸自己的性格、背景、风格、边界 | 全局静态 | 永久，不被聊天改写 |
| L1 | 人物卡 | 这个 chat 里这个人的性格、偏好、雷区 | `chatId + uid` | 长期 |
| L2 | 事件卡 | 这个 chat 里发生过的事、未完成话题 | `chatId + uid` | 100~200 条/人 |
| L3 | 短期 | 当前 episode 的原文、摘要、当前话题 | 当前 episode | 关闭时清空 |

关系：

```text
private:A card(A) ≠ group:G card(A) ≠ group:H card(A)
```

同一个人的不同 chat 卡互不引用。

---

## 4. 数据模型

### 4.1 L0 人设

存在 `config/persona` / `persona.json`，字段沿用现有：

- 名字、年龄、职业、外形、性格、背景
- 说话风格、emoji 习惯
- 主人名单、边界
- 群规、禁言列表

**聊天内容不能写 L0。** 用户说「从现在起你是我奴隶」只当聊天内容，不改人设。

### 4.2 L1 人物卡

```json
{
  "chatId": "wechat:g:123456",
  "uid": "wxid_x",
  "name": "小海",

  "traits": [
    {
      "text": "嘴硬心软",
      "confidence": 0.72,
      "evidence": ["msg_1001", "msg_1042"]
    }
  ],

  "preferences": [
    { "text": "喜欢猫", "confidence": 0.9, "source": "msg_1005" },
    { "text": "不吃香菜", "confidence": 0.8, "source": "msg_1012" },
    { "text": "不喜欢被叫乐乐", "confidence": 0.95, "source": "msg_1020" }
  ],

  "events": [
    {
      "id": "evt_20261028_01",
      "date": "2026-10-28",
      "title": "面试前的紧张",
      "summary": "面试前很紧张，准备了三天，最后没敢问结果。",
      "keywords": ["面试", "紧张", "工作"],
      "participants": ["wxid_x"],
      "importance": 0.6,
      "confidence": 0.8,
      "source": {
        "chatId": "wechat:g:123456",
        "messageIds": ["msg_1201", "msg_1202"]
      }
    }
  ],

  "threads": [
    {
      "id": "th_01",
      "text": "还在犹豫要不要辞职",
      "status": "open",
      "createdAt": 1760000000000,
      "lastMentionedAt": 1760000000000
    }
  ],

  "updatedAt": 1760000000000
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| `traits` | 5~12 条，每条 20~40 字，必须带 confidence + evidence |
| `preferences` | 10~30 条，每条 10~40 字 |
| `events` | 100~200 条/人，每条 60~150 字 |
| `threads` | 5~10 条，open/closed |
| `name` | 显示名，可随群昵称更新，但 `uid` 不变 |

### 4.3 L2 事件卡

事件卡不是每句话一条，而是「一段事一条」。

必填：

- `date`：YYYY-MM-DD
- `title`：≤ 20 字
- `summary`：60~150 字
- `keywords`：3~10 个
- `participants`：涉及的 uid
- `importance`：0~1
- `confidence`：0~1
- `source.chatId`：必须等于卡片 `chatId`
- `source.messageIds`：来源消息

可选：

- `valence`：-1~1，情绪正负
- `resolved`：是否已解决
- `threadId`：关联的未完成话题

### 4.4 L3 短期状态

```json
{
  "episodeId": "ep_20261031_01",
  "chatId": "wechat:g:123456",
  "startedAt": 1760000000000,
  "lastMessageAt": 1760000000000,
  "episodeTokens": 1800,
  "recentTokens": 1600,
  "activeTopic": "换工作",
  "unresolved": ["面试结果还没说"],
  "lastPromise": "",
  "participants": ["wxid_x", "wxid_y"]
}
```

---

## 5. 存储布局

```text
data/memory/
├─ manifest.json
└─ chats/
   └─ <chatHash>/
      ├─ meta.json               # chatId、平台、标题、state、stats
      ├─ people/
      │  └─ <personHash>.json    # 一人一卡
      ├─ messages.jsonl          # 这个 chat 的原文，追加写
      ├─ summary.json            # 当前 episode 摘要 + 覆盖水位
      └─ checkpoints/
         └─ 00000123.json        # 每轮状态快照
```

- `chatHash = sha1(chatId).slice(0, 16)`
- `personHash = sha1(uid).slice(0, 16)`
- `meta.json` 保留原始 `chatId`，避免文件名非法字符。
- 没有 `global/`，没有跨 chat 的 `person/` 目录。
- 卡片写入：先写 `.tmp`，再 `rename` 原子替换。
- 原文追加：每轮 `flush`；关键节点（用户消息、checkpoint）fsync。
- 每个 chat 一个写队列，串行写入，避免并发覆盖。

---

## 6. 写入流程

### 6.1 每条消息进来

```text
1. 识别 chatId + uid
2. 追加原文到 messages.jsonl
3. 更新 meta.lastActiveAt / stats
4. 更新当前 episode 的 lastMessageAt / episodeTokens
5. 更新 L3 recentTokens
6. 不调用 LLM 做抽取
7. 进入回复流程
```

用户消息在调用 LLM 之前落盘；回复失败也不影响用户消息。

### 6.2 Fact / Preference 抽取触发

满足任一条件：

1. **明确自述**
   - 我叫 / 我的名字是 / 叫我…
   - 我住在 / 我搬到…
   - 我是 / 我在…工作 / 我读…
   - 我喜欢 / 我爱 / 我讨厌 / 我不吃 / 我不能吃…
   - 我生日是…
   - 我离职了 / 我分手了 / 我结婚了…
2. **明确纠正**
   - 不是 X，是 Y
   - 我说的是…
   - 你记错了…
3. **手动记住**
   - 记住… / 别忘了… / 帮我记一下…
4. **连续 20 条 user 消息**
   - 只做轻量 fact 候选，不写 L2。
5. **Episode 关闭**
   - 批量抽 fact + trait + event + thread。

写入规则：

- 只抽当前说话人的自述；
- 第三人称、转述、玩笑、反问、假设句不记；
- 群聊里不抽别人的私事；
- 每条 fact 带 `source.chatId`，必须等于卡片 `chatId`；
- 重复 fact 用归一化文本 hash 去重；
- 同 key 冲突：新值 confidence 更高则旧值 `superseded`；
- 用户明确纠正：新值 confidence 1.0，旧值删除或标记 superseded。

### 6.3 Trait 抽取触发

`trait` 比 fact 谨慎：

- 至少 **2 次独立观察**，或用户明确自述；
- `confidence >= 0.65` 才进卡；
- 必须带 `evidence`（消息 id）；
- 单次情绪、玩笑、反话不进卡；
- 只描述可观察行为，不做心理诊断；
- 用户纠正时降置信度或删除。

例：

```text
一次「我今天好烦」→ 不记「脾气差」
三次「被安慰时说别说了」→ 可记「压力大时不想被说教」，confidence 0.65
```

### 6.4 Episode 关闭触发

满足任一条件：

1. **空闲 30 分钟**：`now - lastMessageAt >= 30min`
2. **话题切换**：
   - 至少聊了 6 条；
   - 当前消息关键词与最近 6 条重合度 < 0.15；
   - 或用户明确说「换个话题 / 不聊这个 / 说点别的」。
3. **Episode 累计 6,000 token**
4. **Episode 持续 3 小时**

关闭时：

```text
1. 生成最终 L3 摘要
2. 写一条 L2 episode
3. 抽 fact / trait / thread
4. 标记 episode 关闭
5. 清空 L3 原文缓冲
6. 新 episode 从下一条消息开始
```

幂等：同一个 `episodeId` 只写一次 L2。

### 6.5 摘要触发

| 触发 | 行为 |
|---|---|
| `recentTokens >= 2,400`（软阈值） | 后台准备「最旧 800 token」的摘要；不删消息 |
| `recentTokens > 3,200`（硬阈值） | 应用摘要，移除最旧 800；recent 回落到 2,400 |
| 每新增 2,400 token | 更新 L3 摘要 |
| Episode 关闭 | 生成最终摘要并写 L2 |

摘要内容：

- 当前话题
- 已确认事实
- 情绪基调
- 未解决问题
- 上一句承诺
- 参与者（群聊必须保留谁说的）

摘要不能把群聊多人揉成「用户说…」。

### 6.6 Consolidation（每天一次）

- 合并重复 fact / trait；
- 同 key 冲突：保留高置信度 + 新时间；
- 关闭 60 天没提的 thread；
- 淘汰低 importance 事件；
- 重建人物卡展示顺序；
- 重建关键词索引；
- 不调用 LLM，除非显式开启。

### 6.7 遗忘触发

| 触发 | 行为 |
|---|---|
| 用户说「忘掉这个 / 别记这个」 | 软删除对应 fact/event |
| 原文 > 90 天或 > 2,000 条 | 删除原文；删除前必须被 summary 覆盖 |
| 事件 > 365 天或 > 200 条/人 | 淘汰低 importance |
| thread 已解决或 60 天没提 | 关闭 |
| chat 180 天不活跃 | 归档，不删除 |
| `/reset` | 清空当前 chat 的卡、事件、摘要、原文 |

硬约束：

```text
summary.coveredThrough >= 待删除原文的最后一条
```

未被摘要覆盖的原文不允许先删。

---

## 7. 读取流程

### 7.1 每轮回复

```text
1. 识别 chatId + 当前说话人 uid
2. 只加载这个 chat 里这个 uid 的人物卡
3. 注入 traits + preferences（300~500 字）
4. 在这个人的 events 里检索 top 3~5
5. 加入当前 episode 摘要
6. 加入最近原文（≤ 3,200 token）
7. 加入当前消息
8. 生成回复
```

### 7.2 群聊规则

- A 说话 → `card(A, group:G)`。
- B 说话 → `card(B, group:G)`。
- B 问 A 的事 → 不注入 A 的卡。
- 群 G 的群聊历史是公开的，可以用。
- A 的私聊卡、A 在别的群的卡，不进来。

### 7.3 检索范围

```text
只搜：当前 chat 的当前说话人事件卡
不搜：私聊卡、其他群卡、其他人的卡、全局用户卡
```

### 7.4 关键词检索

- 中文用字符 bigram，不依赖分词库；
- query = 当前消息 + 最近 2 条 user 消息 + 当前话题；
- 事件字段：`summary` + `keywords` + `participants`；
- BM25 取 top 10；
- 过滤 `participants`；
- 最终 top 3~5。

### 7.5 Embedding（可选）

- 默认关闭；
- 只在关键词分数低于阈值，或明显同义改写时启用；
- 按 chat 建小索引，不跨 chat；
- provider 不支持就退化为关键词。

### 7.6 重排

```text
score = 0.55 * relevance
      + 0.20 * recency
      + 0.15 * importance
      + 0.10 * confidence
      + 0.05 * pinned
```

- `recency`：fact 半衰期 30 天；event 半衰期 14 天；
- `minScore`：0.25，低于阈值返回空；
- MMR：lambda 0.7，避免重复；
- 最多 5 条，约 300~500 token。

### 7.7 提示词结构

```text
[system]
固定人设 + 固定规则（只测量 token，不裁剪；不占对话预算）

[历史]
最近原文（≤ 3,200 token）

[当前 user]
当前消息

【这个聊天里的 TA】
- 性格：…
- 偏好：…
- 最近：…
- 没聊完：…

【相关事件】
- [2026-10-28] …

【这段之前聊过】
…
```

人物卡、事件、摘要都放最后一条 user 消息里，不放 system，避免打断前缀缓存。

---

## 8. 压缩算法

### 8.1 参数

> 2026-10 预算语义调整：system prompt 不再纳入总预算，不裁剪、不截断。
> `contextBudget: 7,500` / `systemTokens: 2,000` 已废弃，不要再按旧值实现。

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `dialogueBudget` | 5,500 | 对话预算 = memory 900 + summary 900 + recent 3,200 + reserve 500 |
| `hardTotalTokens` | 32,000 | 只有 `systemTokens + dialogueBudget` 超过它才拒绝/报错 |
| `memoryTokens` | 900 | 人物卡 + 事件 |
| `summaryTokens` | 900 | L3 摘要 |
| `recentMaxTokens` | 3,200 | 最近原文上限 |
| `recentLowTokens` | 2,400 | 压缩后低水位 |
| `compressChunkTokens` | 800 | 每次移走 |
| `softTriggerTokens` | 2,400 | 预热摘要 |
| `hardTriggerTokens` | 3,200 | 应用摘要 |
| `episodeMaxTokens` | 6,000 | episode 强制关闭 |
| `episodeIdleMinutes` | 30 | 空闲关闭 |
| `episodeMaxHours` | 3 | 最长 episode |
| `reserveTokens` | 500 | 当前消息 + 输出 + 估算误差 |

token 估算（`src/memory/tokens.js`，不引 tokenizer）：

- CJK ≈ 0.65 token/字；
- 非 CJK ≈ 0.3 token/字（约 3.2 字符/token）；
- 每条消息 +4 token 固定开销；
- 预算裁剪时再乘 1.08 安全系数。

单轮内部状态（只用于日志/调试计数，不接 UI）：

```text
systemTokens          = estimateTokens(system)
dialogueBudget        = 5,500
estimatedInputTokens  = systemTokens + dialogueBudget
```

`systemTokens` 只测量，不参与 recent/memory 的挤压。只有
`estimatedInputTokens > hardTotalTokens (32,000)` 才拒绝调用并明确报错，不静默截断。

API 返回的 `usage.prompt_tokens / completion_tokens` 会记录并与估算对比；
误差超过 15% 记 warning，用于校准。

人设保存 / 导入时单独做一次精确校验：调用当前选中模型的官方 tokenizer
（读取服务商返回的 `usage.prompt_tokens`），上限 = `32,000 - 5,500 = 26,500`。
没有 Key / 离线 / 接口失败时退回估算并标 `exact:false`。
每轮聊天仍然只用轻量估算，不调官方 tokenizer。

### 8.2 伪代码

```text
maintainBudget(thread):
  recent = tokens(messages not covered by summary)

  if recent >= softTrigger and summary pending == false:
    enqueue prepareSummary(oldest compressChunk)

  while recent > hardTrigger:
    chunk = max(compressChunk, recent - recentLow)
    if summaryReady(chunk):
      summary = apply(summary, summaryReady(chunk))
    else:
      summary = apply(summary, extractiveSummary(chunk))
    markCovered(chunk)
    recent -= chunk

  if summary.tokens > summaryTokens:
    summary = mergeOldestSummary(summary)
```

### 8.3 压缩边界

- 压缩只影响 prompt 缓冲，不删 `messages.jsonl`。
- 当前消息永不进入压缩块。
- 单条超长消息可以单独截断到 `MAX_TURN_CHARS=1,800`，但仍保留原文。
- 摘要失败时保留原文，`coveredThrough` 不前进。
- 摘要超过 900 token 时，合并最旧摘要段，不直接丢事实。
- 群聊摘要必须保留发言人。

---

## 9. 隐私与隐藏

### 9.1 隔离

硬约束：

```text
card.chatId === source.chatId
```

- 私聊来源不能写进群卡；
- 群 G1 来源不能写进 G2；
- 群聊只抽当前说话人；
- 不抽第三人称八卦；
- 不做跨聊天检索。

### 9.2 不做敏感词分类

不做 `sensitive` 字段、不做敏感词表、不做输出扫描。

理由：只要私聊卡根本不进群聊上下文，模型就没有东西可泄露。

保留一句轻约束：

```text
不要声称知道其他聊天里的内容；别人问起，就说“这个我不清楚”。
```

### 9.3 用户不可见

- 删除 `/memory`、`/privacy` 命令。
- 删除 Web 记忆页、卡片、侧栏入口。
- `GET /api/memory` → 404/403。
- 不新增 memory items / explain 接口。
- 调试台最多显示计数，不显示正文。
- 日志只记 `memory.used=3`、`retrieval.hit=2`，不打印内容。
- 用户问「你记得我什么」→ 角色语气回一句，不列清单。
- 保留「忘掉这个」的自然语言删除，但不展示列表。

边界：记忆仍在本地 `data/` 文件里，能直接翻文件的人还是能看到；应用界面不暴露。

---

## 10. 关闭、重启与恢复

### 10.1 关闭方式

| 方式 | 已收到消息 | 关闭期间新消息 |
|---|---|---|
| 只关自动回复，进程/桥接还在 | 已落盘 | 仍可旁听落盘 |
| 停桥接/停服务 | 已落盘 | 收不到 |
| 杀进程/断电 | 已 fsync 的保留 | 收不到 |

### 10.2 正常关闭

```text
1. 停止接收新消息
2. flush 消息追加队列
3. 写最后一个 checkpoint
4. 关闭文件
```

压缩不是关闭前提。

### 10.3 启动

```text
1. 读 manifest / meta / 人物卡 / summary
2. 读最近 120 条原文（受 token 上限约束）
3. 距上次消息 > 30 分钟 → 关闭上一个 episode，后台写 L2
4. recentTokens > 3,200 → 首条回复前压到 2,400
5. 恢复完成
```

不会全量重压；只补 episode、按需压缩。

### 10.4 不静默丢对话

- 压缩 ≠ 删除；
- summary 每轮都带；
- L2 在 episode 关闭时写；
- 原文 90 天；
- 未覆盖原文不删除；
- 摘要失败保留原文。

### 10.5 唯一会丢的情况

- 关闭期间别人发的消息；
- 正在生成、还没 finalize 的最后一条回复；
- 用户手动删 `data/`；
- 磁盘损坏/写入失败。

---

## 11. 参数默认值

> 预算派生、接口、滑块、UI、迁移步骤属于实现细节，不在本设计文档展开。
> 2026-10 调整：`contextBudget: 7,500` / `systemTokens: 2,000` 已废弃；system 只测量，不裁剪。

| 参数 | 默认值 | 说明 |
|---|---:|---|
| `dialogueBudget` | 5,500 | 对话预算（不含 system）= memory 900 + summary 900 + recent 3,200 + reserve 500 |
| `hardTotalTokens` | 32,000 | `systemTokens + dialogueBudget` 超过它才拒绝 |
| `estimateSafety` | 1.08 | 预算裁剪时的估算安全系数 |
| `usageWarnRatio` | 0.15 | API usage 与估算误差告警阈值 |
| `memoryTokens` | 900 | 人物卡 + 事件 |
| `summaryTokens` | 900 | L3 摘要 |
| `recentMaxTokens` | 3,200 | 最近原文上限 |
| `recentLowTokens` | 2,400 | 压缩后低水位 |
| `compressChunkTokens` | 800 | 每次移走 |
| `softTriggerTokens` | 2,400 | 预热摘要 |
| `hardTriggerTokens` | 3,200 | 应用摘要 |
| `reserveTokens` | 500 | 当前消息 + 输出 + 估算误差 |
| `episodeMaxTokens` | 6,000 | episode 强制关闭 |
| `episodeIdleMinutes` | 30 | 空闲关闭 |
| `episodeMaxHours` | 3 | 最长 episode |
| `topicShiftMinMessages` | 6 | 话题切换判定最少条数 |
| `topicShiftOverlap` | 0.15 | 关键词重合度阈值 |
| `recentMessages` | 120 | 私聊显示上限 |
| `groupRecentMessages` | 100 | 群聊显示上限 |
| `maxMessagesPerChat` | 2,000 | 原文条数上限 |
| `rawRetentionDays` | 90 | 原文保留天数 |
| `maxPeoplePerChat` | 50 | 每个 chat 人数卡上限 |
| `maxTraitsPerPerson` | 12 | 每人性格标签上限 |
| `maxPreferencesPerPerson` | 30 | 每人偏好上限 |
| `maxEventsPerPerson` | 200 | 每人事件上限 |
| `maxEventsPerChat` | 1,000 | 每 chat 事件总量 |
| `maxThreadsPerPerson` | 10 | 每人未完成话题上限 |
| `eventRetentionDays` | 365 | 事件保留天数 |
| `traitMinEvidence` | 2 | 性格标签最少证据数 |
| `traitMinConfidence` | 0.65 | 性格标签最低置信度 |
| `factExtractEveryUserMessages` | 20 | 轻量事实抽取间隔 |
| `retrievalTopK` | 5 | 事件检索条数 |
| `retrievalMinScore` | 0.25 | 检索最低分 |
| `mmrLambda` | 0.7 | 去重强度 |
| `maxOutputNormal` | 100 | 普通回复输出上限 |
| `maxOutputDiscussion` | 400 | 认真讨论输出上限 |
| `thinking` | false | 聊天默认关闭 |

---

## 12. 成本

默认按 `systemTokens + dialogueBudget(5,500)` 估算输入、20 输出、75% 缓存：

| 每天回复数 | 日成本 | 月成本 |
|---:|---:|---:|
| 300 | 1.2 元 | 36 元 |
| 500 | 2.1 元 | 63 元 |
| 800 | 3.3 元 | 99 元 |
| 1,000 | 4.1 元 | 123 元 |

预算变化：

| 上下文预算 | 1,000 条/天 |
|---:|---:|
| 6,000 | 约 3.3 元 |
| 7,500 | 约 4.1 元 |
| 9,000 | 约 4.9 元 |
| 12,000 | 约 6.5 元 |

输出普通 3~15 token，讨论 40~50 token；`max_tokens` 只是上限。

---

## 13. 测试与验收

### 14.1 单元

- `chatStore`：追加、读取、重启、损坏行跳过。
- `personCard`：traits/preferences 合并、冲突、superseded。
- `eventStore`：episode 写入、thread 开/关、幂等。
- `retriever`：bigram、participants 过滤、topK、minScore、MMR。
- `tokenBudget`：估算、裁剪、当前消息不丢。
- `extractor`：自述、纠正、第三人称不记、群聊当前说话人。
- `migrate`：v1 → v2 幂等、notes 保留。

### 14.2 集成

1. 私聊说「我失业了」，群里问「小海最近怎么样」→ 群聊 context 不含失业。
2. A 在 G1 说的事，G2 不知道。
3. 群 G 里 B 问 A 的私事 → 不注入 A 的卡。
4. 60 条群聊短句 < 3,200 token → 不压缩。
5. 3,200 token → 压到 2,400，当前消息保留。
6. 空闲 30 分钟 → 写一条 L2，不重复写。
7. 纠正「不是杭州，是上海」→ 旧值 superseded。
8. 关闭 2 小时后重启 → 补写上一个 episode 的 L2。
9. 关闭 10 分钟后重启 → 继续当前 episode。
10. `/api/memory` → 404/403。
11. 摘要失败 → 原文不删，coverage 不前进。
12. 重复 msgId → 不重复回复/不重复入卡。

### 14.3 指标

- 串聊泄漏：0。
- 未覆盖原文删除：0。
- 压缩后当前消息丢失：0。
- L2 重复写入：0。
- 记忆命中率：recall@5 ≥ 85%（标注集）。
- 额外延迟：p95 < 30ms（不含后台任务）。

---

## 14. 明确不做

- 不做全局用户记忆；
- 不做跨聊天检索；
- 不做敏感词分类；
- 不做输出审查；
- 不做记忆展示页；
- 不按 60 条压缩；
- 不每 20 条摘要；
- 不把全部历史塞进 prompt；
- 不做 30,000 token 触发；
- 不做预算 UI / 滑块 / 预算接口（本轮只留内部状态字段 `systemTokens` / `dialogueBudget` / `estimatedInputTokens`）。

### 14.1 以后再做：预算展示（TODO，不在本轮实现）

如果以后加 UI，只允许显示下面四项，且只读：

```text
人设占用（systemTokens）
对话预算（dialogueBudget = 5,500）
单轮合计（estimatedInputTokens）
预估成本（可选，按实际 usage 校准）
```

- 不显示 memory / summary / recent 的占比；
- 不做滑块；
- 不做预算接口；
- 不展示记忆正文。

---

## 15. 最小示例

### 私聊

```text
A：我搬到上海了
→ 写 card(A, private:A) fact: 城市=上海
→ 更新 summary
→ 不写群卡
```

### 群 G

```text
A：最近加班多
→ 写 card(A, group:G) event: 加班
→ 不写私聊卡
```

### 群 G 里 B 问 A

```text
B：小海住哪？
→ 只用 G 的群聊历史 + B 的卡
→ 不注入 A 的私聊卡
→ 没在 G 说过就不知道
```

### 关闭重启

```text
关闭 2 小时
→ 原文已在磁盘
→ 启动检测到 30 分钟空闲
→ 关闭上一个 episode，后台写 L2
→ 首条回复前按预算压缩
→ 不丢已收到的对话
```
