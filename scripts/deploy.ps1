<#
把「开发目录」的代码同步到「运行目录」，并可选重启服务。

为什么需要它：手工 Copy-Item 会在目标里套出一层同名目录（web\web、src\src），
或者把 data\、config.json 一起覆盖 —— 这两件事都真实发生过，代价是配置和聊天记忆丢了。

它做的事：
  1. robocopy 只同步代码，**永不**覆盖 data\、config.json、runtime\、日志、图片
  2. 逐文件比对 MD5，确认关键文件真的过去了（不一致直接报错）
  3. -Restart 时按顺序重启 服务 + 桥接（带环境变量，和 .bat 里一致）

用法：
  powershell -File scripts\deploy.ps1                          # 同步到默认目标，不重启
  powershell -File scripts\deploy.ps1 -Target F:\whale-girl-3.0-full -Restart
#>
param(
  [string]$Target = 'F:\whale-girl-3.0-full',
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'
$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $Target)) { throw "目标目录不存在：$Target" }
if (-not (Test-Path (Join-Path $Target 'server.js'))) { throw "目标不像 whale-girl 目录（没有 server.js）：$Target" }

Write-Host "同步：$src  ->  $Target" -ForegroundColor Cyan

# 1) 只同步代码
$exclDirs = @('data', 'runtime', 'wechatauto_db', 'wechatauto_logs', '__pycache__', 'whale-girl-3.0-full')
$exclFiles = @('config.json', '*.log', '*.png', '*.jpg', '*.bak-*')
$rcArgs = @($src, $Target, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD') + $exclDirs + @('/XF') + $exclFiles
robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy 失败，退出码 $LASTEXITCODE" }

# 2) 校验关键文件（防止「改了但没过去」）
$must = @(
  'server.js', 'package.json',
  'web\index.html', 'web\assets\app.js', 'web\assets\style.css',
  'src\vision.js', 'src\bot.js', 'src\master.js', 'src\persona.js',
  'examples\wechatauto_bridge.py', 'tools\uia-diag.py', 'scripts\release-check.js'
)
$bad = @()
foreach ($f in $must) {
  $a = Join-Path $src $f; $b = Join-Path $Target $f
  if (-not (Test-Path $b)) { $bad += "$f（目标缺失）"; continue }
  if ((Get-FileHash $a -Algorithm MD5).Hash -ne (Get-FileHash $b -Algorithm MD5).Hash) { $bad += "$f（内容不一致）" }
}
if ($bad.Count) {
  Write-Host "!! 同步后校验失败：" -ForegroundColor Red
  $bad | ForEach-Object { Write-Host "   - $_" -ForegroundColor Red }
  throw "代码没同步干净，先别重启服务"
}
Write-Host "✓ 校验通过：$($must.Count) 个关键文件一致；data\ 与 config.json 未动" -ForegroundColor Green

# 3) 重启
if ($Restart) {
  Get-Process node, python -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    Write-Host "  停止 $($_.ProcessName) $($_.Id)"
  }
  Start-Sleep -Seconds 2
  $env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'; $env:WECHATAUTO_RHYTHM = 'off'
  $env:HTTP_PROXY = ''; $env:HTTPS_PROXY = ''; $env:ALL_PROXY = ''; $env:NO_PROXY = '*'
  Start-Process -FilePath (Join-Path $Target 'runtime\node.exe') -ArgumentList 'server.js' -WorkingDirectory $Target -WindowStyle Minimized
  # 桥接用守护循环启动：长时间挂着时微信窗口被回收会导致原生崩溃（0xC0000005），
  # 守护循环 3 秒内自动拉起，不用人工重启。
  $loop = Join-Path $Target 'scripts\bridge_loop.bat'
  Start-Process -FilePath $loop -WorkingDirectory $Target -WindowStyle Minimized
  Start-Sleep -Seconds 6
  $listen = (netstat -ano | Select-String ':8787.*LISTENING')
  Write-Host ("  8787 监听：{0}" -f $(if ($listen) { '是' } else { '否 ← 服务没起来' })) -ForegroundColor $(if ($listen) { 'Green' } else { 'Red' })
  $log = Join-Path $Target 'data\wechat-bridge-4x.log'
  if (Test-Path $log) {
    Write-Host "  桥接日志最后的结论：" -ForegroundColor Cyan
    Get-Content $log -Encoding UTF8 -Tail 6 | ForEach-Object { "    $_" }
  }
}
Write-Host "完成。" -ForegroundColor Green
