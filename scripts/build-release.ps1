<#
一键出包：测试 → 发布自检 → 打两个 zip → 直接读 zip 验证关键字段。

为什么需要它：3.0.3 那次就是「源码里改好了，包里还是旧文件」，用户装完发现设置里没有功能。
这里强制：测试不过不出包、自检不过不出包、出完包再从 zip 里读文件校验。

用法：
  powershell -File scripts\build-release.ps1                          # 输出到默认目录
  powershell -File scripts\build-release.ps1 -OutDir D:\release -Version 3.0.5
#>
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE 'Documents\whale-girl-release'),
  [string]$RuntimeSource = '',   # 默认用本目录的 runtime\
  [switch]$SkipFull              # 只打源码包
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path $node)) { $node = 'node' }
$rt = if ($RuntimeSource) { $RuntimeSource } else { Join-Path $root 'runtime' }

function Step($msg) { Write-Host "`n=== $msg ===" -ForegroundColor Cyan }

Step '1/5 运行测试'
Push-Location $root
& $node --test 'tests/*.test.js' 2>&1 | Select-String -Pattern '^not ok|^# (tests|pass|fail)' | ForEach-Object { Write-Host "  $($_.Line)" }
if ($LASTEXITCODE -ne 0) { Pop-Location; throw '测试没通过，不出包' }

Step '2/5 暂存（排除 data / config.json / runtime / 日志）'
# 包名带完整版本号：以前写死 whale-girl-3.0，解压后谁也分不清 3.0.9 和 3.0.16，混用就把新修复盖掉了
$ver = (Get-Content (Join-Path $root 'package.json') -Encoding UTF8 -Raw | ConvertFrom-Json).version
$pkgName = "whale-girl-$ver"
$pkgNameFull = "$pkgName-full"
Write-Host "  版本：$ver（包名 $pkgName）"
$build = Join-Path $env:TEMP ('whale-build-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stage = Join-Path $build $pkgName
New-Item -ItemType Directory $stage -Force | Out-Null
$rcArgs = @($root, $stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD',
  'data', 'runtime', '.tools', 'artifacts', 'bin', 'obj', 'publish', '.git', 'wechatauto_db', 'wechatauto_logs', '__pycache__', 'whale-girl-*-full', 'backup',
  '/XF', 'config.json', '*.log', '*.png', '*.jpg', '*.bak-*')
robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { Pop-Location; throw "robocopy 失败 $LASTEXITCODE" }

# 使用已发布的启动器，避免根目录正在运行的旧 exe 被打入新包。
$publishedLauncher = Join-Path $root 'launcher\publish\WhaleLauncher.exe'
if (Test-Path $publishedLauncher) {
  Copy-Item -LiteralPath $publishedLauncher -Destination (Join-Path $stage 'WhaleLauncher.exe') -Force
}

# 本地活动用的东西不进包：吵架大赛预设（避免别人一下载就拿去开骂）
$localOnly = @('personas\persona-v4-fight.json', 'resources\clapback-fight.txt')
foreach ($rel in $localOnly) {
  $p = Join-Path $stage $rel
  if (Test-Path $p) {
    Remove-Item $p -Force
    Write-Host "  已排除（本地活动用）：$rel"
  }
}

Step '3/5 发布自检（--release）'
Push-Location $stage
& $node 'scripts\release-check.js' --release 2>&1 | Select-Object -Last 4 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Pop-Location; Pop-Location; throw '发布自检不通过，不出包' }
Pop-Location

Step '4/5 打包'
New-Item -ItemType Directory $OutDir -Force | Out-Null
$srcZip = Join-Path $OutDir ($pkgName + '.zip')
if (Test-Path $srcZip) { Remove-Item $srcZip -Force }
Compress-Archive -Path $stage -DestinationPath $srcZip -CompressionLevel Optimal
Write-Host ("  源码包：{0:N0} KB  →  {1}" -f ((Get-Item $srcZip).Length / 1KB), (Split-Path $srcZip -Leaf))
$fullZip = $null
if (-not $SkipFull) {
  $fullDir = Join-Path $build $pkgNameFull
  robocopy $stage $fullDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  robocopy $rt (Join-Path $fullDir 'runtime') /E /NFL /NDL /NJH /NJS /NP | Out-Null
  # 首次运行会从示例生成配置；发行包不包含 config.json，覆盖更新不会重置用户设置。
  $fullZip = Join-Path $OutDir ($pkgNameFull + '.zip')
  if (Test-Path $fullZip) { Remove-Item $fullZip -Force }
  & tar -a -cf $fullZip -C $build $pkgNameFull
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "tar 打包失败 $LASTEXITCODE" }
  Write-Host ("  完整包：{0:N1} MB  →  {1}" -f ((Get-Item $fullZip).Length / 1MB), (Split-Path $fullZip -Leaf))
}

Step '5/5 从 zip 里读文件复核（不信任磁盘）'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$checks = @(
  @{ entry = 'web/index.html'; needle = 'visionApiKey'; label = '看图 API 字段' },
  @{ entry = 'web/index.html'; needle = 'btnVisionTest'; label = '测试看图按钮' },
  @{ entry = 'src/http/routes/vision.js'; needle = '/api/vision/test'; label = '看图测试接口' },
  @{ entry = 'src/core/master.js'; needle = 'matchMaster'; label = '主人判定' },
  @{ entry = 'tools/uia-diag.py'; needle = 'QACCESSIBLE_ACTIVE_RVA_BY_VERSION'; label = 'UIA 诊断工具' }
)
foreach ($zipPath in @($srcZip, $fullZip) | Where-Object { $_ }) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  foreach ($c in $checks) {
    $e = $zip.Entries | Where-Object { $_.FullName -replace '\\', '/' -match ("/" + [regex]::Escape($c.entry) + '$') } | Select-Object -First 1
    if (-not $e) { throw "$(Split-Path $zipPath -Leaf) 里缺 $($c.entry)" }
    $sr = New-Object System.IO.StreamReader($e.Open()); $txt = $sr.ReadToEnd(); $sr.Close()
    if (-not $txt.Contains($c.needle)) { throw "$(Split-Path $zipPath -Leaf) 的 $($c.entry) 不含「$($c.label)」" }
  }
  $zip.Dispose()
  Write-Host "  ✓ $(Split-Path $zipPath -Leaf) 通过 $($checks.Count) 项内容检查"
}

Remove-Item $build -Recurse -Force -ErrorAction SilentlyContinue
Pop-Location
Write-Host "`n出包完成：$OutDir（版本 $ver）" -ForegroundColor Green
