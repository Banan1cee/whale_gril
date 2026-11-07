# 参与贡献

欢迎提 PR。这个项目有一条硬规矩：**每个 bug 修复都要配一条能复现它的测试**，否则不合并。

## 一、本地跑起来

```bash
# 需要 Node.js 18+（只跑网页版 / 单元测试就够）
node -v
npm start            # 打开 http://127.0.0.1:8787

# 接微信才需要 Python 3.12
python -m pip install -r requirements.txt
# wechatauto 由仓库 vendor/wechatauto 提供，pip 不需要装它；源码直跑桥接时把 vendor 加进 PYTHONPATH
```

不想装环境：下载 Releases 里的完整包，里面已经带好 Node + Python，解压双击就能跑。

## 二、改代码之前

1. 先看 `BUGS.md`：每个 bug 的现象 / 根因 / 修复 / 回归测试都记在里面，别重复踩
2. 看 `CHANGELOG.md`：确认你要改的东西没人正在做
3. `npm test` 先跑一遍，确认基线是绿的（当前 Node 817 + Python 119，CI 实测）

## 三、提 PR 的步骤

```bash
# 1. fork 到自己账号，然后
git clone https://github.com/<你的用户名>/whale_girl.git
cd whale_girl
git checkout -b fix/一句话说明

# 2. 改代码 + 补测试
npm test

# 3. 提交（信息格式见 docs/协作规范.md）
git add -A
git commit
git push origin fix/一句话说明
```

提交信息按 `docs/协作规范.md` 写：标题一行，正文分 **新增 / 改进 / 修复 / 其他** 四段，
每段编号，一条改动一行。没有内容的段整段删掉。

然后在 GitHub 上点 **Compare & pull request**，按模板填。

## 四、启动器 / 安装包

### UI 改动默认改哪边？

说「界面 / UI / 设置项 / 加个开关」时，**默认改启动器 EXE（`launcher/`）**。
内核不再提供网页界面（4.0.2 起 `web/` 已删除，`GET /` 返回 404 JSON），所以没有「两边同步」这回事；
只有任务书明确要求恢复网页界面时才新建 `web/`。
给 AI 协作者的同一约定写在仓库根目录 `AGENTS.md`，不用每次口头交代。

- 改 `launcher/` 之后要重新发布：`dotnet publish launcher/WhaleLauncher.csproj -c Release -o launcher/publish -p:PublishSingleFile=true -p:SelfContained=false`，
  再把 `launcher/publish/WhaleLauncher.exe` 覆盖到仓库根目录（根目录那份是直接发给用户的成品）。
- 安装包**只在 GitHub Actions 构建**（`.github/workflows/installer.yml`，手动 `workflow_dispatch` 或推 `v*` tag）；
  本机不跑 `ISCC`，也不提交 `dist/` 里的安装包。
- 改了安装脚本 / 打包排除表 / CI，至少跑一次 `installer` 流水线并看烟测结果。

## 五、PR 检查清单

- [ ] `npm test` 全绿（不许删别人的测试来让它变绿）
- [ ] 提交信息按 `docs/协作规范.md` 的 新增 / 改进 / 修复 / 其他 四段写，每条改动归到正确的类
- [ ] 新增/修改的行为有对应测试，且**修复前会失败、修复后通过**
- [ ] 改到用户看得到的行为时，`CHANGELOG.md` 加一段（版本号我们合并时统一提）
- [ ] 修的是 bug 就在 `BUGS.md` 加一行：现象 / 根因 / 修复 / 版本 / 回归测试
- [ ] 没有提交 `data/`、`config.json`、`wechatauto_db/`、日志、任何真实 Key 或 wxid
- [ ] 中文注释清楚说明「为什么」，不是「做了什么」

## 六、提 issue

用仓库里的 issue 模板。bug 请附：

- 现象（最好带日志里的关键几行，把 wxid 和昵称打码）
- 复现步骤
- 版本号（`/api/status` 里的 version）
- 你的环境：微信版本、Windows 版本、有没有装 Python

## 七、不要做的事

- 不要提交任何真实 API Key（提交了就撤回 + 立刻去平台重置 Key）
- 不要提交聊天记录、微信号、截图里的真实昵称
- 不要为了「能跑」去改测试断言或跳过测试
- 不要引入需要 `npm install` 的运行时依赖（这个项目刻意保持零依赖）
