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
Write-Host "  [1/2] 下载运行时（约 86MB）：$url"
if (-not (Test-Path $zip) -or (Get-Item $zip).Length -lt 10MB) {
  Invoke-WebRequest -Uri $url -OutFile "$zip.part" -UseBasicParsing -TimeoutSec 1800
  Move-Item "$zip.part" $zip -Force
}

Write-Host '  [2/2] 解压到 runtime\ …'
if (Test-Path $runtime) { Remove-Item $runtime -Recurse -Force }
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($zip, $runtime)

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
