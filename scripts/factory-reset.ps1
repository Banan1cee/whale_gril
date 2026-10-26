<#
鲸鲸 · 恢复出厂（真正的「格式化」）

它会做这些事（顺序很重要）：
  1. 停掉所有进程（服务 / 桥接 / 守护 / 热键）
  2. 把 data\ 和 config.json 备份到 backup\reset-时间戳\（万一还想找回 Key / 聊天记录）
  3. 删掉：data\（聊天记忆、API Key、人设调教、PAUSED、媒体缓存）、config.json（主人名单 / 令牌 / 各项设置）、
     wechatauto_db\、wechatauto_logs\、debug.log
  4. 用 config.example.json 重建 config.json —— 跟刚解压时一模一样
  5. 重新启动服务 + 桥接（-NoStart 可跳过）

注意：这不是「重启」，是**真的清空**。API Key、主人名单、聊天记忆、人设都会没。
可以先备份里捞回来：backup\reset-时间戳\

用法：
  双击 重置全部.bat
  powershell -File scripts\factory-reset.ps1            # 交互确认
  powershell -File scripts\factory-reset.ps1 -Yes -NoStart   # 免确认、不重启（自检/测试用）
#>
param(
  [switch]$Yes,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
Set-Location $root

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

Say ''
Say '  ============================================================' 'Cyan'
Say '    重置鲸鲸 —— 恢复出厂（会清空所有设置和记忆）' 'Cyan'
Say '  ============================================================' 'Cyan'
Say ''
Say '  会删除：' 'Yellow'
Say '    · data\            聊天记忆、API Key、人设调教、PAUSED、图片缓存' 'Yellow'
Say '    · config.json      主人名单、网关令牌、各项设置' 'Yellow'
Say '    · wechatauto_db\   微信数据库快照' 'Yellow'
Say '    · wechatauto_logs\ 桥接日志' 'Yellow'
Say ''
Say '  会保留：程序本体（src / web / runtime / examples ...），以及一份自动备份' 'Gray'
Say ''

if (-not $Yes) {
  $ans = Read-Host '确认要格式化吗？输入 RESET 继续（其它任意键取消）'
  if ($ans -ne 'RESET') {
    Say ''
    Say '  已取消，什么都没动。' 'Green'
    exit 1
  }
}

# ---------- 1) 停掉所有进程 ----------
Say ''
Say '[1/5] 停止服务与桥接…' 'Cyan'
$stopAll = Join-Path $PSScriptRoot 'stop-all.ps1'
if (Test-Path $stopAll) {
  & powershell -NoProfile -ExecutionPolicy Bypass -File $stopAll -Quiet | Out-Null
} else {
  Say '  ! 找不到 scripts\stop-all.ps1，按端口兜底杀一次' 'Yellow'
  foreach ($procId in @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)) {
    if ($procId) { $null = & taskkill.exe /PID $procId /T /F 2>&1 }
  }
}
Start-Sleep -Seconds 1

# ---------- 2) 备份 ----------
Say ''
Say '[2/5] 备份现有数据…' 'Cyan'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupDir = Join-Path $root ('backup\reset-' + $stamp)
$backedUp = @()
New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
foreach ($rel in @('data', 'config.json')) {
  $src = Join-Path $root $rel
  if (-not (Test-Path $src)) { continue }
  try {
    Copy-Item -LiteralPath $src -Destination (Join-Path $backupDir $rel) -Recurse -Force
    $backedUp += $rel
  } catch {
    Say ('  ! 备份 ' + $rel + ' 失败：' + $_.Exception.Message) 'Yellow'
  }
}
if ($backedUp.Count) {
  Say ('  已备份：' + ($backedUp -join '、')) 'Green'
  Say ('  位置：' + $backupDir) 'Gray'
} else {
  Say '  没有需要备份的东西（已经是干净的）' 'Gray'
  Remove-Item -LiteralPath $backupDir -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------- 3) 清空 ----------
Say ''
Say '[3/5] 清空所有设置与记忆…' 'Cyan'
$targets = @('data', 'config.json', 'wechatauto_db', 'wechatauto_logs', 'debug.log')
foreach ($rel in $targets) {
  $p = Join-Path $root $rel
  if (-not (Test-Path $p)) { continue }
  try {
    Remove-Item -LiteralPath $p -Recurse -Force
    Say ('  · 已删除 ' + $rel) 'Gray'
  } catch {
    Say ('  ! 删除 ' + $rel + ' 失败：' + $_.Exception.Message) 'Yellow'
  }
}
# 顺手清掉运行中可能留下的临时文件（不动代码备份 *.bak-*）
foreach ($pat in @('wechatauto_ocr_tmp.png', '*.tmp')) {
  Get-ChildItem -Path $root -Filter $pat -File -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
    Say ('  · 已删除 ' + $_.Name) 'Gray'
  }
}

# ---------- 4) 从示例配置重建 ----------
Say ''
Say '[4/5] 用出厂配置重建 config.json…' 'Cyan'
$example = Join-Path $root 'config.example.json'
$configPath = Join-Path $root 'config.json'
if (Test-Path $example) {
  Copy-Item -LiteralPath $example -Destination $configPath -Force
  Say '  · 已从 config.example.json 重建（主人名单为空、网关令牌为 change-me-*）' 'Green'
} else {
  Say '  ! 找不到 config.example.json，config.json 会在下次启动时自动生成' 'Yellow'
}
New-Item -ItemType Directory -Path (Join-Path $root 'data') -Force | Out-Null

# ---------- 5) 重启 ----------
Say ''
if ($NoStart) {
  Say '[5/5] 按 -NoStart 跳过启动' 'Cyan'
} else {
  Say '[5/5] 重新启动服务与桥接…' 'Cyan'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('powershell -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $PSScriptRoot 'start.ps1') + '"') -WorkingDirectory $root -WindowStyle Minimized
  Start-Sleep -Seconds 4
  $loop = Join-Path $PSScriptRoot 'bridge_loop.bat'
  if (Test-Path $loop) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $loop + '"') -WorkingDirectory $root -WindowStyle Minimized
  }
  Start-Sleep -Seconds 4
  $listen = @(Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue)
  if ($listen.Count) {
    Say '  · 服务已起来：http://127.0.0.1:8787' 'Green'
  } else {
    Say '  ! 服务好像没起来，双击「启动鲸鱼娘.bat」看看报错' 'Yellow'
  }
}

Say ''
Say '  ============================================================' 'Green'
Say '    已恢复出厂：和刚解压时一样' 'Green'
Say '    · 需要重新填 API Key（网页右上角「设置」）' 'Gray'
Say '    · 主人名单为空：去调试台 /debug 抄自己的 wxid 填回去' 'Gray'
Say '    · 旧数据在 backup\reset-… 里，需要可以捞' 'Gray'
Say '  ============================================================' 'Green'
Say ''
