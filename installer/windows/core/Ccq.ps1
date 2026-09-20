# Ccq.ps1 - ccq 可执行文件管理（Windows 平台唯一实现）
# 功能: 架构/路径检测、版本规范化与比较、Release tag/URL 解析、下载（gzip-first/raw fallback）、
#       运行中映像替换与回滚、replacement backup cleanup、用户 PATH 注册表写入、下载 handoff 确认。
# 说明: 完整 install 与 download-ccq.ps1 专用入口都 dot-source 本文件消费同一实现；
#       本文件是这些 CCQ 行为函数的唯一声明处，旧 Process.ps1 / Install.ps1 不得再定义。

#Requires -Version 5.1

Set-StrictMode -Version Latest
# ─── CCQ 可执行文件管理 ──────────────────────────────────────────────────────

function Get-CcqArchitecture {
    <#
    .SYNOPSIS
    检测当前平台架构，返回 ccq 可执行文件对应的 target 名称
    .OUTPUTS
    "windows-x64" | "windows-arm64"
    .DESCRIPTION
    仅支持 x64/AMD64 与 ARM64；无法判定真实架构时明确失败，绝不回退猜测。
    #>
    param()

    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        'ARM64' { return "windows-arm64" }
        'AMD64' { return "windows-x64" }
        # 32-bit 宿主（x86）下 PROCESSOR_ARCHITECTURE 是 x86，但 PROCESSOR_ARCHITEW6432
        # 暴露真实架构；只有在这里能确定时才返回，否则失败。
        'x86' {
            $w6432 = $env:PROCESSOR_ARCHITEW6432
            switch ($w6432) {
                'ARM64' { return "windows-arm64" }
                'AMD64' { return "windows-x64" }
                default { throw "无法在 32-bit 宿主下确定 Windows 处理器架构: PROCESSOR_ARCHITECTURE=$arch, PROCESSOR_ARCHITEW6432=$w6432" }
            }
        }
        default {
            throw "无法识别的 Windows 处理器架构: $arch"
        }
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
            $msg += "。请先关闭所有 ccq 窗口后重试；若仍失败请确认文件未被占用且可写。"
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

# ─── CCQ Release 解析与下载 handoff ──────────────────────────────────────────
function Get-CcqReleaseTag {
    <#
    .SYNOPSIS
    返回当前安装器对应的 Release tag；源码模式通常为不可比较的占位值。
    #>
    param()

    $tag = [Environment]::GetEnvironmentVariable("CCQ_RELEASE_TAG", "Process")
    if ([string]::IsNullOrWhiteSpace($tag)) {
        $tag = $script:CcqReleaseTag
    }

    return $tag.Trim()
}

function Get-CcqReleaseTargetVersion {
    <#
    .SYNOPSIS
    从 Release tag 提取可与 ccq --version 比较的目标版本。
    #>
    param()

    $tag = Get-CcqReleaseTag
    if ($tag -notlike 'v*') {
        return ""
    }

    $version = ConvertTo-CcqComparableVersion -Version $tag
    if ($version -notmatch '^\d+\.\d+\.\d+') {
        return ""
    }

    return $version
}

function Get-CcqReleaseDownloadBaseUrl {
    <#
    .SYNOPSIS
    解析 ccq 可执行文件下载基址；tag 构建使用当前 Release，源码运行回退 latest。
    #>
    param()

    $overrideUrl = [Environment]::GetEnvironmentVariable("CCQ_RELEASE_DOWNLOAD_BASE_URL", "Process")
    if (-not [string]::IsNullOrWhiteSpace($overrideUrl)) {
        return $overrideUrl.TrimEnd('/')
    }

    $tag = Get-CcqReleaseTag

    # 哨兵判断改用"tag 是否以 v 开头"（与 build.ps1 的 GITHUB_REF_NAME -like 'v*' 约定一致）。
    # 不可比对占位符字面量：build 用全文 Replace 注入 tag，会把此处的 "__CCQ_RELEASE_TAG__" 一并
    # 替换成实际 tag，导致 `$tag -ne $tag` 恒为 false → 永远走 latest 兜底（已实测复现）。
    if ($tag -like 'v*') {
        return "https://github.com/MrNine-666/claude-code-quickstart/releases/download/$tag"
    }

    return "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download"
}

function Confirm-CcqExecutableDownload {
    <#
    .SYNOPSIS
    在 install 末尾或专用下载入口中执行 ccq 下载与安装的 handoff。
    .DESCRIPTION
    完整 install 与 download-ccq.ps1 共用本 handoff，仅入口 UX 不同：
    - Install：未安装时先弹「是否现在下载 ccq 可执行文件」确认，用户可拒绝。
    - Dedicated：用户主动运行专用下载脚本即视为首次下载授权，跳过首次确认菜单。
    两种模式都保留：同版本跳过；版本不一致时显示默认保留的覆盖菜单；目标版本未知时保留现有可执行文件。
    确认后按平台架构下载到 %USERPROFILE%\.local\bin\ccq.exe，并通过注册表
    HKCU\Environment 加入用户 PATH（非 Profile）。
    .PARAMETER Mode
    Install = 完整安装入口（保留首次下载确认）；Dedicated = 专用下载入口（视为已授权）。
    .OUTPUTS
    $true = ccq 已可用，或按既定策略有意跳过（同版本 / 目标版本未知 / 用户选择保留 / 用户放弃首次下载）。
    $false = 本次确实尝试下载但没有得到可用的 ccq 可执行文件（例如锁定、传输失败、替换失败）。
    专用入口据此决定进程退出码；完整 install 继续沿用「告警但不中断」的既有行为。
    #>
    param(
        [ValidateSet('Install', 'Dedicated')]
        [string]$Mode = 'Install'
    )

    Write-UiPrimary "ccq 管理工具安装"
    Write-Host ""
    Write-UiInfo "ccq 是 Claude Code Quickstart 的管理控制台，提供以下功能："
    Write-UiInfo "  • 供应商管理（Provider 配置）"
    Write-UiInfo "  • MCP Server 管理"
    Write-UiInfo "  • Skills 管理"
    Write-UiInfo "  • 提示词配置"
    Write-UiInfo "  • 配置文件管理"
    Write-UiInfo "  • 工具管理（安装/更新 Claude Code、Codex、Pi、CodeGraph、OpenSpec 等）"
    Write-UiInfo "  • 扩展管理（安装/更新/卸载 Pi package 扩展）"
    Write-Host ""

    # 1. 已安装时先比较当前版本与安装器 Release 版本。
    $installed = Test-CcqExecutableInstalled
    $targetVersion = Get-CcqReleaseTargetVersion
    if ($installed.IsInstalled) {
        Write-UiSuccess "✓ ccq 可执行文件已安装: $($installed.Path)"
        Write-UiInfo "  当前版本: $($installed.Version)"

        if ([string]::IsNullOrWhiteSpace($targetVersion)) {
            Write-UiWarning "无法确定安装器目标版本，已保留现有 ccq"
            Write-UiDim "  如需更新，请使用正式 Release 安装脚本或在 ccq 中执行更新"
            return $true
        }

        Write-UiInfo "  目标版本: $targetVersion"
        $currentVersion = ConvertTo-CcqComparableVersion -Version $installed.Version
        if ([string]::Equals($currentVersion, $targetVersion, [System.StringComparison]::OrdinalIgnoreCase)) {
            Write-UiSuccess "✓ 当前版本与目标版本一致，无需覆盖"
            return $true
        }

        Write-UiWarning "检测到 ccq 版本不一致"
        $overwriteDecision = Show-SingleSelectMenu `
            -Title "是否覆盖现有文件？" `
            -Options @("是，覆盖为 $targetVersion", "否，保留当前版本 $currentVersion") `
            -DefaultIndex 1

        if ($overwriteDecision -ne 0) {
            Write-UiInfo "已保留当前 ccq 版本: $currentVersion"
            return $true
        }

        Write-UiWarning "将使用目标版本 $targetVersion 覆盖当前版本 $currentVersion"
    } else {
        if ($Mode -eq 'Dedicated') {
            # 用户主动运行专用下载入口，本身就是首次下载授权，不再重复询问是否下载。
            Write-UiInfo "用户主动运行 CCQ 专用下载入口，视为已授权下载 ccq 可执行文件"
        } else {
            $decision = Show-SingleSelectMenu `
                -Title "是否现在下载 ccq 可执行文件到 PATH 目录？" `
                -Options @("是，下载 ccq", "否，稍后手动安装") `
                -DefaultIndex 0

            if ($decision -ne 0) {
                Write-Host ""
                Write-UiInfo "已跳过 ccq 可执行文件下载"
                Write-UiDim "  如需稍后安装，请访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
                Write-Host ""
                Write-UiPrimary "后续安装 Claude Code / Codex / Pi："
                Write-UiInfo "  稍后安装 ccq 后运行 ccq，进入「工具管理」按需安装 Claude Code、Codex 或 Pi"
                Write-UiInfo "  API Key、provider/profile 可在「供应商」菜单中可视化配置；Pi 官方登录请在 Pi 中执行 /login"
                # 用户主动放弃首次下载：这是既定策略下的正常结束，不是失败。
                return $true
            }
        }
    }

    Write-Host ""
    Write-UiInfo "正在准备下载 ccq 可执行文件..."

    # 2. 检测平台架构
    $arch = Get-CcqArchitecture
    Write-UiInfo "检测到平台架构: $arch"

    # 3. 构建下载 URL
    $baseUrl = Get-CcqReleaseDownloadBaseUrl
    $exeName = "ccq-${arch}.exe"
    $downloadUrl = "${baseUrl}/${exeName}"

    Write-UiDim "  下载 URL: $downloadUrl"

    # 4. 执行下载与安装
    $installResult = Install-CcqExecutable -DownloadUrl $downloadUrl

    if ($installResult.Success) {
        Write-Host ""
        Write-UiSuccess " ccq 可执行文件安装成功！"
        Write-Host ""
        Write-UiPrimary "下一步："
        Write-UiInfo "  1. 打开 Windows Terminal，新建一个 PowerShell 7 标签页"
        Write-UiDim "     （Windows Terminal 中点击标签栏的 ∨ 下拉菜单选择 PowerShell）"
        Write-UiInfo "  2. 输入 ccq 进入管理控制台"
        Write-UiInfo "  3. 进入「工具管理」安装 Claude Code、Codex 或 Pi，再到「供应商」配置 API Key、provider/profile"
        Write-Host ""
        Write-UiDim "（当前会话 PATH 尚未刷新，必须开启新终端 ccq 命令才生效）"
    } else {
        Write-Host ""
        Write-UiWarning "ccq 可执行文件下载失败"
        Write-UiDim "  错误: $($installResult.ErrorMessage)"
        Write-UiInfo "您可以稍后手动下载："
        Write-UiInfo "  1. 访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
        Write-UiInfo "  2. 下载对应平台的可执行文件（$exeName）"
        Write-UiInfo "  3. 放置到任意 PATH 目录"
        Write-Host ""
        Write-UiPrimary "后续安装 Claude Code / Codex / Pi："
        Write-UiInfo "  等待 ccq 安装完成后运行 ccq，进入「工具管理」按需安装 Claude Code、Codex 或 Pi"
        Write-UiInfo "  API Key、provider/profile 可在「供应商」菜单中可视化配置；Pi 官方登录请在 Pi 中执行 /login"
    }

    # 只有 Install-CcqExecutable 的结果能决定成败：Success=$true 时上面已打印成功引导。
    # 专用入口用该返回值决定退出码，避免「下载失败仍报成功」被脚本化调用误判。
    return $installResult.Success
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
