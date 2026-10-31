param([string]$Dotnet = 'dotnet', [string]$NuGetConfig = '')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'artifacts\launcher-tests'
$argsRestore = @()
if ($NuGetConfig) { $argsRestore = @('--configfile', $NuGetConfig) }
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) { $node = (Get-Command node -ErrorAction Stop).Source }
& $Dotnet build (Join-Path $root 'tests\launcher\FakeBridge\FakeBridge.csproj') -c Release -o (Join-Path $out 'fake') --nologo @argsRestore
if ($LASTEXITCODE -ne 0) { throw '模拟桥接编译失败' }
& $Dotnet build (Join-Path $root 'tests\launcher\Checks\Checks.csproj') -c Release -o (Join-Path $out 'checks') --nologo @argsRestore
if ($LASTEXITCODE -ne 0) { throw '启动器测试编译失败' }
& $Dotnet (Join-Path $out 'checks\SupervisorChecks.dll') $root $node
if ($LASTEXITCODE -ne 0) { throw '启动器进程生命周期测试失败' }
