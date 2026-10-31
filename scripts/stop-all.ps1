# 鲸鲸 · 一键终止所有
# 停掉：服务（8787）、微信桥接、桥接守护循环、启动器窗口，并写 data\PAUSED 防止被自动拉起
# 用法：双击 一键终止.bat，或 powershell -File scripts\stop-all.ps1
param(
  [switch]$Quiet,
  [string]$AppRoot = ''
)

$ErrorActionPreference = 'Continue'

$root = if ($AppRoot) { [IO.Path]::GetFullPath($AppRoot) } else { Split-Path -Parent $PSScriptRoot }
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root
$dataDir = Join-Path $root 'data'

function Say($msg, $color = 'Gray') {
  if (-not $Quiet) { Write-Host $msg -ForegroundColor $color }
}

Say ''
Say '  ==========================================' 'Cyan'
Say '    正在终止鲸鲸的所有进程' 'Cyan'
Say '  ==========================================' 'Cyan'
Say ''

# 1) 先立暂停标记：bridge_loop.bat 看到它就乖乖等着，不会 3 秒后把桥接拉起来
try {
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $dataDir 'PAUSED') -Value ([string](Get-Date -Format 'o')) -Encoding UTF8
  Say '  · 已写入 data\PAUSED（防止自动重启）'
} catch {
  Say ('  ! 写 PAUSED 失败：' + $_.Exception.Message) 'Yellow'
}

$patterns = @(
  @{ Match = 'wechatauto_bridge.py'; Label = '微信桥接' },
  @{ Match = 'bridge_loop.bat';      Label = '桥接守护循环' },
  @{ Match = '启动微信桥接.bat';      Label = '桥接启动窗口' },
  @{ Match = '启动鲸鱼娘.bat';        Label = '服务启动窗口' },
  @{ Match = 'server.js';            Label = '鲸鲸服务' }
)

function Find-Targets {
  $found = @()
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue
  foreach ($p in $patterns) {
    foreach ($proc in $procs) {
      if (-not $proc.CommandLine) { continue }
      if ($proc.ProcessId -eq $PID) { continue }
      if ($proc.CommandLine -notlike ('*' + $p.Match + '*')) { continue }
      # 必须属于本项目，避免误伤同名的别的 node / python
      if ($proc.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
      # 别碰 DeepSeek Harness 自己的子进程，只杀真正跑 server.js 的那个
      if ($proc.Name -eq 'DSH Desktop.exe' -and $p.Match -ne 'server.js') { continue }
      $found += [pscustomobject]@{ Pid = $proc.ProcessId; Label = $p.Label }
    }
  }
  return $found
}

# 停止前先保存当前记忆；失败时保留服务，避免强杀丢掉尚未写盘的数据。
$port = 8787
try {
  $value = [int](Get-Content -LiteralPath (Join-Path $dataDir 'server-port.txt') -Raw -ErrorAction Stop)
  if ($value -gt 0 -and $value -lt 65536) { $port = $value }
} catch { }
$serviceIds = @((Find-Targets | Where-Object { $_.Label -eq '鲸鲸服务' }).Pid)
if ($serviceIds.Count -gt 0) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 3 -ErrorAction Stop
    if ($health.service -ne 'whale-girl' -or $serviceIds -notcontains $health.pid) { throw '无法确认本目录的内核身份' }
    $settings = Get-Content -LiteralPath (Join-Path $root 'config.json') -Encoding UTF8 -Raw -ErrorAction Stop | ConvertFrom-Json
    $token = if ($null -ne $settings.gateway.wechat.inboundToken) { [string]$settings.gateway.wechat.inboundToken } else { 'change-me-wechat' }
    $headers = @{}
    if ($token) { $headers['x-bot-token'] = $token }
    $saved = Invoke-RestMethod -Headers $headers -Uri "http://127.0.0.1:$port/api/runtime/prepare-stop" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 -ErrorAction Stop
    if (-not $saved.ok) { throw '记忆保存失败' }
    Say '  · 最新记忆已保存并备份'
  } catch {
    Say ('  保存未完成，已取消终止，服务保留运行：' + $_.Exception.Message) 'Yellow'
    exit 1
  }
}

# 2) 多轮清扫：杀父进程的时候可能正好有子进程在启动，多扫两遍才干净
$killed = New-Object System.Collections.ArrayList
for ($pass = 1; $pass -le 3; $pass++) {
  $targets = @(Find-Targets | Sort-Object Pid -Unique)
  if ($targets.Count -eq 0) { break }
  foreach ($t in $targets) {
    if ($t.Pid -eq $PID) { continue }
    $null = & taskkill.exe /PID $t.Pid /T /F 2>&1
    if ($LASTEXITCODE -eq 0) {
      [void]$killed.Add(('{0} pid {1}' -f $t.Label, $t.Pid))
      Say ('  · 已停止 ' + $t.Label + ' pid ' + $t.Pid)
    }
  }
  Start-Sleep -Milliseconds 700
}

# 3) 兜底：还在监听 8787 的，按端口再杀一次
Start-Sleep -Milliseconds 300
$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($procId in @($listener)) {
  if (-not $procId -or $procId -eq $PID) { continue }
  $owned = @((Find-Targets).Pid)
  if ($owned -notcontains $procId) { Say ('  跳过其它程序占用的端口，pid ' + $procId) 'Yellow'; continue }
  $null = & taskkill.exe /PID $procId /T /F 2>&1
  if ($LASTEXITCODE -eq 0) {
    [void]$killed.Add(('8787 端口 pid {0}' -f $procId))
    Say ('  · 已停止占用 8787 的进程 pid ' + $procId)
  }
}

# 4) 确认结果
Start-Sleep -Milliseconds 700
$left = @(Find-Targets | Sort-Object Pid -Unique)
$portLeft = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count

Say ''
if ($left.Count -eq 0 -and $portLeft -eq 0) {
  if ($killed.Count -eq 0) {
    Say '  没有在跑的东西，已经是停着的状态。' 'Green'
  } else {
    Say ('  已全部终止，共 ' + $killed.Count + ' 个进程。') 'Green'
  }
} else {
  Say '  还有没停干净的：' 'Yellow'
  foreach ($x in $left) { Say ('    - ' + $x.Label + ' pid ' + $x.Pid) 'Yellow' }
  if ($portLeft -gt 0) { Say '    - 8787 端口还在监听' 'Yellow' }
  Say '  再运行一次这个脚本，或者用任务管理器结束。' 'Yellow'
}
Say ''
Say '  恢复方法：双击「启动鲸鱼娘.bat」，再双击「启动微信桥接.bat」'
Say '  （桥接启动时会自动清掉 data\PAUSED）'
Say ''
