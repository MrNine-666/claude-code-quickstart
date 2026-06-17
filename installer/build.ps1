#Requires -Version 7.0
# build.ps1 - Windows 单文件打包构建脚本
# 作者: 哈雷酱 (本小姐的构建工具杰作！)
# 功能: 将 Windows 多文件安装器打包成独立可分发的单文件脚本

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-BuildManifest {
    <#
    .SYNOPSIS
    读取跨平台构建清单，统一 artifact 名称、入口与 core 顺序。
    #>
    param()

    $manifestPath = Join-Path $PSScriptRoot 'contracts\build.json'
    if (-not (Test-Path $manifestPath -PathType Leaf)) {
        throw "构建清单不存在: $manifestPath"
    }

    return (Get-Content -Path $manifestPath -Encoding UTF8 -Raw | ConvertFrom-Json -AsHashtable)
}

function Get-BuildArtifactConfig {
    <#
    .SYNOPSIS
    从构建清单中获取 Windows 指定角色的 artifact 配置。
    #>
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Windows')]
        [string]$Platform,

        [Parameter(Mandatory)]
        [string]$Role
    )

    $manifest = Get-BuildManifest
    $artifacts = @($manifest[$Platform]['Artifacts'])
    foreach ($artifact in $artifacts) {
        if ([string]$artifact['Role'] -eq $Role) {
            return $artifact
        }
    }
    throw "未找到构建 artifact 配置: $Platform/$Role"
}

function Get-BuildArtifactPathList {
    <#
    .SYNOPSIS
    从 artifact 配置字段读取路径数组。
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$Artifact,

        [Parameter(Mandatory)]
        [string]$FieldName
    )

    if (-not $Artifact.ContainsKey($FieldName)) {
        return ,@()
    }
    $items = @($Artifact[$FieldName] | ForEach-Object { [string]$_ })
    return ,$items
}

function ConvertTo-WindowsBuildPath {
    <#
    .SYNOPSIS
    将 Registry 返回的 Windows 步骤路径归一化为 installer/ 相对 canonical 路径。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $normalized = $Path -replace '\\', '/'
    if ($normalized -like 'windows/*') {
        return $normalized
    }
    return "windows/$normalized"
}

function Get-BootstrapBuildOrder {
    <#
    .SYNOPSIS
    返回 Bootstrap 脚本构建时需要按顺序拼接的文件路径数组。
    #>
    $artifact = Get-BuildArtifactConfig -Platform Windows -Role Bootstrap
    $coreFiles = Get-BuildArtifactPathList -Artifact $artifact -FieldName 'CoreFiles'
    $order = @($coreFiles + @([string]$artifact['EntryFile']))
    return $order
}

function Get-InstallBuildOrder {
    <#
    .SYNOPSIS
    返回安装入口脚本构建时需要按顺序拼接的文件路径数组。
    #>
    $artifact = Get-BuildArtifactConfig -Platform Windows -Role Install
    $coreFiles = Get-BuildArtifactPathList -Artifact $artifact -FieldName 'CoreFiles'

    . "$PSScriptRoot\windows\core\Registry.ps1"
    $stepFiles = @(Get-StepFiles | ForEach-Object { ConvertTo-WindowsBuildPath -Path $_ })

    $order = @($coreFiles + $stepFiles + @([string]$artifact['EntryFile']))
    return $order
}

function Get-ManageBuildOrder {
    <#
    .SYNOPSIS
    返回管理入口脚本构建时需要按顺序拼接的文件路径数组。
    #>
    $artifact = Get-BuildArtifactConfig -Platform Windows -Role Manage
    $coreFiles = Get-BuildArtifactPathList -Artifact $artifact -FieldName 'CoreFiles'

    . "$PSScriptRoot\windows\core\Registry.ps1"
    $stepFiles = @(Get-StepFiles | ForEach-Object { ConvertTo-WindowsBuildPath -Path $_ })

    $order = @($coreFiles + $stepFiles + @([string]$artifact['EntryFile']))
    return $order
}

function Get-ScriptParamBlockInfo {
    <#
    .SYNOPSIS
    解析脚本的顶层 param 块，并返回其行号范围与原始文本行。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$ScriptPath
    )

    if (-not (Test-Path $ScriptPath -PathType Leaf)) {
        return $null
    }

    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $ScriptPath, [ref]$tokens, [ref]$errors
    )

    if (-not $ast.ParamBlock) {
        return $null
    }

    $startLine = $ast.ParamBlock.Extent.StartLineNumber
    $endLine = $ast.ParamBlock.Extent.EndLineNumber
    $allLines = @(Get-Content -Path $ScriptPath -Encoding UTF8)

    if ($allLines.Count -lt $startLine) {
        return $null
    }

    $paramLines = @($allLines[($startLine - 1)..($endLine - 1)])

    return @{
        StartLine = $startLine
        EndLine   = $endLine
        Lines     = $paramLines
    }
}

function Invoke-ManageBundleBuild {
    <#
    .SYNOPSIS
    调用 esbuild 将 manage.js + 子管理器打包为单文件 bundle dist/manage.js（P10 方案 3）。

    .DESCRIPTION
    取代 base64 多文件内嵌：manage.js 经 esbuild 静态打包全部子模块，由 wrapper 缓存到
    $TMPDIR/.ccq/manage.js 后运行。需要 node + esbuild（devDependency）。
    esbuild 不可用时告警跳过（不阻断 .ps1 产物构建；CI 在 npm ci 后产出 bundle）。

    .OUTPUTS
    System.Boolean - 构建成功返回 $true，跳过或失败返回 $false
    #>
    param(
        [Parameter(Mandatory)]
        [string]$InstallerRoot
    )

    $esbuildConfig = Join-Path $InstallerRoot 'contracts' 'scripts' 'esbuild.config.js'
    if (-not (Test-Path $esbuildConfig -PathType Leaf)) {
        Write-Host "[WARN] 未找到 esbuild 配置，跳过 manage.js bundle 构建: $esbuildConfig" -ForegroundColor Yellow
        return $false
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "[WARN] 未检测到 node，跳过 manage.js bundle 构建" -ForegroundColor Yellow
        return $false
    }

    $repoRoot = Split-Path $InstallerRoot -Parent
    $esbuildModule = Join-Path $repoRoot 'node_modules' 'esbuild'
    if (-not (Test-Path $esbuildModule -PathType Container)) {
        Write-Host "[WARN] 未安装 esbuild 依赖（请先 npm ci），跳过 manage.js bundle 构建" -ForegroundColor Yellow
        return $false
    }

    Write-Host '正在构建 manage.js 单文件 bundle (esbuild)...'
    & node $esbuildConfig
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] manage.js bundle 构建失败（esbuild 退出码 $LASTEXITCODE）" -ForegroundColor Red
        return $false
    }
    Write-Host '[PASS] manage.js 单文件 bundle 已生成' -ForegroundColor Green
    return $true
}

function Build-SingleFileScript {
    <#
    .SYNOPSIS
    将多个源文件合并为单个可分发脚本。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$InstallerRoot,

        [Parameter(Mandatory)]
        [string[]]$FileOrder,

        [Parameter(Mandatory)]
        [string]$OutputPath,

        [Parameter(Mandatory)]
        [string]$RequiresHeader,

        [string]$HoistParamFromRelativePath = '',

        [string]$OutputEncoding = 'UTF8'
    )

    foreach ($relPath in @($FileOrder)) {
        $fullPath = Join-Path $InstallerRoot $relPath
        if (-not (Test-Path $fullPath -PathType Leaf)) {
            throw "源文件不存在: $fullPath"
        }
    }

    $buffer = [System.Collections.Generic.List[string]]::new()
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $buffer.Add('# ═══════════════════════════════════════════════════════════════════════════════')
    $buffer.Add('# 本文件由 build.ps1 自动生成，请勿手动编辑')
    $buffer.Add("# 生成时间: $timestamp")
    $buffer.Add('# 原始文件:')
    foreach ($relPath in @($FileOrder)) {
        $buffer.Add("#   - $relPath")
    }
    $buffer.Add('# ═══════════════════════════════════════════════════════════════════════════════')
    $buffer.Add($RequiresHeader)
    $buffer.Add('')

    $hoistedParamInfo = $null
    if ($HoistParamFromRelativePath) {
        $paramSourcePath = Join-Path $InstallerRoot $HoistParamFromRelativePath
        $hoistedParamInfo = Get-ScriptParamBlockInfo -ScriptPath $paramSourcePath
        if (-not $hoistedParamInfo) {
            throw "未找到可提升的 param 块: $paramSourcePath"
        }

        foreach ($paramLine in @($hoistedParamInfo.Lines)) {
            $buffer.Add($paramLine)
        }
        $buffer.Add('')
    }

    $dotSourcePattern = '^\s*\.\s+'
    $scriptRootPattern = '^\s*\$scriptRoot\s*=\s*Split-Path\s+.*\$MyInvocation\.MyCommand\.Path'

    foreach ($relPath in @($FileOrder)) {
        $fullPath = Join-Path $InstallerRoot $relPath
        $buffer.Add('')
        $separator = '# ' + [string]::new([char]0x2500, 3) + " 来自: $relPath " + [string]::new([char]0x2500, 40)
        $buffer.Add($separator)
        $buffer.Add('')

        $lines = @(Get-Content -Path $fullPath -Encoding UTF8)
        $lineNumber = 0
        foreach ($line in $lines) {
            $lineNumber++

            if ($hoistedParamInfo -and
                $relPath -eq $HoistParamFromRelativePath -and
                $lineNumber -ge $hoistedParamInfo.StartLine -and
                $lineNumber -le $hoistedParamInfo.EndLine) {
                continue
            }

            if ($line -match $dotSourcePattern) { continue }
            if ($line -match '^\s*#Requires\s') { continue }
            if ($line -match $scriptRootPattern) { continue }
            $buffer.Add($line)
        }
    }

    $outputDir = Split-Path -Parent $OutputPath
    if (-not (Test-Path $outputDir -PathType Container)) {
        New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    }

    $tempPath = Join-Path $outputDir ("_tmp_" + [System.IO.Path]::GetRandomFileName() + ".ps1")
    try {
        $buffer -join "`r`n" | Set-Content -Path $tempPath -Encoding $OutputEncoding -NoNewline
        Move-Item -Path $tempPath -Destination $OutputPath -Force
    }
    catch {
        if (Test-Path $tempPath) {
            Remove-Item -Path $tempPath -Force -ErrorAction SilentlyContinue
        }
        throw
    }

    Write-Host "[PASS] 已生成: $OutputPath" -ForegroundColor Green
}

function Test-BuiltScriptSyntax {
    <#
    .SYNOPSIS
    使用 PowerShell 解析器检验脚本语法。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$ScriptPath
    )

    if (-not (Test-Path $ScriptPath -PathType Leaf)) {
        Write-Host "[FAIL] 文件不存在: $ScriptPath" -ForegroundColor Red
        return $false
    }

    $errors = $null
    $null = [System.Management.Automation.Language.Parser]::ParseFile(
        $ScriptPath, [ref]$null, [ref]$errors
    )

    $parseErrors = @($errors)
    if ($parseErrors.Count -gt 0) {
        Write-Host "[FAIL] 语法错误 ($ScriptPath):" -ForegroundColor Red
        foreach ($err in $parseErrors) {
            Write-Host "  行 $($err.Extent.StartLineNumber): $($err.Message)" -ForegroundColor Red
        }
        return $false
    }

    Write-Host "[PASS] 语法检查通过: $ScriptPath" -ForegroundColor Green
    return $true
}

function Clear-KnownBuildArtifacts {
    <#
    .SYNOPSIS
    清理输出目录中的当前平台构建产物，避免旧产物残留。
    .DESCRIPTION
    Windows 构建入口只清理 Windows 产物（.ps1），保留 macOS 产物（.sh）。
    macOS 构建入口应只清理 macOS 产物（.sh），保留 Windows 产物（.ps1）。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$OutputDir,

        [Parameter(Mandatory)]
        [ValidateSet('Windows', 'macOS')]
        [string]$Platform
    )

    $filesToClean = if ($Platform -eq 'Windows') {
        @('bootstrap.ps1', 'install.ps1', 'manage.ps1')
    } else {
        @('install.sh', 'manage.sh')
    }

    foreach ($fileName in $filesToClean) {
        $path = Join-Path $OutputDir $fileName
        if (Test-Path $path -PathType Leaf) {
            Remove-Item -Path $path -Force
        }
    }
}

function Assert-ExpectedWindowsOutputs {
    <#
    .SYNOPSIS
    确认 Windows 构建入口生成了 Windows 三个 artifact。
    .DESCRIPTION
    不再禁止 macOS 产物存在，允许两个平台产物共存。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$OutputDir
    )

    $expected = @('bootstrap.ps1', 'install.ps1', 'manage.ps1')
    foreach ($fileName in $expected) {
        $path = Join-Path $OutputDir $fileName
        if (-not (Test-Path $path -PathType Leaf)) {
            throw "缺少预期 Windows 构建产物: $path"
        }
    }
}

function Main {
    <#
    .SYNOPSIS
    Windows 构建入口：只生成 bootstrap.ps1、install.ps1、manage.ps1。
    .PARAMETER InstallerRoot
    installer/ 目录的绝对路径。
    .PARAMETER OutputDir
    输出目录路径。
    .PARAMETER Platform
    保留兼容参数名，但仅允许 Windows。
    #>
    param(
        [string]$InstallerRoot = (Resolve-Path $PSScriptRoot).Path,
        [string]$OutputDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'dist'),
        [ValidateSet('Windows')]
        [string]$Platform = 'Windows'
    )

    if (-not (Test-Path $InstallerRoot -PathType Container)) {
        throw "InstallerRoot 不是有效目录: $InstallerRoot"
    }

    Write-Host '═══════════════════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host '  Claude Code 安装器 - Windows 单文件构建工具' -ForegroundColor Cyan
    Write-Host '═══════════════════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host ''
    Write-Host "安装器根目录: $InstallerRoot"
    Write-Host "输出目录:     $OutputDir"
    Write-Host "构建平台:     $Platform"
    Write-Host ''

    if (-not (Test-Path $OutputDir -PathType Container)) {
        New-Item -ItemType Directory -Path $OutputDir -Force | Out-Null
        Write-Host "已创建输出目录: $OutputDir"
    }
    Clear-KnownBuildArtifacts -OutputDir $OutputDir -Platform $Platform

    # 构建 manage.js 单文件 bundle（P10 方案 3：esbuild 打包，取代 base64 内嵌）
    Write-Host ''
    Write-Host '─── 构建 manage.js 单文件 bundle ──────────────────────────' -ForegroundColor Yellow
    $null = Invoke-ManageBundleBuild -InstallerRoot $InstallerRoot

    $builtItems = [System.Collections.Generic.List[hashtable]]::new()
    $allOk = $true

    Write-Host ''
    Write-Host '─── 构建 Windows Bootstrap 单文件版本 ──────────────────────' -ForegroundColor Yellow
    $bootstrapArtifact = Get-BuildArtifactConfig -Platform Windows -Role Bootstrap
    $bootstrapOrder = @(Get-BootstrapBuildOrder)
    $bootstrapOutput = Join-Path $OutputDir ([string]$bootstrapArtifact['OutputFile'])
    Build-SingleFileScript `
        -InstallerRoot $InstallerRoot `
        -FileOrder $bootstrapOrder `
        -OutputPath $bootstrapOutput `
        -RequiresHeader ([string]$bootstrapArtifact['RequiresHeader']) `
        -OutputEncoding ([string]$bootstrapArtifact['OutputEncoding'])

    Write-Host ''
    Write-Host '─── 构建 Windows Install 单文件版本 ───────────────────────' -ForegroundColor Yellow
    $installArtifact = Get-BuildArtifactConfig -Platform Windows -Role Install
    $installOrder = @(Get-InstallBuildOrder)
    $installOutput = Join-Path $OutputDir ([string]$installArtifact['OutputFile'])
    Build-SingleFileScript `
        -InstallerRoot $InstallerRoot `
        -FileOrder $installOrder `
        -OutputPath $installOutput `
        -RequiresHeader ([string]$installArtifact['RequiresHeader']) `
        -HoistParamFromRelativePath ([string]$installArtifact['HoistParamFrom']) `
        -OutputEncoding ([string]$installArtifact['OutputEncoding'])

    Write-Host ''
    Write-Host '─── 构建 Windows Manage 单文件版本 ────────────────────────' -ForegroundColor Yellow
    $manageArtifact = Get-BuildArtifactConfig -Platform Windows -Role Manage
    $manageOrder = @(Get-ManageBuildOrder)
    $manageOutput = Join-Path $OutputDir ([string]$manageArtifact['OutputFile'])
    Build-SingleFileScript `
        -InstallerRoot $InstallerRoot `
        -FileOrder $manageOrder `
        -OutputPath $manageOutput `
        -RequiresHeader ([string]$manageArtifact['RequiresHeader']) `
        -HoistParamFromRelativePath ([string]$manageArtifact['HoistParamFrom']) `
        -OutputEncoding ([string]$manageArtifact['OutputEncoding'])

    Write-Host ''
    Write-Host '─── Windows 语法检查 ──────────────────────────────────────' -ForegroundColor Yellow
    $bootstrapOk = Test-BuiltScriptSyntax -ScriptPath $bootstrapOutput
    $installOk = Test-BuiltScriptSyntax -ScriptPath $installOutput
    $manageOk = Test-BuiltScriptSyntax -ScriptPath $manageOutput
    $allOk = $allOk -and $bootstrapOk -and $installOk -and $manageOk

    $builtItems.Add(@{ Name = 'Windows Bootstrap'; Path = $bootstrapOutput; Ok = $bootstrapOk })
    $builtItems.Add(@{ Name = 'Windows Install'; Path = $installOutput; Ok = $installOk })
    $builtItems.Add(@{ Name = 'Windows Manage'; Path = $manageOutput; Ok = $manageOk })

    Assert-ExpectedWindowsOutputs -OutputDir $OutputDir

    Write-Host ''
    Write-Host '═══════════════════════════════════════════════════════════════' -ForegroundColor Cyan
    Write-Host '  构建摘要' -ForegroundColor Cyan
    Write-Host '═══════════════════════════════════════════════════════════════' -ForegroundColor Cyan

    foreach ($item in $builtItems) {
        $size = if (Test-Path $item.Path -PathType Leaf) { (Get-Item $item.Path).Length } else { 0 }
        Write-Host "  $($item.Name): $($item.Path)"
        Write-Host "              大小: $([math]::Round($size / 1KB, 1)) KB | 语法: $(if ($item.Ok) { '[PASS]' } else { '[FAIL]' })"
    }
    Write-Host ''

    if ($allOk) {
        Write-Host '  Windows 构建完成！所有已校验文件通过。' -ForegroundColor Green
    }
    else {
        Write-Host '  Windows 构建完成，但存在语法错误，请检查。' -ForegroundColor Red
        exit 1
    }
}

Main @args
