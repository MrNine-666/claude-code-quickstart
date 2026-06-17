# 更新状态管理 - CCQ
# 作者: 哈雷酱 (本小姐的更新基础设施杰作！)
# 功能: 提供更新清单、内容指纹、更新快照等更新状态管理基础设施
# 与 macOS Update.zsh 对称的集中式 Update core（消除组织不对称，非功能变更）
# 依赖: Profile.ps1（Get-UserHome / Initialize-BackupDirectory / Write-FileAtomically / Get-CleanupPolicyContract / $script:BackupDirectory）,
#       Ui.ps1（Write-Ui*）。必须在 Profile.ps1 之后、Provider.ps1 之前加载。

#Requires -Version 7.0

# 严格模式
Set-StrictMode -Version Latest

# ============================================================
# 更新清单（内容指纹管理）
# ============================================================

function Get-UpdateManifestPath {
    <#
    .SYNOPSIS
    获取更新清单文件路径（~/.ccq/update-manifest.json）
    #>
    param()

    return "$(Get-UserHome)\.ccq\update-manifest.json"
}

function Read-UpdateManifest {
    <#
    .SYNOPSIS
    读取更新清单（容错：文件不存在或损坏时返回空清单）
    .RETURNS
    hashtable - 清单对象 { schemaVersion, steps, updatedAt }
    #>
    param()

    $emptyManifest = @{ schemaVersion = 1; steps = @{} }
    $path = Get-UpdateManifestPath

    if (-not (Test-Path $path)) {
        return $emptyManifest
    }

    try {
        $raw = Get-Content -Path $path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return $emptyManifest
        }

        $obj = $raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if (-not $obj -or -not $obj.ContainsKey("steps")) {
            return $emptyManifest
        }
        if (-not ($obj["steps"] -is [hashtable])) {
            $obj["steps"] = @{}
        }

        return $obj
    } catch {
        Write-UiWarning "更新清单读取失败，将重建: $($_.Exception.Message)"
        return $emptyManifest
    }
}

function Write-UpdateManifest {
    <#
    .SYNOPSIS
    原子写入更新清单
    .PARAMETER Manifest
    清单 hashtable 对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Manifest
    )

    $Manifest["updatedAt"] = (Get-Date).ToUniversalTime().ToString("o")

    $dir = Split-Path (Get-UpdateManifestPath) -Parent
    if (-not (Test-Path $dir)) {
        New-Item -Path $dir -ItemType Directory -Force | Out-Null
    }

    $json = $Manifest | ConvertTo-Json -Depth 12
    $success = Write-FileAtomically -FilePath (Get-UpdateManifestPath) -Content $json
    if (-not $success) {
        throw "更新清单写入失败: $(Get-UpdateManifestPath)"
    }
}

# ============================================================
# 内容指纹（变更检测）
# ============================================================

function Get-StringFingerprint {
    <#
    .SYNOPSIS
    计算字符串的 SHA256 指纹（用于内容变更检测）
    .PARAMETER Text
    要计算指纹的字符串
    .RETURNS
    64 字符的十六进制 SHA256 哈希
    #>
    param(
        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Text
    )

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
        $hash = $sha.ComputeHash($bytes)
        return ($hash | ForEach-Object { $_.ToString("x2") }) -join ""
    } finally {
        $sha.Dispose()
    }
}

# ============================================================
# 更新快照（变更前备份）
# ============================================================

function New-UpdateSnapshot {
    <#
    .SYNOPSIS
    创建更新前的会话级快照目录
    .PARAMETER FilePaths
    要备份的文件路径列表
    .RETURNS
    快照目录路径，失败时 throw
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$FilePaths
    )

    # 生成唯一目录名: update_yyyyMMdd_HHmmss_fff_<PID>_<GUID8>
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss_fff"
    $pid_ = $PID
    $guid8 = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $dirName = "update_${timestamp}_${pid_}_${guid8}"
    $snapshotDir = Join-Path $script:BackupDirectory $dirName

    # 确保备份根目录存在
    Initialize-BackupDirectory

    # 创建快照目录
    New-Item -Path $snapshotDir -ItemType Directory -Force | Out-Null

    # Canary 预检：验证可写性
    $canaryPath = Join-Path $snapshotDir "_canary.tmp"
    try {
        "canary" | Out-File -FilePath $canaryPath -Encoding UTF8 -Force
        if (-not (Test-Path $canaryPath)) {
            throw "快照目录不可写: $snapshotDir"
        }
        Remove-Item $canaryPath -Force
    } catch {
        throw "快照目录写入预检失败: $($_.Exception.Message)"
    }

    # 逐文件复制到快照目录
    $manifest = @{
        CreatedAt = (Get-Date).ToString("o")
        Files     = @()
    }

    foreach ($filePath in $FilePaths) {
        if (-not (Test-Path $filePath)) {
            continue
        }

        try {
            # 计算相对路径（以用户主目录为基准）
            $homeDir = Get-UserHome
            $relativePath = $filePath
            if ($filePath.StartsWith($homeDir, [System.StringComparison]::OrdinalIgnoreCase)) {
                $relativePath = $filePath.Substring($homeDir.Length).TrimStart('\', '/')
            }

            # 创建目标子目录
            $destPath = Join-Path $snapshotDir $relativePath
            $destDir = Split-Path $destPath -Parent
            if (-not (Test-Path $destDir)) {
                New-Item -Path $destDir -ItemType Directory -Force | Out-Null
            }

            # 复制文件
            Copy-Item -Path $filePath -Destination $destPath -Force

            # 计算 hash
            $hash = (Get-FileHash -Path $filePath -Algorithm SHA256).Hash

            $manifest.Files += @{
                Source    = $filePath
                Relative  = $relativePath
                Hash      = $hash
                Timestamp = (Get-Item $filePath).LastWriteTime.ToString("o")
            }
        } catch {
            Write-UiWarning "警告: 无法备份文件 $filePath : $($_.Exception.Message)"
        }
    }

    # 写入 manifest.json
    $manifestPath = Join-Path $snapshotDir "manifest.json"
    $manifest | ConvertTo-Json -Depth 5 | Out-File -FilePath $manifestPath -Encoding UTF8 -Force

    Write-UiSuccess "✓ 更新快照已创建: $snapshotDir ($($manifest.Files.Count) 个文件)"
    return $snapshotDir
}

function Clear-OldUpdateSnapshots {
    <#
    .SYNOPSIS
    清理旧的更新快照目录
    .PARAMETER MaxSnapshots
    保留的最大快照数（默认从契约读取，fallback 5）
    .PARAMETER DaysToKeep
    保留天数（默认从契约读取，fallback 30）
    .PARAMETER CurrentSnapshotDir
    当前会话快照目录，跳过不清理
    .RETURNS
    清理的目录数量
    #>
    param(
        [int]$MaxSnapshots = 0,
        [int]$DaysToKeep = 0,
        [string]$CurrentSnapshotDir = ""
    )

    try {
        # 从契约读取策略参数（contracts-first）
        $contractPolicy = Get-CleanupPolicyContract
        if ($MaxSnapshots -le 0) {
            $MaxSnapshots = if ($contractPolicy -and $contractPolicy.maxSnapshots) { $contractPolicy.maxSnapshots } else { 5 }
        }
        if ($DaysToKeep -le 0) {
            $DaysToKeep = if ($contractPolicy -and $contractPolicy.maxAgeInDays) { $contractPolicy.maxAgeInDays } else { 30 }
        }
        $recentMinutesSkip = if ($contractPolicy -and $contractPolicy.recentMinutesSkip) { $contractPolicy.recentMinutesSkip } else { 5 }

        if (-not (Test-Path $script:BackupDirectory)) {
            return 0
        }

        # HC-13: 强制数组上下文，防止 $null.Count 异常
        $allSnapshots = @(Get-ChildItem -Path $script:BackupDirectory -Directory -Filter "update_*" |
            Sort-Object CreationTime -Descending)

        if ($allSnapshots.Count -eq 0) {
            return 0
        }

        $cutoffDate = (Get-Date).AddDays(-$DaysToKeep)
        $recentCutoff = (Get-Date).AddMinutes(-$recentMinutesSkip)
        $dirsToDelete = @()

        foreach ($dir in $allSnapshots) {
            # 跳过当前会话快照
            if ($CurrentSnapshotDir -and $dir.FullName -eq $CurrentSnapshotDir) {
                continue
            }

            # 跳过最近 N 分钟内创建的目录
            if ($dir.CreationTime -gt $recentCutoff) {
                continue
            }

            $dirsToDelete += $dir
        }

        # 计算可保留的快照（排除当前会话和最近 5 分钟的）
        $eligibleSnapshots = @($allSnapshots | Where-Object {
            ($CurrentSnapshotDir -eq "" -or $_.FullName -ne $CurrentSnapshotDir) -and
            ($_.CreationTime -le $recentCutoff)
        })

        # 按时间排序，保留最新的 MaxSnapshots 个
        $toKeep = @($eligibleSnapshots | Select-Object -First $MaxSnapshots |
            Where-Object { $_.CreationTime -ge $cutoffDate })

        # 需要删除的 = 有资格的 - 保留的
        $toDelete = @($eligibleSnapshots | Where-Object {
            $_.FullName -notin @($toKeep | ForEach-Object { $_.FullName })
        })

        $deletedCount = 0
        foreach ($dir in $toDelete) {
            try {
                Remove-Item $dir.FullName -Recurse -Force
                $deletedCount++
            } catch {
                Write-UiWarning "警告: 无法删除快照目录: $($dir.Name)"
            }
        }

        if ($deletedCount -gt 0) {
            Write-UiSuccess "✓ 已清理 $deletedCount 个旧更新快照"
        }

        return $deletedCount

    } catch {
        Write-UiDanger "清理更新快照失败: $($_.Exception.Message)"
        return 0
    }
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
