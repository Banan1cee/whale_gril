# The same pinned file manifest checks downloaded, cached and installed driver packages.
function Get-VbCablePackageProblems([string]$Directory, [string]$Manifest = (Join-Path $PSScriptRoot 'vb-cable-pack45.json')) {
    $files = Get-Content -LiteralPath $Manifest -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($entry in $files.PSObject.Properties) {
        $path = Join-Path $Directory $entry.Name
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { "Missing: $($entry.Name)"; continue }
        $algorithm = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead($path)
        try {
            $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '')
        } finally { $stream.Dispose(); $algorithm.Dispose() }
        if (-not [string]::Equals($actual, [string]$entry.Value, [StringComparison]::OrdinalIgnoreCase)) { "Modified: $($entry.Name)" }
    }
}
function Assert-VbCablePackage([string]$Directory) {
    $problems = @(Get-VbCablePackageProblems $Directory)
    if ($problems.Count) { throw ('Incomplete VB-CABLE Pack45: ' + ($problems -join '; ')) }
}
