<#
  把 .NET 10 桌面运行时安装包下到 runtime\dotnet\（打包前跑一次）。

  为什么单独一个脚本：
    - runtime\ 在 .gitignore 里，60MB 的安装包不该进 git；
    - 但 build-release.ps1 打「完整包」时会把 runtime\ 整个带进去，
      用户拿到包就能离线装运行时，不用再联网。

  用法：powershell -NoProfile -ExecutionPolicy Bypass -File scripts\fetch-dotnet-runtime.ps1
        加 -Force 重新下载（默认已存在且签名有效就跳过）
#>
param(
    [string]$Major = '10',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent
$Dir = Join-Path $RepoRoot 'runtime\dotnet'
$Target = Join-Path $Dir "windowsdesktop-runtime-$Major-win-x64.exe"
$Url = "https://aka.ms/dotnet/$Major.0/windowsdesktop-runtime-win-x64.exe"

function Test-GoodInstaller([string]$path) {
    if (-not (Test-Path $path)) { return $false }
    $sig = Get-AuthenticodeSignature $path
    if ($sig.Status -ne 'Valid') { return $false }
    if ($sig.SignerCertificate.Subject -notmatch 'Microsoft') { return $false }
    return (Get-Item $path).Length -gt 10MB
}

New-Item -ItemType Directory $Dir -Force | Out-Null

if (-not $Force -and (Test-GoodInstaller $Target)) {
    $mb = [math]::Round((Get-Item $Target).Length / 1MB, 1)
    Write-Host "已存在且签名有效（${mb} MB）：$Target" -ForegroundColor Green
    exit 0
}

Write-Host "正在下载 .NET $Major 桌面运行时（约 60MB）..." -ForegroundColor Cyan
# 重试 3 次：aka.ms 是 302，CI 上偶尔会在跳转那一步断；下到一半的文件按大小判掉重来
$ok = $false
for ($i = 1; $i -le 3; $i++) {
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Target -UseBasicParsing
        $ok = $true
        break
    } catch {
        Write-Host "  第 $i 次下载失败：$($_.Exception.Message)" -ForegroundColor Yellow
        Remove-Item $Target -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }
}
if (-not $ok) {
    Write-Host "下载失败。手动下载后放到：$Target" -ForegroundColor Red
    Write-Host "  $Url" -ForegroundColor Red
    exit 1
}

if (-not (Test-GoodInstaller $Target)) {
    Write-Host "下载到的文件签名校验没通过，删掉重试或手动下载：" -ForegroundColor Red
    Write-Host "  $Url" -ForegroundColor Red
    Remove-Item $Target -Force -ErrorAction SilentlyContinue
    exit 1
}

$mb = [math]::Round((Get-Item $Target).Length / 1MB, 1)
Write-Host "完成（${mb} MB）：$Target" -ForegroundColor Green
Write-Host "打包时 build-release.ps1 会把 runtime\ 带进「完整包」。" -ForegroundColor Gray
