param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string]$ExpectedVersion
)
$ErrorActionPreference = 'Stop'
$version = @(& $Executable --version 2>&1)
if ($LASTEXITCODE -ne 0) { throw "--version failed: $($version -join "`n")" }
if (($version -join "`n").Trim() -ne $ExpectedVersion) { throw "Version mismatch: $($version -join "`n") (expected $ExpectedVersion)" }
& $Executable --help
if ($LASTEXITCODE -ne 0) { throw '--help failed' }
$output = @(& $Executable 2>&1)
if ($LASTEXITCODE -ne 0) { throw "non-TTY smoke failed: $($output -join "`n")" }
