# 升级/迁移数据：把旧版本文件夹里的 data\ 和 config.json 搬到当前目录。
#
# 场景：更新时解压到了新文件夹，结果「记忆没了」。这个脚本把旧目录的数据搬过来。
# 用法：双击 升级到新版本.bat（会自动找同级的旧版本目录；找不到就让你拖路径进来）
param(
  [string]$FromDir = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path $root 'data'
$configFile = Join-Path $root 'config.json'

Write-Host ''
Write-Host '  🐋 鲸鲸 · 迁移旧数据' -ForegroundColor Cyan
Write-Host '  ────────────────────────────────────────────'

function Has-Memory($dir) {
  if (-not $dir) { return $false }
  $store = Join-Path $dir 'data\store.json'
  if (-not (Test-Path $store)) { return $false }
  try {
    $raw = Get-Content $store -Raw -Encoding UTF8 | ConvertFrom-Json
    $n = 0
    if ($raw.sessions) { $n = ($raw.sessions.PSObject.Properties | Measure-Object).Count }
    return $n -gt 0
  } catch { return $false }
}

function Copy-Data($src) {
  Write-Host "  从：$src"
  if (-not (Test-Path (Join-Path $src 'data'))) {
    Write-Host '  ✗ 这个目录里没有 data\（确认是旧版本的文件夹？）' -ForegroundColor Red
    return $false
  }
  New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
  # 先把当前（可能是空的）先留个底，别把已有数据覆盖掉
  if (Test-Path (Join-Path $dataDir 'store.json')) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $bak = Join-Path $root "backup\before-migrate-$stamp"
    New-Item -ItemType Directory -Path $bak -Force | Out-Null
    Copy-Item (Join-Path $dataDir '*') $bak -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  当前数据已另存：$bak" -ForegroundColor DarkGray
  }
  Copy-Item (Join-Path $src 'data\*') $dataDir -Recurse -Force
  $srcCfg = Join-Path $src 'config.json'
  if ((Test-Path $srcCfg) -and -not (Test-Path $configFile)) {
    Copy-Item $srcCfg $configFile -Force
    Write-Host '  config.json 也一起搬过来了（主人名单 / token 保留）' -ForegroundColor Green
  } elseif (Test-Path $srcCfg) {
    Write-Host '  当前目录已有 config.json，保留现在的（要换可以手动复制）' -ForegroundColor DarkGray
  }
  Write-Host '  ✓ data\ 已迁移' -ForegroundColor Green
  return $true
}

# 1) 当前目录已经有记忆 → 什么都不用做
if (Has-Memory($root)) {
  Write-Host '  当前目录已经有记忆了，不需要迁移。直接双击「启动鲸鱼娘.bat」就行。' -ForegroundColor Green
  Write-Host ''
  Read-Host '按回车关闭'
  exit 0
}

# 2) 指定了目录
if ($FromDir) {
  if (Copy-Data((Resolve-Path $FromDir).Path)) { Write-Host ''; Read-Host '按回车关闭'; exit 0 }
  exit 1
}

# 3) 自动找同级的旧版本目录（同级、上级里名字带 whale-girl / whale_gril 的）
$parent = Split-Path -Parent $root
$candidates = @()
foreach ($scope in @($parent, (Split-Path -Parent $parent))) {
  if (-not $scope -or -not (Test-Path $scope)) { continue }
  $candidates += Get-ChildItem $scope -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -ne $root -and $_.Name -match 'whale[-_ ]?g(irl|ril)' -and (Has-Memory $_.FullName) }
}
$candidates = $candidates | Sort-Object LastWriteTime -Descending

if ($candidates.Count -gt 0) {
  Write-Host '  找到这些旧版本目录（有记忆）：'
  for ($i = 0; $i -lt $candidates.Count; $i++) {
    $c = $candidates[$i]
    Write-Host ("    [{0}] {1}   ({2})" -f ($i + 1), $c.FullName, $c.LastWriteTime.ToString('yyyy-MM-dd HH:mm'))
  }
  Write-Host ''
  $choice = Read-Host "  输入序号迁移，直接回车取消"
  if ($choice -match '^\d+$' -and [int]$choice -ge 1 -and [int]$choice -le $candidates.Count) {
    if (Copy-Data($candidates[[int]$choice - 1].FullName)) {
      Write-Host ''
      Write-Host '  迁移完成。现在双击「启动鲸鱼娘.bat」就能带着记忆启动了。' -ForegroundColor Cyan
      Write-Host ''
      Read-Host '按回车关闭'
      exit 0
    }
  }
  Write-Host '  已取消，没有改动任何东西。'
  Write-Host ''
  Read-Host '按回车关闭'
  exit 0
}

Write-Host '  没自动找到旧版本目录。' -ForegroundColor Yellow
Write-Host ''
Write-Host '  两个办法：'
Write-Host '   A. 把你旧版本的整个文件夹拖到这个窗口里，回车'
Write-Host '   B. 手动把旧文件夹里的 data\ 和 config.json 复制到：'
Write-Host "      $root"
Write-Host ''
$manual = Read-Host '  拖路径进来（或直接回车退出）'
if ($manual) {
  $manual = $manual.Trim('"').Trim()
  if (Test-Path $manual) {
    if (Copy-Data((Resolve-Path $manual).Path)) {
      Write-Host ''
      Write-Host '  迁移完成。双击「启动鲸鱼娘.bat」即可。' -ForegroundColor Cyan
    }
  } else {
    Write-Host "  ✗ 找不到这个路径：$manual" -ForegroundColor Red
  }
}
Write-Host ''
Read-Host '按回车关闭'
