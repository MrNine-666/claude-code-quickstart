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

    # 构建清单位于 installer/contracts/（TDR-10 拆分：build.json 归 installer）
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

function Get-ArtifactBuildOrder {
    <#
    .SYNOPSIS
    返回单个 Windows artifact（按 Role）构建时需要拼接的文件路径数组。
    .DESCRIPTION
    Role 数据驱动：CoreFiles 始终拼接；IncludeSteps 为真时才追加 step 模块；
    最后追加 EntryFile。Install 与 CcqDownload 共用同一段构建/校验代码，不按 role 复制。
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$Artifact
    )

    $coreFiles = Get-BuildArtifactPathList -Artifact $Artifact -FieldName 'CoreFiles'
    $order = @($coreFiles)

    if ($Artifact.ContainsKey('IncludeSteps') -and [bool]$Artifact['IncludeSteps']) {
        . "$PSScriptRoot\windows\core\Registry.ps1"
        $stepFiles = @(Get-StepFiles | ForEach-Object { ConvertTo-WindowsBuildPath -Path $_ })
        $order += $stepFiles
    }

    $order += [string]$Artifact['EntryFile']
    return ,@($order)
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

    function ConvertTo-Base64LineList {
        param(
            [Parameter(Mandatory)]
            [string]$Text,

            [int]$LineWidth = 76
        )

        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $base64 = [Convert]::ToBase64String($bytes)
        $lines = [System.Collections.Generic.List[string]]::new()
        for ($offset = 0; $offset -lt $base64.Length; $offset += $LineWidth) {
            $length = [Math]::Min($LineWidth, $base64.Length - $offset)
            $lines.Add($base64.Substring($offset, $length))
        }
        return ,@($lines)
    }

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

    # Raw main/dist 脚本必须是纯 ASCII trampoline：Windows PowerShell 5.1 的远程响应
    # 可能按 Latin1/ANSI 解码，BOM 也无法纠正。
    # 让外层脚本只包含 ASCII，再在本机用 UTF-8 还原真实脚本，才能保留 irm|iex 入口。
    $scriptText = $buffer -join "`r`n"
    $outputText = $scriptText
    $effectiveEncoding = $OutputEncoding
    if ($OutputEncoding -eq 'asciiTrampoline') {
        $base64Lines = @(ConvertTo-Base64LineList -Text $scriptText)
        $trampoline = [System.Collections.Generic.List[string]]::new()
        $trampoline.Add('#Requires -Version 5.1')
        $trampoline.Add('# This ASCII trampoline preserves irm|iex compatibility on Windows PowerShell 5.1.')
        $trampoline.Add('$ErrorActionPreference = ''Stop''')
        $trampoline.Add('$script = @''')
        foreach ($base64Line in $base64Lines) {
            $trampoline.Add($base64Line)
        }
        $trampoline.Add('''@')
        $trampoline.Add('$bytes = [Convert]::FromBase64String(($script -replace ''\s'', ''''))')
        $trampoline.Add('$text = [Text.Encoding]::UTF8.GetString($bytes)')
        $trampoline.Add('& ([scriptblock]::Create($text)) @args')
        $outputText = $trampoline -join "`r`n"
        $effectiveEncoding = 'ascii'
    }

    # 临时文件用 .tmp 而非 .ps1 扩展名：含 irm|iex 下载-执行特征的 install.ps1，其 .ps1 临时文件
    # 可能被 Windows Defender 在 Move 前直接删除/隔离，导致 "Cannot find path"（重试无法挽回）。
    # .tmp 不触发 Defender 对 PowerShell 脚本的启发式扫描，规避临时阶段被删；Move 后才成为 .ps1。
    $tempPath = Join-Path $outputDir ("_tmp_" + [System.IO.Path]::GetRandomFileName() + ".tmp")
    try {
        $outputText | Set-Content -Path $tempPath -Encoding $effectiveEncoding -NoNewline
        # Move 重试：Windows Defender 实时扫描可能瞬时锁定刚写入的大文件（尤其含下载-执行模式的
        # install.ps1），触发 Access denied。重试 5 次（间隔 300ms）让扫描句柄释放后再 Move。
        for ($moveAttempt = 1; ; $moveAttempt++) {
            try {
                Move-Item -Path $tempPath -Destination $OutputPath -Force
                break
            } catch {
                # 临时文件已不存在（被 Defender 删除等）则重试无意义，立即抛出清晰错误
                if (-not (Test-Path $tempPath)) { throw }
                if ($moveAttempt -ge 5) { throw }
                Start-Sleep -Milliseconds 300
            }
        }
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

function Assert-ExpectedWindowsOutputs {
    <#
    .SYNOPSIS
    确认 Windows scripts-only 构建入口生成了全部脚本。
    .DESCRIPTION
    不再禁止 macOS 产物存在，允许两个平台产物共存。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$OutputDir
    )

    $manifest = Get-BuildManifest
    foreach ($fileName in @($manifest['Windows']['Artifacts'] | ForEach-Object { $_['OutputFile'] })) {
        $path = Join-Path $OutputDir $fileName
        if (-not (Test-Path $path -PathType Leaf)) {
            throw "缺少预期 Windows 构建产物: $path"
        }
    }
}

function Main {
    <#
    .SYNOPSIS
    Windows 人工 scripts-only 构建入口：生成 install.ps1 / download-tui.ps1。
    .PARAMETER InstallerRoot
    installer/ 目录的绝对路径。
    .PARAMETER OutputDir
    输出目录路径。
    .PARAMETER Platform
    保留兼容参数名，但仅允许 Windows。
    .PARAMETER ScriptsOnly
    显式声明 scripts-only；默认也是此模式，不依赖已有 exe/gzip。
    .PARAMETER SkipTuiBuild
    兼容旧调用；当前入口始终只构建脚本。
    #>
    param(
        [string]$InstallerRoot = (Resolve-Path $PSScriptRoot).Path,
        [string]$OutputDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'dist'),
        [ValidateSet('Windows')]
        [string]$Platform = 'Windows',
        [switch]$ScriptsOnly,
        [switch]$SkipTuiBuild
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
    # 不预删已跟踪脚本；构建成功后由 Build-SingleFileScript 替换。

    # 安装脚本独立人工构建，不编译或检查 TUI 可执行文件。

    $builtItems = [System.Collections.Generic.List[hashtable]]::new()
    $allOk = $true

    # Role 数据驱动：Install 与 CcqDownload 共用同一段构建与语法校验代码，不按 role 复制粘贴。
    foreach ($artifact in @((Get-BuildManifest)['Windows']['Artifacts'])) {
        $role = [string]$artifact['Role']
        Write-Host ''
        Write-Host "─── 构建 Windows $role 单文件版本 ───────────────────────" -ForegroundColor Yellow
        $artifactOrder = Get-ArtifactBuildOrder -Artifact $artifact
        $artifactOutput = Join-Path $OutputDir ([string]$artifact['OutputFile'])
        $hoistParamFrom = if ($artifact.ContainsKey('HoistParamFrom')) { [string]$artifact['HoistParamFrom'] } else { '' }
        Build-SingleFileScript `
            -InstallerRoot $InstallerRoot `
            -FileOrder $artifactOrder `
            -OutputPath $artifactOutput `
            -RequiresHeader ([string]$artifact['RequiresHeader']) `
            -HoistParamFromRelativePath $hoistParamFrom `
            -OutputEncoding ([string]$artifact['OutputEncoding'])

        Write-Host ''
        Write-Host "─── Windows $role 语法检查 ─────────────────────────────────" -ForegroundColor Yellow
        $artifactOk = Test-BuiltScriptSyntax -ScriptPath $artifactOutput
        $allOk = $allOk -and $artifactOk

        $builtItems.Add(@{ Name = "Windows $role"; Path = $artifactOutput; Ok = $artifactOk })
    }

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
