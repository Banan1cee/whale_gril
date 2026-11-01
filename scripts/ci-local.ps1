# 本地 CI：与 .github/workflows/tests.yml 完全同一套步骤。
#
# 用途：推之前先在这里跑一遍，红了就地修，不用等 GitHub 排队。
# 用法（仓库根目录）：npm run ci
#   或：powershell -NoProfile -ExecutionPolicy Bypass -File scripts/ci-local.ps1
# 指定 Python：scripts/ci-local.ps1 -Python "C:\Python312\python.exe"
param(
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Continue'
Push-Location (Split-Path -Parent $PSScriptRoot)
$results = @()

# 临时目录放进仓库内：测试会大量创建临时目录/文件，指向系统 %TEMP% 时
# 在受限沙箱里会被拒（PermissionError），看起来像测试失败，其实是权限。
# 放 artifacts/ci-tmp 既能跑通，也不会污染工作树（artifacts/ 已 gitignore）。
$ciTmp = Join-Path (Get-Location) 'artifacts\ci-tmp'
New-Item -ItemType Directory -Force -Path $ciTmp | Out-Null
$env:TEMP = $ciTmp
$env:TMP = $ciTmp
$env:TMPDIR = $ciTmp

function Step([string]$Name, [scriptblock]$Body) {
    Write-Host ''
    Write-Host "== $Name" -ForegroundColor Cyan
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $global:LASTEXITCODE = 0
    & $Body
    $code = $LASTEXITCODE
    if ($null -eq $code) { $code = 0 }
    $timer.Stop()
    $seconds = [math]::Round($timer.Elapsed.TotalSeconds, 1)
    $script:results += [pscustomobject]@{ Name = $Name; Code = $code; Seconds = $seconds }
    if ($code -ne 0) {
        Write-Host "   FAIL 退出码 $code（$seconds s）" -ForegroundColor Red
    } else {
        Write-Host "   OK（$seconds s）" -ForegroundColor Green
    }
}

Step '环境版本' {
    node -v
    & $Python -c "import sys; print(sys.version)"
    if (Get-Command dotnet -ErrorAction SilentlyContinue) { dotnet --version }
}

Step '分层依赖（谁可以 require 谁）' {
    node scripts/check-layers.js
}

# 必须在启动器编译之前：编译会让 launcher/obj 出现记录本机路径的文本文件，
# 自检会把它当成「泄露个人信息」误报。
Step '发布自检' {
    node scripts/release-check.js
}

Step '隐私扫描（文本 + 二进制）' {
    node scripts/privacy-scan.js .
}

Step 'Node 单元测试' {
    npm test
}

Step 'Python 单元测试' {
    & $Python -m unittest discover -s tests -p 'test_*.py'
}

Step '桥接自检（零焦点发送 / 消息调度）' {
    $failed = @()
    foreach ($script in @('scripts/bg-selftest.py', 'scripts/bridge-pipeline-selftest.py')) {
        Write-Host "----- $script"
        & $Python $script
        if ($LASTEXITCODE -ne 0) { $failed += $script }
    }
    if ($failed.Count -gt 0) {
        Write-Host ("失败：" + ($failed -join '、')) -ForegroundColor Red
        $global:LASTEXITCODE = 1
    }
}

Step '启动器编译' {
    dotnet build launcher/WhaleLauncher.csproj -c Release --nologo
}

Step '启动器进程生命周期回归（模拟桥接）' {
    & (Join-Path $PSScriptRoot 'test-launcher.ps1')
}

Step '启动冒烟（--doctor）' {
    node server.js --doctor
}

Pop-Location

Write-Host ''
Write-Host '==== 汇总 ====' -ForegroundColor Cyan
foreach ($row in $results) {
    $mark = if ($row.Code -eq 0) { 'OK  ' } else { 'FAIL' }
    Write-Host ("  {0}  {1}  ({2} s)" -f $mark, $row.Name, $row.Seconds)
}
$failed = @($results | Where-Object { $_.Code -ne 0 })
if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host ("失败 {0} 项：{1}" -f $failed.Count, ($failed.Name -join '、')) -ForegroundColor Red
    exit 1
}
Write-Host ''
Write-Host '全部通过' -ForegroundColor Green
exit 0
