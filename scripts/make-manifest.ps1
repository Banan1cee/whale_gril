<#
生成 release-manifest.json —— 启动器启动时读它，决定「提不提示 / 强不强制 / 让不让启动」。

用法：
  pwsh -NoProfile -File scripts/make-manifest.ps1 -Version 4.0.1
  pwsh -NoProfile -File scripts/make-manifest.ps1 -Version 4.0.1 -Force -Fresh

它会：
  1. 以仓库根目录现有的 release-manifest.json 当「策略模板」，原样保留你手填的
     force_after_hours / force / kill_below / channel / message；
  2. 覆盖 latest / released_at / manifest_version（序号 +1，客户端靠它拒绝旧响应）；
  3. 写回同一个文件（CI 里还会把它传成 Release 资产、commit 回 main）。

所以：
  · 「默认项」和「配置项」都在 release-manifest.json 里改，不要改这个脚本；
  · 只有 latest / released_at / manifest_version 是发版时自动算的，别手改。
#>
param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$OutFile = 'release-manifest.json',
    [string]$Message = '',
    [switch]$Fresh
)

$ErrorActionPreference = 'Stop'

# 归一化成三段式（4.0 -> 4.0.0）
$v = "$Version".Trim() -replace '^[vV]', ''
if ($v -match '^\d+\.\d+$') { $v = "$v.0" }
if ($v -notmatch '^\d+\.\d+\.\d+$') { throw "版本号不合法：$Version（要 x.y.z）" }

# 第一次生成用的默认策略。之后一律以现有文件为准，这里的值不会再覆盖你的修改。
$policy = [ordered]@{
    latest            = $v
    released_at       = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
    force_after_hours = 12
    force             = $null      # null=按时间闸 / true=立即强制 / false=只提示
    kill_below        = $null      # 填版本号 = 低于它的直接不许启动
    message           = ''
    manifest_version  = 1
    channel           = 'stable'
}

$oldVer = 0
$oldMessage = ''
$oldLatest = ''
if (-not $Fresh -and (Test-Path -LiteralPath $OutFile)) {
    try {
        $old = Get-Content -LiteralPath $OutFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $names = @($old.PSObject.Properties.Name)
        if ($names -contains 'force_after_hours') { $policy.force_after_hours = [int]$old.force_after_hours }
        if ($names -contains 'force') { $policy.force = $old.force }
        if ($names -contains 'kill_below') { $policy.kill_below = $old.kill_below }
        if ($names -contains 'channel') { $policy.channel = [string]$old.channel }
        if ($names -contains 'latest') { $oldLatest = [string]$old.latest }
        if ($names -contains 'message') { $oldMessage = [string]$old.message }
        if ($names -contains 'manifest_version') { $oldVer = [int]$old.manifest_version }
    } catch {
        Write-Warning "现有的 $OutFile 解析不了，按默认策略重新生成：$($_.Exception.Message)"
    }
}
$policy.manifest_version = $oldVer + 1

# message 优先级：命令行 -Message > 手写文案 > 自动跟随版本。
# 判据：上一版 message 是不是当初自动生成的（「更新到 v<上一版」），是就当作自动值刷新掉。
$autoMessage = ($oldMessage -eq "更新到 v$oldLatest")
$policy.message = if ($Message) { $Message }
    elseif ($oldMessage -and -not $autoMessage) { $oldMessage }
    else { "更新到 v$v" }

$json = $policy | ConvertTo-Json -Depth 6
$full = [IO.Path]::GetFullPath($OutFile)
# JSON 用无 BOM 的 UTF-8：System.Text.Json 读带 BOM 的流会直接抛异常
[IO.File]::WriteAllText($full, $json + "`n", (New-Object Text.UTF8Encoding($false)))

Write-Host "已生成 $full"
Write-Host ("  最新版本   $v")
Write-Host ("  发布时间   $($policy.released_at)")
Write-Host ("  时间闸     $($policy.force_after_hours) 小时")
$forceText = if ($null -eq $policy.force) { 'null（到点自动强制）' } else { "$($policy.force)" }
Write-Host ("  force      $forceText")
$killText = if ($null -eq $policy.kill_below) { 'null（不熔断）' } else { "$($policy.kill_below)" }
Write-Host ("  kill_below $killText")
Write-Host ("  序号       $($policy.manifest_version)")
