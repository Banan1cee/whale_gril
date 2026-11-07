# 代码签名策略（Code signing policy）

> Free code signing provided by [SignPath.io](https://about.signpath.io),
> certificate by [SignPath Foundation](https://signpath.org).

本文件说明鲸鲸（whale_girl）的 Windows 发行包是怎么签名的、谁有权批准、怎么验证。
对应的流水线在 [`.github/workflows/installer.yml`](.github/workflows/installer.yml)。

> **许可提示：** 本项目自 4.0.x 起采用 **AGPL-3.0-only**（OSI 认可的开源许可证）。
> SignPath Foundation 的免费 OSS 签名要求 OSI 认可的许可证；AGPL-3.0 符合这一前提，
> 但仍需满足公开仓库、GitHub-hosted runner 和可复现构建等其它条件。

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
贡献者名单见 [GitHub contributors](https://github.com/Banan1cee/whale_girl/graphs/contributors)。

## 隐私政策（privacy policy）

本项目的完整隐私政策只有一份，位于仓库根目录：

- [PRIVACY.md](../PRIVACY.md)

这里不再重复政策正文，避免多处内容不一致。

## 怎么验证签名

```powershell
# 1) 看签名状态和证书主体：应为 Valid，签发者 SignPath Foundation
Get-AuthenticodeSignature .\whale-girl-4.0.7-setup.exe |
    Format-List Status, StatusMessage, SignerCertificate

# 2) 对照 Release 里挂的 SHA256SUMS.txt
Get-FileHash .\whale-girl-4.0.7-setup.exe -Algorithm SHA256
```

也可以右键 exe →「属性」→「数字签名」看签名者和时间戳。

签名有效只说明「这个二进制确实是由本仓库的 GitHub Actions 构建的」；它不保证
你从非官方渠道下载到的文件是同一个——请以 GitHub Releases 页面上的
`SHA256SUMS.txt` 为准。

## 构建可复现性说明

- 流水线只跑在本仓库的 GitHub-hosted runner 上
- 启动器由 `dotnet publish` 从 `launcher/` 源码编译（`Deterministic=true`，不带 PDB）
- 安装包由仓库自带的 Inno Setup 7.1.1（`installer/innosetup/`）编译，版本号从 tag / `package.json` 取
- 签名前后的校验值都写在运行摘要里
