# 文件安全编辑 - CCQ
# 作者: 哈雷酱 (本小姐的安全编辑杰作！)
# 功能: 提供文件备份、标记块编辑、原子写入等安全文件操作

#Requires -Version 5.1

# 严格模式
Set-StrictMode -Version Latest

# 全局配置
$script:BackupDirectory = "$env:TEMP\ClaudeEnvInstaller\Backups"
$script:ManagedBlockStartMarker = "# >>> Claude Code Quickstart >>>"
$script:ManagedBlockEndMarker = "# <<< Claude Code Quickstart <<<"

# ── 契约加载（contracts-first + inline fallback）──

function Get-CleanupPolicyContractsRoot {
    # irm|iex 场景下 $PSScriptRoot 为空，直接返回空触发 fallback
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        return ""
    }

    $currentDir = $PSScriptRoot
    for ($i = 0; $i -lt 3; $i++) {
        $currentDir = Split-Path -Parent $currentDir
        if ([string]::IsNullOrWhiteSpace($currentDir)) {
            break
        }

        # installer 契约位于 installer/contracts/（TDR-10 拆分）；从 core/ 上溯命中（i=1 = installer/contracts/）
        $contractsDir = Join-Path $currentDir "contracts"
        if (Test-Path $contractsDir) {
            return $contractsDir
        }
    }
    return ""
}

function Get-CleanupPolicyContractPath {
    if (-not [string]::IsNullOrWhiteSpace($env:CCQ_CLEANUP_POLICY_CONTRACT)) {
        return $env:CCQ_CLEANUP_POLICY_CONTRACT
    }
    $contractsRoot = Get-CleanupPolicyContractsRoot
    if ([string]::IsNullOrWhiteSpace($contractsRoot)) { return "" }
    return (Join-Path $contractsRoot "cleanup-policy.json")
}

function Get-CleanupPolicyContract {
    $contractPath = Get-CleanupPolicyContractPath
    if ([string]::IsNullOrWhiteSpace($contractPath) -or -not (Test-Path $contractPath)) {
        return $null
    }
    try {
        $contractRaw = Get-Content $contractPath -Raw -ErrorAction Stop
        $contractObj = $contractRaw | ConvertFrom-JsonToHashtable -ErrorAction Stop
        if ($contractObj -and $contractObj.ContainsKey("contract")) {
            return $contractObj["contract"]
        }
    } catch {
        # 静默降级到 fallback
    }
    return $null
}

# ============================================================
# 路径归一化工具（解决 Windows 8.3 短文件名问题）
# ============================================================

function Resolve-LongPath {
    <#
    .SYNOPSIS
    将路径（含 8.3 短路径如 ADMINI~1）解析为规范的长路径
    .PARAMETER Path
    待解析的路径
    .RETURNS
    规范化的长路径字符串；如果所有策略均失败，返回原始路径
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) { return $Path }

    # 策略 1: Get-Item 获取 FullName（最可靠）
    try {
        if (Test-Path $Path) {
            return (Get-Item $Path).FullName
        }
    } catch { }

    # 无 ~ 说明不是短路径，直接返回
    if ($Path -notmatch '~') { return $Path }

    # 策略 2: [System.IO.Path]::GetFullPath（不依赖文件存在）
    try {
        $resolved = [System.IO.Path]::GetFullPath($Path)
        if ($resolved -notmatch '~') { return $resolved }
    } catch { }

    # 策略 3: 逐级解析父目录
    try {
        $parent = Split-Path $Path -Parent
        $leaf = Split-Path $Path -Leaf
        if ($parent -and (Test-Path $parent)) {
            $resolvedParent = (Get-Item $parent).FullName
            if ($resolvedParent -notmatch '~') {
                return Join-Path $resolvedParent $leaf
            }
        }
    } catch { }

    # 所有策略失败，返回原始路径
    return $Path
}

function Get-UserHome {
    <#
    .SYNOPSIS
    获取规范化的用户主目录长路径（跨平台）
    .DESCRIPTION
    多重回退策略确保始终返回可用的长路径：
    GetFolderPath → $env:USERPROFILE → $HOMEDRIVE+$HOMEPATH → $HOME → $LOCALAPPDATA 父目录
    .RETURNS
    用户主目录的完整长路径
    #>
    param()

    # 策略 1: .NET GetFolderPath（最可靠，始终返回长路径）
    try {
        $path = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        if (-not [string]::IsNullOrWhiteSpace($path) -and (Test-Path $path)) {
            return (Get-Item $path).FullName
        }
    } catch { }

    # 策略 2: $env:USERPROFILE + Resolve-LongPath
    if (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        return Resolve-LongPath $env:USERPROFILE
    }

    # 策略 3: $HOMEDRIVE + $HOMEPATH
    if (-not [string]::IsNullOrWhiteSpace($env:HOMEDRIVE) -and -not [string]::IsNullOrWhiteSpace($env:HOMEPATH)) {
        $combined = Join-Path $env:HOMEDRIVE $env:HOMEPATH
        return Resolve-LongPath $combined
    }

    # 策略 4: $HOME
    if (-not [string]::IsNullOrWhiteSpace($env:HOME)) {
        return Resolve-LongPath $env:HOME
    }

    # 策略 5: $LOCALAPPDATA 父目录（最终回退）
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        try {
            return Split-Path (Resolve-LongPath $env:LOCALAPPDATA) -Parent
        } catch { }
    }

    # 极端情况：返回 $env:USERPROFILE 原始值
    return $env:USERPROFILE
}

function Initialize-BackupDirectory {
    <#
    .SYNOPSIS
    初始化备份目录
    #>
    param()

    try {
        # 归一化备份路径（解决 $env:TEMP 返回 8.3 短路径问题）
        $script:BackupDirectory = Resolve-LongPath $script:BackupDirectory

        if (-not (Test-Path $script:BackupDirectory)) {
            New-Item -Path $script:BackupDirectory -ItemType Directory -Force | Out-Null
            Write-UiSuccess "✓ 备份目录已创建: $script:BackupDirectory"
        }
    } catch {
        Write-UiWarning "警告: 无法创建备份目录: $($_.Exception.Message)"
    }
}

function Backup-FileWithTimestamp {
    <#
    .SYNOPSIS
    创建带时间戳的文件备份
    .PARAMETER FilePath
    要备份的文件路径
    .PARAMETER BackupReason
    备份原因（用于文件名）
    .RETURNS
    备份文件路径，如果备份失败则返回 $null
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string]$BackupReason = "edit"
    )

    if (-not (Test-Path $FilePath)) {
        Write-UiDim "文件不存在，无需备份: $FilePath"
        return $null
    }

    try {
        # 确保备份目录存在
        Initialize-BackupDirectory

        # 生成备份文件名
        $fileInfo = Get-Item $FilePath
        $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
        $backupFileName = "$($fileInfo.BaseName)_$($BackupReason)_$timestamp$($fileInfo.Extension)"
        $backupPath = Join-Path $script:BackupDirectory $backupFileName

        # 创建备份
        Copy-Item -Path $FilePath -Destination $backupPath -Force

        Write-UiSuccess "✓ 文件已备份: $backupPath"
        return $backupPath

    } catch {
        Write-UiWarning "警告: 文件备份失败: $($_.Exception.Message)"
        return $null
    }
}

function Get-ManagedBlockContent {
    <#
    .SYNOPSIS
    从文件中读取标记块内容
    .PARAMETER FilePath
    文件路径
    .PARAMETER StartMarker
    开始标记（可选，使用默认标记）
    .PARAMETER EndMarker
    结束标记（可选，使用默认标记）
    .RETURNS
    包含 Found, Content, StartLine, EndLine 的对象
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string]$StartMarker = $script:ManagedBlockStartMarker,

        [string]$EndMarker = $script:ManagedBlockEndMarker
    )

    $result = @{
        Found = $false
        Content = [System.Collections.ArrayList]::new()
        StartLine = -1
        EndLine = -1
        BeforeBlock = [System.Collections.ArrayList]::new()
        AfterBlock = [System.Collections.ArrayList]::new()
    }

    if (-not (Test-Path $FilePath)) {
        Write-UiDim "文件不存在: $FilePath" -Level Detail
        return $result
    }

    try {
        $lines = Get-Content $FilePath -Encoding UTF8 -ErrorAction SilentlyContinue

        # 处理空文件或读取失败的情况
        if ($null -eq $lines) {
            $lines = @()
        } elseif ($lines -isnot [array]) {
            # 单行文件会返回字符串而不是数组
            $lines = @($lines)
        }

        $inBlock = $false
        $lineNumber = 0

        foreach ($line in $lines) {
            $lineNumber++

            # 空行/null 防御：StrictMode 下对 $null 调用 .Trim() 会抛异常
            $lineText = if ($null -eq $line) { "" } else { [string]$line }

            if ($lineText.Trim() -eq $StartMarker.Trim()) {
                $result.StartLine = $lineNumber
                $inBlock = $true
                $result.Found = $true
                continue
            }

            if ($lineText.Trim() -eq $EndMarker.Trim() -and $inBlock) {
                $result.EndLine = $lineNumber
                $inBlock = $false
                continue
            }

            if ($inBlock) {
                $null = $result.Content.Add($lineText)
            } elseif ($result.StartLine -eq -1) {
                # 在标记块之前
                $null = $result.BeforeBlock.Add($lineText)
            } elseif ($result.EndLine -ne -1) {
                # 在标记块之后
                $null = $result.AfterBlock.Add($lineText)
            }
        }

        if ($result.Found) {
            Write-UiSuccess "✓ 找到标记块: 第 $($result.StartLine) - $($result.EndLine) 行"
        } else {
            Write-UiDim "未找到标记块" -Level Detail
            # 如果没有找到标记块，所有内容都在 BeforeBlock 中
            $result.BeforeBlock.Clear()
            foreach ($bLine in $lines) { $null = $result.BeforeBlock.Add($bLine) }
        }

        return $result

    } catch {
        Write-UiDanger "读取文件失败: $($_.Exception.Message)"
        throw
    }
}

function Set-ManagedBlockInFile {
    <#
    .SYNOPSIS
    在文件中设置标记块内容
    .PARAMETER FilePath
    文件路径
    .PARAMETER Content
    要写入标记块的内容数组
    .PARAMETER StartMarker
    开始标记（可选，使用默认标记）
    .PARAMETER EndMarker
    结束标记（可选，使用默认标记）
    .PARAMETER CreateIfNotExists
    如果文件不存在是否创建
    .PARAMETER AppendIfNoBlock
    如果没有找到标记块是否追加到文件末尾
    .RETURNS
    操作成功返回 $true，失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string[]]$Content,

        [string]$StartMarker = $script:ManagedBlockStartMarker,

        [string]$EndMarker = $script:ManagedBlockEndMarker,

        [switch]$CreateIfNotExists,

        [switch]$AppendIfNoBlock
    )

    try {
        # 验证 Content 参数
        if ($null -eq $Content -or $Content.Count -eq 0) {
            Write-UiWarning "内容为空，无法写入标记块"
            return $false
        }

        # 检查文件是否存在
        if (-not (Test-Path $FilePath)) {
            if ($CreateIfNotExists) {
                Write-UiPrimary "创建新文件: $FilePath" -Level Detail
                # 创建目录（如果不存在）
                $directory = Split-Path $FilePath -Parent
                if ($directory -and -not (Test-Path $directory)) {
                    New-Item -Path $directory -ItemType Directory -Force | Out-Null
                }
            } else {
                Write-UiDanger "文件不存在: $FilePath"
                return $false
            }
        }

        # 读取现有标记块
        $blockInfo = Get-ManagedBlockContent -FilePath $FilePath -StartMarker $StartMarker -EndMarker $EndMarker

        # 构建新的文件内容
        $newContent = [System.Collections.ArrayList]::new()

        # 添加标记块之前的内容
        if ($blockInfo.BeforeBlock -and $blockInfo.BeforeBlock.Count -gt 0) {
            foreach ($line in $blockInfo.BeforeBlock) {
                $null = $newContent.Add($line)
            }
        }

        # 如果没有找到标记块且需要追加
        if (-not $blockInfo.Found -and $AppendIfNoBlock) {
            # 如果文件不为空，添加空行分隔
            if ($newContent.Count -gt 0) {
                $null = $newContent.Add("")
            }
        }

        # 添加标记块
        $null = $newContent.Add($StartMarker)
        if ($Content -and $Content.Count -gt 0) {
            foreach ($line in $Content) {
                $null = $newContent.Add($line)
            }
        }
        $null = $newContent.Add($EndMarker)

        # 如果找到了标记块，添加标记块之后的内容
        if ($blockInfo.Found -and $blockInfo.AfterBlock -and $blockInfo.AfterBlock.Count -gt 0) {
            foreach ($line in $blockInfo.AfterBlock) {
                $null = $newContent.Add($line)
            }
        }

        # 转换为数组
        $contentArray = $newContent.ToArray()

        # 内容相等短路：避免无意义的备份和重写
        # 仅当结构完整（BEGIN + END 均找到）且内容一致时才短路，损坏块不短路以保留自愈能力
        if ((Test-Path $FilePath) -and $blockInfo.Found -and $blockInfo.EndLine -ne -1) {
            $existingContent = @($blockInfo.Content.ToArray())
            $innerContent = @($contentArray[1..($contentArray.Count - 2)])
            $contentEqual = $false
            if ($innerContent.Count -eq $existingContent.Count) {
                $contentEqual = $true
                for ($ci = 0; $ci -lt $innerContent.Count; $ci++) {
                    if ([string]$innerContent[$ci] -ne [string]$existingContent[$ci]) {
                        $contentEqual = $false
                        break
                    }
                }
            }
            if ($contentEqual) {
                Write-UiSuccess "✓ 标记块内容未变更，跳过写入: $FilePath" -Level Detail
                return $true
            }
        }

        # 备份现有文件（内容确实需要变更时才备份）
        if (Test-Path $FilePath) {
            $null = Backup-FileWithTimestamp -FilePath $FilePath -BackupReason "managed_block"
        }

        $success = Write-FileAtomically -FilePath $FilePath -Content $contentArray

        if ($success) {
            Write-UiSuccess "✓ 标记块已更新: $FilePath" -Level Detail
            return $true
        } else {
            Write-UiDanger "✗ 标记块更新失败: $FilePath"
            return $false
        }

    } catch {
        Write-UiDanger "设置标记块失败: $($_.Exception.Message)"
        return $false
    }
}

function Test-CcqSubsectionMarkersPresent {
    <#
    .SYNOPSIS
    检测托管块内容中是否存在 CCQ 子段标记
    .PARAMETER Content
    托管块内容数组
    .RETURNS
    存在任意子段标记返回 $true，否则返回 $false
    #>
    param(
        [AllowEmptyString()]
        [string[]]$Content
    )

    $lines = @()
    if ($null -ne $Content) {
        $lines = @($Content)
    }

    foreach ($line in $lines) {
        if ([string]::IsNullOrWhiteSpace([string]$line)) { continue }
        if (($line.Trim()) -match '^\s*#\s*\[CCQ:[A-Za-z0-9_-]+:(BEGIN|END)\]\s*$') {
            return $true
        }
    }

    return $false
}

function Convert-LegacyManagedBlockContentToSubsection {
    <#
    .SYNOPSIS
    将无子段标记的旧托管块内容包装为指定子段
    .PARAMETER Content
    旧托管块内容
    .PARAMETER LegacySection
    旧内容归属子段名（默认 FNM）
    .RETURNS
    转换后的托管块内容数组
    #>
    param(
        [AllowEmptyString()]
        [string[]]$Content,

        [string]$LegacySection = "FNM"
    )

    $source = @()
    if ($null -ne $Content) {
        $source = @($Content)
    }

    $result = [System.Collections.ArrayList]::new()
    $null = $result.Add("# [CCQ:$LegacySection:BEGIN]")
    foreach ($line in $source) {
        $null = $result.Add($line)
    }
    $null = $result.Add("# [CCQ:$LegacySection:END]")

    return $result.ToArray()
}



function Migrate-ManagedBlockToSubsections {
    <#
    .SYNOPSIS
    迁移旧托管块为子段结构（幂等）
    .PARAMETER FilePath
    Profile 文件路径
    .RETURNS
    迁移成功返回 $true，跳过或失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    try {
        $blockInfo = Get-ManagedBlockContent -FilePath $FilePath
        if (-not $blockInfo.Found) {
            return $false
        }

        $lines = @($blockInfo.Content.ToArray())
        $hasSubsectionMarkers = Test-CcqSubsectionMarkersPresent -Content $lines

        if ($hasSubsectionMarkers) {
            # 已有子段标记，检查是否存在”裸内容”（不在任何子段内的非标记非空行）
            # 裸内容是历史遗留的未包裹 FNM 配置，需要将其收敛为 FNM 子段
            $hasFnmBegin = $false
            $hasFnmEnd = $false
            $inAnySection = $false
            $hasBareContent = $false

            foreach ($checkLine in $lines) {
                $checkTrimmed = ([string]$checkLine).Trim()
                if ($checkTrimmed -eq '# [CCQ:FNM:BEGIN]') { $hasFnmBegin = $true; $inAnySection = $true; continue }
                if ($checkTrimmed -eq '# [CCQ:FNM:END]') { $hasFnmEnd = $true; $inAnySection = $false; continue }
                if ($checkTrimmed -match '^#\s*\[CCQ:[A-Za-z0-9_-]+:BEGIN\]$') { $inAnySection = $true; continue }
                if ($checkTrimmed -match '^#\s*\[CCQ:[A-Za-z0-9_-]+:END\]$') { $inAnySection = $false; continue }
                # 跳过损坏的空名称 CCQ 标记（如 # [CCQ:]），不视为裸内容
                if ($checkTrimmed -match '^#\s*\[CCQ:[^A-Za-z0-9_-]*\]$') { continue }
                # 不在任何子段内的非空行 = 裸内容
                if (-not $inAnySection -and -not [string]::IsNullOrWhiteSpace($checkTrimmed)) {
                    $hasBareContent = $true
                    break
                }
            }

            # 存在裸内容且 FNM 标记不完整时，将裸内容收敛为 FNM 子段（保留其他已有子段）
            if ($hasBareContent -and (-not $hasFnmBegin -or -not $hasFnmEnd)) {
                $fnmLines = [System.Collections.ArrayList]::new()
                $otherLines = [System.Collections.ArrayList]::new()
                $inSection = $false

                foreach ($wLine in $lines) {
                    $wTrimmed = ([string]$wLine).Trim()
                    # 跳过残留的 FNM 标记（避免重复）
                    if ($wTrimmed -eq '# [CCQ:FNM:BEGIN]' -or $wTrimmed -eq '# [CCQ:FNM:END]') { continue }
                    # 跳过损坏的空名称 CCQ 标记（如 # [CCQ:]），直接丢弃
                    if ($wTrimmed -match '^#\s*\[CCQ:[^A-Za-z0-9_-]*\]$') { continue }
                    if ($wTrimmed -match '^#\s*\[CCQ:[A-Za-z0-9_-]+:BEGIN\]$') {
                        $inSection = $true
                        $null = $otherLines.Add($wLine)
                        continue
                    }
                    if ($wTrimmed -match '^#\s*\[CCQ:[A-Za-z0-9_-]+:END\]$') {
                        $inSection = $false
                        $null = $otherLines.Add($wLine)
                        continue
                    }
                    if ($inSection) {
                        $null = $otherLines.Add($wLine)
                    } else {
                        # 裸内容归入 FNM 子段
                        $null = $fnmLines.Add($wLine)
                    }
                }

                $result = [System.Collections.ArrayList]::new()
                $null = $result.Add('# [CCQ:FNM:BEGIN]')
                foreach ($l in $fnmLines) { $null = $result.Add($l) }
                $null = $result.Add('# [CCQ:FNM:END]')
                foreach ($l in $otherLines) { $null = $result.Add($l) }
                return (Set-ManagedBlockInFile -FilePath $FilePath -Content $result.ToArray())
            }

            # FNM 标记完整或无裸内容，幂等成功
            return $true
        }


        $migratedContent = Convert-LegacyManagedBlockContentToSubsection -Content $lines -LegacySection "FNM"
        return (Set-ManagedBlockInFile -FilePath $FilePath -Content $migratedContent)

    } catch {
        Write-UiWarning "⚠ 托管块迁移失败: $($_.Exception.Message)" -Level Debug
        return $false
    }
}

function Set-ManagedSubsectionInFile {
    <#
    .SYNOPSIS
    在托管块中 Upsert 指定子段
    .PARAMETER FilePath
    Profile 文件路径
    .PARAMETER SectionName
    子段名称（如 FNM、SHORTCUTS）
    .PARAMETER SectionContent
    子段内容数组
    .RETURNS
    操作成功返回 $true，失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$SectionName,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$SectionContent
    )

    try {
        $blockInfo = Get-ManagedBlockContent -FilePath $FilePath
        if (-not $blockInfo.Found) {
            return $false
        }

        $lines = @($blockInfo.Content.ToArray())
        $beginMarker = "# [CCQ:$SectionName:BEGIN]"
        $endMarker = "# [CCQ:$SectionName:END]"

        $beginIdx = -1
        $endIdx = -1

        for ($i = 0; $i -lt $lines.Count; $i++) {
            $trimmed = $lines[$i].Trim()
            if ($trimmed -eq $beginMarker) {
                $beginIdx = $i
            }
            if ($trimmed -eq $endMarker) {
                $endIdx = $i
                break
            }
        }

        $newLines = [System.Collections.ArrayList]::new()

        if ($beginIdx -ge 0 -and $endIdx -ge 0 -and $endIdx -gt $beginIdx) {
            # 子段存在，替换
            for ($i = 0; $i -lt $beginIdx; $i++) {
                $null = $newLines.Add($lines[$i])
            }

            $null = $newLines.Add($beginMarker)
            foreach ($line in $SectionContent) {
                $null = $newLines.Add($line)
            }
            $null = $newLines.Add($endMarker)

            for ($i = $endIdx + 1; $i -lt $lines.Count; $i++) {
                $null = $newLines.Add($lines[$i])
            }
        } else {
            # 子段不存在，追加
            foreach ($line in $lines) {
                $null = $newLines.Add($line)
            }

            if ($newLines.Count -gt 0) {
                $null = $newLines.Add("")
            }

            $null = $newLines.Add($beginMarker)
            foreach ($line in $SectionContent) {
                $null = $newLines.Add($line)
            }
            $null = $newLines.Add($endMarker)
        }

        return (Set-ManagedBlockInFile -FilePath $FilePath -Content $newLines.ToArray())

    } catch {
        Write-UiWarning "⚠ 子段写入失败: $($_.Exception.Message)" -Level Debug
        return $false
    }
}

function Write-ProfileSubsection {
    <#
    .SYNOPSIS
    统一的 Profile 子段写入入口（迁移 + Upsert + 降级创建）
    .PARAMETER FilePath
    Profile 文件路径
    .PARAMETER SectionName
    子段名称（如 FNM、SHORTCUTS）
    .PARAMETER SectionContent
    子段内容数组
    .RETURNS
    操作成功返回 $true，失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$SectionName,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$SectionContent
    )

    try {
        # 1. 迁移旧结构（幂等）
        if (Test-Path $FilePath) {
            $null = Migrate-ManagedBlockToSubsections -FilePath $FilePath
        }

        # 2. 尝试子段 Upsert
        $result = Set-ManagedSubsectionInFile -FilePath $FilePath -SectionName $SectionName -SectionContent $SectionContent

        # 3. 降级：托管块不存在时创建新块
        if (-not $result) {
            $initialContent = @("# [CCQ:${SectionName}:BEGIN]")
            $initialContent += @($SectionContent)
            $initialContent += @("# [CCQ:${SectionName}:END]")
            $result = Set-ManagedBlockInFile -FilePath $FilePath -Content $initialContent -CreateIfNotExists -AppendIfNoBlock
        }

        return $result

    } catch {
        Write-UiWarning "⚠ Profile 子段写入失败: $($_.Exception.Message)" -Level Debug
        return $false
    }
}

function Remove-CcqSubsectionFromFile {
    <#
    .SYNOPSIS
    从托管块中移除指定子段（标记 + 内容）
    .DESCRIPTION
    移除指定子段后，若托管块内无实质内容，则连同托管块整体移除。
    .PARAMETER FilePath
    Profile 文件路径
    .PARAMETER SectionName
    子段名称（如 FNM、SHORTCUTS）
    .RETURNS
    操作成功返回 $true，失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$SectionName
    )

    try {
        if (-not (Test-Path $FilePath)) {
            return $true
        }

        # 迁移旧结构（幂等），确保子段标记存在
        $null = Migrate-ManagedBlockToSubsections -FilePath $FilePath

        $blockInfo = Get-ManagedBlockContent -FilePath $FilePath
        if (-not $blockInfo.Found) {
            return $true
        }

        $lines = @($blockInfo.Content.ToArray())
        $beginMarker = "# [CCQ:${SectionName}:BEGIN]"
        $endMarker = "# [CCQ:${SectionName}:END]"

        # 检测子段是否存在
        $hasBegin = $false
        $hasEnd = $false
        foreach ($line in $lines) {
            $trimmed = ([string]$line).Trim()
            if ($trimmed -eq $beginMarker) { $hasBegin = $true }
            if ($trimmed -eq $endMarker) { $hasEnd = $true }
        }

        if (-not $hasBegin -and -not $hasEnd) {
            return $true
        }

        # 剥离目标子段（标记 + 内容）
        $newLines = [System.Collections.ArrayList]::new()
        $inTargetSection = $false

        foreach ($line in $lines) {
            $trimmed = ([string]$line).Trim()

            if ($trimmed -eq $beginMarker) {
                $inTargetSection = $true
                continue
            }

            if ($inTargetSection -and $trimmed -eq $endMarker) {
                $inTargetSection = $false
                continue
            }

            if (-not $inTargetSection) {
                $null = $newLines.Add($line)
            }
        }

        # 检查剩余内容是否有实质性内容（非空白行）
        $hasContent = $false
        foreach ($remainLine in $newLines) {
            if (-not [string]::IsNullOrWhiteSpace([string]$remainLine)) {
                $hasContent = $true
                break
            }
        }

        if (-not $hasContent) {
            # 无实质内容，移除整个托管块
            return (Remove-ManagedBlockFromFile -FilePath $FilePath)
        }

        # 修剪尾部空行
        while ($newLines.Count -gt 0 -and [string]::IsNullOrWhiteSpace([string]$newLines[$newLines.Count - 1])) {
            $newLines.RemoveAt($newLines.Count - 1)
        }

        return (Set-ManagedBlockInFile -FilePath $FilePath -Content $newLines.ToArray())

    } catch {
        Write-UiWarning "⚠ 子段移除失败 [${SectionName}]: $($_.Exception.Message)" -Level Debug
        return $false
    }
}

function Write-FileAtomically {
    <#
    .SYNOPSIS
    原子写入文件（临时文件 + Move-Item）
    .PARAMETER FilePath
    目标文件路径
    .PARAMETER Content
    要写入的内容数组
    .PARAMETER Encoding
    文件编码
    .RETURNS
    操作成功返回 $true，失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [AllowEmptyCollection()]
        [string[]]$Content,

        [string]$Encoding = "UTF8"
    )

    $tempFile = $null

    try {
        # 验证 Content 参数（允许空数组，因为可能是空文件）
        if ($null -eq $Content) {
            Write-UiWarning "内容为 null，使用空数组"
            $Content = @()
        }

        # 确保 Content 是数组类型
        if ($Content -isnot [array]) {
            $Content = @($Content)
        }

        # 确保目标目录存在
        $directory = Split-Path $FilePath -Parent
        if ($directory -and -not (Test-Path $directory)) {
            New-Item -Path $directory -ItemType Directory -Force | Out-Null
        }

        # 生成临时文件路径（GUID 命名防并发冲突）
        $tempFile = "$FilePath.tmp_$([guid]::NewGuid().ToString('N').Substring(0,8))"

        # 写入临时文件（处理空数组的情况）
        if ($Content.Count -eq 0) {
            # 创建空文件
            New-Item -Path $tempFile -ItemType File -Force | Out-Null
        } else {
            $Content | Out-File -FilePath $tempFile -Encoding $Encoding -Force
        }

        # 验证临时文件写入成功
        if (-not (Test-Path $tempFile)) {
            throw "临时文件写入失败"
        }

        # 原子移动（重命名），含重试机制（3 次，指数退避 1s/2s/4s）
        $moveSuccess = $false
        for ($retry = 0; $retry -lt 3; $retry++) {
            try {
                Move-Item -Path $tempFile -Destination $FilePath -Force
                $moveSuccess = $true
                break
            } catch {
                if ($retry -eq 2) { throw }
                Start-Sleep -Seconds ([math]::Pow(2, $retry))
            }
        }

        # 验证最终文件存在
        if (-not $moveSuccess -or -not (Test-Path $FilePath)) {
            throw "文件移动失败"
        }

        Write-UiSuccess "✓ 文件原子写入成功: $FilePath" -Level Detail
        return $true

    } catch {
        Write-UiDanger "原子写入失败: $($_.Exception.Message)"

        # 清理临时文件
        if ($tempFile -and (Test-Path $tempFile)) {
            try {
                Remove-Item $tempFile -Force
            } catch {
                Write-UiWarning "警告: 无法清理临时文件: $tempFile"
            }
        }

        return $false
    }
}

function Remove-ManagedBlockFromFile {
    <#
    .SYNOPSIS
    从文件中移除标记块
    .PARAMETER FilePath
    文件路径
    .PARAMETER StartMarker
    开始标记（可选，使用默认标记）
    .PARAMETER EndMarker
    结束标记（可选，使用默认标记）
    .RETURNS
    操作成功返回 $true，失败返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string]$StartMarker = $script:ManagedBlockStartMarker,

        [string]$EndMarker = $script:ManagedBlockEndMarker
    )

    if (-not (Test-Path $FilePath)) {
        Write-UiDim "文件不存在: $FilePath"
        return $true  # 文件不存在，认为移除成功
    }

    try {
        # 备份文件
        $null = Backup-FileWithTimestamp -FilePath $FilePath -BackupReason "remove_block"

        # 读取标记块信息
        $blockInfo = Get-ManagedBlockContent -FilePath $FilePath -StartMarker $StartMarker -EndMarker $EndMarker

        if (-not $blockInfo.Found) {
            Write-UiDim "未找到标记块，无需移除" -Level Detail
            return $true
        }

        # 构建新内容（移除标记块）
        $newContent = [System.Collections.ArrayList]::new()

        if ($blockInfo.BeforeBlock -and $blockInfo.BeforeBlock.Count -gt 0) {
            foreach ($line in $blockInfo.BeforeBlock) {
                $null = $newContent.Add($line)
            }
        }

        if ($blockInfo.AfterBlock -and $blockInfo.AfterBlock.Count -gt 0) {
            foreach ($line in $blockInfo.AfterBlock) {
                $null = $newContent.Add($line)
            }
        }

        # 转换为数组并原子写入
        $contentArray = $newContent.ToArray()
        $success = Write-FileAtomically -FilePath $FilePath -Content $contentArray

        if ($success) {
            Write-UiSuccess "✓ 标记块已移除: $FilePath"
            return $true
        } else {
            Write-UiDanger "✗ 标记块移除失败: $FilePath"
            return $false
        }

    } catch {
        Write-UiDanger "移除标记块失败: $($_.Exception.Message)"
        return $false
    }
}

function Test-ManagedBlockExists {
    <#
    .SYNOPSIS
    检测文件中是否存在标记块
    .PARAMETER FilePath
    文件路径
    .PARAMETER StartMarker
    开始标记（可选，使用默认标记）
    .PARAMETER EndMarker
    结束标记（可选，使用默认标记）
    .RETURNS
    存在返回 $true，不存在返回 $false
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string]$StartMarker = $script:ManagedBlockStartMarker,

        [string]$EndMarker = $script:ManagedBlockEndMarker
    )

    if (-not (Test-Path $FilePath)) {
        return $false
    }

    try {
        $blockInfo = Get-ManagedBlockContent -FilePath $FilePath -StartMarker $StartMarker -EndMarker $EndMarker
        return $blockInfo.Found
    } catch {
        return $false
    }
}

function Get-BackupFiles {
    <#
    .SYNOPSIS
    获取备份文件列表
    .PARAMETER Pattern
    文件名模式（可选）
    .RETURNS
    备份文件信息数组
    #>
    param(
        [string]$Pattern = "*"
    )

    try {
        if (-not (Test-Path $script:BackupDirectory)) {
            Write-UiDim "备份目录不存在"
            return @()
        }

        $backupFiles = Get-ChildItem -Path $script:BackupDirectory -Filter $Pattern | Sort-Object LastWriteTime -Descending

        $results = @()
        foreach ($file in $backupFiles) {
            $results += [PSCustomObject]@{
                Name = $file.Name
                FullPath = $file.FullName
                Size = $file.Length
                Created = $file.CreationTime
                Modified = $file.LastWriteTime
            }
        }

        return $results

    } catch {
        Write-UiDanger "获取备份文件列表失败: $($_.Exception.Message)"
        return @()
    }
}

function Clear-OldBackups {
    <#
    .SYNOPSIS
    清理旧的备份文件
    .PARAMETER DaysToKeep
    保留天数（默认 7 天）
    .PARAMETER MaxFiles
    最大文件数（默认 50 个）
    .RETURNS
    清理的文件数量
    #>
    param(
        [int]$DaysToKeep = 7,
        [int]$MaxFiles = 50
    )

    try {
        if (-not (Test-Path $script:BackupDirectory)) {
            return 0
        }

        $cutoffDate = (Get-Date).AddDays(-$DaysToKeep)
        $allBackups = Get-ChildItem -Path $script:BackupDirectory | Sort-Object LastWriteTime -Descending

        $filesToDelete = @()

        # 按时间删除
        $filesToDelete += $allBackups | Where-Object { $_.LastWriteTime -lt $cutoffDate }

        # 按数量删除（保留最新的 MaxFiles 个）
        if ($allBackups.Count -gt $MaxFiles) {
            $filesToDelete += $allBackups | Select-Object -Skip $MaxFiles
        }

        # 去重
        $filesToDelete = $filesToDelete | Select-Object -Unique

        $deletedCount = 0
        foreach ($file in $filesToDelete) {
            try {
                Remove-Item $file.FullName -Force
                $deletedCount++
            } catch {
                Write-UiWarning "警告: 无法删除备份文件: $($file.Name)"
            }
        }

        if ($deletedCount -gt 0) {
            Write-UiSuccess "✓ 已清理 $deletedCount 个旧备份文件"
        }

        return $deletedCount

    } catch {
        Write-UiDanger "清理备份文件失败: $($_.Exception.Message)"
        return 0
    }
}

# 初始化备份目录
Initialize-BackupDirectory

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用