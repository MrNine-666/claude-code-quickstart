param(
    [Parameter(Mandatory = $true)]
    [string]$SourceExe
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$sourcePath = (Resolve-Path -LiteralPath $SourceExe).Path
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$smokeHome = Join-Path $tempRoot ('ccq-uninstall-smoke-' + [Guid]::NewGuid().ToString('N'))
$targetDir = Join-Path $smokeHome '.local\bin'
$targetExe = Join-Path $targetDir 'ccq.exe'
$previousHome = $env:CCQ_HOME
# helper 与其日志现写在目标 exe 同目录（$targetDir），不再落 $env:TEMP：
# CI Windows runner 上 Node os.tmpdir() 与 PowerShell $env:TEMP 是不同目录，
# 此前 smoke 在 $env:TEMP 查找导致既看不到残留 helper 也读不到日志。
$beforeHelpers = @()

try {
    New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    Copy-Item -LiteralPath $sourcePath -Destination $targetExe -Force
    $env:CCQ_HOME = $smokeHome

    $uninstallOutput = @(& $targetExe uninstall --yes 2>&1)
    $uninstallExitCode = $LASTEXITCODE
    if ($uninstallExitCode -ne 0) {
        throw "ccq uninstall failed with exit code ${uninstallExitCode}:`n$($uninstallOutput -join "`n")"
    }

    $newHelpers = @()
    $deadline = (Get-Date).AddSeconds(20)
    do {
        $newHelpers = @(
            Get-ChildItem -LiteralPath $targetDir -Force -Filter '.ccq-uninstall-*.ps1' -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName }
        )
        if (-not (Test-Path -LiteralPath $targetExe) -and $newHelpers.Count -eq 0) {
            break
        }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)

    if (Test-Path -LiteralPath $targetExe) {
        # 决定性诊断：helper 未删除 exe 时，dump uninstall 输出、helper 落盘日志与残留 helper，
        # 避免只凭 20s 超时结论盲猜（helper 未启动 / Wait-Process 后死亡 / 删除被拒各有不同日志痕迹）。
        $helperLog = Join-Path $targetDir 'ccq-uninstall.log'
        $logContent = if (Test-Path -LiteralPath $helperLog) { Get-Content -LiteralPath $helperLog -Raw } else { '(no ccq-uninstall.log)' }
        $seenHelpers = @(
            Get-ChildItem -LiteralPath $targetDir -Force -Filter '.ccq-uninstall-*.ps1' -ErrorAction SilentlyContinue |
                ForEach-Object { $_.FullName }
        )
        $diag = @(
            'The running ccq.exe was not removed after its parent exited.',
            "uninstall exit code: ${uninstallExitCode}",
            "uninstall output:`n$($uninstallOutput -join "`n")",
            "residual helpers: $($seenHelpers -join ', ')",
            "helper log:`n$logContent"
        ) -join "`n----`n"
        throw $diag
    }
    if ($newHelpers.Count -ne 0) {
        throw "The uninstall helper did not self-clean: $($newHelpers.FullName -join ', ')"
    }
    Write-Host '[PASS] Windows ccq.exe compiled self-uninstall smoke' -ForegroundColor Green
} finally {
    $env:CCQ_HOME = $previousHome
    $resolvedSmokeHome = [IO.Path]::GetFullPath($smokeHome)
    if (-not $resolvedSmokeHome.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a non-temporary path: $resolvedSmokeHome"
    }
    Remove-Item -LiteralPath $resolvedSmokeHome -Recurse -Force -ErrorAction SilentlyContinue
}
