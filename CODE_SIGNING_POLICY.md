# 代码签名策略（Code signing policy）

> Free code signing provided by [SignPath.io](https://about.signpath.io),
> certificate by [SignPath Foundation](https://signpath.org).

本文件说明鲸鲸（whale_gril）的 Windows 发行包是怎么签名的、谁有权批准、怎么验证。
对应的流水线在 [`.github/workflows/installer.yml`](.github/workflows/installer.yml)。

## 签哪些文件

| 产物 | 说明 |
| --- | --- |
| `WhaleLauncher.exe` | WPF 启动器（`launcher/`），也是安装包里的那个 |
| `whale-girl-<版本>-setup.exe` | Inno Setup 安装包 |

两个文件都用 Authenticode（SHA-256 + RFC3161 时间戳）签名，签名由 SignPath.io 在
它的 HSM 里完成，私钥不在本仓库、也不在构建机磁盘上。

**签名顺序不能反**：启动器必须先签，再被 Inno 压进安装包；安装包本身最后签
（`installer/whale.iss` 里嵌的是 `launcher/publish/WhaleLauncher.exe`，
所以 CI 第一步签完会把它回填过去再编包）。

## 什么时候签

- 只有**发行构建**才会请求签名：
  - 打 `v*` tag 触发时用签名策略 `release-signing`（该策略在 SignPath 后台配成**人工审批**：
    每个签名请求都要项目批准人点一下）
  - 手动 `workflow_dispatch` 触发时同上
  - 其它分支的构建（`test/**`）用 `test-signing`，签出来只作为 Artifact 留着验证，
    不会建 Release
- 每个签名请求都由 SignPath 侧校验来源：产物必须来自本仓库的 GitHub Actions
  工作流（origin verification），本机编的 exe 拿不到签名
- 配了 `SIGNING_MODE` 却签不上时，流水线会直接失败，不会把未签名包当成品发出去

## 谁可以签（团队角色）

这个项目目前是单人维护，角色对应关系如下：

| 角色 | 成员 | 职责 |
| --- | --- | --- |
| Authors（可以不经评审直接改代码） | [@Banan1cee](https://github.com/Banan1cee) | 改代码、提交 |
| Reviewers（评审别人的改动） | [@Banan1cee](https://github.com/Banan1cee) | 外部 PR 必须由维护者评审后合并 |
| Approvers（批准签名） | [@Banan1cee](https://github.com/Banan1cee) | 在 SignPath 里逐次批准发行签名 |

协作改动请走 Pull Request；`main` 的每次发版都由 Approver 在 SignPath 后台确认后才会签名。
贡献者名单见 [GitHub contributors](https://github.com/Banan1cee/whale_gril/graphs/contributors)。

## 隐私声明（privacy policy）

**本程序不会把它收集到的数据发给用户没有指定的系统。**

- 聊天内容、人设、记忆、联系人缓存都在本机 `data/` 目录里，卸载时默认保留
- 需要模型回复时，聊天内容会发往**用户自己配置的模型接口**（`config.json` 里的
  `baseUrl` / `apiKey`，例如 DeepSeek、阿里云百炼等；第三方服务的隐私政策由各自提供）
- 开启语音识别时，别人发来的语音（转成 wav）会发往用户配置的语音接口（默认阿里云百炼的
  `qwen3-asr-flash`）；开启看图时，图片会发往用户配置的视觉接口
- 联网搜索功能会把检索词发往搜索服务（B站 / 微博 / 头条等公开接口）
- 没有遥测、没有自动上报、不往维护者的服务器发任何数据
- 程序监听 `127.0.0.1:8787`，只对本机开放，没有登录鉴权，**不要暴露到公网**

## 怎么验证签名

```powershell
# 1) 看签名状态和证书主体：应为 Valid，签发者 SignPath Foundation
Get-AuthenticodeSignature .\whale-girl-4.0.0-setup.exe |
    Format-List Status, StatusMessage, SignerCertificate

# 2) 对照 Release 里挂的 SHA256SUMS.txt
Get-FileHash .\whale-girl-4.0.0-setup.exe -Algorithm SHA256
```

也可以右键 exe →「属性」→「数字签名」看签名者和时间戳。

签名有效只说明「这个二进制确实是由本仓库的 GitHub Actions 构建的」；它不保证
你从非官方渠道下载到的文件是同一个——请以 GitHub Releases 页面上的
`SHA256SUMS.txt` 为准。

## 构建可复现性说明

- 流水线只跑在本仓库的 GitHub-hosted runner 上
- 启动器由 `dotnet publish` 从 `launcher/` 源码编译（`Deterministic=true`，不带 PDB）
- 安装包由仓库自带的 Inno Setup 7.1.1（`tools/innosetup/`）编译，版本号从 tag / `package.json` 取
- 签名前后的校验值都写在运行摘要里
