# PowerShell 语法检查脚本
# 作者: 哈雷酱 (本小姐的专业测试工具！)

param(
    [string]$Path
)

Write-Host "🔍 开始检查 PowerShell 脚本语法..." -ForegroundColor Cyan

# 以脚本所在目录（repo 根）为锚点，无论 CWD 在哪都正确定位各 .ps1 来源
$repoRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
$installerRoot = if ($Path) { $Path } else { Join-Path $repoRoot 'installer' }

# 收集所有需要检查的文件：
#   installer/windows/**、installer/build.ps1、根级 contracts/**（含 Test-Contracts.ps1）、manage/scripts/**
#   注：contracts 已上升为根级，旧 installer/contracts 已不存在，必须扫根级 contracts 与 manage/scripts
$scriptFiles = @()
$scriptFiles += Get-ChildItem (Join-Path $installerRoot 'windows') -Recurse -Filter "*.ps1" -ErrorAction SilentlyContinue
$buildScript = Get-Item (Join-Path $installerRoot 'build.ps1') -ErrorAction SilentlyContinue
if ($buildScript) {
    $scriptFiles += $buildScript
}
$scriptFiles += Get-ChildItem (Join-Path $repoRoot 'contracts') -Recurse -Filter "*.ps1" -ErrorAction SilentlyContinue
$scriptFiles += Get-ChildItem (Join-Path $repoRoot 'manage/scripts') -Recurse -Filter "*.ps1" -ErrorAction SilentlyContinue

$totalFiles = $scriptFiles.Count
$passedFiles = 0
$failedFiles = 0

Write-Host "找到 $totalFiles 个 PowerShell 脚本文件" -ForegroundColor Yellow

foreach ($file in $scriptFiles) {
    Write-Host "检查: $($file.Name)" -NoNewline

    try {
        $tokens = $null
        $parseErrors = $null
        $null = [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$parseErrors)
        if (@($parseErrors).Count -gt 0) {
            $messages = @($parseErrors | ForEach-Object { "Line $($_.Extent.StartLineNumber): $($_.Message)" })
            throw ($messages -join "; ")
        }
        Write-Host " ✓" -ForegroundColor Green
        $passedFiles++
    }
    catch {
        Write-Host " ✗" -ForegroundColor Red
        Write-Host "  错误: $($_.Exception.Message)" -ForegroundColor Red
        $failedFiles++
    }
}

Write-Host "`n📊 语法检查结果:" -ForegroundColor Cyan
Write-Host "  总文件数: $totalFiles" -ForegroundColor White
Write-Host "  通过: $passedFiles" -ForegroundColor Green
Write-Host "  失败: $failedFiles" -ForegroundColor Red

if ($failedFiles -eq 0) {
    Write-Host "`n🎉 所有脚本语法检查通过！" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`n❌ 发现语法错误，请修复后重试" -ForegroundColor Red
    exit 1
}