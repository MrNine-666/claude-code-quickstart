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

function Invoke-ManageTuiPackage {
    <#
    .SYNOPSIS
    构建 TUI 可执行文件（4 平台交叉编译）到 dist/ 目录。

    .DESCRIPTION
    构建 OpenTUI TUI 可执行文件（4 平台交叉编译）。流程：
      1. 确保 Bun 可用（>=1.2.0）；
      2. 在 tui/ 子项目中执行 bun run build（调用 scripts/build.ts）；
      3. 产出 4 个 raw 可执行文件和对应 4 个 gzip 更新资产到 dist/:
         - ccq-windows-x64.exe
         - ccq-windows-arm64.exe
         - ccq-macos-x64
         - ccq-macos-arm64
    契约已通过 src/core/embedded-contracts.ts 静态 import 内嵌进可执行文件（TDR-4）。
    Bun 不可用时 warn 跳过（不阻断平台 .ps1 产物构建；CI 通过 release artifact 校验强制可执行文件）。

    .OUTPUTS
    System.Boolean - 构建成功返回 $true，跳过或失败返回 $false
    #>
    param(
        [Parameter(Mandatory)]
        [string]$InstallerRoot,

        [Parameter(Mandatory)]
        [string]$OutputDir
    )

    $repoRoot = Split-Path $InstallerRoot -Parent
    $tuiDir = Join-Path $repoRoot 'tui'
    if (-not (Test-Path $tuiDir -PathType Container)) {
        Write-Host "[WARN] 未找到 tui 子项目，跳过可执行文件构建: $tuiDir" -ForegroundColor Yellow
        return $false
    }

    # 检查 Bun（>=1.2.0）
    $bunCmd = Get-Command bun -ErrorAction SilentlyContinue
    if (-not $bunCmd) {
        Write-Host "[WARN] 未检测到 Bun，跳过 TUI 可执行文件构建" -ForegroundColor Yellow
        Write-Host "       请安装 Bun (https://bun.sh) 并确保在 PATH 中" -ForegroundColor Yellow
        return $false
    }

    # 验证 Bun 版本
    $bunVersion = & bun --version 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[WARN] 无法获取 Bun 版本，跳过 TUI 可执行文件构建" -ForegroundColor Yellow
        return $false
    }

    Write-Host "正在构建 TUI 可执行文件（Bun $bunVersion）..."
    Write-Host "工作目录: $tuiDir"

    # 执行 bun run build（调用 scripts/build.ts）
    Push-Location $tuiDir
    try {
        & bun run build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[FAIL] TUI 可执行文件构建失败（退出码 $LASTEXITCODE）" -ForegroundColor Red
            return $false
        }
    } finally {
        Pop-Location
    }

    # 验证产物并复制到 OutputDir；TUI 本地构建直接输出到 repo 根 dist/。
    $tuiArtifactDir = Join-Path $repoRoot 'dist'
    $manifest = Get-BuildManifest
    $expectedFiles = @(
        $manifest['BuildEntrypoints']['Windows']['Artifacts'] |
            Where-Object { [string]$_ -ne 'install.ps1' }
    )

    $allSuccess = $true
    foreach ($fileName in $expectedFiles) {
        $srcPath = Join-Path $tuiArtifactDir $fileName
        $destPath = Join-Path $OutputDir $fileName

        if (-not (Test-Path $srcPath -PathType Leaf)) {
            Write-Host "[FAIL] 缺失可执行文件: $fileName" -ForegroundColor Red
            $allSuccess = $false
            continue
        }

        # TUI 本地构建已直接写入 OutputDir；若调用方改了 OutputDir，则再复制过去。
        $srcFullPath = (Resolve-Path $srcPath).Path
        $destFullPath = [System.IO.Path]::GetFullPath($destPath)
        if ($srcFullPath -ne $destFullPath) {
            Copy-Item -Path $srcPath -Destination $destPath -Force
        }
        $sizeKB = [math]::Round((Get-Item $destPath).Length / 1KB, 1)
        Write-Host "[PASS] $fileName 已生成（$sizeKB KB）" -ForegroundColor Green
    }

    if (-not $allSuccess) {
        Write-Host "[FAIL] 部分可执行文件构建失败" -ForegroundColor Red
        return $false
    }

    Write-Host "[PASS] 所有 TUI 可执行文件构建完成" -ForegroundColor Green
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

    # Release install.ps1 必须是纯 ASCII trampoline：Windows PowerShell 5.1 的 Invoke-RestMethod
    # 对 GitHub Release application/octet-stream 会按 Latin1/ANSI 解码，BOM 也无法纠正。
    # 让外层脚本只包含 ASCII，再在本机用 UTF-8 还原真实脚本，才能保留 irm|iex 入口。
    $scriptText = $buffer -join "`r`n"
    $releaseTag = [Environment]::GetEnvironmentVariable('GITHUB_REF_NAME', 'Process')
    if ([string]::IsNullOrWhiteSpace($releaseTag) -or $releaseTag -notlike 'v*') {
        $releaseTag = '__CCQ_RELEASE_TAG__'
    }
    $scriptText = $scriptText.Replace('__CCQ_RELEASE_TAG__', $releaseTag)
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

function Clear-KnownBuildArtifacts {
    <#
    .SYNOPSIS
    清理输出目录中的当前平台构建产物，避免旧产物残留。
    .DESCRIPTION
    Windows 构建入口清理当前 Windows install 产物与旧 Manage/Bootstrap 残留，保留 macOS install 产物。
    macOS 构建入口应只清理 macOS 产物（.sh），保留 Windows 产物（.ps1）。
    .PARAMETER SkipTuiBuild
    为真时只清理 install 脚本与 legacy 残留，保留已交叉编译的 ccq-* 可执行产物与 gzip 更新资产，
    供 CI 下游 job 复用 build-tui job 下载的 artifact。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$OutputDir,

        [Parameter(Mandatory)]
        [ValidateSet('Windows', 'macOS')]
        [string]$Platform,

        [switch]$SkipTuiBuild
    )

    $manifest = Get-BuildManifest
    $platformKey = if ($Platform -eq 'Windows') { 'Windows' } else { 'MacOS' }
    $platformArtifacts = @($manifest['BuildEntrypoints'][$platformKey]['Artifacts'])
    $legacyArtifacts = if ($Platform -eq 'Windows') {
        # 旧 Manage/Bootstrap 残留（HC-DELETE-LEGACY）
        @('manage.ps1', 'bootstrap.ps1', 'manage.sh', 'manage-tui.tgz')
    } else {
        @()
    }

    # SkipTuiBuild 模式下保留交叉编译的可执行产物与 gzip 资产，只重建 install 脚本，
    # 因此这一层只清理 install 脚本与 legacy 残留，ccq-* 与 *.gz 留给 download-artifact 提供。
    if ($SkipTuiBuild) {
        $platformArtifactsConfig = @($manifest[$platformKey]['Artifacts'])
        $installOutputFile = ($platformArtifactsConfig | Where-Object { [string]$_['Role'] -eq 'Install' } |
            Select-Object -First 1)['OutputFile']
        $filesToClean = @([string]$installOutputFile) + $legacyArtifacts
    } else {
        $filesToClean = @($platformArtifacts + $legacyArtifacts)
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
    确认 Windows 构建入口生成了 Windows artifact（install.ps1 + 2 raw + 2 gzip）。
    .DESCRIPTION
    不再禁止 macOS 产物存在，允许两个平台产物共存。
    #>
    param(
        [Parameter(Mandatory)]
        [string]$OutputDir
    )

    $manifest = Get-BuildManifest
    $expected = @($manifest['BuildEntrypoints']['Windows']['Artifacts'])
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
    Windows 构建入口：生成 install.ps1 + 从 tui/dist 拷贝 2 raw + 2 gzip。
    .PARAMETER InstallerRoot
    installer/ 目录的绝对路径。
    .PARAMETER OutputDir
    输出目录路径。
    .PARAMETER Platform
    保留兼容参数名，但仅允许 Windows。
    .PARAMETER SkipTuiBuild
    为真时跳过 TUI 可执行文件交叉编译，并保留已存在的 ccq-* / gzip 产物，供 CI 下游 job
    复用 build-tui job 通过 download-artifact 提供的现成可执行文件。本地直接运行保持默认。
    #>
    param(
        [string]$InstallerRoot = (Resolve-Path $PSScriptRoot).Path,
        [string]$OutputDir = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot '..')).Path 'dist'),
        [ValidateSet('Windows')]
        [string]$Platform = 'Windows',
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
    Clear-KnownBuildArtifacts -OutputDir $OutputDir -Platform $Platform -SkipTuiBuild:$SkipTuiBuild

    # 构建 TUI 可执行文件（4 平台交叉编译）
    Write-Host ''
    Write-Host '─── 构建 TUI 可执行文件（4 平台） ─────────────────────────' -ForegroundColor Yellow
    if ($SkipTuiBuild) {
        Write-Host '[SKIP] SkipTuiBuild 已启用，跳过 TUI 可执行文件构建并复用现有产物' -ForegroundColor Yellow
    } else {
        $null = Invoke-ManageTuiPackage -InstallerRoot $InstallerRoot -OutputDir $OutputDir
    }

    $builtItems = [System.Collections.Generic.List[hashtable]]::new()
    $allOk = $true

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
    Write-Host '─── Windows 语法检查 ──────────────────────────────────────' -ForegroundColor Yellow
    $installOk = Test-BuiltScriptSyntax -ScriptPath $installOutput
    $allOk = $allOk -and $installOk

    $builtItems.Add(@{ Name = 'Windows Install'; Path = $installOutput; Ok = $installOk })

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
