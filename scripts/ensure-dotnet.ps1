<#
  确保 .NET 10 桌面运行时可用。启动器（WhaleLauncher.exe）是框架依赖的，
  用户机器没有这个运行时，双击只会看到 Windows 的英文报错。

  查找顺序：
    1. 随包的便携运行时 ..\.dotnet10（发行包带了就用，不碰系统、不联网）
    2. 系统里已装的 Microsoft.WindowsDesktop.App 10.*
    3. 都没有 → 用 runtime\dotnet\ 下随包的安装包装上
    4. 随包安装包也没有 → winget → 官方下载

  退出码：0 = 可用（含刚装好），1 = 不可用
#>
param(
    [switch]$Auto,          # 不询问，直接装（bat 里首次运行也走这个）
    [switch]$DryRun,        # 只打印将要做什么，不真装（排查用）
    [string]$Major = '10'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent
$WingetId = "Microsoft.DotNet.DesktopRuntime.$Major"
$DirectUrl = "https://aka.ms/dotnet/$Major.0/windowsdesktop-runtime-win-x64.exe"

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal $id).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-Runtime([string]$major) {
    # 只认 x.y.z 这种纯版本号目录：10.0.10.bak 之类不能算数
    $pattern = '^' + [regex]::Escape($major) + '\.\d+\.\d+$'
    # 只查 x64 位置：whale 启动器是 x64 程序，Program Files (x86) 下那份
    # 32 位运行时它用不上，算进“已安装”会导致检测误判、启动器仍然打不开。
    $roots = @(
        (Join-Path $env:ProgramFiles 'dotnet\shared\Microsoft.WindowsDesktop.App'),
        (Join-Path $env:LOCALAPPDATA 'Microsoft\dotnet\shared\Microsoft.WindowsDesktop.App')
    )
    foreach ($root in $roots) {
        if ([string]::IsNullOrEmpty($root) -or -not (Test-Path $root)) { continue }
        $hit = Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
               Where-Object { $_.Name -match $pattern }
        if ($hit) { return $hit[0].Name }
    }
    return $null
}

function Find-Portable([string]$major) {
    # bat 的约定：仓库根上一级的 .dotnet10 是一个完整的便携运行时
    $portableRoot = Join-Path (Split-Path $RepoRoot -Parent) '.dotnet10'
    $hostExe = Join-Path $portableRoot 'dotnet.exe'
    if (-not (Test-Path $hostExe)) { return $null }
    $rtDir = Join-Path $portableRoot 'shared\Microsoft.WindowsDesktop.App'
    if (-not (Test-Path $rtDir)) { return $null }
    # 只认 x.y.z 这种纯版本号目录：10.0.10.bak 之类不能算数
    $pattern = '^' + [regex]::Escape($major) + '\.\d+\.\d+$'
    $hit = Get-ChildItem $rtDir -Directory -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -match $pattern }
    if ($hit) { return $portableRoot }
    return $null
}

function Find-LocalInstaller {
    # 随包携带的安装包（runtime\dotnet\windowsdesktop-runtime-*-win-x64.exe）
    $dir = Join-Path $RepoRoot 'runtime\dotnet'
    if (-not (Test-Path $dir)) { return $null }
    $hit = Get-ChildItem $dir -Filter 'windowsdesktop-runtime-*-win-x64.exe' -ErrorAction SilentlyContinue |
           Sort-Object Name -Descending | Select-Object -First 1
    if ($hit) { return $hit.FullName }
    return $null
}

function Install-Local([string]$path) {
    Write-Host "正在安装随包的运行时：$(Split-Path $path -Leaf)" -ForegroundColor Cyan
    $p = Start-Process -FilePath $path -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
    # 3010 = 成功但需要重启
    return ($p.ExitCode -eq 0 -or $p.ExitCode -eq 3010)
}

function Install-Winget {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { return $false }
    Write-Host "正在用 winget 安装 .NET $Major 桌面运行时（约 60MB）..." -ForegroundColor Cyan
    & winget install --id $WingetId -e --silent --accept-source-agreements --accept-package-agreements
    return ($LASTEXITCODE -eq 0)
}

function Install-Download {
    $tmp = Join-Path $env:TEMP "windowsdesktop-runtime-$Major-win-x64.exe"
    Write-Host "正在下载官方安装包..." -ForegroundColor Cyan
    try {
        Invoke-WebRequest -Uri $DirectUrl -OutFile $tmp -UseBasicParsing
    } catch {
        Write-Host "下载失败：$($_.Exception.Message)" -ForegroundColor Red
        return $false
    }
    $ok = Install-Local $tmp
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    return $ok
}

# ── 主流程 ─────────────────────────────────────────────

$portable = Find-Portable $Major
if ($portable) {
    Write-Host "使用随包的 .NET $Major 运行时：$portable" -ForegroundColor Green
    exit 0
}

$ver = Find-Runtime $Major
if ($ver) {
    Write-Host "已检测到 .NET $Major 桌面运行时 $ver" -ForegroundColor Green
    exit 0
}

$local = Find-LocalInstaller
Write-Host ""
Write-Host "缺少 .NET $Major 桌面运行时，启动器打不开。" -ForegroundColor Yellow
if ($local) {
    Write-Host "安装包已在本地：$(Split-Path $local -Leaf)（约 60MB，只需装一次）" -ForegroundColor Yellow
} else {
    Write-Host "需要下载安装（约 60MB，只需一次）。" -ForegroundColor Yellow
}
Write-Host ""

if ($DryRun) {
    Write-Host "[DryRun] 将执行：$(if ($local) { "本地安装 $local" } else { 'winget 或官方下载' })" -ForegroundColor Magenta
    exit 1
}

if (-not $Auto) {
    $ans = Read-Host "现在安装吗？[Y/n]"
    if ($ans -and $ans -notmatch '^[Yy]') {
        Write-Host "已取消。手动下载：$DirectUrl" -ForegroundColor Yellow
        exit 1
    }
}

if (-not (Test-Admin)) {
    Write-Host "安装需要管理员权限，正在提权（会再弹一次 UAC）..." -ForegroundColor Cyan
    $argLine = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Auto -Major $Major"
    Start-Process powershell -Verb RunAs -ArgumentList $argLine -Wait
    # 子进程装完，这里重新检测
    if (Find-Runtime $Major) { exit 0 }
    Write-Host "提权后仍未检测到运行时，请重启电脑后再试。" -ForegroundColor Red
    exit 1
}

$ok = $false
if ($local) {
    $ok = Install-Local $local
} else {
    $ok = Install-Winget
    if (-not $ok) { $ok = Install-Download }
}

if ($ok -and (Find-Runtime $Major)) {
    Write-Host ".NET $Major 桌面运行时已装好。" -ForegroundColor Green
    exit 0
}

Write-Host ""
Write-Host "自动安装没成功。请手动下载安装：" -ForegroundColor Red
Write-Host "  $DirectUrl" -ForegroundColor Red
try { Start-Process $DirectUrl } catch { }
exit 1
