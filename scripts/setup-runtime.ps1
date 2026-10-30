# 把「运行环境」装进 runtime/：直接下载官方打好的 runtime 包（Node 22 + Python 3.12 + 依赖）。
#
# 为什么这么做：GitHub 上「Code → Download ZIP」只有源码（几百 KB），不含运行时；
# 从零 pip 装 wechatauto 那套依赖经常卡在编译（winsdk / pywin32），体验很差。
# 这里改成下一份已经调好的运行时包（约 86MB），解压即用，和 Releases 里的完整包一模一样。
#
# 用法：双击 一键装运行环境.bat（或 powershell -File scripts/setup-runtime.ps1）
$ErrorActionPreference = 'Stop'

# 国内网络经常有残留代理，直连失败；这些站点都不需要代理
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')) {
  if (Test-Path "env:$name") { Remove-Item "env:$name" -ErrorAction SilentlyContinue }
}
$env:NO_PROXY = '*'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$REPO = 'Banan1cee/whale_gril'
$REL = 'v3.50'
$ASSET = 'runtime-3.50.zip'

Write-Host ''
Write-Host '  🐋 鲸鲸 · 安装运行环境' -ForegroundColor Cyan
Write-Host '  ────────────────────────────────────────────'

$nodeExe = Join-Path $runtime 'node.exe'
$pyExe = Join-Path $runtime 'python\python.exe'
if ((Test-Path $nodeExe) -and (Test-Path $pyExe)) {
  Write-Host '  runtime 已经装好了，跳过' -ForegroundColor Green
  $nodeVer = & $nodeExe -v
  Write-Host "  Node：$nodeVer"
  Write-Host ''
  exit 0
}

$url = "https://github.com/$REPO/releases/download/$REL/$ASSET"
$zip = Join-Path $env:TEMP $ASSET
$part = "$zip.part"
Write-Host "  [1/2] 下载运行时（约 86MB，网慢要几分钟）：$url"
if ((-not (Test-Path $zip)) -or (Get-Item $zip).Length -lt 10MB) {
  # Windows 10+ 自带 curl：比 Invoke-WebRequest 稳，也不吃内存
  $curl = (Get-Command curl.exe -ErrorAction SilentlyContinue)
  $failCode = 0
  if ($curl) {
    & $curl.Source -L --fail --retry 3 --retry-delay 2 --connect-timeout 30 -o $part $url
    $failCode = $LASTEXITCODE
  } else {
    try { Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing -TimeoutSec 1800 } catch { $failCode = 1 }
  }
  # curl 偶尔在收尾时报 write error（exit 23），但文件其实是完整的——按大小判断，别白跑一遍
  $partSize = if (Test-Path $part) { (Get-Item $part).Length / 1MB } else { 0 }
  if ($partSize -gt 50) {
    Move-Item $part $zip -Force
  } else {
    throw ("下载失败（exit $failCode，已下 {0:N1}MB）。可以手动下载后放到 {1}" -f $partSize, $zip)
  }
}

Write-Host '  [2/2] 解压到 runtime\ …'
if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
# 包里可能带一层 runtime\ 顶层目录，先解到临时目录再判断，别搞成 runtime\runtime
$tmpDir = Join-Path $env:TEMP ('whale-rt-' + [guid]::NewGuid().ToString('N'))
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $tmpDir)
$inner = Join-Path $tmpDir 'runtime'
if (Test-Path $inner) { Move-Item $inner $runtime } else { Move-Item $tmpDir $runtime }
Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  自检：' -NoNewline
$nodeOk = (Test-Path $nodeExe)
$pyCheck = & $pyExe -c "import wechatauto, psutil, win32com; print('ok')" 2>&1
if ($nodeOk -and ($pyCheck -match 'ok')) {
  Write-Host ' 运行时正常 ✅' -ForegroundColor Green
  $nodeVer = & $nodeExe -v
  Write-Host "  Node：$nodeVer"
  Write-Host ''
  Write-Host '  完成。现在可以双击「启动鲸鱼娘.bat」了。' -ForegroundColor Cyan
} else {
  Write-Host ' 有问题 ❌' -ForegroundColor Red
  Write-Host "  node 存在：$nodeOk"
  Write-Host $pyCheck
  Write-Host ' 可以把上面这段发到仓库的 Issues。'
}
Write-Host ''
