# 鲸鲸 · 冒烟测试（需要服务已经在运行）
# 用法（Windows PowerShell）：
#   powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\smoke.ps1 -BaseUrl http://127.0.0.1:8788
param(
  [string]$BaseUrl = 'http://127.0.0.1:8787'
)

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = 'Continue'
$script:pass = 0
$script:fail = 0
$script:tmpDir = [System.IO.Path]::GetTempPath()

function Write-Utf8([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# 统一用 curl.exe：把 JSON 写进临时文件再用 --data-binary，避免 PowerShell 传参时中文被转码
function CurlText([string]$url, [string]$method = 'GET', [string]$jsonBody = '', [string[]]$headers = @()) {
  $curlArgs = @('-sS', '--max-time', '25', '-X', $method, $url)
  foreach ($h in $headers) { $curlArgs += @('-H', $h) }
  $tmp = $null
  if ($jsonBody) {
    $tmp = Join-Path $script:tmpDir ('whale-smoke-' + [guid]::NewGuid().ToString('N') + '.json')
    Write-Utf8 $tmp $jsonBody
    $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', "@$tmp")
  }
  try {
    $out = & curl.exe @curlArgs 2>&1
    if ($LASTEXITCODE -ne 0) { throw "curl 退出码 $LASTEXITCODE : $out" }
    return ($out | Out-String)
  } finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}

function CurlStatus([string]$url, [string]$method = 'GET', [string]$jsonBody = '', [string[]]$headers = @()) {
  $curlArgs = @('-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '20', '-X', $method, $url)
  foreach ($h in $headers) { $curlArgs += @('-H', $h) }
  $tmp = $null
  if ($jsonBody) {
    $tmp = Join-Path $script:tmpDir ('whale-smoke-' + [guid]::NewGuid().ToString('N') + '.json')
    Write-Utf8 $tmp $jsonBody
    $curlArgs += @('-H', 'Content-Type: application/json', '--data-binary', "@$tmp")
  }
  try {
    return (& curl.exe @curlArgs 2>&1 | Out-String).Trim()
  } finally {
    if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
  }
}

function Check([string]$name, [scriptblock]$body) {
  try {
    $detail = & $body
    Write-Host ("  [PASS] " + $name + "  " + $detail) -ForegroundColor Green
    $script:pass++
  } catch {
    Write-Host ("  [FAIL] " + $name + "  " + $_.Exception.Message) -ForegroundColor Red
    $script:fail++
  }
}

Write-Host "`n🐋 鲸鲸冒烟测试 → $BaseUrl" -ForegroundColor Cyan

Check '首页 HTML' {
  $html = CurlText "$BaseUrl/"
  if ($html -notmatch '鲸鲸') { throw '页面里没有找到「鲸鲸」' }
  "长度 $($html.Length) 字符"
}

foreach ($asset in @('/assets/style.css', '/assets/app.js', '/assets/avatar.jpg', '/assets/jingjing.jpg')) {
  Check "静态资源 $asset" {
    $body = CurlText "$BaseUrl$asset"
    if ($body.Length -lt 200) { throw "内容太短：$($body.Length)" }
    "长度 $($body.Length) 字符"
  }
}

Check 'GET /api/status' {
  $data = (CurlText "$BaseUrl/api/status") | ConvertFrom-Json
  if (-not $data.ok) { throw 'ok != true' }
  "name=$($data.name) mock=$($data.mock) model=$($data.model) 网关=$($data.gateways.Count)"
}

Check 'GET /api/persona' {
  $data = (CurlText "$BaseUrl/api/persona") | ConvertFrom-Json
  if (-not $data.name) { throw '缺少 name' }
  "别名 $($data.aliases.Count) 个"
}

Check 'GET /api/settings（模型服务列表）' {
  $data = (CurlText "$BaseUrl/api/settings") | ConvertFrom-Json
  if (-not $data.providers -or -not $data.providers.ollama) { throw '缺少模型服务预设' }
  $count = @($data.providers.PSObject.Properties).Count
  "当前=$($data.provider) / 可选 $count 个服务"
}

Check '私聊 SSE 流式回复' {
  $body = '{"text":"你好呀","mode":"private","sessionId":"smoke","senderName":"小海"}'
  $sse = CurlText "$BaseUrl/api/chat" 'POST' $body
  if ($sse -notmatch '"type":"delta"') { throw '没有收到 delta 事件' }
  if ($sse -notmatch '"type":"done"') { throw '没有收到 done 事件' }
  $m = [regex]::Match($sse, '"type":"done","text":"([^"]{1,40})')
  "回复片段：" + $m.Groups[1].Value
}

Check '群聊没被 @ 时保持安静' {
  $body = '{"text":"今天加班好累","mode":"group","sessionId":"smoke","senderName":"阿螈"}'
  $data = (CurlText "$BaseUrl/api/chat" 'POST' $body) | ConvertFrom-Json
  if ($data.action -ne 'ignore') { throw "预期 ignore，实际 $($data.action)" }
  "reason=$($data.reason)"
}

Check '群聊被 @ 时开口' {
  $body = '{"text":"@鲸鲸 在吗","mode":"group","sessionId":"smoke","senderName":"海胆酱","atMe":true}'
  $sse = CurlText "$BaseUrl/api/chat" 'POST' $body
  if ($sse -notmatch '"type":"done"') { throw '没有收到 done 事件' }
  'ok'
}

Check 'GET /api/memory' {
  $data = (CurlText "$BaseUrl/api/memory?sessionId=smoke&mode=private") | ConvertFrom-Json
  if (-not $data.ok) { throw 'ok != true' }
  "记忆条数=$($data.notes.Count)"
}

Check 'GET /healthz' {
  $data = (CurlText "$BaseUrl/healthz") | ConvertFrom-Json
  if (-not $data.ok) { throw 'ok != true' }
  'ok'
}

# 微信网关（用 config.json 里的 token；没配置就用默认值）
$token = 'change-me-wechat'
$configPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'config.json'
if (Test-Path $configPath) {
  try {
    $cfg = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($cfg.gateway.wechat.inboundToken) { $token = $cfg.gateway.wechat.inboundToken }
  } catch { }
}

Check '微信网关 webhook（token 校验 + 解析 + 回复）' {
  $body = '{"chat_id":"room_smoke","chat_type":"group","user_id":"u1","nickname":"阿螈","text":"@鲸鲸 在吗","msg_id":"smoke-1"}'
  $data = (CurlText "$BaseUrl/webhook/wechat" 'POST' $body @("x-bot-token: $token")) | ConvertFrom-Json
  if (-not $data.ok) { throw 'ok != true' }
  if ($data.skipped) {
    "解析正常；适配器未启用（config.json 里 gateway.wechat.enabled=false）→ $($data.skipped)"
  } else {
    "action=$($data.action) outbound_ok=$($data.outbound.ok)"
  }
}

Check '微信网关拒绝错误 token' {
  $body = '{"chat_id":"r","text":"hi"}'
  $code = CurlStatus "$BaseUrl/webhook/wechat" 'POST' $body @('x-bot-token: wrong')
  if ($code -ne '403') { throw "预期 403，实际 $code" }
  '403'
}

Write-Host "`n结果：$($script:pass) 项通过，$($script:fail) 项失败`n" -ForegroundColor $(if ($script:fail -eq 0) { 'Green' } else { 'Red' })
if ($script:fail -gt 0) { exit 1 }
exit 0
