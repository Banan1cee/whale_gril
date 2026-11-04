# AGENTS.md —— 给 AI / 自动化协作者的项目约定

本文件是进入这个仓库时的默认约定。任务书 / 用户当次指令与这里冲突时，以任务书 / 当次指令为准；
它们没写到的部分，按下面来，不要每次再问。

## 1. UI 改动的默认落点：**EXE，不是 WebUI**

本项目说「UI / 界面 / 设置项 / 加个开关 / 加个按钮 / 改个文案」，**默认指启动器 EXE**。

- 默认改 `launcher/`（WPF：`launcher/Views/*.xaml` + `*.xaml.cs`），成品是仓库根目录的 `WhaleLauncher.exe`。
- 只有明确说「网页 / WebUI / 浏览器 / 网页设置页 / web」时才改 `web/`。
- 同一个用户可见的设置如果两边都有设置页，**默认两边同步**：EXE 为主，网页跟随；
  任务书明确只要求一侧时，按任务书来。
- `web/` 是内核自带的网页聊天 / 调试页（`server.js` 提供），改它不会出现在 EXE 里。

### 改完 launcher 必须重新发布 EXE

只改源码不重发 EXE，用户是看不到的。发布命令：

```powershell
dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher/publish `
  -p:PublishSingleFile=true -p:SelfContained=false
Copy-Item launcher/publish/WhaleLauncher.exe .\WhaleLauncher.exe -Force
```

- 本机没有 .NET SDK 时：只提交源码，并在回复里明确写「EXE 待发布」，**不要**假装 EXE 已更新。
- CI 的 `tests.yml` 会 `dotnet build` 校验 launcher 编译；`installer.yml` 在 `test/**` 分支构建安装包（不含正式发布）。
- 详细打包 / 签名流程见 `CONTRIBUTING.md` 第四节和 `docs/打包与签名.md`。

## 2. 代码与测试

- CommonJS、**零 npm 运行时依赖**、Node ≥ 18；不要引入需要 `npm install` 的运行时依赖。
- 每个行为改动配一条能复现它的测试；修 bug 要「修复前失败、修复后通过」。
- 测试逐文件跑：`node tests/xxx.test.js`。
  （沙箱里 `node --test "tests/*.test.js"` 可能因 spawn EPERM 失败，这不代表测试坏了。）
- 提交前至少跑：`node scripts/check-layers.js`、`node scripts/release-check.js`、`node scripts/privacy-scan.js .`。
- 中文注释讲「为什么」，不要写「做了什么」式的废话；不重排无关代码。

## 3. 日志与隐私

- 失败日志要能回答「为什么失败」：用 `src/infra/errors.js` 的 `describeError`，
  输出 `type / code / status / detail`；不要只打 `err.message`（`LlmError` 的 message 是给用户看的话术）。
- 日志里不打聊天正文 / 记忆正文，只打长度、计数、结构证据。
- 不提交真实 API Key、wxid、群号、聊天记录、`data/`、日志文件。

## 4. 协作方式

- 不直接 push `main`：改分支 → PR → CI 绿了再合并。
- 提交信息按 `docs/协作规范.md`（新增 / 改进 / 修复 / 其他 四段）。
- 用户可见行为变了，`CHANGELOG.md` 补一段。
