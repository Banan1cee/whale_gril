# 鲸鲸 · 启动器
# 自动寻找可用的运行时：系统里的 Node.js → 本机 DeepSeek Harness 自带的 Electron 内核
# 用法：双击 启动鲸鱼娘.bat，或在命令行运行 scripts\start.ps1
param(
  [switch]$NoBrowser,
  [switch]$Check,
  [int]$Port = 0,
  [string]$NodeExe = ''
)

$ErrorActionPreference = 'Stop'
$env:TZ = 'Asia/Shanghai'
# 本机代理（Clash 等）没开时，残留的 HTTPS_PROXY 会让所有模型请求连到 127.0.0.1:7897 而失败。
# 模型接口和国内站点都不需要代理，启动前直接清掉，避免「明明有网却连不上模型」。
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
  if (Test-Path "env:$name") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}
$env:NO_PROXY = '127.0.0.1,localhost,::1'
$env:no_proxy = $env:NO_PROXY
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  chcp 65001 > $null 2>&1
} catch { }

$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

$candidates = New-Object System.Collections.ArrayList

# 0) 包里自带的 Node（最优先）
#    解压后 runtime\node.exe 就在，用户什么都不用装
$bundled = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $bundled)) { $bundled = Join-Path (Split-Path -Parent $PSScriptRoot) 'runtime\node.exe' }
if (Test-Path $bundled) {
  [void]$candidates.Add(@{ Path = $bundled; Electron = $false; From = '包内 runtime' })
}

# 1) 显式指定的运行时
if ($NodeExe -and (Test-Path $NodeExe)) {
  [void]$candidates.Add(@{ Path = (Resolve-Path $NodeExe).Path; Electron = $false; From = '参数 NODE_EXE' })
}
if ($env:NODE_EXE -and (Test-Path $env:NODE_EXE)) {
  [void]$candidates.Add(@{ Path = (Resolve-Path $env:NODE_EXE).Path; Electron = $false; From = '环境变量 NODE_EXE' })
}

# 2) PATH 里的 node
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  [void]$candidates.Add(@{ Path = $nodeCmd.Source; Electron = $false; From = 'PATH' })
}

# 3) 常见 Node.js 安装位置
foreach ($p in @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )) {
  if ($p -and (Test-Path $p)) {
    [void]$candidates.Add(@{ Path = $p; Electron = $false; From = '常见安装目录' })
  }
}

# 4) DeepSeek Harness 自带的 Electron 内核（没有装 Node 也能跑）
$dshCandidates = @()
$dshCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\DSH Desktop\DSH Desktop.exe')
$dshCandidates += (Join-Path $env:ProgramFiles 'DSH Desktop\DSH Desktop.exe')
$dshCandidates += (Join-Path $env:USERPROFILE 'DSH Desktop\DSH Desktop.exe')
if ($env:DSH_EXE) { $dshCandidates += $env:DSH_EXE }
# 本机路径（不进 git）：scripts\node-path.local 第一行写 exe 路径
$localNode = Join-Path $PSScriptRoot 'node-path.local'
if (Test-Path $localNode) {
  $line = (Get-Content $localNode -Encoding UTF8 | Select-Object -First 1)
  if ($line -and (Test-Path $line.Trim())) { $dshCandidates += $line.Trim() }
}
# 从卸载注册表里再找一次
try {
  $keys = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($k in $keys) {
    Get-ItemProperty $k -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -like '*DSH*' -and $_.InstallLocation } |
      ForEach-Object { $dshCandidates += (Join-Path $_.InstallLocation 'DSH Desktop.exe') }
  }
} catch { }

foreach ($dsh in $dshCandidates) {
  if ($dsh -and (Test-Path $dsh)) {
    [void]$candidates.Add(@{ Path = $dsh; Electron = $true; From = 'DeepSeek Harness' })
    break
  }
}

$pick = $null
foreach ($c in $candidates) {
  if (Test-Path $c.Path) { $pick = $c; break }
}

Write-Host ''
Write-Host '  🐋  鲸鲸 · DeepSeek 鲸鱼娘聊天机器人' -ForegroundColor Cyan
Write-Host '  ────────────────────────────────────────────'

if (-not $pick) {
  Write-Host '  ❌ 没找到可用的 Node.js 运行时。' -ForegroundColor Red
  Write-Host ''
  Write-Host '  正常情况下包里自带 runtime\node.exe，不需要你装任何东西。'
  Write-Host '  如果这个文件被删了或没解压出来，任选一个办法：'
  Write-Host '   A. 重新解压完整压缩包（runtime\node.exe 应该在）'
  Write-Host '   B. 安装 Node.js LTS：https://nodejs.org/zh-cn'
  Write-Host '   C. 装了 DeepSeek Harness 的话，指定它的路径：'
  Write-Host '      启动鲸鱼娘.bat -NodeExe "D:\...\DSH Desktop.exe"'
  Write-Host ''
  exit 1
}

Write-Host ("  运行时：     " + $pick.Path)
Write-Host ("  来源：       " + $pick.From)
if ($Check) {
  if (Test-Path (Join-Path $root 'server.js')) {
    Write-Host '  启动文件：   server.js ✅'
  } else {
    Write-Host '  启动文件：   server.js 缺失 ❌' -ForegroundColor Red
    exit 1
  }
  Write-Host ''
  Write-Host '  自检通过，可以启动了。'
  exit 0
}

$serverArgs = @((Join-Path $root 'server.js'))
if ($NoBrowser) { $serverArgs += '--no-browser' }
if ($Port -gt 0) { $serverArgs += "--port=$Port" }

Write-Host '  ────────────────────────────────────────────'
Write-Host '  正在浮上水面…（按 Ctrl+C 可以让鲸鲸潜回深海）'
Write-Host ''

try {
  if ($pick.Electron) {
    $env:ELECTRON_RUN_AS_NODE = '1'
    $errLog = Join-Path $root 'data\runtime-stderr.log'
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
    # Electron 内核会往 stderr 打一行无害的 crashpad 提示，重定向掉，保持控制台干净
    & $pick.Path @serverArgs 2>> $errLog
  } else {
    & $pick.Path @serverArgs
  }
} catch {
  Write-Host ''
  Write-Host ('启动失败：' + $_.Exception.Message) -ForegroundColor Red
  exit 1
}

$code = $LASTEXITCODE
if ($null -eq $code) { $code = 0 }
if ($code -ne 0) {
  Write-Host ''
  Write-Host ("服务异常退出（代码 " + $code + "）。") -ForegroundColor Yellow
  $errLog = Join-Path $root 'data\runtime-stderr.log'
  if (Test-Path $errLog) {
    Write-Host '最近的错误日志：' -ForegroundColor Yellow
    Get-Content $errLog -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -Last 12 | ForEach-Object { Write-Host ('  ' + $_) }
  }
}
exit $code
