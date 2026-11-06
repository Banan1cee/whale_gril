# 下载鲸鲸（Download）

## 官方下载

**唯一官方渠道：[GitHub Releases](https://github.com/Banan1cee/whale_girl/releases)**

| 文件 | 说明 |
| --- | --- |
| `whale-girl-<版本>-setup.exe` | Windows 安装包（内置 Node + CPython 3.12，用户端零网络依赖） |
| `SHA256SUMS.txt` | 安装包的 SHA-256 校验值 |

## 代码签名

当前发行包**尚未签名**，Windows 会提示「未知发布者」。签名申请与策略见 [docs/CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)。

### 校验下载

```powershell
Get-FileHash .\whale-girl-4.0.0-setup.exe -Algorithm SHA256   # 对照 SHA256SUMS.txt
```

## 其它安装方式

想自己跑源码（macOS / Linux / 想改代码）见 README 的「快速开始（源码版）」，
需要 Node.js 18+。
