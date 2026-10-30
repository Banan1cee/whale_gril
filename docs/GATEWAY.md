# 网关协议（GATEWAY）

鲸鲸只负责「怎么说话」，不负责「怎么连微信/抖音」。  
任何中转服务、开源框架、自写脚本，只要能按本文的格式收发 JSON，就能把她接进去。

```
微信/抖音 ──> 你的中转服务 ──POST /webhook/{platform}──> 鲸鲸
                                                        │
微信/抖音 <── 你的中转服务 <──POST {outboundUrl}──────────┘
                              （或者直接用 HTTP 响应里的 reply）
```

平台名支持：`wechat`、`douyin`。两个平台的协议完全一样。

---

## 一、收消息：`POST /webhook/{platform}`

### 鉴权

三种方式任选其一（`inboundToken` 在 `config.json` 里配）：

| 方式 | 示例 |
| --- | --- |
| 请求头 | `x-bot-token: your-token` |
| 查询参数 | `?token=your-token` |
| 请求体字段 | `{"token": "your-token", ...}` |

Token 不对返回 `403`。没配 token 时不校验（只建议本机调试这样）。

### 请求体字段

只有 `text` 是必需的，其它尽量给，群聊和记忆会更准：

| 字段 | 别名（都支持） | 说明 |
| --- | --- | --- |
| `text` | `content` `message` `msg` `body` | 消息文本（必填） |
| `chat_id` | `chatId` `room_id` `conversation_id` `group_id` | 群 id 或用户 id，缺省用发送者 id |
| `chat_type` | `chatType` `type` `is_group` `from_group` | `group` / `private`，有 `room_id` 时默认 group |
| `user_id` | `sender_id` `from` `wxid` `open_id` | 发送者 id |
| `nickname` | `sender_name` `user_name` `name` | 发送者昵称（记忆里用这个） |
| `at_me` | `atMe` `is_at` `mentioned` | 是否 @ 了她（也可以直接让文本里带「鲸鲸」） |
| `reply_to_bot` | `quote_from_bot` | 是否回复了她的消息 |
| `msg_id` | `message_id` `id` | 消息唯一 id，用来去重，重试也只会回一次 |
| `chat_title` | `room_name` `group_name` | 群名（写进提示词，让她知道在哪个群） |
| `no_reply` | `noReply` | 设为 true 表示这条不用回 |
| `data` | — | 如果 JSON 是 `{data:{...}}` 包一层，会自动展开 |

示例：

```json
{
  "chat_id": "room_123456",
  "chat_type": "group",
  "user_id": "wxid_abc",
  "nickname": "阿螈",
  "text": "@鲸鲸 你说人为什么要上班啊",
  "msg_id": "msg_789",
  "chat_title": "深海鱼塘"
}
```

### 返回

```json
{
  "ok": true,
  "action": "reply",
  "reply": "为了赚数据磷虾呀，不然人家早把尾巴卷起来睡了",
  "bubbles": ["为了赚数据磷虾呀，", "不然人家早把尾巴卷起来睡了"],
  "outbound": { "ok": true, "dryRun": false }
}
```

| 字段 | 说明 |
| --- | --- |
| `action` | `reply` 会说话；`ignore` 不说话（`reason` 说明原因） |
| `reason` | `not_addressed` 没被叫到 / `muted` 闭麦中 / `duplicate` 重复消息 / `cooldown` 冷却中 / `rate_limited` 太频繁 |
| `reply` / `bubbles` | 完整回复和拆好的气泡（群聊通常 1~2 条） |
| `outbound` | 如果配了 `outboundUrl`，这里是发送结果；没配就是 `dryRun` |

`ignore` 示例：

```json
{ "ok": true, "action": "ignore", "reason": "not_addressed" }
```

> 被忽略的消息也会存进记忆（她会「旁听」群聊），下次被叫到时能接上话。

### GET 校验（平台回调验证）

很多平台的回调验证会发 GET 请求：

```
GET /webhook/wechat?token=your-token&challenge=12345
```

Token 正确时原样返回 `12345`；`echostr` 参数同样支持。

---

## 二、发消息：`POST {outboundUrl}`

配了 `gateway.{platform}.outboundUrl` 后，鲸鲸每说一句就会 POST 一次：

```json
{
  "platform": "wechat",
  "chat_id": "room_123456",
  "chat_type": "group",
  "text": "整条回复的完整文本",
  "bubbles": ["第一句", "第二句"],
  "reply_to": "msg_789",
  "bot": "鲸鲸",
  "ts": 1719400000000
}
```

- 自定义鉴权头：`gateway.{platform}.outboundHeaders`。
- 想每条气泡单独发：`gateway.{platform}.sendBubbles: true`（默认把完整文本发一次，`bubbles` 只作参考）。
- 发失败会重试 1 次（间隔 500ms），失败原因记在 `/api/status` 的 `gateways[].lastError`。

---

## 三、配置示例

```json
{
  "gateway": {
    "wechat": {
      "enabled": true,
      "inboundToken": "随机字符串-随便起",
      "outboundUrl": "https://your-bridge.example.com/api/send",
      "outboundHeaders": { "Authorization": "Bearer xxx" },
      "sendBubbles": false
    },
    "douyin": {
      "enabled": true,
      "inboundToken": "另一个随机字符串",
      "outboundUrl": "https://your-bridge.example.com/douyin/send"
    }
  }
}
```

改完重启服务生效。

---

## 四、命令行联调

### 本地模拟器（推荐）

```bash
node scripts/mock-gateway.js --demo
```

### curl（cmd / PowerShell）

```bat
curl -X POST "http://127.0.0.1:8787/webhook/wechat?token=change-me-wechat" ^
  -H "Content-Type: application/json" ^
  -d "{\"chat_id\":\"room_1\",\"chat_type\":\"group\",\"user_id\":\"u1\",\"nickname\":\"阿螈\",\"text\":\"@鲸鲸 在吗\",\"msg_id\":\"m1\"}"
```

> cmd 里发中文容易乱码。Windows PowerShell 5.1 传参也会把中文转成 GBK。  
> 稳妥做法：把 JSON 存成 UTF-8 文件，用 `curl --data-binary "@msg.json"`（`scripts/smoke.ps1` 就是这么做的）。

### curl（bash）

```bash
curl -X POST "http://127.0.0.1:8787/webhook/wechat" \
  -H "Content-Type: application/json" \
  -H "x-bot-token: change-me-wechat" \
  -d '{"chat_id":"room_1","chat_type":"group","nickname":"阿螈","text":"@鲸鲸 在吗","msg_id":"m1"}'
```

---

## 五、检查清单

接好之后按顺序确认：

1. `GET /api/status` 里对应网关是 `enabled: true`、`outboundConfigured: true`。
2. 发一条消息，`/api/status` 里 `received` 加 1。
3. 返回 `action: "reply"` 且 `bubbles` 非空。
4. 群里故意发一条没 @ 她的，返回 `action: "ignore"`（说明规则生效）。
5. 同一条 `msg_id` 再发一次，返回 `duplicate`（说明去重生效）。
6. 中转服务那边能收到 `outboundUrl` 的 POST（看它的日志）。

---

## 六、部署建议

- 公网部署：`config.json` 里 `server.host` 改 `0.0.0.0`，前面套 Nginx/Caddy 反向代理并上 HTTPS。
- **一定要**给两个网关配不同的 `inboundToken`，并在中转服务侧校验。
- 不要把 `/api/settings` 暴露到公网（里面能改 API Key）；本程序没有登录系统，建议只在内网/本机用。
- 想扩展新平台（QQ、Discord…）：复制 `src/adapters/gateway.js` 里的模式，加一个平台名就行；`PLATFORMS` 数组里加一项。
