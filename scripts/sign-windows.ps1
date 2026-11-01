<#
  用 PFX 证书给 exe 签名。谁在用：.github/workflows/installer.yml。

  顺序很重要：启动器（WhaleLauncher.exe）必须在**编译安装包之前**签好，
  安装包（whale-girl-*-setup.exe）在**编译之后**签。反过来做的话，
  安装包里嵌的还是未签名的启动器，用户装完看到的还是「未知发布者」。

  证书从哪来（按优先级）：
    1. 参数 -PfxBase64 / -PfxPassword
    2. 环境变量 WINDOWS_SIGNING_PFX_BASE64 / WINDOWS_SIGNING_PFX_PASSWORD

  没配置证书时：打印「未签名」并以 0 退出（没有证书也要能出包）；
  要强制签名就加 -Require，这时没证书直接失败。

  时间戳走 DigiCert（RFC3161，SHA256）。时间戳失败就整体失败：没有时间戳的签名
  在证书过期后会失效，比不签更难排查。

  用法（本机验证 CI 的证书能不能签）：
    $env:WINDOWS_SIGNING_PFX_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))
    $env:WINDOWS_SIGNING_PFX_PASSWORD = '...'
    powershell -File scripts\sign-windows.ps1 -Path .\WhaleLauncher.exe
#>
param(
    [Parameter(Mandatory = $true)][string[]]$Path,
    [string]$PfxBase64 = $env:WINDOWS_SIGNING_PFX_BASE64,
    [string]$PfxPassword = $env:WINDOWS_SIGNING_PFX_PASSWORD,
    [string]$TimestampUrl = 'http://timestamp.digicert.com',
    [switch]$Require
)

$ErrorActionPreference = 'Stop'

function Note([string]$msg) { Write-Host "  $msg" }

function Fail([string]$msg) {
    Write-Host "[x] $msg" -ForegroundColor Red
    if ($env:GITHUB_ACTIONS -eq 'true') { Write-Output "::error title=签名失败::$msg" }
    exit 1
}

# 在 Windows SDK 里找 signtool.exe：按版本目录（10.0.26100.0）挑最新的那份
function Find-SignTool {
    $found = @()
    foreach ($root in @("${env:ProgramFiles(x86)}\Windows Kits\10\bin", "${env:ProgramFiles}\Windows Kits\10\bin")) {
        if ([string]::IsNullOrEmpty($root) -or -not (Test-Path $root)) { continue }
        $found += Get-ChildItem $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' }
    }
    $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if ($cmd) { $found += Get-Item $cmd.Source }

    $best = $null
    $bestVer = $null
    foreach ($c in $found) {
        $ver = [version]'0.0'
        try { $ver = [version]$c.Directory.Parent.Name } catch { }
        if (-not $best -or $ver -gt $bestVer) { $best = $c; $bestVer = $ver }
    }
    return $best
}

Write-Host '== 代码签名' -ForegroundColor Cyan

# 没证书：默认放行（提示一句），-Require 时失败
if ([string]::IsNullOrWhiteSpace($PfxBase64)) {
    $msg = '没有配置代码签名证书（WINDOWS_SIGNING_PFX_BASE64），本次产物未签名'
    if ($Require) { Fail $msg }
    Write-Host "[!] $msg" -ForegroundColor Yellow
    if ($env:GITHUB_ACTIONS -eq 'true') { Write-Output "::warning title=未签名::$msg" }
    exit 0
}

$PfxBase64 = $PfxBase64 -replace '\s', ''
$tool = Find-SignTool
if (-not $tool) {
    Fail '找不到 signtool.exe（Windows SDK 未安装？）。可以只出未签名包：不要配置签名 secrets。'
}
$signtool = $tool.FullName
Note "signtool：$signtool"

# 先把要签的文件都确认存在，再动证书，避免签一半才报错
$targets = @()
foreach ($p in $Path) {
    if (-not (Test-Path -LiteralPath $p)) { Fail "要签名的文件不存在：$p" }
    $targets += (Resolve-Path -LiteralPath $p).Path
}

$pfx = Join-Path ([IO.Path]::GetTempPath()) ('whale-sign-' + [guid]::NewGuid().ToString('N') + '.pfx')
try {
    [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($PfxBase64))
}
catch {
    Fail "PFX 解码失败（WINDOWS_SIGNING_PFX_BASE64 是不是 base64？）：$($_.Exception.Message)"
}

try {
    foreach ($f in $targets) {
        Note "签名 $(Split-Path $f -Leaf)"
        & $signtool sign /fd SHA256 /td SHA256 /tr $TimestampUrl /f $pfx /p $PfxPassword $f
        if ($LASTEXITCODE -ne 0) { Fail "签名失败（signtool exit $LASTEXITCODE）：$f" }

        # 签完立刻回读：状态不是 Valid 就等于没签上
        $sig = Get-AuthenticodeSignature -LiteralPath $f
        if ($sig.Status -ne 'Valid') {
            Fail "签名校验没过：$f（$($sig.Status)：$($sig.StatusMessage)）"
        }
        $subject = $sig.SignerCertificate.Subject
        $ts = if ($sig.TimeStamperCertificate) { '已时间戳' } else { '无时间戳' }
        Write-Host "  ✓ $($sig.Status)  $ts  $subject" -ForegroundColor Green
    }
}
finally {
    Remove-Item $pfx -Force -ErrorAction SilentlyContinue
}

Write-Host '== 签名完成' -ForegroundColor Green
