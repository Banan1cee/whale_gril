# vendored wechatauto（上游 PyPI 包 wechatauto-replica 1.2.9）

这个目录是**上游源码树的原样副本**，不是本项目写的代码。

## 上游与版本

- 包名：`wechatauto-replica`
- 版本：`1.2.9`
- 来源：PyPI（wheel 名 `wechatauto_replica-1.2.9-py3-none-any.whl`）
- 落库日期：2026-11-05
- 内容：`wechatauto/` 是包本体（71 个 `.py` + 3 个 `.png` + `py.typed`），
  `wechatauto/dist-info/` 是从 wheel 里带出来的 `dist-info`（METADATA / WHEEL / RECORD /
  entry_points.txt / top_level.txt / licenses/LICENSE），用于许可证合规与来源追溯。

## 为什么固定

1. **正确性**：`scripts/prepare-sticker-runtime.py` 要在构建期直接改这个包的内部实现
   （`uia_driver.py` 的 `_search_button`、`accessibility.py` 的进程/模块探测）。
   它按源码结构做替换，布局一变就 `raise RuntimeError('unknown ... layout')` 停住。
   上游一改动，构建就会在不可预期的地方炸，固定版本才能让构建结果可复现。
2. **可离线**：`runtime/` 被 `.gitignore` 忽略，仓库里不带运行时；以前换台机器必须联网
   从 PyPI 拉这个包，断网或镜像挂掉就建不出来。源码入库后，构建只需装 psutil / pywin32 /
   requests 等通用依赖。
3. **可审计**：源码进 Git，任何一次内容变化都能 diff 出来，而不是靠 wheel 哈希事后追。

## 规矩

- **不许手改这个目录里的任何一行**。包括“顺手修个 bug”“加一行日志”“改个默认值”。
- 需要在构建期调整行为时，改 `scripts/prepare-sticker-runtime.py`：在脚本里写清楚改什么、
  为什么改、匹配不到预期结构时怎么失败（它现在就是 `raise`，别降级成猜）。
- 运行期如果需要改，同样走配置或 `bridge/` 里的适配层，不动 vendored 源码。

## 校验

`MANIFEST.sha256` 每行 `<sha256>  <相对路径>`，路径相对于本目录（`vendor/`），
覆盖 `vendor/wechatauto` 下所有文件。`scripts/build-runtime.ps1` 在复制进 runtime 之前
会逐文件核对：**任何文件哈希对不上、多一个或少一个都 fail**，并提示
「vendor/wechatauto 被手改过，请还原」。`tests/vendor-wechatauto.test.js` 也会在 CI 里跑同一组校验。

改完 vendored 文件后必须重新生成：

```powershell
# 在仓库根目录执行（PowerShell）
$root = 'vendor'
$lines = Get-ChildItem "$root\wechatauto" -Recurse -File |
  Sort-Object FullName |
  ForEach-Object {
    $rel = $_.FullName.Substring((Resolve-Path $root).Path.Length + 1).Replace('\', '/')
    (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() + '  ' + $rel
  }
[IO.File]::WriteAllLines("$root\MANIFEST.sha256", $lines, (New-Object Text.UTF8Encoding $false))
```

## 以后怎么升级

1. `python -m pip download wechatauto-replica==<新版本> -d 临时目录`（wheel 即可，不要装进系统环境）。
2. 解压 wheel，整棵替换 `vendor/wechatauto`（`dist-info` 一起换，改目录名为 `dist-info`）。
3. 重新生成 `MANIFEST.sha256`（上面那段命令）。
4. 跑 `scripts/build-runtime.ps1` 与 `scripts/prepare-sticker-runtime.py`：
   如果它 `raise`「unknown ... layout」，说明上游改了内部结构 —— 先看 diff 再决定补丁怎么改，
   **不许猜**。
5. 断网全量构建一次（或用不可达的 `-Mirror` 验证不依赖索引），再真机发一条消息确认。
