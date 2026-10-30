<#
.SYNOPSIS
  一键构建 runtime\：node.exe + CPython 3.12 embeddable + 桥接依赖 + manifest.json

.DESCRIPTION
  4.0 打包流水线的第一步。在构建机联网跑一次，产物随安装包发布，用户端零网络：

    runtime\node.exe        Node 内核
    runtime\python\         CPython 3.12 embeddable（已装好桥接依赖）
    runtime\wheelhouse\     离线轮子（构建用，打进安装包前要排除）
    runtime\manifest.json   版本与文件指纹

  两个踩过的坑，写在这里免得重来：

  1. 别用 get-pip.py：它在 embeddable 上会空转（实测 3 分钟纯 CPU 不落盘）。
     改成「解包 pip wheel 进 site-packages」，几十秒搞定。
  2. 别让 embeddable 的 pip 直接联网：它的 TLS 握手要 33 秒（同一台机器 curl 是秒开），
     几十个请求下来看着就像卡死。改成「系统 pip 先把 wheel 全部抓到本地，
     再让 runtime 的 pip 用 --no-index 离线装」。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\build-runtime.ps1
  powershell -ExecutionPolicy Bypass -File scripts\build-runtime.ps1 -Force
#>
param(
  [string]$PythonVersion = '3.12.10',
  [string]$PythonUrl = '',
  [string[]]$Packages = @('wechatauto-replica==1.2.8.1', 'psutil', 'pywin32', 'requests'),
  [string]$Mirror = 'https://pypi.tuna.tsinghua.edu.cn/simple',
  [switch]$Force,
  [switch]$SkipNode
)

# 用 Continue 而不是 Stop：PowerShell 5.1 下原生命令往 stderr 写一行（比如 pywin32 的
# postinstall 在非管理员下报错）就会被当成终止错误，把整个构建打断。退出码我们自己判。
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $root 'runtime'
$pythonDir = Join-Path $runtime 'python'
$wheelhouse = Join-Path $runtime 'wheelhouse'
$sitePackages = Join-Path $pythonDir 'Lib\site-packages'
$pythonExe = Join-Path $pythonDir 'python.exe'
$pyTag = ($PythonVersion -split '\.')[0..1] -join ''          # 3.12 -> 312
if (-not $PythonUrl) {
  $PythonUrl = "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip"
}
$env:PIP_DISABLE_PIP_VERSION_CHECK = '1'
$env:PIP_CACHE_DIR = Join-Path $env:TEMP 'whale-pipcache'
$mirrorHost = ([uri]$Mirror).Host

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Info($msg) { Write-Host "  $msg" }
function Fail($msg) { Write-Host "  [x] $msg" -ForegroundColor Red; exit 1 }

function Get-File($url, $out) {
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 0)) { Info "已存在，跳过下载：$(Split-Path -Leaf $out)"; return }
  Info "下载 $url"
  & curl.exe -L --fail --retry 3 --retry-delay 2 -o $out $url
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out)) { Fail "下载失败：$url" }
}

# 优先要二进制轮子；拿不到（pyautogui 这类只发源码包的）退回源码包
function Get-Wheel($name) {
  $common = @('-m', 'pip', 'download', '--dest', $wheelhouse, '--no-deps',
    '-i', $Mirror, '--trusted-host', $mirrorHost)
  & python @common --only-binary=:all: --platform win_amd64 --python-version 3.12 --implementation cp --abi cp312 $name 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Info "  轮子  $name"; return }
  & python @common --no-binary :all: $name 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) { Info "  源码包 $name"; return }
  Fail "拿不到 $name（镜像源或网络问题）"
}

# ---------------------------------------------------------------- 0. 目录
Step '0/6 准备目录'
New-Item -ItemType Directory -Force -Path $runtime, $wheelhouse | Out-Null
foreach ($junk in @('.temp', '.uv-cache')) {
  $p = Join-Path $runtime $junk
  if (Test-Path $p) { try { Remove-Item $p -Recurse -Force -ErrorAction Stop; Info "清掉遗留 $junk" } catch { Info "清不掉 $junk（被占用，忽略）" } }
}

# ---------------------------------------------------------------- 1. node
Step '1/6 node.exe'
$nodeExe = Join-Path $runtime 'node.exe'
if ($SkipNode) {
  Info '按参数跳过（复用已有 node.exe）'
} elseif ((Test-Path $nodeExe) -and -not $Force) {
  Info "已有 node.exe $(& $nodeExe -v)"
} else {
  $sysNode = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $sysNode) { Fail '本机没有 node，无法取 node.exe；装 Node 24 LTS 后重跑' }
  Copy-Item $sysNode $nodeExe -Force
  Info "从 $sysNode 复制，$(& $nodeExe -v)"
}

# ---------------------------------------------------------------- 2. python
Step '2/6 CPython embeddable'
if ((Test-Path $pythonExe) -and -not $Force) {
  Info "已有 python：$(& $pythonExe -c 'import sys;print(sys.version.split()[0])')"
} else {
  $zip = Join-Path $env:TEMP "python-$PythonVersion-embed-amd64.zip"
  Get-File $PythonUrl $zip
  if (Test-Path $pythonDir) { Remove-Item $pythonDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $pythonDir | Out-Null
  & tar -xf $zip -C $pythonDir
  if ($LASTEXITCODE -ne 0) { Fail '解压 embeddable 失败' }
  Info "解压到 runtime\python（$(& $pythonExe -c 'import sys;print(sys.version.split()[0])')）"
}

# ._pth：不加这两行，site-packages 里的包 import 不到
$pth = Join-Path $pythonDir "python$pyTag._pth"
$wantPth = "python$pyTag.zip`r`n.`r`nLib\site-packages`r`nimport site`r`n"
if (-not (Test-Path $pth) -or ((Get-Content $pth -Raw) -ne $wantPth)) {
  [IO.File]::WriteAllText($pth, $wantPth, (New-Object Text.UTF8Encoding $false))
  Info "已修正 $(Split-Path -Leaf $pth)：加 Lib\site-packages + import site"
}

# ---------------------------------------------------------------- 3. pip 自举
Step '3/6 给 runtime 装 pip'
if (Test-Path (Join-Path $sitePackages 'pip')) {
  Info "pip 已在：$(& $pythonExe -m pip --version)"
} else {
  $sysPython = (Get-Command python -ErrorAction SilentlyContinue).Source
  if (-not $sysPython) { Fail '本机没有系统 python，无法取 pip wheel（构建机需要一份带 pip 的 Python）' }
  New-Item -ItemType Directory -Force -Path $sitePackages | Out-Null
  & $sysPython -m pip download --no-deps --only-binary=:all: --dest $wheelhouse pip setuptools wheel
  if ($LASTEXITCODE -ne 0) { Fail '下载 pip wheel 失败' }
  Get-ChildItem $wheelhouse -Filter *.whl | Where-Object { $_.Name -match '^(pip|setuptools|wheel)-' } | ForEach-Object {
    & tar -xf $_.FullName -C $sitePackages
    Info "解包 $($_.Name)"
  }
  & $pythonExe -m pip --version
  if ($LASTEXITCODE -ne 0) { Fail 'runtime python 里的 pip 不可用' }
}

# ---------------------------------------------------------------- 4. 桥接依赖（离线装，缺什么补什么）
Step '4/6 安装桥接依赖'
$commonArgs = @('-m', 'pip', 'install', '--no-index', '--find-links', $wheelhouse,
  '--no-build-isolation', '--no-cache-dir', '--no-warn-script-location') + $Packages
for ($round = 1; $round -le 12; $round++) {
  $out = & $pythonExe @commonArgs 2>&1
  if ($LASTEXITCODE -eq 0) { Info '依赖安装完成'; break }
  $missing = ([regex]::Match(($out -join "`n"), 'No matching distribution found for ([A-Za-z0-9][A-Za-z0-9_.\-]*)')).Groups[1].Value
  if (-not $missing) { $out | Select-Object -Last 12; Fail '依赖安装失败（不是缺包的问题）' }
  Info "缺 $missing，补抓进 wheelhouse（第 $round 轮）"
  Get-Wheel $missing
}
if ($LASTEXITCODE -ne 0) { Fail '依赖安装没在 12 轮内收敛' }

# ---------------------------------------------------------------- 5. pywin32 postinstall
Step '5/6 pywin32 postinstall'
$post = Get-ChildItem $sitePackages -Recurse -Filter 'pywin32_postinstall.py' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $post) {
  Info '没找到 pywin32_postinstall.py，跳过'
} else {
  & $pythonExe $post.FullName -install *> $null
  if ($LASTEXITCODE -eq 0) { Info 'COM 注册完成' }
  else { Info '注册表写入被拒（非管理员）：不影响 import 与 UIA；安装器拿到管理员权限后可再补一次' }
}

# ---------------------------------------------------------------- 6. 自检 + manifest
Step '6/6 自检与 manifest'
$check = & $pythonExe -c "import wechatauto, psutil, win32com, uiautomation; print('imports ok')" 2>&1
if ($LASTEXITCODE -ne 0) { $check | Select-Object -Last 6; Fail '依赖导入失败' }
Info $check

$listJson = & $pythonExe -m pip list --format=json --disable-pip-version-check
$packagesObj = [ordered]@{}
foreach ($p in ($listJson | ConvertFrom-Json | Sort-Object name)) { $packagesObj[$p.name] = $p.version }

$hash = { param($p) if (Test-Path $p) { (Get-FileHash $p -Algorithm SHA256).Hash.ToLower() } else { '' } }
$pyFiles = (Get-ChildItem $pythonDir -Recurse -File | Measure-Object Length -Sum)
$manifest = [ordered]@{
  schema   = 1
  builtAt  = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz')
  node     = [ordered]@{ version = (& $nodeExe -v).Trim(); sha256 = (& $hash $nodeExe) }
  python   = [ordered]@{ version = $PythonVersion; tag = $pyTag; url = $PythonUrl; sha256 = (& $hash $pythonExe) }
  packages = $packagesObj
  sizes    = [ordered]@{
    pythonMB     = [math]::Round($pyFiles.Sum / 1MB, 1)
    wheelhouseMB = [math]::Round(((Get-ChildItem $wheelhouse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
  }
}
$manifestPath = Join-Path $runtime 'manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))

Write-Host "`n✓ runtime 就绪" -ForegroundColor Green
Info "python : $(& $pythonExe -c 'import sys;print(sys.version.split()[0])')（$($manifest.sizes.pythonMB) MB）"
Info "node   : $(& $nodeExe -v)"
Info "包数量 : $($packagesObj.Count)"
Info "manifest: runtime\manifest.json"
Info "提醒：wheelhouse（$($manifest.sizes.wheelhouseMB) MB）只是构建缓存，打安装包时要排除。"
