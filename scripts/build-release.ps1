# 本地出包：测试 -> 干净源码树自检 -> 加便携运行时 -> 从 zip 验证。
# 本脚本不推送、不创建 Release、不上传任何文件。
param(
  [string]$OutDir = (Join-Path $env:USERPROFILE 'Documents\whale-girl-release'),
  [string]$RuntimeSource = '',
  [switch]$SkipFull
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$rt = if ($RuntimeSource) { (Resolve-Path -LiteralPath $RuntimeSource).Path } else { Join-Path $root 'runtime' }
$node = Join-Path $rt 'node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
$ver = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$pkgName = "whale-girl-$ver"
$OutDir = [IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
$build = Join-Path $OutDir ('.build-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $build | Out-Null
$testsLog = Join-Path $OutDir ($pkgName + '-tests.log')

Write-Host "1/5 运行全部测试（不发微信）：$ver"
if (Test-Path -LiteralPath (Join-Path $rt 'python\python.exe')) { $env:WHALE_TEST_PYTHON = Join-Path $rt 'python\python.exe' }
$env:PYTHONUTF8 = '1'; $env:PYTHONIOENCODING = 'utf-8'
Push-Location $root
try {
  # Python unittest writes successful results to stderr too; under Windows
  # PowerShell 5.1 it must not be mistaken for a failing native command.
  $ErrorActionPreference = 'Continue'
  & $node --test 'tests/*.test.js' 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $testsLog -Encoding UTF8
  $testCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($testCode -ne 0) { throw "测试失败，不出包：$testsLog" }
} finally { Pop-Location; $ErrorActionPreference = 'Stop' }

Write-Host '2/5 暂存源码（排除配置、数据、Git、运行时、缓存）'
$sourceParent = Join-Path $build 'source'
$stage = Join-Path $sourceParent 'whale-girl'
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$rcArgs = @($root, $stage, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/XD',
  '.git', '.github', 'data', 'runtime', 'node_modules', 'backup', '__pycache__', 'wechatauto_db', 'wechatauto_logs',
  '/XF', 'config.json', '*.log', '*.zip', '*.pyc', '*.bak-*', '协作指南.md')
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw '源码暂存失败' }
foreach ($rel in @('personas\persona-v4-fight.json', 'resources\clapback-fight.txt')) {
  $target = Join-Path $stage $rel
  if (Test-Path -LiteralPath $target) {
    $resolved = (Resolve-Path -LiteralPath $target).Path
    if (-not $resolved.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '拒绝删除暂存树以外路径' }
    Remove-Item -LiteralPath $resolved -Force
  }
}

Write-Host '3/5 发布自检（只检查不含 runtime 的源码树）'
$checkLog = Join-Path $OutDir ($pkgName + '-release-check.log')
$ErrorActionPreference = 'Continue'
& $node (Join-Path $stage 'scripts\release-check.js') --release 2>&1 | ForEach-Object { $_.ToString() } | Set-Content -LiteralPath $checkLog -Encoding UTF8
$checkCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($checkCode -ne 0) { throw "发布自检失败，不出包：$checkLog" }

Write-Host '4/5 构建候选包（完整包也绝不带 config.json/data）'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceCandidate = Join-Path $build ($pkgName + '-source.zip')
[IO.Compression.ZipFile]::CreateFromDirectory($sourceParent, $sourceCandidate, [IO.Compression.CompressionLevel]::Optimal, $false)
$candidates = @($sourceCandidate)
$fullDir = $null
if (-not $SkipFull) {
  foreach ($required in @('node.exe', 'python\python.exe', 'ffmpeg\bin\ffmpeg.exe')) {
    if (-not (Test-Path -LiteralPath (Join-Path $rt $required))) { throw "运行时缺少 $required" }
  }
  $fullParent = Join-Path $build 'full'
  $fullDir = Join-Path $fullParent 'whale-girl'
  New-Item -ItemType Directory -Path $fullDir -Force | Out-Null
  & robocopy $stage $fullDir /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw '完整包源码复制失败' }
  & robocopy $rt (Join-Path $fullDir 'runtime') /E /NFL /NDL /NJH /NJS /NP /XD __pycache__ /XF '*.pyc' '*.log' | Out-Null
  if ($LASTEXITCODE -ge 8) { throw '运行时复制失败' }
  $ErrorActionPreference = 'Continue'
  & (Join-Path $rt 'python\python.exe') -B (Join-Path $stage 'scripts\prepare-sticker-runtime.py') $fullDir
  $patchCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($patchCode -ne 0) { throw '运行时补丁验证失败，不出包' }
  $fullCandidate = Join-Path $build ($pkgName + '.zip')
  [IO.Compression.ZipFile]::CreateFromDirectory($fullParent, $fullCandidate, [IO.Compression.CompressionLevel]::Optimal, $false)
  $candidates += $fullCandidate
}

Write-Host '5/5 从 zip 复核所有源码哈希、版本、禁带数据和关键功能'
$checks = @(
  @{ entry = 'web/index.html'; needle = 'visionApiKey' },
  @{ entry = 'web/index.html'; needle = 'btnVisionTest' },
  @{ entry = 'server.js'; needle = '/api/vision/test' },
  @{ entry = 'src/master.js'; needle = 'matchMaster' },
  @{ entry = 'tools/uia-diag.py'; needle = 'QACCESSIBLE_ACTIVE_RVA_BY_VERSION' },
  @{ entry = 'src/stickers.js'; needle = 'normalizeEmotion' },
  @{ entry = 'web/debug.html'; needle = '（此为绝大部分情绪，建议多加表情包）' }
)
foreach ($candidate in $candidates) {
  $zip = [IO.Compression.ZipFile]::OpenRead($candidate)
  try {
    $entryMap = @{}
    foreach ($entry in $zip.Entries) { $entryMap[$entry.FullName.Replace('\', '/')] = $entry }
    foreach ($name in $entryMap.Keys) {
      if ($name -match '^whale-girl/(config\.json|data/|\.git/)') { throw "包里混入运行数据：$name" }
    }
    foreach ($file in Get-ChildItem -LiteralPath $stage -File -Recurse) {
      $relative = $file.FullName.Substring($stage.Length + 1).Replace('\', '/')
      $entry = $entryMap['whale-girl/' + $relative]
      if (-not $entry) { throw "包内缺文件：$relative" }
      $stream = $entry.Open(); $sha = [Security.Cryptography.SHA256]::Create()
      try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') } finally { $stream.Dispose(); $sha.Dispose() }
      if ($hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "源码哈希不匹配：$relative" }
    }
    foreach ($check in $checks) {
      $reader = New-Object IO.StreamReader($entryMap['whale-girl/' + $check.entry].Open())
      try { $text = $reader.ReadToEnd() } finally { $reader.Dispose() }
      if (-not $text.Contains($check.needle)) { throw "关键功能缺失：$($check.entry)" }
    }
    $reader = New-Object IO.StreamReader($entryMap['whale-girl/package.json'].Open())
    try { $packagedVersion = ($reader.ReadToEnd() | ConvertFrom-Json).version } finally { $reader.Dispose() }
    if ($packagedVersion -ne $ver) { throw '包内版本不一致' }
  } finally { $zip.Dispose() }
}
# Only publish to the LOCAL output directory after every candidate has passed.
$backups = Join-Path $OutDir 'local-backups'
foreach ($candidate in $candidates) {
  $destination = Join-Path $OutDir (Split-Path -Leaf $candidate)
  if (Test-Path -LiteralPath $destination) {
    New-Item -ItemType Directory -Path $backups -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination (Join-Path $backups ((Split-Path -Leaf $destination) + '.' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak'))
  }
  Copy-Item -LiteralPath $candidate -Destination $destination -Force
  Write-Host ('本地包：{0}（{1:N1} MB）' -f $destination, ((Get-Item -LiteralPath $destination).Length/1MB))
}
$resolvedBuild = (Resolve-Path -LiteralPath $build).Path
if ((Split-Path -Parent $resolvedBuild) -ne $OutDir -or (Split-Path -Leaf $resolvedBuild) -notlike '.build-*') { throw '拒绝清理意外暂存目录' }
Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
Write-Host "完成：$ver；没有上传。测试日志：$testsLog"
