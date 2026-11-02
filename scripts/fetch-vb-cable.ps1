<# Download the unmodified VB-CABLE Pack45 for distribution; never install it on the build machine. #>
param([string]$Destination = (Join-Path (Split-Path $PSScriptRoot -Parent) 'runtime\vb-cable'))
$ErrorActionPreference = 'Stop'
$ExpectedSetupHash = '734C35DFA6D98F48782A451633CEB471166EC70D60482FD89A1123D0EE3C4F41'
$Url = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack45.zip'

function Test-Package([string]$directory) {
    $exe = Join-Path $directory 'VBCABLE_Setup_x64.exe'
    if (-not (Test-Path -LiteralPath $exe) -or -not (Test-Path -LiteralPath (Join-Path $directory 'readme.txt'))) { return $false }
    $signature = Get-AuthenticodeSignature -LiteralPath $exe
    return $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match 'BUREL VINCENT' -and
        (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -eq $ExpectedSetupHash
}

if (Test-Package $Destination) { Write-Output 'VB-CABLE Pack45 already verified.'; exit 0 }
$tempRoot = [IO.Path]::GetFullPath($env:TEMP)
$scratch = Join-Path $tempRoot ('whale-vb-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch | Out-Null
try {
    $zip = Join-Path $scratch 'pack45.zip'
    Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing -TimeoutSec 90
    $unpacked = Join-Path $scratch 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    if (-not (Test-Package $unpacked)) { throw 'VB-CABLE publisher or Pack45 fingerprint check failed.' }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Get-ChildItem -LiteralPath $unpacked -Force | Copy-Item -Destination $Destination -Recurse -Force
    Write-Output 'Verified VB-CABLE Pack45 copied with its original readme. Donationware: https://vb-audio.com/Cable/'
} finally {
    # Only remove the exact scratch directory created directly under TEMP.
    if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($scratch)) -eq $tempRoot) {
        Remove-Item -LiteralPath $scratch -Recurse -Force
    }
}
