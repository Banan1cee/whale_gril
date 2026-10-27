<#
  一键更新：从 GitHub Release 拉最新版，原地覆盖代码；data\ 和 config.json 一个字节都不动。

  用法（双击根目录的 一键更新.bat 即可）：
    scripts\update.ps1                    # 自动找安装目录 → 查最新 → 更新
    scripts\update.ps1 -Check             # 只看有没有新版
    scripts\update.ps1 -Rollback          # 退回上一次更新前
    scripts\update.ps1 "D:\xxx.zip"       # 离线：直接装本地包
    scripts\update.ps1 -Tag v3.54 -Force  # 指定版本 / 降级
    scripts\update.ps1 -DryRun            # 只出计划，不下载不落盘
    scripts\update.ps1 -NoMirror          # 只用官方源

  说明：
    - release 是打包好的 zip（含 runtime），不是 git 仓库；这里只做「下载 → 校验 → 覆盖」，不编辑任何源码
    - 覆盖时跳过 data\、config.json、backup\、日志；runtime 只增改不删除（包里带的 ffmpeg 会补进来）
    - 下载按官方 API 给的 sha256 校验；官方不通时自动换镜像（镜像只搬运，不参与校验）
    - 覆盖后自检版本号 / 记忆条数 / config 哈希，任一项不过就自动回滚
#>
[CmdletBinding()]
param(
    [string]$Root,
    [string]$Tag,
    [string]$Mirror,
    [string]$ApiUrl,
    [string]$AssetBase,
    [switch]$NoMirror,
    [switch]$Check,
    [switch]$DryRun,
    [switch]$Force,
    [switch]$KeepRuntime,
    [switch]$KeepZip,
    [switch]$Yes,
    [switch]$Rollback,
    [Parameter(Position = 0)][string]$Zip
)

$ErrorActionPreference = 'Stop'

$Repo = 'Banan1cee/whale_gril'
$StateDir = if ($env:TEMP) { Join-Path $env:TEMP 'whale-girl-tools' } else { Join-Path $PSScriptRoot '..\.state' }
$StateFile = Join-Path $StateDir 'last-root.txt'
$CanPrompt = (-not [Console]::IsInputRedirected)
$UseProgress = $true
try { if ([Console]::IsOutputRedirected -or [Console]::IsInputRedirected) { $UseProgress = $false } } catch { $UseProgress = $false }

$Work = $null
$Helper = $null
$OverlayStarted = $false
$script:lastBackup = ''
$script:Stage = 'net'

function Say {
    param([string]$Text = '', [string]$Color = 'Gray')
    Write-Host $Text -ForegroundColor $Color
}

# 5.1 在输出被重定向时读写 console buffer 会抛 Win32 0x5，进度条一律加开关
function Update-Progress {
    param([string]$Activity, [string]$Status = '', [int]$Percent = -1, [switch]$Done)
    if (-not $script:UseProgress) { return }
    if ($Done) { Write-Progress -Activity $Activity -Completed; return }
    if ($Percent -ge 0) {
        Write-Progress -Activity $Activity -Status $Status -PercentComplete $Percent
    } else {
        Write-Progress -Activity $Activity -Status $Status
    }
}

# ---------------------------------------------------------------- 小工具（独立运行，不依赖外部 ps1）

function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1073741824) { return ('{0:N1} GB' -f ($Bytes / 1073741824)) }
    if ($Bytes -ge 1048576) { return ('{0:N1} MB' -f ($Bytes / 1048576)) }
    if ($Bytes -ge 1024) { return ('{0:N0} KB' -f ($Bytes / 1024)) }
    return "$Bytes B"
}

function Invoke-Robocopy {
    param(
        [string]$Source,
        [string]$Dest,
        [string[]]$ExcludeDirs = @(),
        [string[]]$ExcludeFiles = @()
    )
    if (-not (Test-Path -LiteralPath $Dest)) { New-Item -ItemType Directory -Force -Path $Dest | Out-Null }
    $a = @($Source, $Dest, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:2', '/W:2')
    if ($ExcludeDirs -and $ExcludeDirs.Count -gt 0) { $a += '/XD'; $a += $ExcludeDirs }
    if ($ExcludeFiles -and $ExcludeFiles.Count -gt 0) { $a += '/XF'; $a += $ExcludeFiles }
    $out = & robocopy @a 2>&1
    return [pscustomobject]@{ Code = $LASTEXITCODE; Ok = ($LASTEXITCODE -lt 8); Output = @($out) }
}

function Get-StoreStats {
    param([string]$Root)
    $file = Join-Path $Root 'data\store.json'
    $res = [pscustomobject]@{ Path = $file; Exists = $false; Sessions = 0; Messages = 0; Notes = 0; Size = 0; SavedAt = '' }
    if (-not (Test-Path -LiteralPath $file)) { return $res }
    try { $j = (Get-Content -LiteralPath $file -Raw -Encoding UTF8) | ConvertFrom-Json } catch { return $res }
    $sessions = 0; $messages = 0; $notes = 0
    if ($j.PSObject.Properties.Name -contains 'sessions' -and $j.sessions) {
        foreach ($prop in $j.sessions.PSObject.Properties) {
            $sessions++
            $messages += @($prop.Value.messages).Count
            if ($prop.Value.profiles) {
                foreach ($p in $prop.Value.profiles.PSObject.Properties) { $notes += @($p.Value.notes).Count }
            }
        }
    }
    $res.Exists = $true
    $res.Sessions = $sessions
    $res.Messages = $messages
    $res.Notes = $notes
    try { $res.Size = (Get-Item -LiteralPath $file -Force).Length } catch { }
    if ($j.savedAt) { $res.SavedAt = [string]$j.savedAt }
    return $res
}

# ---------------------------------------------------------------- 基本读取

function Get-AppVersion {
    param([string]$AppRoot)
    try {
        $pkg = Join-Path $AppRoot 'package.json'
        if (-not (Test-Path -LiteralPath $pkg)) { return '' }
        $j = (Get-Content -LiteralPath $pkg -Raw -Encoding UTF8) | ConvertFrom-Json
        return [string]$j.version
    } catch { return '' }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLower()
}

function ConvertTo-VerParts {
    param([string]$V)
    $s = ''
    if ($V) { $s = ([string]$V).Trim() -replace '^[vV]', '' }
    $parts = @()
    foreach ($piece in ($s -split '[.\-+_ ]')) {
        if ($piece -match '^\d+') { $parts += [int]([regex]::Match($piece, '^\d+').Value) }
    }
    while ($parts.Count -lt 4) { $parts += 0 }
    return , $parts
}

function Compare-Ver {
    param([string]$A, [string]$B)
    $x = ConvertTo-VerParts $A
    $y = ConvertTo-VerParts $B
    for ($i = 0; $i -lt 4; $i++) {
        if ($x[$i] -gt $y[$i]) { return 1 }
        if ($x[$i] -lt $y[$i]) { return -1 }
    }
    return 0
}

# ---------------------------------------------------------------- 找安装目录

function Get-RunningAppRoots {
    $found = @()
    foreach ($p in @(Get-Process -Name node -ErrorAction SilentlyContinue)) {
        $exe = ''
        try { $exe = $p.Path } catch { }
        if (-not $exe) { continue }
        if ((Split-Path -Leaf (Split-Path -Parent $exe)) -ne 'runtime') { continue }
        $cand = Split-Path -Parent (Split-Path -Parent $exe)
        if ($cand -and (Test-Path -LiteralPath (Join-Path $cand 'server.js'))) { $found += $cand }
    }
    return @($found | Select-Object -Unique)
}

function Resolve-AppRoot {
    param([string]$Given)

    $cands = @()
    if ($Given) {
        $p = [IO.Path]::GetFullPath($Given)
        if (-not (Test-Path -LiteralPath $p)) { throw ("路径不存在：" + $p) }
        if (Test-Path -LiteralPath (Join-Path $p 'server.js')) { return $p }
        foreach ($d in @(Get-ChildItem -LiteralPath $p -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'server.js')) { $cands += $d.FullName }
        }
        if ($cands.Count -eq 0) { throw ("这个路径里没找到 server.js：" + $p) }
    } else {
        $here = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
        if (Test-Path -LiteralPath (Join-Path $here 'server.js')) { $cands += $here }
        $cwd = (Get-Location).Path
        if (Test-Path -LiteralPath (Join-Path $cwd 'server.js')) { $cands += $cwd }
        $cands += @(Get-RunningAppRoots)
        if (Test-Path -LiteralPath $StateFile) {
            $last = (Get-Content -LiteralPath $StateFile -Raw -ErrorAction SilentlyContinue)
            if ($last) {
                $last = $last.Trim()
                if ($last -and (Test-Path -LiteralPath (Join-Path $last 'server.js'))) { $cands += $last }
            }
        }
        foreach ($d in @(Get-ChildItem -LiteralPath $here -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path -LiteralPath (Join-Path $d.FullName 'server.js')) { $cands += $d.FullName }
        }
    }

    $cands = @($cands | Where-Object { $_ } | Select-Object -Unique)
    if ($cands.Count -eq 0) {
        Say ''
        Say '  没自动找到鲸鲸安装目录（server.js 所在的那个文件夹）。' 'Yellow'
        if (-not $CanPrompt) { throw '请用 -Root 指定安装目录。' }
        $ans = Read-Host '  把安装目录拖进来 / 粘贴路径（直接回车取消）'
        if (-not $ans) { throw '已取消。' }
        return (Resolve-AppRoot -Given ($ans.Trim().Trim('"')))
    }
    if ($cands.Count -eq 1) { return $cands[0] }

    Say ''
    Say '  找到多个可能的安装目录：' 'Yellow'
    for ($i = 0; $i -lt $cands.Count; $i++) {
        Say ('    [' + ($i + 1) + '] ' + $cands[$i] + '   (版本 ' + (Get-AppVersion $cands[$i]) + ')')
    }
    if (-not $CanPrompt) { return $cands[0] }
    $pick = Read-Host ('  选哪个？(1-' + $cands.Count + '，直接回车=1)')
    $idx = 0
    if ($pick -match '^\d+$') { $idx = [int]$pick - 1 }
    if ($idx -lt 0 -or $idx -ge $cands.Count) { $idx = 0 }
    return $cands[$idx]
}

# ---------------------------------------------------------------- 网络（优先用包里的 node）

function Write-HttpHelper {
    param([string]$Path)
    $js = @'
'use strict';
// 只做两件事：把 URL 内容存文件（json），或流式下载（download）。
// 用 node 自带的 https，避免 PowerShell 5.1 / schannel 在部分机器上握手失败。
const https = require('https');
const http = require('http');
const fs = require('fs');

function request(url, depth) {
  return new Promise((resolve, reject) => {
    if (depth > 6) return reject(new Error('重定向次数过多'));
    const lib = url.indexOf('https:') === 0 ? https : http;
    const req = lib.get(url, { headers: { 'user-agent': 'whale-girl-updater/1.0', 'accept': 'application/vnd.github+json' } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        try { resolve(request(new URL(res.headers.location, url).toString(), depth + 1)); }
        catch (e) { reject(e); }
        return;
      }
      if (code !== 200) {
        let body = '';
        res.on('data', (d) => { if (body.length < 300) body += d; });
        res.on('end', () => reject(new Error('HTTP ' + code + ' ' + body.replace(/\s+/g, ' ').slice(0, 160))));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('网络超时')));
  });
}

(async () => {
  const mode = process.argv[2];
  const url = process.argv[3];
  const out = process.argv[4];
  const res = await request(url, 0);
  if (mode === 'json') {
    const chunks = [];
    for await (const c of res) chunks.push(c);
    fs.writeFileSync(out, Buffer.concat(chunks));
    console.log('OK');
    return;
  }
  const total = Number(res.headers['content-length'] || 0);
  const ws = fs.createWriteStream(out);
  let got = 0;
  let lastPct = -1;
  for await (const c of res) {
    got += c.length;
    if (!ws.write(c)) await new Promise((r) => ws.once('drain', r));
    if (total > 0) {
      const pct = Math.floor(got * 100 / total);
      if (pct >= lastPct + 5) {
        lastPct = pct;
        console.log('P ' + pct + ' ' + (got / 1048576).toFixed(1) + '/' + (total / 1048576).toFixed(1));
      }
    }
  }
  await new Promise((r) => ws.end(r));
  console.log('OK ' + got);
})().catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
'@
    [IO.File]::WriteAllText($Path, $js, (New-Object Text.UTF8Encoding($false)))
}

function Find-NodeExe {
    param([string]$AppRoot)
    $cands = @()
    if ($AppRoot) { $cands += (Join-Path $AppRoot 'runtime\node.exe') }
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { $cands += $cmd.Source }
    foreach ($c in $cands) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return ''
}

function Get-ReleaseInfo {
    param([string[]]$Urls)
    $out = Join-Path $Work 'release.json'
    $node = Find-NodeExe $script:appRoot
    $errors = @()
    foreach ($u in @($Urls | Where-Object { $_ } | Select-Object -Unique)) {
        try {
            if ($node) {
                $lines = @(& $node $Helper 'json' $u $out 2>&1)
                if ($LASTEXITCODE -ne 0) {
                    $msg = ($lines | Where-Object { $_ -like 'ERR *' } | Select-Object -First 1)
                    if ($msg) { $msg = ([string]$msg) -replace '^ERR ', '' } else { $msg = '未知错误' }
                    throw $msg
                }
            } else {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $u -OutFile $out -UseBasicParsing -Headers @{ 'User-Agent' = 'whale-girl-updater' } | Out-Null
            }
            if (-not (Test-Path -LiteralPath $out)) { throw '没拿到内容' }
            return (Get-Content -LiteralPath $out -Raw -Encoding UTF8 | ConvertFrom-Json)
        } catch {
            $errors += ($u + '：' + $_.Exception.Message)
            Write-Host ('  ⚠ 查询失败：' + $_.Exception.Message) -ForegroundColor DarkYellow
        }
    }
    return $null
}

function Save-ReleaseAsset {
    param(
        [string[]]$Urls,
        [string]$Dest,
        [string]$Label,
        [long]$ExpectedSize = 0,
        [string]$ExpectedSha = ''
    )

    $ProgressPreference = 'SilentlyContinue'
    $node = Find-NodeExe $script:appRoot
    $errors = @()
    foreach ($u in @($Urls | Where-Object { $_ } | Select-Object -Unique)) {
        $hostName = $u
        try { $hostName = ([Uri]$u).Host } catch { }
        if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue }
        try {
            if ($node) {
                $err = ''
                & $node $Helper 'download' $u $Dest 2>&1 | ForEach-Object {
                    $line = [string]$_
                    if ($line -match '^P (\d+) (.+)$') {
                        Update-Progress -Activity ('下载 ' + $Label) -Status ($hostName + '  ' + $matches[2] + ' MB') -Percent ([int]$matches[1])
                    } elseif ($line -match '^ERR (.+)$') {
                        $err = $matches[1]
                    }
                }
                Update-Progress -Activity ('下载 ' + $Label) -Done
                if ($LASTEXITCODE -ne 0) { throw ('下载失败：' + $err) }
            } else {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                Invoke-WebRequest -Uri $u -OutFile $Dest -UseBasicParsing -Headers @{ 'User-Agent' = 'whale-girl-updater' }
            }
            if (-not (Test-Path -LiteralPath $Dest)) { throw '下载后文件不存在' }
            $len = (Get-Item -LiteralPath $Dest).Length
            if ($ExpectedSize -gt 0 -and $len -ne $ExpectedSize) { throw ('大小不对（' + $len + '/' + $ExpectedSize + ' 字节）') }
            if ($ExpectedSha) {
                $h = (Get-FileHash -LiteralPath $Dest -Algorithm SHA256).Hash.ToLower()
                if ($h -ne $ExpectedSha) { throw 'sha256 对不上' }
            }
            return $len
        } catch {
            $errors += ([string]$hostName + '：' + $_.Exception.Message)
            Say ('  ⚠ ' + $hostName + ' 没成功（' + $_.Exception.Message + '），换下一个源…') 'Yellow'
            if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Force -ErrorAction SilentlyContinue }
        }
    }
    throw ('所有下载源都失败：' + ($errors -join ' / ') + '。可手动下载 zip 后用 一键升级.bat，或用 -Mirror 指定镜像。')
}

# ---------------------------------------------------------------- 解压 / 体检

function Expand-ReleaseZip {
    param([string]$ZipPath, [string]$Dest)
    Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
    New-Item -ItemType Directory -Force -Path $Dest | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($ZipPath)
    $made = New-Object 'System.Collections.Generic.HashSet[string]'
    $total = $archive.Entries.Count
    $n = 0
    try {
        foreach ($e in $archive.Entries) {
            $name = $e.FullName
            if (-not $name) { continue }
            if ($name.EndsWith('/') -or $name.EndsWith('\')) { continue }
            $rel = ($name -replace '/', '\').TrimStart('\')
            if ($rel -match '\.\.') { continue }
            $target = Join-Path $Dest $rel
            $dir = Split-Path -Parent $target
            if ($dir -and -not $made.Contains($dir)) {
                New-Item -ItemType Directory -Force -Path $dir | Out-Null
                [void]$made.Add($dir)
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $target, $true)
            $n++
            if (($n % 400) -eq 0 -and $total -gt 0) {
                Update-Progress -Activity '解压新版' -Status ('已解压 ' + $n + ' 个文件') -Percent ([int](($n * 100) / $total))
            }
        }
    } finally {
        $archive.Dispose()
        Update-Progress -Activity '解压新版' -Done
    }
    return $n
}

function Find-PackageRoot {
    param([string]$ExtractDir)
    if (Test-Path -LiteralPath (Join-Path $ExtractDir 'server.js')) { return $ExtractDir }
    $dirs = @(Get-ChildItem -LiteralPath $ExtractDir -Directory -ErrorAction SilentlyContinue |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'server.js') })
    if ($dirs.Count -eq 1) { return $dirs[0].FullName }
    throw '解压后没找到唯一的新版源码目录（server.js）。'
}

function Test-NewCodeSyntax {
    param([string]$SrcRoot)
    $node = Find-NodeExe $script:appRoot
    if (-not $node) { Say '  没找到 node.exe，跳过语法检查。' 'DarkGray'; return }
    $targets = @('server.js')
    $srcDir = Join-Path $SrcRoot 'src'
    if (Test-Path -LiteralPath $srcDir) {
        foreach ($f in @(Get-ChildItem -LiteralPath $srcDir -Filter '*.js' -ErrorAction SilentlyContinue)) { $targets += ('src\' + $f.Name) }
    }
    foreach ($t in $targets) {
        $full = Join-Path $SrcRoot $t
        if (-not (Test-Path -LiteralPath $full)) { continue }
        & $node '--check' $full 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('新版代码语法检查没通过：' + $t) }
    }
    Say ('  语法检查通过（' + $targets.Count + ' 个 js 文件）') 'DarkGray'
}

# ---------------------------------------------------------------- 本地补丁检测

$FeatureMarks = @(
    [pscustomobject]@{ File = 'examples\whale_sticker.py';       Pattern = $null;               Name = '收藏表情发送' },
    [pscustomobject]@{ File = 'src\bot.js';                      Pattern = 'takeStickerMarks';  Name = '表情标记解析' },
    [pscustomobject]@{ File = 'examples\wechatauto_bridge.py';   Pattern = 'class MergeQueue';  Name = '连发合并队列' },
    [pscustomobject]@{ File = 'src\llm.js';                      Pattern = 'x-opencode-session'; Name = 'OpenCode 会话头' }
)

function Get-PresentFeatures {
    param([string]$AppRoot)
    $list = @()
    foreach ($m in $FeatureMarks) {
        $p = Join-Path $AppRoot $m.File
        if (-not (Test-Path -LiteralPath $p)) { continue }
        if ($m.Pattern) {
            if (Select-String -LiteralPath $p -Pattern $m.Pattern -SimpleMatch -Quiet -ErrorAction SilentlyContinue) { $list += $m.Name }
        } else {
            $list += $m.Name
        }
    }
    return $list
}

# ---------------------------------------------------------------- 停进程

function Get-AppProcessesByPath {
    param([string]$AppRoot)
    $res = @()
    foreach ($p in @(Get-Process -Name node, python, pythonw -ErrorAction SilentlyContinue)) {
        $exe = ''
        try { $exe = $p.Path } catch { }
        if ($exe -and $exe.StartsWith($AppRoot, [StringComparison]::OrdinalIgnoreCase)) {
            $res += [pscustomobject]@{ Id = $p.Id; Name = $p.ProcessName; Path = $exe }
        }
    }
    return $res
}

function Get-WatchdogProcesses {
    param([string]$AppRoot)
    # 桥接的崩溃守护（cmd 跑 bridge_loop.bat）—— CIM 被系统挡住就拿不到，属于尽力而为
    try {
        $list = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction Stop)
        return @($list | Where-Object {
            $_.CommandLine -and (
                $_.CommandLine.IndexOf($AppRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
                $_.CommandLine -match 'bridge_loop|启动微信桥接'
            )
        })
    } catch {
        return @()
    }
}

function Stop-AppForUpdate {
    param([string]$AppRoot)
    $total = 0
    for ($round = 1; $round -le 3; $round++) {
        $procs = @(Get-AppProcessesByPath $AppRoot)
        $wd = @(Get-WatchdogProcesses $AppRoot)
        if ($procs.Count -eq 0 -and $wd.Count -eq 0) { break }
        foreach ($w in $wd) { try { Stop-Process -Id $w.ProcessId -Force -ErrorAction Stop; $total++ } catch { } }
        foreach ($p in $procs) { try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $total++ } catch { } }
        Start-Sleep -Milliseconds 900
    }
    $left = @(Get-AppProcessesByPath $AppRoot)
    return [pscustomobject]@{ Killed = $total; Left = $left }
}

function Test-FileWritable {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $true }
    try {
        $fs = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        $fs.Close()
        return $true
    } catch { return $false }
}

# ---------------------------------------------------------------- 备份 / 覆盖

function Backup-ForUpdate {
    param([string]$AppRoot)
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dir = Join-Path $AppRoot ('backup\update-' + $stamp)
    New-Item -ItemType Directory -Force -Path $dir | Out-Null

    $cfg = Join-Path $AppRoot 'config.json'
    if (Test-Path -LiteralPath $cfg) { Copy-Item -LiteralPath $cfg -Destination (Join-Path $dir 'config.json') -Force }

    $data = Join-Path $AppRoot 'data'
    if (Test-Path -LiteralPath $data) {
        [void](Invoke-Robocopy -Source $data -Dest (Join-Path $dir 'data') `
            -ExcludeDirs @((Join-Path $data 'media-cache')) -ExcludeFiles @('*.log'))
    }

    $code = Join-Path $dir 'code'
    [void](Invoke-Robocopy -Source $AppRoot -Dest $code `
        -ExcludeDirs @(
            (Join-Path $AppRoot 'data'),
            (Join-Path $AppRoot 'runtime'),
            (Join-Path $AppRoot 'backup'),
            (Join-Path $AppRoot 'node_modules'),
            (Join-Path $AppRoot '.git'),
            (Join-Path $AppRoot 'wechatauto_db'),
            (Join-Path $AppRoot 'wechatauto_logs'),
            (Join-Path $AppRoot 'logs')
        ) -ExcludeFiles @('config.json', '*.log'))

    return $dir
}

# ---------------------------------------------------------------- 结果报告 / 还原

function Show-Result {
    param([string]$Kind, [string]$Message, [string[]]$Detail = @())
    $color = 'Green'
    $icon = [char]0x2705
    switch ($Kind) {
        'network' { $color = 'Yellow'; $icon = [char]0x26A0 }
        'cancelled' { $color = 'Yellow'; $icon = [char]0x26A0 }
        'rolled' { $color = 'Yellow'; $icon = [char]0x21A9 }
        'failed' { $color = 'Red'; $icon = [char]0x2717 }
    }
    Say ''
    Say '  ─────────────────────────────────────────────' $color
    Say ('  ' + $icon + ' ' + $Message) $color
    foreach ($d in $Detail) { if ($d) { Say ('     ' + $d) 'Gray' } }
    Say '  ─────────────────────────────────────────────'
    Say ''
}

function Restore-Backup {
    param([string]$AppRoot, [string]$BackupDir)
    $codeDir = Join-Path $BackupDir 'code'
    if (-not (Test-Path -LiteralPath (Join-Path $codeDir 'server.js'))) {
        throw ('备份里没有代码（缺 code\server.js）：' + $BackupDir)
    }
    $rc = Invoke-Robocopy -Source $codeDir -Dest $AppRoot -ExcludeDirs @('data', 'runtime', 'backup') -ExcludeFiles @('config.json', '*.log')
    if (-not $rc.Ok) { throw ('还原代码失败（robocopy ' + $rc.Code + '）') }
    $bakCfg = Join-Path $BackupDir 'config.json'
    if (Test-Path -LiteralPath $bakCfg) {
        Copy-Item -LiteralPath $bakCfg -Destination (Join-Path $AppRoot 'config.json') -Force
    }
}

function Invoke-RollbackFlow {
    $script:Stage = 'rollback'
    $bakRoot = Join-Path $script:appRoot 'backup'
    $list = @()
    if (Test-Path -LiteralPath $bakRoot) {
        $list = @(Get-ChildItem -LiteralPath $bakRoot -Directory -Filter 'update-*' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending)
    }
    if ($list.Count -eq 0) { throw '没找到任何备份（backup\update-*），没东西可回滚。' }
    $target = $list[0].FullName
    $bakVer = Get-AppVersion (Join-Path $target 'code')
    Say ''
    Say ('  回滚到最近一次备份：' + (Split-Path -Leaf $target) + '（版本 ' + $bakVer + '）') 'Yellow'
    if ($CanPrompt -and -not $Yes) {
        $ans = Read-Host '  确认回滚？(y/N)'
        if ($ans -notmatch '^\s*[yY]') { Show-Result -Kind 'cancelled' -Message '已取消，什么都没动'; exit 0 }
    }
    [void](Stop-AppForUpdate -AppRoot $script:appRoot)
    Restore-Backup -AppRoot $script:appRoot -BackupDir $target
    $nv = Get-AppVersion $script:appRoot
    Show-Result -Kind 'ok' -Message ('已回滚到 ' + $nv) -Detail @(('备份：' + $target), '下一步：双击 启动鲸鱼娘.bat')
    exit 0
}

# ---------------------------------------------------------------- 主流程

try {
    Say ''
    Say '  🐋 鲸鲸 · 一键更新' 'Cyan'
    Say '  ─────────────────────────────────────────────'
    Say '  只换代码：data\（记忆）和 config.json 一个字节都不动' 'DarkGray'
    Say ''

    $script:appRoot = Resolve-AppRoot -Given $Root
    $localVer = Get-AppVersion $script:appRoot
    if (-not $localVer) { $localVer = '0' }
    Say ('  当前安装：' + $script:appRoot) 'Gray'
    Say ('  当前版本：' + $localVer) 'Gray'

    if ($Rollback) { Invoke-RollbackFlow }

    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    Set-Content -LiteralPath $StateFile -Value $script:appRoot -Encoding UTF8

    $Work = Join-Path $env:TEMP ('whale-online-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
    New-Item -ItemType Directory -Force -Path $Work | Out-Null
    $Helper = Join-Path $Work 'whale-http.js'
    Write-HttpHelper -Path $Helper

    $fromZip = $false
    $zipPath = ''
    $zipName = ''
    $digest = ''
    $remoteVer = ''
    $asset = $null
    $exclDirs = @('data', 'runtime', 'backup', 'node_modules', '.git', 'wechatauto_db', 'wechatauto_logs', 'logs', '__pycache__')
    $exclFiles = @('config.json', '*.log')

    if ($Zip) {
        if (-not (Test-Path -LiteralPath $Zip)) { throw ('本地包不存在：' + $Zip) }
        $zipPath = [IO.Path]::GetFullPath($Zip)
        if ($zipPath -notmatch '\.zip$') { throw '本地包必须是 .zip。' }
        if ($Check) { throw '本地包模式不支持 -Check。' }
        if ($DryRun) { throw '本地包模式不支持 -DryRun。' }
        $fromZip = $true
        $zipName = [IO.Path]::GetFileName($zipPath)
        Say ''
        Say ('  使用本地包：' + $zipPath) 'Cyan'
        Say '  （不查 GitHub，版本号以包内 package.json 为准；没有官方 sha256 可比对）' 'DarkGray'
    }

    if (-not $fromZip) {
    $script:Stage = 'net'
    if ($Tag -and $Tag -notmatch '^[vV]') { $Tag = 'v' + $Tag }
    $apiPath = if ($Tag) { 'tags/' + $Tag } else { 'latest' }
    $apiUrls = @()
    if ($ApiUrl) {
        $apiUrls += $ApiUrl
    } else {
        $apiUrls += ('https://api.github.com/repos/' + $Repo + '/releases/' + $apiPath)
        $apiUrls += ('https://api.kkgithub.com/repos/' + $Repo + '/releases/' + $apiPath)
    }
    Say '  正在查询 GitHub Release…' 'DarkGray'
    $rel = Get-ReleaseInfo -Urls $apiUrls

    $cacheTag = if ($Tag) { $Tag } else { 'latest' }
    $releaseCache = Join-Path $StateDir ('release-' + ($cacheTag -replace '[^0-9A-Za-z\.\-]', '_') + '.json')
    $fromCache = $false
    if ($rel) {
        try { ($rel | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath $releaseCache -Encoding UTF8 } catch { }
    } elseif (Test-Path -LiteralPath $releaseCache) {
        $rel = (Get-Content -LiteralPath $releaseCache -Raw -Encoding UTF8 | ConvertFrom-Json)
        $fromCache = $true
        Say '  ⚠ 连不上 GitHub API，改用上次缓存里的版本信息（可能不是最新）。' 'Yellow'
    } elseif ($Tag) {
        $v = $Tag -replace '^[vV]', ''
        $rel = [pscustomobject]@{
            tag_name = $Tag
            name = '（离线：按 -Tag 直接构造下载地址）'
            body = ''
            assets = @([pscustomobject]@{
                name = ('whale-girl-' + $v + '.zip')
                size = 0
                digest = ''
                browser_download_url = ('https://github.com/' + $Repo + '/releases/download/' + $Tag + '/whale-girl-' + $v + '.zip')
            })
        }
        Say ('  ⚠ 拿不到 GitHub API，按 -Tag 直连构造下载地址：' + $Tag) 'Yellow'
    } else {
        throw '查不到任何版本信息（API 被墙 / 断网 / 限流）。可以：① 挂代理后重跑；② 手动下载 zip 后双击 一键升级.bat；③ 加 -Tag v3.54 走直连模式。'
    }

    $remoteVer = ([string]$rel.tag_name) -replace '^[vV]', ''
    $assets = @($rel.assets)
    $zips = @($assets | Where-Object { $_.name -match '\.zip$' })
    $pref = @($zips | Where-Object { $_.name -match '^whale-girl' })
    $asset = $null
    if ($pref.Count -gt 0) { $asset = $pref[0] } elseif ($zips.Count -gt 0) { $asset = $zips[0] }
    if (-not $asset) { throw '这个 release 里没有 zip 资产。' }

    Say ''
    Say ('  最新版本：' + $remoteVer + '    ' + [string]$rel.name) 'Cyan'
    if ($rel.body) {
        $bodyLines = @(([string]$rel.body) -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 10)
        foreach ($l in $bodyLines) { Say ('    ' + $l) 'DarkGray' }
    }

    if ($asset.size) { Say ('  安装包：' + $asset.name + '（' + (Format-Size ([long]$asset.size)) + '）') 'Gray' }

    $cmp = Compare-Ver $remoteVer $localVer
    if ($cmp -le 0 -and -not $Force) {
        Say ''
        if ($Tag -and $cmp -lt 0) {
            Say ('  当前 ' + $localVer + ' 比指定的 ' + $remoteVer + ' 还新，不需要更新。' ) 'Green'
            Say ('     真要降级/重装请加 -Force（会先备份，可回滚）。') 'DarkGray'
        } else {
            Say '  ✅ 已经是最新版本，不用更新。' 'Green'
            Say ('     （想强制重装同版本请加 -Force）') 'DarkGray'
        }
        exit 0
    }

    if ($Check) {
        Say ''
        Say ('  有新版：' + $localVer + ' → ' + $remoteVer) 'Yellow'
        Say '  双击 一键更新.bat 即可更新（会先备份、再覆盖代码）。' 'Gray'
        exit 0
    }

    if (-not $Yes -and $CanPrompt) {
        Say ''
        Say ('  [回车] 现在更新到 ' + $remoteVer + '     [r] 回滚上次更新     [q] 退出') 'Cyan'
        $pick = Read-Host '  选择'
        if ($pick -match '^\s*[qQ]') { Show-Result -Kind 'cancelled' -Message '已取消，什么都没动'; exit 0 }
        if ($pick -match '^\s*[rR]') { Invoke-RollbackFlow }
    }

    $zipName = [string]$asset.name
    $cacheDir = Join-Path $StateDir 'cache'
    New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
    $zipPath = Join-Path $cacheDir $zipName
    $digest = ''
    if ($asset.PSObject.Properties['digest'] -and $asset.digest) {
        $digest = (([string]$asset.digest) -split ':')[-1].ToLower()
    }

    $exclDirs = @('data', 'runtime', 'backup', 'node_modules', '.git', 'wechatauto_db', 'wechatauto_logs', 'logs', '__pycache__')
    $exclFiles = @('config.json', '*.log')
    $bakPreview = Join-Path $script:appRoot ('backup\update-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))

    if ($DryRun) {
        Say ''
        Say '  [预演] 将执行：' 'Cyan'
        Say ('    1) 下载 ' + $zipName + ' 并校验 sha256')
        Say ('    2) 解压到临时目录、检查版本号和语法')
        Say ('    3) 停掉正在跑的鲸鲸（若有）')
        Say ('    4) 备份到 ' + $bakPreview)
        Say ('    5) 用新版覆盖代码，跳过：' + ($exclDirs -join '、'))
        Say ('       以及文件：' + ($exclFiles -join '、'))
        Say '    6) 校验记忆条数、config.json 哈希、版本号'
        Say ''
        Say ('  目标：' + $localVer + ' → ' + $remoteVer) 'Yellow'
        exit 0
    }

    $needDownload = $true
    if (Test-Path -LiteralPath $zipPath) {
        $okSize = ([long]$asset.size -le 0) -or ((Get-Item -LiteralPath $zipPath).Length -eq [long]$asset.size)
        $okHash = ($digest -eq '') -or ((Get-Sha256 $zipPath) -eq $digest)
        if ($okSize -and $okHash) {
            Say ''
            Say '  命中本地缓存，跳过下载。' 'DarkGray'
            $needDownload = $false
        }
    }

    if ($needDownload) {
        $official = [string]$asset.browser_download_url
        if ($AssetBase) {
            $official = $AssetBase.TrimEnd('/') + '/' + ($official -replace '^https?://[^/]+/', '')
        }
        $urls = @()
        if ($Mirror) { $urls += ($Mirror.TrimEnd('/') + '/' + $official) }
        $urls += $official
        if (-not $NoMirror) {
            foreach ($m in @('https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/')) {
                $urls += ($m + $official)
            }
        }
        Say ''
        Say ('  下载中：' + $zipName) 'Cyan'
        [void](Save-ReleaseAsset -Urls $urls -Dest $zipPath -Label $zipName -ExpectedSize ([long]$asset.size) -ExpectedSha $digest)
    }

    $len = (Get-Item -LiteralPath $zipPath).Length
    if ([long]$asset.size -gt 0 -and $len -ne [long]$asset.size) {
        throw ('包大小不对：' + $len + ' 字节，应该是 ' + $asset.size + ' 字节。')
    }
    $hash = Get-Sha256 $zipPath
    if ($digest -and $hash -ne $digest) {
        Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
        throw ('sha256 校验不通过（拿到 ' + $hash + '，应为 ' + $digest + '）。文件已删除，重跑一次。')
    }
    Say ('  ✅ 校验通过：' + (Format-Size $len) + '，sha256 ' + $hash.Substring(0, 12) + '…') 'Green'
    }

    $script:Stage = 'prep'
    Say ''
    Say '  解压新版…' 'DarkGray'
    $extract = Join-Path $Work 'extract'
    $count = Expand-ReleaseZip -ZipPath $zipPath -Dest $extract
    $srcRoot = Find-PackageRoot -ExtractDir $extract
    $srcVer = Get-AppVersion $srcRoot
    if (-not $fromZip -and $srcVer -and (Compare-Ver $srcVer $remoteVer) -ne 0) {
        throw ('包里版本号（' + $srcVer + '）和 release tag（' + $remoteVer + '）对不上。')
    }
    Say ('  已解压 ' + $count + ' 个文件，包内版本 ' + $srcVer) 'DarkGray'

    if ($fromZip) {
        $remoteVer = $srcVer
        $cmpZip = Compare-Ver $remoteVer $localVer
        if ($cmpZip -le 0 -and -not $Force) {
            Show-Result -Kind 'ok' -Message ('包内版本 ' + $remoteVer + ' 不比本地的 ' + $localVer + ' 新，什么都没做') -Detail @('真要重装/降级请加 -Force')
            exit 0
        }
        Say ('  目标：' + $localVer + ' → ' + $remoteVer) 'Yellow'
    }

    Test-NewCodeSyntax -SrcRoot $srcRoot

    # ---- 补丁闸门 ----
    $localFeatures = @(Get-PresentFeatures $script:appRoot)
    $srcFeatures = @(Get-PresentFeatures $srcRoot)
    $missing = @($localFeatures | Where-Object { $srcFeatures -notcontains $_ })
    if ($missing.Count -gt 0) {
        Say ''
        Say '  ⚠ 新版包里没有这些本地功能：' 'Yellow'
        foreach ($m in $missing) { Say ('     - ' + $m) 'Yellow' }
        Say '     覆盖后相关文件会被新版替换，这些功能会消失。' 'Yellow'
        if (-not $Force) {
            if (-not $CanPrompt) { throw '检测到本地功能会丢，已中止。确认要丢请加 -Force。' }
            $ans = Read-Host '     仍然继续？输入 y 继续，其他任意键取消'
            if ($ans -notmatch '^\s*[yY]') { throw '已取消，没有改动任何文件。' }
        } else {
            Say '     已指定 -Force，继续覆盖。' 'Red'
        }
    } elseif ($localFeatures.Count -gt 0) {
        Say '  新版里包含你现有的本地功能，继续。' 'Green'
    }

    # ---- 记录基线 ----
    $before = Get-StoreStats -Root $script:appRoot
    $cfgPath = Join-Path $script:appRoot 'config.json'
    $cfgHashBefore = ''
    if (Test-Path -LiteralPath $cfgPath) { $cfgHashBefore = Get-Sha256 $cfgPath }

    # ---- 停进程 ----
    Say ''
    Say '  停止正在运行的鲸鲸…' 'DarkGray'
    $stop = Stop-AppForUpdate -AppRoot $script:appRoot
    Say ('  已停止 ' + $stop.Killed + ' 个进程') 'Gray'
    if ($stop.Left.Count -gt 0) {
        Say '  ⚠ 还有进程没停掉（可能权限不够，或桥接守护在自动拉起）：' 'Yellow'
        foreach ($p in $stop.Left) { Say ('     PID ' + $p.Id + '  ' + $p.Path) 'Yellow' }
        Say '     如果覆盖时报"文件被占用"，请先双击 一键终止.bat，再从安装目录运行本工具。' 'Yellow'
    }
    if (-not (Test-FileWritable (Join-Path $script:appRoot 'server.js'))) {
        throw 'server.js 还被占用着，先关闭鲸鲸再更新（双击 一键终止.bat）。'
    }

    # ---- 备份 ----
    Say ''
    Say '  备份 data\ + config.json + 现有代码…' 'DarkGray'
    $bak = Backup-ForUpdate -AppRoot $script:appRoot
    $script:lastBackup = $bak
    $script:Stage = 'overlay'
    Say ('  备份完成：' + $bak) 'Gray'

    # ---- 覆盖 ----
    $newRt = Join-Path $srcRoot 'runtime'
    $needRuntime = $false
    if ($KeepRuntime) {
        Say '  按 -KeepRuntime 保留原 runtime。' 'DarkGray'
    } elseif (Test-Path -LiteralPath $newRt) {
        $needRuntime = $true
        $localNode = Join-Path $script:appRoot 'runtime\node.exe'
        $pkgNode = Join-Path $newRt 'node.exe'
        if ((Test-Path -LiteralPath $localNode) -and (Test-Path -LiteralPath $pkgNode)) {
            if ((Get-Sha256 $localNode) -eq (Get-Sha256 $pkgNode)) {
                $pkgFfmpeg = Test-Path -LiteralPath (Join-Path $newRt 'ffmpeg')
                $localFfmpeg = Test-Path -LiteralPath (Join-Path $script:appRoot 'runtime\ffmpeg')
                if ((-not $pkgFfmpeg) -or $localFfmpeg) {
                    $needRuntime = $false
                    Say '  runtime 已经是同一套（node.exe 一致、ffmpeg 齐），跳过。' 'DarkGray'
                }
            }
        }
    }

    if ($needRuntime) {
        $OverlayStarted = $true
        Say '  更新 runtime（只增改不删除，你多放的东西会留着）…' 'DarkGray'
        $rr = Invoke-Robocopy -Source $newRt -Dest (Join-Path $script:appRoot 'runtime')
        if (-not $rr.Ok) { throw ('替换 runtime 失败（robocopy ' + $rr.Code + '）。备份在 ' + $bak) }
    }

    Say ''
    Say '  覆盖代码…' 'DarkGray'
    $OverlayStarted = $true
    $rc = Invoke-Robocopy -Source $srcRoot -Dest $script:appRoot -ExcludeDirs $exclDirs -ExcludeFiles $exclFiles
    if (-not $rc.Ok) {
        throw ('复制失败（robocopy 退出码 ' + $rc.Code + '）。备份在 ' + $bak + '，用 一键更新.bat -Rollback 恢复。')
    }

    # ---- 自检 ----
    $newVer = Get-AppVersion $script:appRoot
    if ((Compare-Ver $newVer $remoteVer) -ne 0) {
        throw ('覆盖后版本号是 ' + $newVer + '，应该是 ' + $remoteVer + '。备份在 ' + $bak)
    }
    $after = Get-StoreStats -Root $script:appRoot
    if ($before.Exists -and $after.Messages -lt $before.Messages) {
        throw ('记忆条数变少了（' + $before.Messages + ' → ' + $after.Messages + '）。用 一键更新.bat -Rollback 恢复。')
    }
    $cfgHashAfter = ''
    if (Test-Path -LiteralPath $cfgPath) { $cfgHashAfter = Get-Sha256 $cfgPath }
    if ($cfgHashBefore -and $cfgHashAfter -ne $cfgHashBefore) {
        throw ('config.json 被动过了！用 一键更新.bat -Rollback 恢复。')
    }

    # ---- 收尾 ----
    if (-not $KeepZip) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue

    $memLine = if ($after.Exists) {
        '记忆：' + $after.Sessions + ' 个会话 / ' + $after.Messages + ' 条消息（更新前 ' + $before.Messages + ' 条）'
    } else {
        '这个目录没有 data\，没有记忆需要保护'
    }
    Show-Result -Kind 'ok' -Message ('更新完成：' + $localVer + ' → ' + $newVer) -Detail @(
        $memLine,
        ('config.json：' + $(if ($cfgHashBefore) { '原样保留' } else { '本来就没有，未创建' })),
        ('备份：' + $bak),
        '下一步：双击 启动鲸鱼娘.bat（改了代码必须重启才生效）',
        '想退回上一版：双击 一键更新.bat -Rollback'
    )
    if (-not (Test-Path -LiteralPath (Join-Path $script:appRoot 'runtime\node.exe'))) {
        Say '  ⚠ runtime 里没有 node.exe，先双击 一键装运行环境.bat' 'Yellow'
    }

    exit 0
} catch {
    $err = $_.Exception.Message
    Say ''
    Say ('  ✗ ' + $err) 'Red'
    if ($OverlayStarted -and $script:lastBackup -and (Test-Path -LiteralPath $script:lastBackup)) {
        Say '  覆盖之后没过自检，正在用备份自动回滚…' 'Yellow'
        try {
            [void](Stop-AppForUpdate -AppRoot $script:appRoot)
            Restore-Backup -AppRoot $script:appRoot -BackupDir $script:lastBackup
            $v = Get-AppVersion $script:appRoot
            Show-Result -Kind 'rolled' -Message ('更新失败，已自动回滚到 ' + $v) -Detail @(
                ('原因：' + $err),
                ('备份：' + $script:lastBackup),
                '记忆和 config.json 都还原了，可以直接继续用。'
            )
            exit 3
        } catch {
            Show-Result -Kind 'failed' -Message '更新失败，而且自动回滚也没成功' -Detail @(
                ('原因：' + $err),
                ('回滚报错：' + $_.Exception.Message),
                ('手动恢复：把 ' + $script:lastBackup + '\code 覆盖回安装目录，config.json 也复制回去')
            )
            exit 4
        }
    }
    if ($script:Stage -eq 'rollback') {
        Show-Result -Kind 'failed' -Message '回滚失败' -Detail @(('原因：' + $err), '可以手动把 backup\update-*\code 覆盖回安装目录。')
        exit 4
    }
    if ($script:Stage -eq 'net') {
        Show-Result -Kind 'network' -Message '网络失败，没有改动任何东西' -Detail @(
            ('原因：' + $err),
            '① 过一会儿重跑；② 挂代理重跑；③ 自己下 zip，把 .zip 拖到 一键更新.bat 上（等价于在线更新）'
        )
    } else {
        Show-Result -Kind 'cancelled' -Message '没有改动任何东西（在动安装目录之前就停了）' -Detail @(('原因：' + $err))
    }
    if ($Work -and (Test-Path -LiteralPath $Work) -and -not $KeepZip) {
        Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 2
}
