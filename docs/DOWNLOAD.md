# 下载鲸鲸（Download）

## 官方下载

**唯一官方渠道：[GitHub Releases](https://github.com/Banan1cee/whale_gril/releases)**

| 文件 | 说明 |
| --- | --- |
| `whale-girl-<版本>-setup.exe` | Windows 安装包（内置 Node + CPython 3.12，用户端零网络依赖） |
| `SHA256SUMS.txt` | 安装包的 SHA-256 校验值 |

## 代码签名

Windows 发行包使用 **SignPath Foundation** 提供的免费代码签名：

> Free code signing provided by [SignPath.io](https://about.signpath.io),
> certificate by [SignPath Foundation](https://signpath.org).

- 签名的文件：`WhaleLauncher.exe`（启动器）与 `whale-girl-<版本>-setup.exe`（安装包）
- 只有由本仓库 GitHub Actions 构建出来的产物才会被签名（每个发版都人工批准一次）
- 完整的签名策略见 [docs/CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)；
  隐私声明见 [docs/PRIVACY.md](PRIVACY.md)

### 验证签名

```powershell
Get-AuthenticodeSignature .\whale-girl-4.0.0-setup.exe |
    Format-List Status, SignerCertificate
Get-FileHash .\whale-girl-4.0.0-setup.exe -Algorithm SHA256   # 对照 SHA256SUMS.txt
```

## 其它安装方式

想自己跑源码（macOS / Linux / 想改代码）见 README 的「快速开始（源码版）」，
需要 Node.js 18+。
