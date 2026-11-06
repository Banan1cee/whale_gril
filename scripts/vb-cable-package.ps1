# The same pinned file manifest checks downloaded, cached and installed driver packages.
function Get-VbCablePackageProblems([string]$Directory, [string]$Manifest = (Join-Path $PSScriptRoot 'vb-cable-pack45.json')) {
    $files = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $files.PSObject.Properties) {
        $path = Join-Path $Directory $entry.Name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { "Missing: $($entry.Name)"; continue }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -ne $entry.Value) { "Modified: $($entry.Name)" }
    }
}
function Assert-VbCablePackage([string]$Directory) {
    $problems = @(Get-VbCablePackageProblems $Directory)
    if ($problems.Count) { throw ('Incomplete VB-CABLE Pack45: ' + ($problems -join '; ')) }
}
