# 外部命令执行封装 - CCQ
# 作者: 哈雷酱 (本小姐的专业封装！)
# 功能: 提供外部命令执行、PATH 刷新、版本检测等核心功能

#Requires -Version 5.1

# 严格模式
Set-StrictMode -Version Latest

# 全局配置
$script:DefaultRetryCount = 3
$script:DefaultTimeoutSeconds = 300

function New-CmdShellArguments {
    <#
    .SYNOPSIS
    构造 cmd.exe /c 参数，确保带空格的 .cmd/.bat shim 路径可执行。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandPath,

        [string[]]$Arguments = @()
    )

    $fullCommand = "`"$CommandPath`""
    if (@($Arguments).Count -gt 0) {
        $fullCommand += " " + (@($Arguments) -join ' ')
    }

    return @('/d', '/s', '/c', "`"$fullCommand`"")
}

function Invoke-ExternalCommand {
    <#
    .SYNOPSIS
    通用外部命令执行函数，支持重试和详细错误处理
    .PARAMETER Command
    要执行的命令
    .PARAMETER Arguments
    命令参数数组
    .PARAMETER WorkingDirectory
    工作目录
    .PARAMETER TimeoutSeconds
    超时时间（秒）
    .PARAMETER RetryCount
    重试次数
    .PARAMETER SuppressOutput
    抑制输出
    .RETURNS
    包含 ExitCode, Output, Error, ResolvedPath 的对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [string[]]$Arguments = @(),

        [string]$WorkingDirectory = $PWD,

        [int]$TimeoutSeconds = $script:DefaultTimeoutSeconds,

        [int]$RetryCount = $script:DefaultRetryCount,

        [switch]$SuppressOutput
    )

    $result = @{
        ExitCode = -1
        Output = ""
        Error = ""
        Success = $false
        Command = "$Command $($Arguments -join ' ')"
        ResolvedPath = ""
    }

    # 先解析命令路径，确定执行方式
    $cmdInfo = $null
    $actualFileName = $Command
    $actualArguments = $Arguments

    try {
        $cmdInfo = Get-Command $Command -ErrorAction Stop
        $result.ResolvedPath = $cmdInfo.Source

        # 根据命令类型选择执行方式
        if ($cmdInfo.CommandType -eq 'Application' -or $cmdInfo.CommandType -eq 'ExternalScript') {
            $extension = [System.IO.Path]::GetExtension($cmdInfo.Source).ToLower()

            # 对于 .cmd/.bat 文件，需要通过 cmd.exe 执行
            if ($extension -eq '.cmd' -or $extension -eq '.bat') {
                $actualFileName = 'cmd.exe'
                $actualArguments = New-CmdShellArguments -CommandPath $cmdInfo.Source -Arguments $Arguments
            }
            # 对于 .ps1 文件：优先用同目录同名 .cmd shim（不依赖 PS7、不受执行策略约束）
            elseif ($extension -eq '.ps1') {
                $ps1Dir = Split-Path -Parent $cmdInfo.Source
                $baseName = [System.IO.Path]::GetFileNameWithoutExtension($cmdInfo.Source)
                $cmdShimPath = Join-Path $ps1Dir "$baseName.cmd"

                if (Test-Path $cmdShimPath -PathType Leaf) {
                    # 同目录有 .cmd shim（npm.cmd / yarn.cmd / pnpm.cmd 等），走 cmd.exe
                    $actualFileName = 'cmd.exe'
                    $actualArguments = New-CmdShellArguments -CommandPath $cmdShimPath -Arguments $Arguments
                    $result.ResolvedPath = $cmdShimPath
                } else {
                    # 无 .cmd shim，回退 PowerShell 引擎（优先 pwsh，不可用则 powershell.exe）
                    $psEngine = if (Get-Command 'pwsh.exe' -ErrorAction SilentlyContinue) { 'pwsh.exe' } else { 'powershell.exe' }
                    $actualFileName = $psEngine
                    $ps1Path = $cmdInfo.Source
                    if ($ps1Path -match '\s') {
                        $ps1Path = "`"$ps1Path`""
                    }
                    $actualArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ps1Path) + $Arguments
                }
            }
            # 对于 .exe 文件，直接使用解析后的完整路径
            elseif ($extension -eq '.exe') {
                $actualFileName = $cmdInfo.Source
            }
        }
    } catch {
        # Get-Command 失败，尝试直接执行（可能是系统命令）
        $result.ResolvedPath = "未解析"
    }

    for ($attempt = 1; $attempt -le ($RetryCount + 1); $attempt++) {
        try {
            if (-not $SuppressOutput -and $attempt -gt 1) {
                Write-UiWarning "重试第 $($attempt - 1) 次: $($result.Command)"
            }

            # 构建进程启动信息
            $processInfo = New-Object System.Diagnostics.ProcessStartInfo
            $processInfo.FileName = $actualFileName
            $processInfo.Arguments = $actualArguments -join ' '
            $processInfo.WorkingDirectory = $WorkingDirectory
            $processInfo.UseShellExecute = $false
            $processInfo.RedirectStandardOutput = $true
            $processInfo.RedirectStandardError = $true
            $processInfo.CreateNoWindow = $true

            # 设置 UTF-8 编码避免中文乱码
            try {
                $processInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
                $processInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8
            } catch {
                # 低版本运行时可能不支持，保持默认行为
            }

            # 启动进程
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo = $processInfo

            try {
                # 启动进程
                [void]$process.Start()

                # 同步读取输出（避免快速命令输出丢失）
                $outputBuilder = New-Object System.Text.StringBuilder
                $errorBuilder = New-Object System.Text.StringBuilder

                # 异步读取任务
                $outputTask = $process.StandardOutput.ReadToEndAsync()
                $errorTask = $process.StandardError.ReadToEndAsync()

                # 等待进程完成或超时
                $elapsed = 0
                $heartbeatInterval = 1
                $heartbeatDelaySeconds = 2
                $heartbeatShown = $false

                while (-not $process.WaitForExit($heartbeatInterval * 1000)) {
                    $elapsed += $heartbeatInterval
                    if (-not $SuppressOutput -and $elapsed -ge $heartbeatDelaySeconds) {
                        Write-Host "`r  等待中... ($elapsed 秒)" -NoNewline
                        $heartbeatShown = $true
                    }
                    if ($elapsed -ge $TimeoutSeconds) {
                        if ($heartbeatShown) { Write-Host "" }
                        $process.Kill()
                        throw "命令执行超时 ($TimeoutSeconds 秒): $($result.Command)"
                    }
                }
                if ($heartbeatShown) { Write-Host "" }

                # 确保进程完全退出
                $process.WaitForExit()

                # 等待输出读取完成
                $outputText = $outputTask.GetAwaiter().GetResult()
                $errorText = $errorTask.GetAwaiter().GetResult()

                # 收集结果
                $result.ExitCode = $process.ExitCode
                $result.Output = $outputText.Trim()
                $result.Error = $errorText.Trim()
                $result.Success = ($process.ExitCode -eq 0)

                if ($result.Success) {
                    if (-not $SuppressOutput -and $result.Output) {
                        Write-Host $result.Output
                    }
                    return $result
                } else {
                    $errorMessage = "命令执行失败 (退出码: $($result.ExitCode)): $($result.Command)"
                    if ($result.Error) {
                        $errorMessage += "`n错误输出: $($result.Error)"
                    }
                    if ($result.ResolvedPath) {
                        $errorMessage += "`n解析路径: $($result.ResolvedPath)"
                    }

                    if ($attempt -le $RetryCount) {
                        Write-UiWarning $errorMessage
                        Start-Sleep -Seconds (2 * $attempt)
                        continue
                    } else {
                        throw $errorMessage
                    }
                }
            } finally {
                # 确保进程被清理
                if (-not $process.HasExited) {
                    try { $process.Kill() } catch { }
                }
                $process.Dispose()
            }
        } catch {
            $result.Error = $_.Exception.Message

            if ($attempt -le $RetryCount) {
                Write-UiWarning "执行失败，准备重试: $($_.Exception.Message)"
                Start-Sleep -Seconds (2 * $attempt)
                continue
            } else {
                throw
            }
        }
    }

    return $result
}

function Invoke-WingetInstall {
    <#
    .SYNOPSIS
    使用 winget 安装软件包的模板函数
    .PARAMETER PackageId
    软件包 ID
    .PARAMETER PackageName
    软件包显示名称（用于日志）
    .PARAMETER AcceptLicense
    自动接受许可证
    .PARAMETER Silent
    静默安装
    .PARAMETER Force
    强制安装
    .PARAMETER InstallerType
    指定 winget 安装器类型（如 wix / msi / exe），用于消除同一包 ID 在多种安装器
    （MSI 与 MSIX）间的歧义。留空则由 winget manifest 默认决定。
    .RETURNS
    安装结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageId,

        [string]$PackageName = $PackageId,

        [switch]$AcceptLicense,

        [switch]$Silent,

        [switch]$Force,

        [string]$InstallerType = ""
    )

    # 检查 winget 可用性
    if (-not (Test-CommandAvailable -Command "winget")) {
        throw "winget 不可用，无法安装 $PackageName"
    }

    # 构建参数
    $arguments = @("install", "--id", $PackageId, "-e", "--source", "winget", "--disable-interactivity")

    if ($AcceptLicense) { $arguments += "--accept-package-agreements", "--accept-source-agreements" }
    if ($Silent) { $arguments += "--silent" }
    if ($Force) { $arguments += "--force" }
    # --installer-type：消除同包 ID 多安装器歧义（如 PowerShell 7.6+ winget 默认发 MSIX，
    # 在无 Store/未就绪环境留下 0 字节执行别名空壳存根，启动时抛 0xc0ea0001；
    # 指定 wix 强制 MSI 真身装到 Program Files，不注册 WindowsApps 别名）
    if ($InstallerType) { $arguments += "--installer-type", $InstallerType }

    Write-UiPrimary "正在安装 $PackageName..."

    $maxAttempts = 2
    $timeoutSeconds = 300

    try {
        for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
            $proc = $null
            try {
                if ($attempt -gt 1) {
                    Write-UiWarning "重试第 $($attempt - 1) 次安装: $PackageName"
                }

                # 输出模式：-Silent 时重定向输出（抑制 winget 进度条噪音，如 "Removed N of M files"）
                # 非 Silent 时直通模式，让 winget 进度条直接写入控制台
                # !! 强约束 SC-WINGET-OUTPUT !!：禁止在 -Silent 模式下使用直通模式
                # （RedirectStandardOutput=$false + RedirectStandardError=$false 会导致进度条输出泄漏到终端）
                $procInfo = New-Object System.Diagnostics.ProcessStartInfo
                $procInfo.FileName = "winget"
                $procInfo.Arguments = $arguments -join ' '
                $procInfo.UseShellExecute = $false
                $procInfo.RedirectStandardOutput = $Silent.IsPresent
                $procInfo.RedirectStandardError = $Silent.IsPresent
                $procInfo.CreateNoWindow = $Silent.IsPresent

                $proc = New-Object System.Diagnostics.Process
                $proc.StartInfo = $procInfo
                [void]$proc.Start()

                # -Silent 模式下已重定向输出，必须异步消费缓冲区，否则缓冲区满时 WaitForExit 会死锁
                $outputTask = $null
                $errorTask  = $null
                if ($Silent.IsPresent) {
                    $outputTask = $proc.StandardOutput.ReadToEndAsync()
                    $errorTask  = $proc.StandardError.ReadToEndAsync()
                }

                # 超时保护：避免 winget 异常时无限等待
                if (-not $proc.WaitForExit($timeoutSeconds * 1000)) {
                    try { $proc.Kill() } catch { }
                    throw "winget 安装超时 ($timeoutSeconds 秒)"
                }

                $exitCode = $proc.ExitCode

                if ($exitCode -eq 0) {
                    Write-UiSuccess "✓ $PackageName 安装成功" -Level Detail

                    # 刷新 PATH 以确保新安装的命令可用
                    Refresh-SessionPath

                    return @{
                        Success = $true
                        PackageId = $PackageId
                        PackageName = $PackageName
                        Output = ""
                    }
                } else {
                    throw "winget 安装失败 (退出码: $exitCode)"
                }
            } catch {
                if ($attempt -lt $maxAttempts) {
                    Write-UiWarning "安装失败，准备重试: $($_.Exception.Message)"
                    Start-Sleep -Seconds (2 * $attempt)
                    continue
                }
                throw
            } finally {
                if ($proc) { $proc.Dispose() }
            }
        }
    } catch {
        Write-UiDanger "✗ $PackageName 安装失败: $($_.Exception.Message)"
        throw
    }
}

function Get-LatestWingetBundleUrl {
    <#
    .SYNOPSIS
    解析 winget-cli 最新 Release 的 .msixbundle 下载地址
    .DESCRIPTION
    经 GitHub API 获取 microsoft/winget-cli latest release，
    返回 assets 中以 .msixbundle 结尾的下载 URL；失败返回 $null。
    PS5.1 兼容（Invoke-RestMethod 原生可用）。
    .RETURNS
    string（下载 URL）或 $null
    #>
    param()

    try {
        $api = "https://api.github.com/repos/microsoft/winget-cli/releases/latest"
        $release = Invoke-RestMethod -Uri $api -Headers @{ "User-Agent" = "ccq-installer" } -TimeoutSec 30
        $bundle = $release.assets | Where-Object { $_.browser_download_url -like "*.msixbundle" } | Select-Object -First 1
        if ($bundle) {
            return $bundle.browser_download_url
        }
    } catch {
        Write-UiWarning "⚠ 无法获取 winget 最新版本信息: $($_.Exception.Message)"
    }

    return $null
}

function Install-Winget {
    <#
    .SYNOPSIS
    检测并自动安装 winget（Microsoft.DesktopAppInstaller / App Installer）
    .DESCRIPTION
    winget 缺失时自动安装：按 CPU 架构下载 VCLibs + Microsoft.UI.Xaml 依赖与
    winget 主包 .msixbundle，按「依赖先于主包」顺序经 Add-AppxPackage 安装；
    系统不支持 Add-AppxPackage 或安装失败时回退打开 Microsoft Store + 手动指引。

    可复用资产：供 Install.ps1 PS5.1 入口段与 Install-PowerShell7 复用（DRY）。
    PS5.1 兼容（不使用 PS7 专有语法，预期在 PS7 加载前的入口段上下文调用，
    Add-AppxPackage 原生可用）；HC-15：下载落 $env:TEMP，不依赖 $PSScriptRoot。

    接入点（Phase 2 install 瘦身）：入口段 winget 检测分支 + Install-PowerShell7
    winget 缺失分支。本函数仅用警告级输出，不抛致命错误，由调用方决定后续流程。
    .PARAMETER Force
    即使 winget 已可用也强制重新安装
    .RETURNS
    @{ Success; AlreadyInstalled; Method; ErrorMessage }
    Method: "already" | "appx" | "store-fallback" | "failed"
    #>
    param(
        [switch]$Force
    )

    $result = @{
        Success          = $false
        AlreadyInstalled = $false
        Method           = "failed"
        ErrorMessage     = ""
    }

    # 1. 已可用则跳过（除非 -Force）
    if (-not $Force -and (Test-CommandAvailable -Command "winget")) {
        $result.Success          = $true
        $result.AlreadyInstalled = $true
        $result.Method           = "already"
        Write-UiSuccess "✓ winget 已可用" -Level Detail
        return $result
    }

    Write-UiPrimary "正在安装 winget (App Installer)..."

    # 2. Add-AppxPackage 自动安装路径
    try {
        if (Get-Command -Name "Add-AppxPackage" -ErrorAction SilentlyContinue) {
            # 按 CPU 架构选择依赖包（ARM64 / x64）
            if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
                $vcLibsUrl = "https://aka.ms/Microsoft.VCLibs.arm64.14.00.Desktop.appx"
                $uiXamlUrl = "https://github.com/microsoft/microsoft-ui-xaml/releases/download/v2.8.6/Microsoft.UI.Xaml.2.8.arm64.appx"
            } else {
                $vcLibsUrl = "https://aka.ms/Microsoft.VCLibs.x64.14.00.Desktop.appx"
                $uiXamlUrl = "https://github.com/microsoft/microsoft-ui-xaml/releases/download/v2.8.6/Microsoft.UI.Xaml.2.8.x64.appx"
            }

            # HC-15：下载目录固定 $env:TEMP，不依赖源码路径
            $tmpDir = Join-Path $env:TEMP "ccq-winget"
            if (-not (Test-Path -Path $tmpDir)) {
                New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
            }

            $vcLibsPath = Join-Path $tmpDir "Microsoft.VCLibs.Desktop.appx"
            $uiXamlPath = Join-Path $tmpDir "Microsoft.UI.Xaml.appx"
            $wingetPath = Join-Path $tmpDir "Microsoft.DesktopAppInstaller.msixbundle"

            $wingetUrl = Get-LatestWingetBundleUrl
            if (-not $wingetUrl) {
                throw "无法解析 winget 主包下载地址"
            }

            # 下载依赖与主包（复用 Invoke-FileDownload：自绘进度条 + CTRL+C 可中断，规避 Invoke-WebRequest 原生进度条噪音）
            Write-UiInfo "下载 winget 依赖与主包..."
            $wingetDownloads = @(
                @{ Url = $vcLibsUrl; OutPath = $vcLibsPath; Desc = "VCLibs 依赖" },
                @{ Url = $uiXamlUrl; OutPath = $uiXamlPath; Desc = "UI.Xaml 依赖" },
                @{ Url = $wingetUrl;  OutPath = $wingetPath; Desc = "winget 主包" }
            )
            foreach ($pkg in $wingetDownloads) {
                $dlRes = Invoke-FileDownload -Url $pkg.Url -OutputPath $pkg.OutPath -Description $pkg.Desc
                if (-not $dlRes.Success) {
                    throw "下载 $($pkg.Desc) 失败: $($dlRes.ErrorMessage)"
                }
            }

            # 安装顺序强约束：依赖先于主包（否则 HRESULT 0x80073CF3 依赖缺失）
            Add-AppxPackage -Path $vcLibsPath -ErrorAction Stop
            Add-AppxPackage -Path $uiXamlPath -ErrorAction Stop
            Add-AppxPackage -Path $wingetPath -DependencyPath @($vcLibsPath, $uiXamlPath) -ErrorAction Stop

            # 刷新 PATH 并复检
            Refresh-SessionPath
            if (Test-CommandAvailable -Command "winget") {
                $result.Success = $true
                $result.Method  = "appx"
                Write-UiSuccess "✓ winget 安装成功"
                return $result
            }

            throw "安装后 winget 命令仍不可用"
        } else {
            Write-UiWarning "⚠ 当前系统不支持 Add-AppxPackage（可能为 Server Core 或 AppX 策略受限）"
        }
    } catch {
        Write-UiWarning "⚠ winget 自动安装失败: $($_.Exception.Message)"
    }

    # 3. Microsoft Store 兜底（不中断整体流程）
    try {
        Write-UiInfo "尝试打开 Microsoft Store 安装『应用安装程序 (App Installer)』..."
        Start-Process -FilePath "ms-windows-store://pdp/?productid=9NBLGGH4NNS1" -ErrorAction Stop
        $result.Method       = "store-fallback"
        $result.ErrorMessage = "已打开 Microsoft Store，请手动安装 App Installer 后重新运行脚本"
        Write-UiInfo "已打开 Microsoft Store，请手动安装『应用安装程序』后重新运行脚本"
    } catch {
        $result.Method       = "failed"
        $result.ErrorMessage = "winget 不可用且无法自动安装；请手动安装 App Installer：https://aka.ms/getwinget"
        Write-UiWarning "⚠ $($result.ErrorMessage)"
    }

    return $result
}

function Invoke-NpmGlobalInstall {
    <#
    .SYNOPSIS
    使用 npm 全局安装包的模板函数
    .PARAMETER PackageName
    npm 包名
    .PARAMETER Version
    指定版本
    .PARAMETER Force
    强制安装
    .RETURNS
    安装结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageName,

        [string]$Version,

        [switch]$Force
    )

    # 检查 npm 可用性
    if (-not (Test-CommandAvailable -Command "npm")) {
        throw "npm 不可用，无法安装 $PackageName"
    }

    # 构建包名和版本
    $fullPackageName = $PackageName
    if ($Version) {
        $fullPackageName += "@$Version"
    }

    # 构建参数
    $arguments = @("install", "-g", $fullPackageName)
    if ($Force) { $arguments += "--force" }

    Write-UiPrimary "正在全局安装 npm 包: $fullPackageName..."

    try {
        $result = Invoke-ExternalCommand -Command "npm" -Arguments $arguments -TimeoutSeconds 300

        if ($result.Success) {
            Write-UiSuccess "✓ $fullPackageName 安装成功" -Level Detail

            # 刷新 PATH 以确保新安装的命令可用
            Refresh-SessionPath

            return @{
                Success = $true
                PackageName = $PackageName
                Version = $Version
                FullPackageName = $fullPackageName
                Output = $result.Output
            }
        } else {
            throw "npm 安装失败: $($result.Error)"
        }
    } catch {
        Write-UiDanger "✗ $fullPackageName 安装失败: $($_.Exception.Message)"
        throw
    }
}

# npm 全局过期包缓存（会话级，避免重复查询）
$script:NpmOutdatedCache = $null

function Get-NpmOutdatedGlobal {
    <#
    .SYNOPSIS
    查询所有全局 npm 包的过期状态（带会话缓存）
    .DESCRIPTION
    调用 npm outdated -g --json，返回过期包的 hashtable。
    结果缓存在 $script:NpmOutdatedCache，同一会话内只查询一次。
    对 fnm 环境特殊处理：fnm multishell 临时目录会导致 npm outdated -g
    返回空结果，需解析 junction 真实目标并通过 --prefix 指定。
    .PARAMETER Force
    忽略缓存强制重新查询
    .RETURNS
    hashtable: packageName -> @{ Current; Latest }
    仅包含有更新的包，不在结果中 = 已最新
    #>
    param([switch]$Force)

    if (-not $Force -and $null -ne $script:NpmOutdatedCache) {
        return $script:NpmOutdatedCache
    }

    $outdated = @{}

    try {
        # fnm/nvm 链接前缀修正：链接目录下 npm outdated -g 可能返回空结果
        $arguments = @("outdated", "-g", "--json")
        try {
            $prefixResult = Invoke-ExternalCommand -Command "npm" `
                -Arguments @("prefix", "-g") `
                -SuppressOutput -TimeoutSeconds 10 -RetryCount 0
            if ($prefixResult.Success -and $prefixResult.Output) {
                $prefix = $prefixResult.Output.Trim()
                # ResolveLinkTarget($path, $true) 递归解析 junction/symlink 链（.NET 6+ / PS 7.3+）
                try {
                    $resolved = [System.IO.Directory]::ResolveLinkTarget($prefix, $true)
                    if ($null -ne $resolved -and (Test-Path $resolved.FullName) -and $resolved.FullName -ne $prefix) {
                        $arguments += @("--prefix", $resolved.FullName)
                    }
                } catch {
                    # PS 7.0-7.2 不支持 ResolveLinkTarget，降级跳过 --prefix
                }
            }
        } catch {
            # 解析失败不阻塞，继续使用默认行为
        }

        # npm outdated -g 有过期包时 exit 1（正常行为），无过期时 exit 0
        # Invoke-ExternalCommand 对非零退出码会 throw，而 npm outdated 的 exit 1 是正常语义
        # 因此这里直接调用 npm，不走 Invoke-ExternalCommand
        $jsonOutput = & npm @arguments 2>$null
        # 忽略 $LASTEXITCODE，npm outdated exit 0=全部最新, exit 1=有过期包（均为合法结果）

        $jsonText = if ($jsonOutput) { ($jsonOutput -join "`n").Trim() } else { "" }
        if (-not [string]::IsNullOrWhiteSpace($jsonText)) {
            $parsed = $jsonText | ConvertFrom-JsonToHashtable -ErrorAction SilentlyContinue
            if ($null -ne $parsed) {
                foreach ($pkg in $parsed.Keys) {
                    $info = $parsed[$pkg]
                    $outdated[$pkg] = @{
                        Current = $info["current"]
                        Latest  = $info["latest"]
                    }
                }
            }
        }
    }
    catch {
        # 查询失败不阻塞，返回空 hashtable（各步骤降级为旧行为）
    }

    $script:NpmOutdatedCache = $outdated
    return $outdated
}

function Test-NpmUpdateAvailable {
    <#
    .SYNOPSIS
    检测 npm 包是否有新版本可用（统一入口）
    .DESCRIPTION
    全局安装包：优先使用 Get-NpmOutdatedGlobal 缓存（1 次查全部）
    非全局包（如 npx 安装的）：使用 -NonGlobal 开关回退到 npm view 单独查询
    .PARAMETER PackageName
    npm 包名（如 @anthropic-ai/claude-code）
    .PARAMETER CurrentVersion
    当前本地安装的版本号
    .PARAMETER NonGlobal
    非全局安装的包（如 npx 安装的 ccg-workflow），使用 npm view 查询
    .RETURNS
    @{ Available = $true/$false/$null; CurrentVersion; LatestVersion }
    Available: $true=有更新, $false=已最新, $null=查询失败(应降级为旧行为)
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$PackageName,

        [Parameter(Mandatory = $true)]
        [string]$CurrentVersion,

        [switch]$NonGlobal
    )

    $checkResult = @{
        Available      = $null
        CurrentVersion = $CurrentVersion
        LatestVersion  = ""
    }

    if ($NonGlobal) {
        # 非全局包：npm view 单独查询
        try {
            $npmResult = Invoke-ExternalCommand `
                -Command "npm" `
                -Arguments @("view", $PackageName, "version") `
                -TimeoutSeconds 30 `
                -RetryCount 0 `
                -SuppressOutput

            if ($npmResult.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($npmResult.Output)) {
                $checkResult.LatestVersion = $npmResult.Output.Trim()
                $checkResult.Available = ($CurrentVersion -ne $checkResult.LatestVersion)
            }
        }
        catch {
            # 查询失败不阻塞
        }
    }
    else {
        # 全局包：使用 npm outdated -g 缓存（1 次查全部）
        $outdated = Get-NpmOutdatedGlobal
        if ($outdated.ContainsKey($PackageName)) {
            $checkResult.LatestVersion = $outdated[$PackageName].Latest
            $checkResult.CurrentVersion = $outdated[$PackageName].Current
            $checkResult.Available = $true
        }
        else {
            # 不在 outdated 列表中 = 已最新（或未安装）
            $checkResult.Available = $false
            $checkResult.LatestVersion = $CurrentVersion
        }
    }

    return $checkResult
}

function Test-CommandAvailable {
    <#
    .SYNOPSIS
    检测命令是否可用（验证实际可执行性）
    .PARAMETER Command
    要检测的命令名
    .PARAMETER ReturnDetails
    返回详细诊断信息而非布尔值
    .PARAMETER TimeoutSeconds
    版本命令执行超时时间（秒），默认 10。首次运行较慢的 CLI 可传更大值。
    .RETURNS
    布尔值（默认）或详细诊断对象（ReturnDetails=true）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [switch]$ReturnDetails,

        [int]$TimeoutSeconds = 10
    )

    $details = @{
        Available = $false
        ResolvedPath = ""
        CommandType = ""
        ExitCode = -1
        ErrorMessage = ""
        Output = ""
    }

    try {
        # 先用 Get-Command 检测命令路径
        $cmdInfo = Get-Command $Command -ErrorAction Stop
        $details.ResolvedPath = $cmdInfo.Source
        $details.CommandType = $cmdInfo.CommandType

        # 如果是外部命令（Application），验证文件是否真实存在
        if ($cmdInfo.CommandType -eq 'Application') {
            $exePath = $cmdInfo.Source
            if (-not (Test-Path $exePath -PathType Leaf)) {
                $details.ErrorMessage = "PATH 中有记录但文件不存在: $exePath"
                if ($ReturnDetails) { return $details }
                return $false
            }
        }

        # 如果是 PowerShell 内置命令（Cmdlet/Function/Alias），Get-Command 成功即可用
        if ($cmdInfo.CommandType -in @('Cmdlet', 'Function', 'Alias')) {
            $details.Available = $true
            if ($ReturnDetails) { return $details }
            return $true
        }

        # 对于外部命令，通过实际执行验证可用性
        try {
            $result = Invoke-ExternalCommand -Command $Command -Arguments @("--version") -SuppressOutput -TimeoutSeconds $TimeoutSeconds -RetryCount 0
            $details.ExitCode = $result.ExitCode
            $details.Output = $result.Output
            $details.Available = $result.Success

            if ($result.Success) {
                if ($ReturnDetails) { return $details }
                return $true
            } else {
                $details.ErrorMessage = $result.Error
            }
        } catch {
            # 尝试 -v 参数
            try {
                $result = Invoke-ExternalCommand -Command $Command -Arguments @("-v") -SuppressOutput -TimeoutSeconds $TimeoutSeconds -RetryCount 0
                $details.ExitCode = $result.ExitCode
                $details.Output = $result.Output
                $details.Available = $result.Success

                if ($result.Success) {
                    if ($ReturnDetails) { return $details }
                    return $true
                } else {
                    $details.ErrorMessage = $result.Error
                }
            } catch {
                $details.ErrorMessage = $_.Exception.Message
            }
        }

    } catch {
        # Get-Command 失败，尝试直接执行验证
        $details.ErrorMessage = "Get-Command 失败: $($_.Exception.Message)"

        try {
            $result = Invoke-ExternalCommand -Command $Command -Arguments @("--version") -SuppressOutput -TimeoutSeconds $TimeoutSeconds -RetryCount 0
            $details.ExitCode = $result.ExitCode
            $details.Output = $result.Output
            $details.Available = $result.Success
            $details.ResolvedPath = $result.ResolvedPath

            if ($result.Success) {
                if ($ReturnDetails) { return $details }
                return $true
            } else {
                $details.ErrorMessage = $result.Error
            }
        } catch {
            try {
                $result = Invoke-ExternalCommand -Command $Command -Arguments @("-v") -SuppressOutput -TimeoutSeconds $TimeoutSeconds -RetryCount 0
                $details.ExitCode = $result.ExitCode
                $details.Output = $result.Output
                $details.Available = $result.Success
                $details.ResolvedPath = $result.ResolvedPath

                if ($result.Success) {
                    if ($ReturnDetails) { return $details }
                    return $true
                } else {
                    $details.ErrorMessage = $result.Error
                }
            } catch {
                $details.ErrorMessage = $_.Exception.Message
            }
        }
    }

    if ($ReturnDetails) { return $details }
    return $false
}

function Get-CommandVersion {
    <#
    .SYNOPSIS
    获取命令的版本信息
    .PARAMETER Command
    要获取版本的命令名
    .PARAMETER VersionArgument
    版本参数（默认 --version）
    .RETURNS
    版本字符串，如果无法获取则返回 "未知"
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [string]$VersionArgument = "--version"
    )

    # 特殊处理：对于 PowerShell 命令，直接使用 Get-Command 获取版本
    if ($Command -eq "pwsh" -or $Command -eq "powershell") {
        try {
            $cmdInfo = Get-Command $Command -ErrorAction Stop
            if ($cmdInfo.Version) {
                return $cmdInfo.Version.ToString()
            }
        } catch {
            # 如果 Get-Command 失败，继续使用外部命令方式
        }
    }

    try {
        $result = Invoke-ExternalCommand -Command $Command -Arguments @($VersionArgument) -SuppressOutput -TimeoutSeconds 30 -RetryCount 0

        if ($result.Success -and $result.Output) {
            # 尝试从输出中提取版本号
            $versionPattern = '(\d+\.[\d\.]+[\w\-]*)'
            if ($result.Output -match $versionPattern) {
                return $matches[1]
            } else {
                # 如果没有匹配到标准版本格式，返回第一行
                $firstLine = ($result.Output -split "`n")[0].Trim()
                return $firstLine
            }
        } else {
            return "未知"
        }
    } catch {
        # 如果 --version 失败，尝试 -v
        if ($VersionArgument -eq "--version") {
            return Get-CommandVersion -Command $Command -VersionArgument "-v"
        } else {
            return "未知"
        }
    }
}

function New-TestResult {
    <#
    .SYNOPSIS
    创建标准检测结果对象（步骤契约 HC-2）
    .RETURNS
    标准检测结果 hashtable
    #>
    param()

    return @{
        IsInstalled = $false
        Version     = ""
        Data        = @{}
        Message     = ""
    }
}

function Test-CliToolInstalled {
    <#
    .SYNOPSIS
    通用 CLI 工具检测函数，封装命令可用性检查和版本提取
    .DESCRIPTION
    适用于通过命令行检测的 CLI 工具（codex, gemini 等），
    一次调用完成：命令可用性验证 + 版本号提取 + 标准结果构造。
    .PARAMETER Command
    CLI 工具的命令名（如 "codex", "gemini"）
    .PARAMETER DisplayName
    工具显示名称（如 "Codex CLI"），用于日志输出
    .RETURNS
    标准检测结果 hashtable（IsInstalled, Version, Data, Message）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Command,

        [Parameter(Mandatory = $true)]
        [string]$DisplayName
    )

    $result = New-TestResult

    try {
        # 一次性获取命令可用性和版本输出
        $details = Test-CommandAvailable -Command $Command -ReturnDetails

        if (-not $details.Available) {
            $result.Message = "$Command 命令不可用"
            return $result
        }

        # 从 details.Output 中提取版本号，避免再次执行命令
        $version = ""
        if ($details.Output -match '(\d+\.[\d\.]+[\w\-]*)') {
            $version = $matches[1]
        } elseif ($details.Output) {
            $version = ($details.Output -split "`n")[0].Trim()
        }

        if ([string]::IsNullOrWhiteSpace($version)) {
            $result.Message = "无法获取 $Command 版本信息"
            return $result
        }

        $result.IsInstalled = $true
        $result.Version     = $version
        $result.Message     = "$DisplayName 已安装"
    }
    catch {
        $result.Message = "检测 $DisplayName 时出错: $($_.Exception.Message)"
    }

    return $result
}

function Refresh-SessionPath {
    <#
    .SYNOPSIS
    从注册表读取并刷新当前会话的 PATH 环境变量
    .DESCRIPTION
    当安装新软件后，PATH 可能已在注册表中更新，但当前 PowerShell 会话还未感知到变化。
    此函数从注册表重新读取 PATH 并注入到当前会话中。
    #>
    param()

    try {
        Write-UiPrimary "正在刷新 PATH 环境变量..." -Level Detail

        # 读取系统级 PATH
        $systemPath = ""
        try {
            $systemPath = [Environment]::GetEnvironmentVariable("PATH", "Machine")
        } catch {
            Write-UiWarning "警告: 无法读取系统级 PATH"
        }

        # 读取用户级 PATH
        $userPath = ""
        try {
            $userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        } catch {
            Write-UiWarning "警告: 无法读取用户级 PATH"
        }

        # 合并 PATH（保留当前进程中的 PATH，避免覆盖 fnm 等工具设置的路径）
        $currentPath = $env:PATH -split ';' | Where-Object { $_ -and $_.Trim() }
        $newPath = @()

        # 先添加当前进程的 PATH（包含 fnm use 设置的 Node.js 路径）
        if ($currentPath) { $newPath += $currentPath }

        # 再添加系统级和用户级 PATH
        if ($systemPath) { $newPath += $systemPath -split ';' }
        if ($userPath) { $newPath += $userPath -split ';' }

        # 去重并过滤空值（保持顺序，优先使用当前进程的路径）
        $seen = @{}
        $uniquePath = @()
        foreach ($path in $newPath) {
            $trimmedPath = $path.Trim()
            if ($trimmedPath -and -not $seen.ContainsKey($trimmedPath.ToLower())) {
                $seen[$trimmedPath.ToLower()] = $true
                $uniquePath += $trimmedPath
            }
        }

        # 更新当前会话的 PATH
        $env:PATH = $uniquePath -join ';'

        Write-UiSuccess "✓ PATH 环境变量已刷新" -Level Detail

        # 快速验证常见命令（仅使用 Get-Command，不实际执行）
        $commonCommands = @("node", "npm", "git", "winget", "pwsh", "claude")
        $availableCommands = @()

        foreach ($cmd in $commonCommands) {
            try {
                $cmdInfo = Get-Command $cmd -ErrorAction Stop
                $availableCommands += $cmd
            } catch {
                # 命令不可用，跳过
            }
        }

        if ($availableCommands.Count -gt 0) {
            Write-UiSuccess "可用命令: $($availableCommands -join ', ')" -Level Detail
        }

    } catch {
        Write-UiWarning "警告: PATH 刷新失败: $($_.Exception.Message)"
    }
}

function Test-InternetConnection {
    <#
    .SYNOPSIS
    测试网络连接
    .PARAMETER TestUrls
    要测试的 URL 数组
    .PARAMETER TimeoutSeconds
    每个测试的超时时间
    .RETURNS
    连接测试结果对象
    #>
    param(
        [string[]]$TestUrls = @(
            "https://www.google.com",
            "https://github.com",
            "https://registry.npmmirror.com"
        ),

        [int]$TimeoutSeconds = 10
    )

    $results = @{
        Success = $false
        TestedUrls = @()
        FailedUrls = @()
        ErrorMessage = ""
    }

    foreach ($url in $TestUrls) {
        try {
            Write-UiPrimary "测试连接: $url"

            $request = [System.Net.WebRequest]::Create($url)
            $request.Timeout = $TimeoutSeconds * 1000
            $request.Method = "HEAD"

            $response = $request.GetResponse()
            $response.Close()

            $results.TestedUrls += $url
            Write-UiSuccess "✓ $url 连接成功"

        } catch {
            $results.FailedUrls += $url
            Write-UiDanger "✗ $url 连接失败: $($_.Exception.Message)"
        }
    }

    $results.Success = $results.TestedUrls.Count -gt 0

    if (-not $results.Success) {
        $results.ErrorMessage = "所有网络连接测试都失败了"
    }

    return $results
}

# ============================================================
# 统一检测框架（Unified Test Framework）
# ============================================================

# 会话级缓存（脚本作用域 hashtable）
$script:TestResultCache = @{}

function Get-CachedTestResult {
    <#
    .SYNOPSIS
    从会话缓存获取检测结果（TTL 过期自动清除）
    .PARAMETER CacheKey
    缓存键（通常为 StepId）
    .PARAMETER TtlSeconds
    缓存有效期（秒），默认 30 秒
    .RETURNS
    缓存的检测结果 hashtable，或 $null（未命中/过期）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$CacheKey,

        [int]$TtlSeconds = 30
    )

    if ($script:TestResultCache.ContainsKey($CacheKey)) {
        $entry = $script:TestResultCache[$CacheKey]
        $elapsed = (Get-Date) - $entry.CreatedAt
        if ($elapsed.TotalSeconds -le $TtlSeconds) {
            return $entry.Result
        }
        $script:TestResultCache.Remove($CacheKey)
    }
    return $null
}

function Set-CachedTestResult {
    <#
    .SYNOPSIS
    将检测结果写入会话缓存
    .PARAMETER CacheKey
    缓存键（通常为 StepId）
    .PARAMETER Result
    检测结果对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$CacheKey,

        [Parameter(Mandatory = $true)]
        $Result
    )

    $script:TestResultCache[$CacheKey] = @{
        Result    = $Result
        CreatedAt = Get-Date
    }
}

function Clear-TestResultCache {
    <#
    .SYNOPSIS
    清除检测结果缓存
    .PARAMETER StepId
    指定步骤 ID 精准清除；空则全量清除
    #>
    param(
        [string]$StepId = ""
    )

    if ([string]::IsNullOrWhiteSpace($StepId)) {
        $script:TestResultCache = @{}
    } else {
        if ($script:TestResultCache.ContainsKey($StepId)) {
            $script:TestResultCache.Remove($StepId)
        }
    }
}

function Resolve-JsonPath {
    <#
    .SYNOPSIS
    按 . 分隔的路径遍历 PSObject/hashtable（如 "env.ANTHROPIC_AUTH_TOKEN"）
    .PARAMETER JsonObject
    PSObject 或 hashtable 根节点
    .PARAMETER Path
    点分隔路径
    .RETURNS
    目标节点的值，或 $null（路径不存在）
    #>
    param(
        [Parameter(Mandatory = $true)]
        $JsonObject,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $segments = $Path -split '\.'
    $current = $JsonObject

    foreach ($seg in $segments) {
        if ($null -eq $current) { return $null }

        if ($current -is [hashtable]) {
            if ($current.ContainsKey($seg)) {
                $current = $current[$seg]
            } else {
                return $null
            }
        } elseif ($current -is [System.Management.Automation.PSCustomObject]) {
            if ($current.PSObject.Properties.Name -contains $seg) {
                $current = $current.$seg
            } else {
                return $null
            }
        } else {
            return $null
        }
    }

    return $current
}

function Test-PathStructure {
    <#
    .SYNOPSIS
    目录结构原子检测器：批量检测路径是否满足条件
    .PARAMETER Checks
    检测项数组，每项为 hashtable：@{ Path; Type(File|Dir); Filter; MinCount; ContentMatch }
    .RETURNS
    @{ AllPassed = [bool]; Details = @(...) }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable[]]$Checks
    )

    $allPassed = $true
    $details = [System.Collections.ArrayList]::new()

    foreach ($check in $Checks) {
        $passed = $false
        $info = ""

        if ($check.Type -eq "Dir") {
            $passed = Test-Path $check.Path -PathType Container
            if ($passed -and $check.ContainsKey("Filter") -and $check.ContainsKey("MinCount")) {
                $files = @(Get-ChildItem $check.Path -Filter $check.Filter -ErrorAction SilentlyContinue)
                $passed = $files.Count -ge $check.MinCount
                $info = "found $($files.Count)/$($check.MinCount)"
            }
        } elseif ($check.Type -eq "File") {
            $passed = Test-Path $check.Path -PathType Leaf
            if ($passed -and $check.ContainsKey("ContentMatch")) {
                $content = Get-Content $check.Path -Raw -ErrorAction SilentlyContinue
                if ([string]::IsNullOrWhiteSpace($content)) {
                    $passed = $false
                    $info = "empty file"
                } else {
                    $passed = [bool]($content -match $check.ContentMatch)
                    if (-not $passed) { $info = "content mismatch" }
                }
            }
        }

        if (-not $passed) { $allPassed = $false }
        [void]$details.Add(@{ Path = $check.Path; Passed = $passed; Info = $info })
    }

    return @{ AllPassed = $allPassed; Details = @($details) }
}

function Test-JsonConfig {
    <#
    .SYNOPSIS
    配置文件字段原子检测器：检测 JSON 文件中的必需字段和数组项
    .PARAMETER FilePath
    JSON 文件路径
    .PARAMETER RequiredFields
    必需字段数组：@{ Path = "env.KEY"; ExpectedValue = "xxx"; MatchMode = "Exact|Contains|Exists" }
    .PARAMETER RequiredArrayItems
    必需数组项：@{ Path = "permissions.allow"; Items = @("Bash","Read",...) }
    .PARAMETER AsHashtable
    使用 -AsHashtable 解析 JSON（适用于 mcpServers 等动态键结构）
    .RETURNS
    @{ AllPassed = [bool]; MissingFields = @(...); ParsedJson = $json }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [hashtable[]]$RequiredFields = @(),

        [hashtable[]]$RequiredArrayItems = @(),

        [switch]$AsHashtable
    )

    $configResult = @{
        AllPassed     = $false
        MissingFields = [System.Collections.ArrayList]::new()
        ParsedJson    = $null
        ParseError    = ""
    }

    if (-not (Test-Path $FilePath)) {
        $configResult.ParseError = "file not found: $FilePath"
        return $configResult
    }

    try {
        $rawContent = Get-Content $FilePath -Raw -ErrorAction Stop
        if ($AsHashtable) {
            $json = $rawContent | ConvertFrom-JsonToHashtable -ErrorAction Stop
        } else {
            $json = $rawContent | ConvertFrom-Json -ErrorAction Stop
        }
        $configResult.ParsedJson = $json
    }
    catch {
        $configResult.ParseError = "JSON parse failed: $($_.Exception.Message)"
        return $configResult
    }

    $allPassed = $true

    foreach ($field in $RequiredFields) {
        $value = Resolve-JsonPath -JsonObject $json -Path $field.Path
        $mode = if ($field.ContainsKey("MatchMode")) { $field.MatchMode } else { "Exists" }
        $passed = $false

        switch ($mode) {
            "Exists" {
                $passed = ($null -ne $value) -and (-not [string]::IsNullOrWhiteSpace([string]$value))
            }
            "Exact" {
                $expected = if ($field.ContainsKey("ExpectedValue")) { $field.ExpectedValue } else { "" }
                $passed = ([string]$value -eq [string]$expected)
            }
            "Contains" {
                $expected = if ($field.ContainsKey("ExpectedValue")) { $field.ExpectedValue } else { "" }
                $passed = ([string]$value -match [regex]::Escape($expected))
            }
        }

        if (-not $passed) {
            $allPassed = $false
            [void]$configResult.MissingFields.Add($field.Path)
        }
    }

    foreach ($arrayCheck in $RequiredArrayItems) {
        $array = Resolve-JsonPath -JsonObject $json -Path $arrayCheck.Path
        if ($null -eq $array -or -not ($array -is [System.Array])) {
            $allPassed = $false
            [void]$configResult.MissingFields.Add($arrayCheck.Path)
            continue
        }
        foreach ($item in $arrayCheck.Items) {
            if ($array -notcontains $item) {
                $allPassed = $false
                [void]$configResult.MissingFields.Add("$($arrayCheck.Path)::$item")
            }
        }
    }

    $configResult.AllPassed = $allPassed
    return $configResult
}

function Invoke-UnifiedCheck {
    <#
    .SYNOPSIS
    统一检测框架入口：编排 CLI/目录/配置/自定义检测 + 缓存 + UI 输出
    .PARAMETER StepId
    步骤 ID（缓存键）
    .PARAMETER DisplayName
    步骤显示名称
    .PARAMETER Command
    CLI 命令名（触发 CLI 检测）
    .PARAMETER MinVersion
    最低版本要求（需配合 Command 使用）
    .PARAMETER PathChecks
    目录结构检测项数组
    .PARAMETER ConfigFile
    配置文件路径（触发 JSON 配置检测）
    .PARAMETER RequiredFields
    JSON 必需字段数组
    .PARAMETER RequiredArrayItems
    JSON 必需数组项数组
    .PARAMETER ConfigAsHashtable
    使用 -AsHashtable 解析配置 JSON
    .PARAMETER CustomVerify
    自定义验证脚本块（返回 $true/$false 或版本字符串）
    .PARAMETER UseCache
    启用会话级缓存
    .PARAMETER Quiet
    静默模式（不输出 UI 信息）
    .RETURNS
    标准检测结果 hashtable（IsInstalled, Version, Data, Message）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$StepId,

        [string]$DisplayName = $StepId,

        [string]$Command,
        [string]$MinVersion,

        [hashtable[]]$PathChecks,

        [string]$ConfigFile,
        [hashtable[]]$RequiredFields,
        [hashtable[]]$RequiredArrayItems,
        [switch]$ConfigAsHashtable,

        [scriptblock]$CustomVerify,

        [switch]$UseCache,
        [switch]$Quiet
    )

    # 1. 缓存检查
    if ($UseCache) {
        $cached = Get-CachedTestResult -CacheKey $StepId
        if ($null -ne $cached) { return $cached }
    }

    $result = New-TestResult

    try {
        # 2. CLI 命令检测
        if (-not [string]::IsNullOrWhiteSpace($Command)) {
            $cliResult = Test-CliToolInstalled -Command $Command -DisplayName $DisplayName
            $result.IsInstalled = $cliResult.IsInstalled
            $result.Version = $cliResult.Version
            $result.Data = $cliResult.Data
            $result.Message = $cliResult.Message

            if (-not $cliResult.IsInstalled) {
                return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
            }

            # 版本比较
            if (-not [string]::IsNullOrWhiteSpace($MinVersion) -and -not [string]::IsNullOrWhiteSpace($result.Version)) {
                try {
                    $cleanVersion = $result.Version -replace '^[a-zA-Z\s]+', '' -replace '\.windows.*$', ''
                    $currentVer = [Version]$cleanVersion
                    $requiredVer = [Version]$MinVersion
                    if ($currentVer -lt $requiredVer) {
                        $result.IsInstalled = $false
                        $result.Message = "$DisplayName 版本过低 (当前: $($result.Version), 需要: $MinVersion+)"
                        return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
                    }
                }
                catch {
                    # 版本解析失败，跳过版本检查
                }
            }
        }

        # 3. 目录结构检测
        if ($PathChecks -and $PathChecks.Count -gt 0) {
            $pathResult = Test-PathStructure -Checks $PathChecks
            if (-not $pathResult.AllPassed) {
                $result.IsInstalled = $false
                $result.Message = "$DisplayName 目录结构不完整"
                $result.Data["PathDetails"] = $pathResult.Details
                return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
            }
        }

        # 4. 配置文件检测
        if (-not [string]::IsNullOrWhiteSpace($ConfigFile)) {
            $configResult = Test-JsonConfig -FilePath $ConfigFile `
                -RequiredFields $RequiredFields `
                -RequiredArrayItems $RequiredArrayItems `
                -AsHashtable:$ConfigAsHashtable

            if (-not [string]::IsNullOrWhiteSpace($configResult.ParseError)) {
                $result.IsInstalled = $false
                $result.Message = "$DisplayName 配置解析失败: $($configResult.ParseError)"
                $result.Data["ParseError"] = $configResult.ParseError
                return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
            }

            if (-not $configResult.AllPassed) {
                $result.IsInstalled = $false
                $missingStr = @($configResult.MissingFields) -join ', '
                $result.Message = "$DisplayName 配置不完整: $missingStr"
                return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
            }
            $result.Data["Config"] = $configResult.ParsedJson
        }

        # 5. 自定义验证
        if ($null -ne $CustomVerify) {
            $customResult = & $CustomVerify
            if ($customResult -is [bool]) {
                if (-not $customResult) {
                    $result.IsInstalled = $false
                    $result.Message = "$DisplayName 自定义验证未通过"
                    return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
                }
            } elseif ($customResult -is [string] -and -not [string]::IsNullOrWhiteSpace($customResult)) {
                # 自定义验证返回版本字符串
                $result.Version = $customResult
            }
        }

        # 全部通过
        if (-not $result.IsInstalled) { $result.IsInstalled = $true }
        if ([string]::IsNullOrWhiteSpace($result.Message)) { $result.Message = "$DisplayName 已安装" }
    }
    catch {
        $result.IsInstalled = $false
        $result.Message = "$DisplayName 检测出错: $($_.Exception.Message)"
    }

    return (Complete-UnifiedCheck -Result $result -StepId $StepId -DisplayName $DisplayName -UseCache:$UseCache -Quiet:$Quiet)
}

function Complete-UnifiedCheck {
    <#
    .SYNOPSIS
    统一检测的收尾逻辑：UI 输出 + 写入缓存
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Result,

        [string]$StepId,
        [string]$DisplayName,
        [switch]$UseCache,
        [switch]$Quiet
    )

    $suppressUnifiedCheckOutput = $false
    if (Get-Variable -Scope Script -Name SuppressUnifiedCheckOutput -ErrorAction SilentlyContinue) {
        $suppressUnifiedCheckOutput = [bool]$script:SuppressUnifiedCheckOutput
    }

    if (-not $Quiet -and -not $suppressUnifiedCheckOutput) {
        if ($Result.IsInstalled) {
            $versionSuffix = if (-not [string]::IsNullOrWhiteSpace($Result.Version)) { " (版本: $($Result.Version))" } else { "" }
            Write-UiSuccess "✓ $DisplayName 已安装$versionSuffix"
        } else {
            Write-UiWarning "⚠ $DisplayName [FAIL]: $($Result.Message)"
        }
    }

    if ($UseCache) {
        Set-CachedTestResult -CacheKey $StepId -Result $Result
    }

    return $Result
}

# ─── CCQ 可执行文件管理 ──────────────────────────────────────────────────────

function Get-CcqArchitecture {
    <#
    .SYNOPSIS
    检测当前平台架构，返回 ccq 可执行文件对应的 target 名称
    .OUTPUTS
    "windows-x64" | "windows-arm64"
    #>
    param()

    $arch = $env:PROCESSOR_ARCHITECTURE
    if ($arch -eq "ARM64") {
        return "windows-arm64"
    } else {
        # x64 / AMD64 / EM64T 统一为 x64
        return "windows-x64"
    }
}

function Get-CcqExecutablePath {
    <#
    .SYNOPSIS
    返回 ccq 可执行文件应安装的目标路径（Windows: %USERPROFILE%\.local\bin\ccq.exe）
    .OUTPUTS
    完整的可执行文件路径（含 .exe）
    #>
    param()

    $ccqBinDir = Join-Path $env:USERPROFILE ".local\bin"
    return Join-Path $ccqBinDir "ccq.exe"
}

function ConvertTo-CcqComparableVersion {
    <#
    .SYNOPSIS
    规范化 ccq 命令输出或 Release tag，供安装器比较版本。
    #>
    param(
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Version
    )

    if ([string]::IsNullOrWhiteSpace($Version)) {
        return ""
    }

    $normalized = $Version.Trim() -replace '^ccq\s+', ''
    if ($normalized -match '^[vV](?=\d)') {
        $normalized = $normalized.Substring(1)
    }

    return $normalized.Trim()
}

function Test-CcqExecutableInstalled {
    <#
    .SYNOPSIS
    检测 ccq 可执行文件是否已安装且可用
    .OUTPUTS
    @{ IsInstalled = $true/$false; Version = "x.y.z" | ""; Path = "..." }
    #>
    param()

    $result = @{
        IsInstalled = $false
        Version     = ""
        Path        = ""
    }

    $ccqPath = Get-CcqExecutablePath
    $result.Path = $ccqPath
    if (Test-Path $ccqPath) {
        # 只信任可快速响应 --version 的 ccq；旧/损坏可执行文件可能卡住，必须允许后续重新下载覆盖。
        try {
            $versionResult = Invoke-ExternalCommand -Command $ccqPath -Arguments @("--version") -TimeoutSeconds 3 -RetryCount 0 -SuppressOutput
            if ($versionResult.Success -and -not [string]::IsNullOrWhiteSpace($versionResult.Output)) {
                $result.IsInstalled = $true
                $result.Version = ConvertTo-CcqComparableVersion -Version $versionResult.Output
            }
        } catch {
            $result.IsInstalled = $false
            $result.Version = ""
        }
    }

    return $result
}

function Install-CcqExecutable {
    <#
    .SYNOPSIS
    下载并安装 ccq 可执行文件到 %USERPROFILE%\.local\bin\ccq.exe，并确保该目录在用户 PATH
    .PARAMETER DownloadUrl
    可执行文件下载 URL（如 https://github.com/.../releases/latest/download/ccq-windows-x64.exe）
    .OUTPUTS
    @{ Success = $true/$false; ErrorMessage = ""; Path = "..." }
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$DownloadUrl
    )

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Path         = ""
    }
    $tempPath = $null

    try {
        $ccqPath = Get-CcqExecutablePath
        $ccqBinDir = Split-Path -Parent $ccqPath

        # 1. 创建目标目录
        if (-not (Test-Path $ccqBinDir)) {
            New-Item -ItemType Directory -Path $ccqBinDir -Force | Out-Null
            Write-UiInfo "创建 ccq 目录: $ccqBinDir"
        }

        # 2. 下载可执行文件到临时文件，再原子替换，避免失败时删除已有 ccq。
        $tempPath = "$ccqPath.download.$PID"
        if (Test-Path $tempPath) {
            Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
        }

        $downloadResult = Invoke-FileDownload -Url $DownloadUrl -OutputPath $tempPath -Description "ccq 可执行文件"
        if (-not $downloadResult.Success) {
            throw "ccq 下载失败: $($downloadResult.ErrorMessage)"
        }

        # 3. 验证文件非空（Invoke-FileDownload 已校验存在性与完整性，此处双重确认）
        $fileInfo = Get-Item $tempPath
        if ($fileInfo.Length -eq 0) {
            throw "下载的文件为空"
        }

        Move-Item -Path $tempPath -Destination $ccqPath -Force

        Write-UiSuccess "✓ ccq 可执行文件已下载到: $ccqPath"
        Write-UiDim "  文件大小: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"

        # 4. 确保目录在用户 PATH（通过注册表 HKCU\Environment）
        $pathResult = Add-DirectoryToUserPath -DirectoryPath $ccqBinDir
        if ($pathResult.Success -and $pathResult.AlreadyPresent) {
            Write-UiSuccess "✓ $ccqBinDir 已在用户 PATH，跳过环境变量写入"
            Write-UiDim "  如当前终端无法直接运行 ccq，请开启新终端或直接运行: $ccqPath"
        } elseif ($pathResult.Success -and $pathResult.Added) {
            Write-UiSuccess "✓ $ccqBinDir 已添加到用户 PATH"
            Write-UiWarning "⚠ 请开启新终端后使用 ccq 命令（当前会话 PATH 尚未刷新）"
        } else {
            Write-UiWarning "⚠ 无法自动添加到 PATH，请手动添加以下目录到系统环境变量 PATH："
            Write-UiInfo "  $ccqBinDir"
            Write-UiDim "  或直接运行: $ccqPath"
        }

        $result.Success = $true
        $result.Path = $ccqPath

    } catch {
        if ($tempPath -and (Test-Path $tempPath)) {
            Remove-Item $tempPath -Force -ErrorAction SilentlyContinue
        }
        $result.ErrorMessage = $_.Exception.Message
        Write-UiDanger "ccq 可执行文件安装失败: $($result.ErrorMessage)"
    }

    return $result
}

function Add-DirectoryToUserPath {
    <#
    .SYNOPSIS
    将目录添加到用户级 PATH（通过注册表 HKCU\Environment，非 Profile）。
    .PARAMETER DirectoryPath
    要添加的目录绝对路径。
    .OUTPUTS
    @{ Success; Added; AlreadyPresent; ErrorMessage }
    #>
    param(
        [Parameter(Mandatory=$true)]
        [string]$DirectoryPath
    )

    $result = @{
        Success        = $false
        Added          = $false
        AlreadyPresent = $false
        ErrorMessage   = ""
    }

    try {
        # 1. 读取当前用户 PATH
        $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
        if ([string]::IsNullOrWhiteSpace($currentPath)) {
            $currentPath = ""
        }

        # 2. 检查是否已存在（兼容 %USERPROFILE%\.local\bin 这类未展开写法）
        $pathEntries = @($currentPath -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $normalizedTarget = [Environment]::ExpandEnvironmentVariables($DirectoryPath).TrimEnd('\')

        foreach ($entry in $pathEntries) {
            $normalizedEntry = [Environment]::ExpandEnvironmentVariables([string]$entry).TrimEnd('\')
            if ($normalizedEntry -ieq $normalizedTarget) {
                Write-Verbose "目录已在用户 PATH: $DirectoryPath"
                $result.Success = $true
                $result.AlreadyPresent = $true
                return $result
            }
        }

        # 3. 追加到 PATH（尾部）
        $newPath = if ([string]::IsNullOrWhiteSpace($currentPath)) {
            $DirectoryPath
        } elseif ($currentPath.EndsWith(';')) {
            "${currentPath}${DirectoryPath}"
        } else {
            "${currentPath};${DirectoryPath}"
        }

        # 4. 写入注册表
        [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
        Write-Verbose "已将 $DirectoryPath 添加到用户 PATH"

        $result.Success = $true
        $result.Added = $true
        return $result

    } catch {
        $result.ErrorMessage = $_.Exception.Message
        Write-Verbose "添加到用户 PATH 失败: $($result.ErrorMessage)"
        return $result
    }
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
