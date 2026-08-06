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

function Test-CcqExecutableLocked {
    <#
    .SYNOPSIS
    下载前独占探测目标 ccq.exe 是否被运行中进程锁住，避免在传输完成后才发现无法替换。
    .DESCRIPTION
    尝试以 ReadWrite + FileShare.None 独占打开目标路径：
    - 文件不存在 → Locked=$false（不是占用问题，交给后续逻辑）。
    - 打开成功 → 关闭，Locked=$false。
    - 抛 IOException / UnauthorizedAccessException → Locked=$true，列出 ccq.exe 进程。
    - 其他异常 → Locked=$false，Detail 记异常名，放行交给重试兜底。
    预检是优化路径，不是门禁：探测异常一律放行，绝不能因预检误判阻断正常安装。
    .PARAMETER Path
    目标 ccq.exe 完整路径。
    .OUTPUTS
    @{ Locked = $true/$false; Processes = @(...); Detail = "..." }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $result = @{
        Locked    = $false
        Processes = @()
        Detail    = ""
    }

    # 最外层兜底：预检绝不抛错，任何未预期异常一律放行，交给后续替换逻辑与重试兜底。
    try {
        if (-not (Test-Path -LiteralPath $Path)) {
            $result.Detail = "目标不存在，无需占用预检"
            return $result
        }

        $stream = $null
        try {
            # 独占打开：ReadWrite + FileShare.None。能打开说明目标空闲，可被 File.Replace。
            $stream = [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
            $result.Locked = $false
            $result.Detail = "目标可独占打开，无占用"
        } catch [System.IO.FileNotFoundException] {
            # 目标可能在 Test-Path 与 Open 之间被另一个安装/清理进程删除；
            # 这不是占用，必须放行让后续逻辑创建新文件。
            $result.Locked = $false
            $result.Detail = "目标在预检期间消失，按未安装处理"
        } catch [System.IO.DirectoryNotFoundException] {
            # 父目录同样可能在竞态中消失；不要把路径竞态误报为锁定。
            $result.Locked = $false
            $result.Detail = "目标目录在预检期间消失，按未安装处理"
        } catch [System.IO.IOException] {
            $result.Locked = $true
            $result.Detail = "目标被占用: $($_.Exception.Message)"
            # Get-CcqLockHolderProcesses 已用 `return , $array` 保形，此处不可再套 @()：
            # 再套一层会把空列表包成 @(@()) 使 Count 变 1，导致输出空的「进程: 」括号。
            $result.Processes = Get-CcqLockHolderProcesses -Path $Path
        } catch [System.UnauthorizedAccessException] {
            $result.Locked = $true
            $result.Detail = "目标访问被拒绝（可能被占用或只读）: $($_.Exception.Message)"
            $result.Processes = Get-CcqLockHolderProcesses -Path $Path
        } catch {
            # 其他异常一律放行，交给后续替换逻辑与重试兜底。预检不能阻断正常安装。
            $result.Locked = $false
            $result.Detail = "预检异常已忽略: $($_.Exception.GetType().FullName)"
        } finally {
            if ($null -ne $stream) {
                # Close/Dispose 独立尝试；极少数关闭异常也不能阻止 Dispose 释放句柄。
                try { $stream.Close() } catch { }
                try { $stream.Dispose() } catch { }
            }
        }
    } catch {
        # 最外层兜底：预检绝不抛错，任何未预期异常一律放行。
        $result.Locked = $false
        $result.Detail = "预检兜底放行: $($_.Exception.GetType().FullName)"
        $result.Processes = @()
    }

    return $result
}

function Get-CcqLockHolderProcesses {
    <#
    .SYNOPSIS
    列出可能锁住目标的 ccq.exe 进程（PID + 命令行），帮助用户定位。
    .DESCRIPTION
    匹配 Name='ccq.exe' 的进程。CommandLine 可能因权限不足为空，退化到仅列 PID。
    Get-CimInstance 不可用时返回空列表，不阻断预检判定。
    .PARAMETER Path
    目标可执行文件完整路径。进程名由该路径的 leaf 推导，并优先按
    ExecutablePath/CommandLine 命中该路径精确匹配；匹配不到时退化为同名进程全列。
    .OUTPUTS
    @(@{ ProcessId = ...; CommandLine = "..." })
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $processes = @()
    try {
        # 进程名从目标路径推导，不硬编码 ccq.exe。WQL 字符串需转义单引号。
        $leafName = Split-Path -Path $Path -Leaf
        if ([string]::IsNullOrWhiteSpace($leafName)) { return , $processes }
        $wqlName = $leafName.Replace("'", "''")

        $rawProcs = @(Get-CimInstance -ClassName Win32_Process -Filter "Name='$wqlName'" -ErrorAction SilentlyContinue)

        # 优先精确匹配目标路径（ExecutablePath 比 CommandLine 更可靠）；
        # 权限不足导致两者皆空时退化为同名进程全列（design.md 的退化策略）。
        $exact = @()
        $fallback = @()
        foreach ($p in $rawProcs) {
            if ($null -eq $p) { continue }
            $entry = @{
                ProcessId   = [int]$p.ProcessId
                CommandLine = [string]$p.CommandLine
            }
            $execPath = [string]$p.ExecutablePath
            # -like 会把路径里的 [ ] 当通配符，必须转义；同时保留 -like 的大小写不敏感
            # 语义（Windows 路径大小写不敏感，.Contains() 反而会漏匹配）。
            $pathPattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($Path) + '*'
            if (($execPath -and $execPath -eq $Path) -or
                ($entry.CommandLine -and $entry.CommandLine -like $pathPattern)) {
                $exact += , $entry
            } else {
                $fallback += , $entry
            }
        }
        if (@($exact).Count -gt 0) {
            $processes = $exact
        } else {
            $processes = $fallback
        }
    } catch {
        # Get-CimInstance 不可用或失败：退化到空列表，不阻断预检判定。
        $processes = @()
    }

    return , $processes
}

function Restore-CcqExecutableBackup {
    <#
    .SYNOPSIS
    把 backup 中的旧版本可执行文件搬回 target，回滚失败时保留 backup 不删。
    .DESCRIPTION
    target 存在时用 [System.IO.File]::Replace 原子换回；不存在时用 Move。
    注意：PS5.1 下 File.Replace 的 backup 形参不能传 $null（会抛「路径的格式不合法」），
    必须传 [NullString]::Value 才能走 .NET 的「不保留 backup」语义。
    Replace 失败时降级为 Copy —— 回滚成功比原子性更重要（绝不让用户失去可用 ccq.exe）。
    .OUTPUTS
    $true 表示 target 已恢复可用；$false 表示回滚未完成，调用方必须保留 backup。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$BackupPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    if (-not (Test-Path -LiteralPath $BackupPath)) { return $false }

    try {
        if (Test-Path -LiteralPath $TargetPath) {
            [System.IO.File]::Replace($BackupPath, $TargetPath, [NullString]::Value, $true)
        } else {
            [System.IO.File]::Move($BackupPath, $TargetPath)
        }
        return (Test-Path -LiteralPath $TargetPath)
    } catch {
        # 原子回滚失败：降级为覆盖复制，backup 由调用方按结果决定是否保留。
        try {
            [System.IO.File]::Copy($BackupPath, $TargetPath, $true)
            return (Test-Path -LiteralPath $TargetPath)
        } catch {
            return $false
        }
    }
}

function Clear-CcqReplacementBackupsAfterVerifiedReplace {
    <#
    .SYNOPSIS
    在新 target 通过尺寸校验后，清理当前事务和可确认无主的历史替换 backup。
    .DESCRIPTION
    当前事务 backup 使用有界重试；历史 backup 只有在精确匹配
    <target>.backup.<PID> 且来源 PID 已退出时才删除。任何身份、文件类型、
    进程或文件系统探测不确定性都会保留文件，并通过 WarningMessage 返回绝对路径。
    .OUTPUTS
    @{ RemovedPaths = @(...); RetainedPaths = @(...); WarningMessage = "" }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$TargetPath,

        [Parameter(Mandatory = $true)]
        [string]$CurrentBackupPath,

        [Parameter(Mandatory = $true)]
        [long]$ExpectedTargetSize,

        [int]$MaxAttempts = 20,

        [int]$IntervalMs = 250
    )

    $result = @{
        RemovedPaths   = @()
        RetainedPaths  = @()
        WarningMessage = ""
    }
    $removedPaths = @()
    $retainedPaths = @()

    $targetFullPath = ""
    $currentBackupFullPath = ""
    $targetDirectory = ""
    $targetName = ""
    try {
        $targetFullPath = [System.IO.Path]::GetFullPath($TargetPath)
        $currentBackupFullPath = [System.IO.Path]::GetFullPath($CurrentBackupPath)
        $targetDirectory = [System.IO.Path]::GetDirectoryName($targetFullPath)
        $targetName = [System.IO.Path]::GetFileName($targetFullPath)
    } catch {
        $result.WarningMessage = "ccq.exe 替换已完成，但备份清理路径无法验证，已跳过清理。"
        return $result
    }

    # 清理只属于已验证 replacement 的后置阶段。再次确认 target，防止验证后并发变化。
    $targetVerified = $false
    try {
        if ($ExpectedTargetSize -gt 0 -and
            (Test-Path -LiteralPath $targetFullPath -PathType Leaf)) {
            $targetVerified = ((Get-Item -LiteralPath $targetFullPath -Force -ErrorAction Stop).Length -eq
                $ExpectedTargetSize)
        }
    } catch {
        $targetVerified = $false
    }
    if (-not $targetVerified) {
        $result.WarningMessage = "ccq.exe 替换已完成，但目标校验状态已变化，已跳过备份清理: $targetFullPath"
        return $result
    }

    $candidatePattern = '^' + [regex]::Escape($targetName) + '\.backup\.(?<Pid>\d+)$'
    $currentName = [System.IO.Path]::GetFileName($currentBackupFullPath)
    $currentDirectory = [System.IO.Path]::GetDirectoryName($currentBackupFullPath)
    $currentIdentityValid = ([System.StringComparer]::OrdinalIgnoreCase.Equals($targetDirectory, $currentDirectory) -and
        $currentName -match $candidatePattern)

    # 当前事务 backup 的 PID 必然仍活动，因此不能套用历史 backup 的 PID 判定。
    if (Test-Path -LiteralPath $currentBackupFullPath) {
        if (-not $currentIdentityValid) {
            $retainedPaths += $currentBackupFullPath
        } else {
            $currentRemoved = $false
            for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
                try {
                    $currentItem = Get-Item -LiteralPath $currentBackupFullPath -Force -ErrorAction Stop
                    if ($currentItem -isnot [System.IO.FileInfo] -or
                        (($currentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
                        break
                    }

                    Remove-Item -LiteralPath $currentBackupFullPath -Force -ErrorAction Stop
                    if (-not (Test-Path -LiteralPath $currentBackupFullPath)) {
                        $currentRemoved = $true
                        $removedPaths += $currentBackupFullPath
                        break
                    }
                } catch {
                    # 短时共享冲突和其他删除失败都只影响 cleanup，不改变 replacement 成功。
                }

                if ($attempt -lt $MaxAttempts) {
                    Start-Sleep -Milliseconds $IntervalMs
                }
            }
            if (-not $currentRemoved -and (Test-Path -LiteralPath $currentBackupFullPath)) {
                $retainedPaths += $currentBackupFullPath
            }
        }
    }

    # 只扫描 target 的直接同级项，并在删除前逐项确认精确身份、普通文件和 PID 状态。
    $candidates = @()
    try {
        $candidates = @(Get-ChildItem -LiteralPath $targetDirectory -Force -ErrorAction Stop)
    } catch {
        $result.RemovedPaths = @($removedPaths)
        $result.RetainedPaths = @($retainedPaths)
        $result.WarningMessage = "ccq.exe 替换已完成，但无法扫描历史备份，已保留未确认项。目录: $targetDirectory"
        return $result
    }

    foreach ($candidate in $candidates) {
        $candidateName = [string]$candidate.Name
        if ($candidateName -notmatch $candidatePattern) { continue }

        $candidatePath = [System.IO.Path]::GetFullPath([string]$candidate.FullName)
        if ([System.StringComparer]::OrdinalIgnoreCase.Equals($candidatePath, $currentBackupFullPath)) {
            continue
        }

        if ($candidate -isnot [System.IO.FileInfo] -or
            (($candidate.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
            $retainedPaths += $candidatePath
            continue
        }

        [int]$sourcePid = 0
        if (-not [int]::TryParse([string]$matches['Pid'], [ref]$sourcePid)) {
            $retainedPaths += $candidatePath
            continue
        }

        $sourceProcess = $null
        $pidConfirmedAbsent = $false
        try {
            $sourceProcess = Get-Process -Id $sourcePid -ErrorAction Stop
        } catch {
            # Get-Process 对已退出 PID 使用这个稳定的 fully-qualified error id；
            # 其他异常代表探测不确定，必须保留 recovery artifact。
            if ([string]$_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') {
                $pidConfirmedAbsent = $true
            }
        }

        if ($null -ne $sourceProcess -or -not $pidConfirmedAbsent) {
            $retainedPaths += $candidatePath
            continue
        }

        try {
            Remove-Item -LiteralPath $candidatePath -Force -ErrorAction Stop
            if (Test-Path -LiteralPath $candidatePath) {
                $retainedPaths += $candidatePath
            } else {
                $removedPaths += $candidatePath
            }
        } catch {
            $retainedPaths += $candidatePath
        }
    }

    $result.RemovedPaths = @($removedPaths)
    $result.RetainedPaths = @($retainedPaths)
    if ($retainedPaths.Count -gt 0) {
        $result.WarningMessage = "ccq.exe 替换已完成，但以下旧版本备份暂未清理: " +
            ($retainedPaths -join ', ')
    }
    return $result
}

function Replace-CcqExecutable {
    <#
    .SYNOPSIS
    用 [System.IO.File]::Replace 原子替换 ccq.exe，替换运行中映像不抛 ERROR_ALREADY_EXISTS(183)。
    .DESCRIPTION
    - 目标不存在 → [System.IO.File]::Move。
    - 目标存在 → [System.IO.File]::Replace(temp, target, backup, $true)（NTFS 事务性替换）。
    - 循环 20 × 250ms（复用 self-update.ts / windows-deferred-operation.ts 已验证量级，不另发明参数）。
    - 抛错后用「temp 已被消费 + target 尺寸匹配」二次确认（对齐 self-update.ts:922-926；
      加 temp 判别式是因为安装器无预期 SHA256 可比，纯尺寸会误判同尺寸重装）。
    - 彻底失败时：target 缺失且 backup 在手则回滚；否则原 target 完好不动。
    - 核心不变量：绝不让用户失去可用的 ccq.exe。仅在确认 target 可用后才删 backup；
      回滚未完成时保留 backup 并在错误信息中告知其路径。
    .PARAMETER TempPath
    下载好的临时文件路径（必须与 TargetPath 同目录以满足 File.Replace 同卷约束）。
    .PARAMETER TargetPath
    目标 ccq.exe 完整路径。
    .OUTPUTS
    @{ Success = $true/$false; ErrorMessage = ""; BackupPath = "..." }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$TempPath,

        [Parameter(Mandatory = $true)]
        [string]$TargetPath
    )

    $result = @{
        Success      = $false
        ErrorMessage = ""
        BackupPath   = ""
    }

    # backup 与 temp 都在 target 同目录，满足 File.Replace 同卷约束。
    $backupPath = "$TargetPath.backup.$PID"
    $result.BackupPath = $backupPath

    # 记录 temp 大小，供二次确认与最终校验使用。
    $tempSize = -1L
    if (Test-Path -LiteralPath $TempPath) {
        $tempSize = (Get-Item -LiteralPath $TempPath).Length
    } else {
        $result.ErrorMessage = "临时文件不存在，无法替换"
        return $result
    }

    # 同一长生命周期安装进程可能在上一次回滚失败后再次进入此函数。相同 PID 会生成
    # 相同 backup 路径，而该文件可能是用户唯一可恢复的旧版本，绝不能作为“残留”删除。
    # 本次事务尚未开始，可以安全清理的只有它自己的 temp。
    if (Test-Path -LiteralPath $backupPath) {
        Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue
        $result.ErrorMessage = "检测到未完成替换保留的旧版本备份，已停止本次替换且未修改现有 ccq.exe。请先恢复或移走备份后重试: $backupPath"
        return $result
    }

    $replaced = $false
    # 复用 self-update.ts 已验证的量级：20 次 × 250ms（windows-deferred-operation.ts:6-7）。
    $maxAttempts = 20
    $intervalMs = 250

    for ($i = 1; $i -le $maxAttempts; $i++) {
        try {
            if (Test-Path -LiteralPath $TargetPath) {
                # NTFS 事务性替换：temp → target，旧 target → backup。
                [System.IO.File]::Replace($TempPath, $TargetPath, $backupPath, $true)
            } else {
                [System.IO.File]::Move($TempPath, $TargetPath)
            }
            $replaced = $true
            break
        } catch {
            # 二次确认：File.Replace/Move 抛错不代表没成功（对齐 self-update.ts:922-926）。
            # 安装器没有预期 SHA256 可比（self-update 有），只靠尺寸会在「同尺寸重装」时
            # 把失败误判成功。补一个零成本强判别式：替换成功后 temp 必然已被消费。
            # 被锁失败时 temp 仍在，因此该条件能排除同尺寸假阳性。
            $confirmed = $false
            try {
                $confirmed = (-not (Test-Path -LiteralPath $TempPath) -and
                    (Test-Path -LiteralPath $TargetPath) -and $tempSize -gt 0 -and
                    ((Get-Item -LiteralPath $TargetPath).Length -eq $tempSize))
            } catch {
                # 目标在二次确认期间被并发删除/替换时，按未确认处理并继续重试；
                # 确认本身不能遮蔽原始替换错误或跳过清理/回滚。
                $confirmed = $false
            }
            if ($confirmed) {
                $replaced = $true
                break
            }
            if ($i -lt $maxAttempts) {
                Start-Sleep -Milliseconds $intervalMs
            }
        }
    }

    if (-not $replaced) {
        # Win32 ReplaceFile 不是全程原子：ERROR_UNABLE_TO_MOVE_REPLACEMENT_2(1177) 下
        # target 已被改名为 backup 而 temp 仍在原名，此时 target 不存在。
        # 因此「backup 存在」不等于可以删 backup —— 那是用户唯一的旧版本。
        # 不变量：只有确认 target 已是可用文件，才允许删 backup。
        $restoreAttempted = $false
        $restored = $false
        if ((Test-Path -LiteralPath $backupPath) -and -not (Test-Path -LiteralPath $TargetPath)) {
            # target 缺失且 backup 在手：把旧版本搬回 target，避免用户失去可用 ccq.exe。
            $restoreAttempted = $true
            $restored = Restore-CcqExecutableBackup -BackupPath $backupPath -TargetPath $TargetPath
        }
        if (Test-Path -LiteralPath $TempPath) {
            Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue
        }
        # 失败路径不能仅凭 target 存在就删除 backup：ReplaceFile 报错后的 target 状态并
        # 不足以证明旧版本安全。只有本次回滚已确认成功时，才可清理仍存在的 backup。
        if ($restoreAttempted -and $restored -and
            (Test-Path -LiteralPath $backupPath) -and (Test-Path -LiteralPath $TargetPath)) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $TargetPath) {
            if (Test-Path -LiteralPath $backupPath) {
                $result.ErrorMessage = "ccq.exe 替换在 ${maxAttempts} 次重试后仍失败；当前目标仍在，旧版本备份已保留在: $backupPath"
            } else {
                $result.ErrorMessage = "ccq.exe 被占用，替换在 ${maxAttempts} 次重试后仍失败，已保留现有版本。请关闭所有 ccq 进程后重试。"
            }
        } else {
            $result.ErrorMessage = "ccq.exe 替换在 ${maxAttempts} 次重试后仍失败，且目标缺失。旧版本备份保留在: $backupPath"
        }
        return $result
    }

    # 最终校验（对齐 self-update.ts:932）：替换成功后确认 target 是期望产物。
    $targetMatchesExpected = $false
    try {
        if ((Test-Path -LiteralPath $TargetPath) -and $tempSize -gt 0) {
            $targetMatchesExpected = ((Get-Item -LiteralPath $TargetPath).Length -eq $tempSize)
        }
    } catch {
        $targetMatchesExpected = $false
    }
    if (-not $targetMatchesExpected) {
        # 替换声称成功但目标非期望产物：从 backup 回滚旧 target。
        $hadBackup = Test-Path -LiteralPath $backupPath
        $restored = $false
        if ($hadBackup) {
            $restored = Restore-CcqExecutableBackup -BackupPath $backupPath -TargetPath $TargetPath
        }
        if (Test-Path -LiteralPath $TempPath) {
            Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue
        }
        # 回滚失败时必须保留 backup —— 它是用户唯一的旧版本凭据，删掉就是数据丢失。
        if ($restored -and (Test-Path -LiteralPath $backupPath)) {
            Remove-Item -LiteralPath $backupPath -Force -ErrorAction SilentlyContinue
        }
        if ($restored) {
            $result.ErrorMessage = "ccq.exe 替换后校验失败，已回滚旧版本。请重试。"
        } elseif ($hadBackup) {
            $result.ErrorMessage = "ccq.exe 替换后校验失败且回滚未完成。旧版本备份保留在: $backupPath"
        } else {
            $result.ErrorMessage = "ccq.exe 替换后校验失败，且无备份可回滚。请重试。"
        }
        return $result
    }

    # 成功路径：temp 可直接回收；backup 只能在重新验证 target 后按 replacement cleanup 合同处理。
    if (Test-Path -LiteralPath $TempPath) {
        Remove-Item -LiteralPath $TempPath -Force -ErrorAction SilentlyContinue
    }
    try {
        $cleanupResult = Clear-CcqReplacementBackupsAfterVerifiedReplace `
            -TargetPath $TargetPath `
            -CurrentBackupPath $backupPath `
            -ExpectedTargetSize $tempSize `
            -MaxAttempts $maxAttempts `
            -IntervalMs $intervalMs
        if (-not [string]::IsNullOrWhiteSpace([string]$cleanupResult.WarningMessage)) {
            Write-UiWarning $cleanupResult.WarningMessage
        }
    } catch {
        # replacement 已通过最终校验；cleanup 异常不能把新 target 降级为失败。
        Write-UiWarning "ccq.exe 替换已完成，但备份清理失败，已保留未确认项。备份路径: $backupPath"
    }

    $result.Success = $true
    return $result
}

function Expand-CcqGzipFile {
    <#
    .SYNOPSIS
    完整解压 gzip 文件到新的 raw 临时文件，并拒绝空输出。
    .DESCRIPTION
    使用 GzipStream 读到流末尾，使截断、CRC 或尾部错误表现为失败。输出以
    CreateNew 创建；失败时只清理本次创建的 raw partial，不修改 gzip 输入或目标文件。
    .OUTPUTS
    @{ Success = $true/$false; ErrorMessage = ""; OutputSize = 0 }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$GzipPath,

        [Parameter(Mandatory = $true)]
        [string]$OutputPath
    )

    $result = @{
        Success      = $false
        ErrorMessage = ""
        OutputSize   = 0L
    }
    $inputStream = $null
    $gzipStream = $null
    $outputStream = $null
    $outputCreated = $false

    try {
        $streamError = $null
        try {
            if (-not (Test-Path -LiteralPath $GzipPath -PathType Leaf)) {
                throw "gzip 临时文件不存在: $GzipPath"
            }

            $inputStream = [System.IO.File]::Open(
                $GzipPath,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::Read,
                [System.IO.FileShare]::Read
            )
            $gzipStream = New-Object System.IO.Compression.GzipStream(
                $inputStream,
                [System.IO.Compression.CompressionMode]::Decompress
            )
            $outputStream = [System.IO.File]::Open(
                $OutputPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            $outputCreated = $true
            $gzipStream.CopyTo($outputStream)
            $outputStream.Flush()
        } catch {
            $streamError = $_
        } finally {
            # 每个 Dispose 都必须独立尝试；PS5.1 下任一关闭异常都不能阻止后续句柄释放。
            foreach ($stream in @($outputStream, $gzipStream, $inputStream)) {
                if ($null -eq $stream) { continue }
                try {
                    $stream.Dispose()
                } catch {
                    if ($null -eq $streamError) { $streamError = $_ }
                }
            }
        }
        if ($null -ne $streamError) {
            throw $streamError
        }

        if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) {
            throw "gzip 解压后文件不存在"
        }

        $outputSize = (Get-Item -LiteralPath $OutputPath).Length
        if ($outputSize -le 0) {
            throw "gzip 解压结果为空"
        }

        $result.Success = $true
        $result.OutputSize = [long]$outputSize
    } catch {
        if ($outputCreated -and (Test-Path -LiteralPath $OutputPath)) {
            Remove-Item -LiteralPath $OutputPath -Force -ErrorAction SilentlyContinue
        }
        $result.ErrorMessage = $_.Exception.Message
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
        [Parameter(Mandatory = $true)]
        [string]$DownloadUrl
    )

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Path         = ""
    }
    $tempPath = $null
    $gzipTempPath = $null

    try {
        $ccqPath = Get-CcqExecutablePath
        $ccqBinDir = Split-Path -Parent $ccqPath

        # 1. 占用预检：在网络传输前确认目标可替换，避免下载后才失败。
        $lockState = Test-CcqExecutableLocked -Path $ccqPath
        if ($lockState.Locked) {
            $procs = @($lockState.Processes)
            $msg = "ccq 正在运行或目标被占用，无法替换 ccq.exe"
            if ($procs.Count -gt 0) {
                $pidList = ($procs | ForEach-Object { "PID $($_.ProcessId)" }) -join ', '
                $msg += "（检测到 ccq 进程: $pidList）"
            }
            $msg += "。请先关闭所有 ccq 窗口（含 'ccq cc' 启动的会话）后重试；若仍失败请确认文件未被占用且可写。"
            $result.ErrorMessage = $msg
            Write-UiDanger "ccq 可执行文件安装失败: $msg"
            # 命令行单独打印：ErrorMessage 保持单行可读，明细帮助用户定位是哪个会话还开着。
            foreach ($proc in $procs) {
                $procCmd = [string]$proc.CommandLine
                if ([string]::IsNullOrWhiteSpace($procCmd)) { $procCmd = '(命令行不可读，可能权限不足)' }
                elseif ($procCmd.Length -gt 160) { $procCmd = $procCmd.Substring(0, 160) + '...' }
                Write-UiDim "  PID $($proc.ProcessId): $procCmd"
            }
            return $result
        }
        # 探测异常不阻断：预检是优化路径，Locked=$false 一律放行，交给后续替换逻辑与重试兜底。

        # 2. 创建目标目录
        if (-not (Test-Path $ccqBinDir)) {
            New-Item -ItemType Directory -Path $ccqBinDir -Force | Out-Null
            Write-UiInfo "创建 ccq 目录: $ccqBinDir"
        }

        # 3. 优先下载 gzip 传输资产；不可用或损坏时自动回退 raw URL。
        # 两个临时文件都在 target 同目录，后续 raw temp 可直接交给 File.Replace。
        $tempPath = "$ccqPath.download.$PID"
        $gzipTempPath = "$tempPath.gz"
        foreach ($transportTemp in @($tempPath, $gzipTempPath)) {
            if (Test-Path -LiteralPath $transportTemp) {
                Remove-Item -LiteralPath $transportTemp -Force -ErrorAction SilentlyContinue
            }
        }

        $gzipUrl = "$DownloadUrl.gz"
        $gzipFailureContext = ""
        $gzipReady = $false
        try {
            $gzipDownloadResult = Invoke-FileDownload -Url $gzipUrl -OutputPath $gzipTempPath -Description "ccq gzip 传输资产"
            if (-not $gzipDownloadResult.Success) {
                $gzipFailureContext = "gzip 下载失败: $($gzipDownloadResult.ErrorMessage)"
            } else {
                $expandResult = Expand-CcqGzipFile -GzipPath $gzipTempPath -OutputPath $tempPath
                if ($expandResult.Success) {
                    $gzipReady = $true
                    Remove-Item -LiteralPath $gzipTempPath -Force -ErrorAction SilentlyContinue
                } else {
                    $gzipFailureContext = "gzip 解压失败: $($expandResult.ErrorMessage)"
                }
            }
        } catch {
            $gzipFailureContext = "gzip 传输异常: $($_.Exception.Message)"
        }

        if (-not $gzipReady) {
            foreach ($transportTemp in @($tempPath, $gzipTempPath)) {
                if (Test-Path -LiteralPath $transportTemp) {
                    Remove-Item -LiteralPath $transportTemp -Force -ErrorAction SilentlyContinue
                }
            }
            if ([string]::IsNullOrWhiteSpace($gzipFailureContext)) {
                $gzipFailureContext = "gzip 传输未生成可用文件"
            }
            Write-UiWarning "gzip 传输失败（$gzipFailureContext），正在改用 raw 资产..."

            try {
                $rawDownloadResult = Invoke-FileDownload -Url $DownloadUrl -OutputPath $tempPath -Description "ccq raw 可执行文件"
            } catch {
                throw "raw 下载失败: $($_.Exception.Message)；gzip 失败上下文: $gzipFailureContext"
            }
            if (-not $rawDownloadResult.Success) {
                throw "raw 下载失败: $($rawDownloadResult.ErrorMessage)；gzip 失败上下文: $gzipFailureContext"
            }
        }

        # 4. 无论来源为何，只有完整且非空的 raw temp 才能进入替换流程。
        if (-not (Test-Path -LiteralPath $tempPath -PathType Leaf)) {
            if ($gzipReady) {
                throw "gzip 解压后的 raw 文件不存在"
            }
            throw "raw 下载失败: 下载后文件不存在；gzip 失败上下文: $gzipFailureContext"
        }
        $fileInfo = Get-Item -LiteralPath $tempPath
        if ($fileInfo.Length -eq 0) {
            if ($gzipReady) {
                throw "gzip 解压后的 raw 文件为空"
            }
            throw "raw 下载失败: 下载的文件为空；gzip 失败上下文: $gzipFailureContext"
        }

        # 5. 原子替换：File.Replace 替换运行中映像，重试退避，失败回滚。
        $replaceResult = Replace-CcqExecutable -TempPath $tempPath -TargetPath $ccqPath
        if (-not $replaceResult.Success) {
            # Replace-CcqExecutable 已清理 temp，并保证现有 target 完好。
            $result.ErrorMessage = $replaceResult.ErrorMessage
            Write-UiDanger "ccq 可执行文件安装失败: $($result.ErrorMessage)"
            return $result
        }
        # temp 已在 Replace-CcqExecutable 内被 Move/Replace 消费，不再存在。
        $tempPath = $null
        if (Test-Path -LiteralPath $gzipTempPath) {
            Remove-Item -LiteralPath $gzipTempPath -Force -ErrorAction SilentlyContinue
        }
        $gzipTempPath = $null

        Write-UiSuccess "✓ ccq 可执行文件已下载到: $ccqPath"
        Write-UiDim "  文件大小: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"

        # 6. 确保目录在用户 PATH（通过注册表 HKCU\Environment）
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
        foreach ($transportTemp in @($tempPath, $gzipTempPath)) {
            if ($transportTemp -and (Test-Path -LiteralPath $transportTemp)) {
                Remove-Item -LiteralPath $transportTemp -Force -ErrorAction SilentlyContinue
            }
        }
        $result.ErrorMessage = $_.Exception.Message
        Write-UiDanger "ccq 可执行文件安装失败: $($result.ErrorMessage)"
    }

    return $result
}

function Get-UserPathRegistryState {
    <#
    .SYNOPSIS
    读取用户 PATH 的原始注册表值及其类型，不展开环境变量。
    .DESCRIPTION
    HKCU\Environment\Path 常见为 REG_EXPAND_SZ。必须保留原始的
    %NVM_HOME%/%NVM_SYMLINK% 等表达式，不能通过
    [Environment]::GetEnvironmentVariable(..., "User") 读取展开后的值。
    #>
    param()

    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $false)
        if (-not $key) {
            return @{
                Exists = $false
                Value   = ""
                Kind    = [Microsoft.Win32.RegistryValueKind]::String
            }
        }

        $pathExists = @($key.GetValueNames()) -contains "Path"
        if (-not $pathExists) {
            return @{
                Exists = $false
                Value   = ""
                Kind    = [Microsoft.Win32.RegistryValueKind]::String
            }
        }

        return @{
            Exists = $true
            Value   = [string]$key.GetValue(
                "Path",
                "",
                [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
            )
            Kind    = $key.GetValueKind("Path")
        }
    } finally {
        if ($key) {
            $key.Close()
        }
    }
}

function Set-UserPathRegistryValue {
    <#
    .SYNOPSIS
    按指定注册表类型写入用户 PATH。
    #>
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Value,

        [Parameter(Mandatory = $true)]
        [Microsoft.Win32.RegistryValueKind]$Kind
    )

    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", $true)
        if (-not $key) {
            $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment")
        }
        if (-not $key) {
            throw "无法打开用户环境变量注册表项"
        }

        $key.SetValue("Path", $Value, $Kind)
    } finally {
        if ($key) {
            $key.Close()
        }
    }
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
        # 1. 读取用户 PATH 原始值；不能读取展开后的值，否则会破坏 nvm 变量引用。
        $pathState = Get-UserPathRegistryState
        $currentPath = [string]$pathState.Value
        if ([string]::IsNullOrWhiteSpace($currentPath)) {
            $currentPath = ""
        }

        $pathKind = [Microsoft.Win32.RegistryValueKind]$pathState.Kind
        if ($pathKind -notin @(
                [Microsoft.Win32.RegistryValueKind]::String,
                [Microsoft.Win32.RegistryValueKind]::ExpandString
            )) {
            throw "用户 PATH 注册表类型不受支持: $pathKind"
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

        # 4. 按原始注册表类型写回，保留 %NVM_HOME%/%NVM_SYMLINK% 等表达式。
        Set-UserPathRegistryValue -Value $newPath -Kind $pathKind
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
