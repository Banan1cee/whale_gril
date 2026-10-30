# 兼容旧入口：真正的迁移逻辑已经合并进 update.ps1（-Migrate）。
# 老版本目录里的 升级到新版本.bat 还会调用本文件，这里只做参数转发，不再放任何实现。
param(
    [string]$FromDir = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$params = @{ Migrate = $true }
if ($FromDir) { $params['FromDir'] = $FromDir }
if ($Force) { $params['Force'] = $true }

$target = Join-Path $PSScriptRoot 'update.ps1'
& $target @params
exit $LASTEXITCODE