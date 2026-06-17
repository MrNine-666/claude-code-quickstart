# MCP Server 安装步骤 - CCQ
# 作者: 哈雷酱 (本小姐的专业 MCP 管理！)
# 功能: MCP Server 安装、配置和凭据管理（完全自给自足）

#Requires -Version 5.1

# 严格模式
Set-StrictMode -Version Latest

# 依赖: Ui.ps1, Profile.ps1, Process.ps1（由入口脚本 dot-source 加载）
# 注意：本文件包含完整的 MCP 安装管道函数，不依赖 McpManager.ps1（后者只负责 Manage 管理）

# ============================================================
# 全局变量 - MCP Meta 配置
# ============================================================

$script:McpMetaFileName = "mcp-meta.json"
$script:McpMetaSchemaVersion = 1
$script:McpMaxCorruptBackups = 5
$script:McpLockTimeoutMs = 30000

# DefaultMcpRuntimeDeps 和 McpServers 从 contracts 加载或使用内联 fallback
$script:DefaultMcpRuntimeDeps = @()
$script:McpServers = @{}
$script:McpRulesCategories = [ordered]@{}

# ============================================================
# 契约加载 - 从 contracts/mcp-servers.json 读取配置
# ============================================================

function Load-McpContract {
    <#
    .SYNOPSIS
    从 contracts/mcp-servers.json 加载 MCP Server 定义
    .DESCRIPTION
    优先读取源码目录的 contracts 文件；Release 模式下使用内联 fallback
    #>

    $contractPaths = @()

    # 源码模式：installer/windows/steps/ -> installer/contracts/
    if ($PSScriptRoot) {
        $contractsRoot = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) "contracts"
        $contractPath = Join-Path $contractsRoot "mcp-servers.json"
        if (Test-Path $contractPath) {
            $contractPaths += $contractPath
        }
    }

    # 尝试加载 contracts
    foreach ($path in $contractPaths) {
        try {
            $json = Get-Content -Path $path -Raw -ErrorAction Stop
            $contract = $json | ConvertFrom-Json -AsHashtable

            if ($contract -and $contract.ContainsKey("McpServers")) {
                # 加载 DefaultMcpRuntimeDeps
                if ($contract.ContainsKey("DefaultMcpRuntimeDeps")) {
                    $script:DefaultMcpRuntimeDeps = @($contract.DefaultMcpRuntimeDeps)
                }

                # 加载 McpServers（转换为 ordered hashtable）
                $script:McpServers = [ordered]@{}
                foreach ($key in $contract.McpServers.Keys) {
                    $server = $contract.McpServers[$key]
                    # 补充 RuntimeDeps（如果未定义）
                    if (-not $server.ContainsKey("RuntimeDeps")) {
                        $server["RuntimeDeps"] = $script:DefaultMcpRuntimeDeps
                    }
                    $script:McpServers[$key] = $server
                }

                # 加载 Rules 分类定义（Install 链纯 PS 渲染使用）
                if ($contract.ContainsKey("McpRulesCategories")) {
                    $script:McpRulesCategories = $contract.McpRulesCategories
                }

                Write-UiSuccess "已从 contracts 加载 $($script:McpServers.Count) 个 MCP Server 定义" -Level Debug
                return
            }
        }
        catch {
            Write-UiWarning "contracts 加载失败: $($_.Exception.Message)" -Level Debug
        }
    }

    # Fallback: 使用内联默认配置（Release 模式）
    Write-UiWarning "使用 MCP 内联 fallback 配置" -Level Debug
    Initialize-McpFallbackConfig
}

function Initialize-McpFallbackConfig {
    <#
    .SYNOPSIS
    内联 fallback 配置（仅用于 Release 模式或 contracts 不可用）
    #>

    $script:DefaultMcpRuntimeDeps = @(
        @{
            Name = "Node.js LTS"
            Command = "node"
            MinVersion = "20.0.0"
            WingetId = "OpenJS.NodeJS.LTS"
            ManualUrl = "https://nodejs.org/"
        },
        @{
            Name = "npm"
            Command = "npm"
            MinVersion = "10.0.0"
            WingetId = "OpenJS.NodeJS.LTS"
            ManualUrl = "https://nodejs.org/"
        }
    )

    $script:McpServers = [ordered]@{
        "context7" = @{
            Name = "Context7"
            Description = "库文档和代码示例检索"
            McpType = "stdio"
            Command = "npx"
            Args = @("-y", "@upstash/context7-mcp")
            CredentialType = "none"
            RuntimeDeps = $script:DefaultMcpRuntimeDeps
            Category = "Documentation"
            Priority = 1
            Recommended = $true
        }
        "deepwiki" = @{
            Name = "DeepWiki"
            Description = "GitHub 仓库文档和问答"
            McpType = "http"
            Url = "https://mcp.deepwiki.com/mcp"
            CredentialType = "none"
            Category = "Documentation"
            Priority = 2
            Recommended = $true
        }
        "exa" = @{
            Name = "Exa"
            Description = "AI 搜索引擎"
            McpType = "stdio"
            Command = "npx"
            Args = @("-y", "@upstash/exa-mcp")
            CredentialType = "single-key"
            ApiKeyName = "EXA_API_KEY"
            RuntimeDeps = $script:DefaultMcpRuntimeDeps
            Category = "Search"
            Priority = 3
            Recommended = $true
        }
        "playwright" = @{
            Name = "Playwright"
            Description = "浏览器自动化"
            McpType = "stdio"
            Command = "npx"
            Args = @("-y", "@modelcontextprotocol/server-playwright")
            CredentialType = "none"
            RuntimeDeps = $script:DefaultMcpRuntimeDeps
            Category = "Automation"
            Priority = 4
            Recommended = $true
        }
    }

    # Rules 分类内联 fallback（与 contracts/mcp-servers.json 的 McpRulesCategories 对齐）
    $script:McpRulesCategories = [ordered]@{
        "Search" = @{
            FileName = "ccq-mcp-search.md"
            Title = "搜索工具"
            Desc = "联网搜索和内容提取。"
            Chains = @(
                @{ Scenario = "联网搜索"; Steps = @(@{ McpId = "exa"; Tool = "mcp__exa__web_search_exa" }); Fallback = "WebSearch" }
                @{ Scenario = "公司研究"; Steps = @(@{ McpId = "exa"; Tool = "mcp__exa__company_research_exa" }) }
                @{ Scenario = "代码示例搜索"; Steps = @(@{ McpId = "exa"; Tool = "mcp__exa__get_code_context_exa" }) }
            )
        }
        "Documentation" = @{
            FileName = "ccq-mcp-docs.md"
            Title = "文档检索工具"
            Desc = "库文档和开源项目文档检索。"
            Chains = @(
                @{ Scenario = "库官方文档"; Steps = @(@{ McpId = "context7"; Tool = "mcp__context7__resolve-library-id → mcp__context7__query-docs" }) }
                @{ Scenario = "GitHub 开源项目"; Steps = @(@{ McpId = "deepwiki"; Tool = "mcp__deepwiki__ask_question / read_wiki_structure / read_wiki_contents" }) }
            )
            Tips = @("context7 先 resolve-library-id 再 query-docs", "deepwiki 用于理解 GitHub 项目架构")
        }
    }
}

# 加载 MCP Server 契约（在函数定义后立即调用）
Load-McpContract

# ============================================================
# Rules 同步（Install 链纯 PS 渲染，不依赖 mcp-manager.js）
# ============================================================

function Format-McpRulesContent {
    <#
    .SYNOPSIS
    渲染单个分类的 Rules 文件内容（对齐 mcp-manager.js renderRules）
    .PARAMETER Category
    分类定义 hashtable（含 Title/Desc/Chains/StaticRows/Tips）
    .PARAMETER EnabledMcpIds
    已启用的 MCP Server ID 数组
    .OUTPUTS
    System.String - 渲染后的 markdown 内容；无可渲染行时返回 $null
    #>
    param(
        [Parameter(Mandatory = $true)] [hashtable]$Category,
        [Parameter(Mandatory = $true)] [string[]]$EnabledMcpIds
    )

    $sb = [System.Text.StringBuilder]::new()
    [void]$sb.Append("# $($Category.Title)`n`n")
    [void]$sb.Append("> 自动生成，请勿手动编辑。由 MCP Manager 根据已启用的 MCP Server 动态渲染。`n`n")

    if ($Category.ContainsKey("Desc") -and $Category.Desc) {
        [void]$sb.Append("$($Category.Desc)`n`n")
    }

    [void]$sb.Append("| 场景 | 工具链 |`n")
    [void]$sb.Append("|------|--------|`n")

    # 渲染 Chains（仅保留已启用 MCP 的步骤）
    if ($Category.ContainsKey("Chains") -and $Category.Chains) {
        foreach ($chain in $Category.Chains) {
            $tools = [System.Collections.Generic.List[string]]::new()
            if ($chain.ContainsKey("Steps") -and $chain.Steps) {
                foreach ($step in $chain.Steps) {
                    if ($EnabledMcpIds -contains $step.McpId) {
                        $tool = if ($step.ContainsKey("Tool") -and $step.Tool) { $step.Tool } else { "mcp__$($step.McpId)__*" }
                        $tools.Add($tool)
                    }
                }
            }
            if ($chain.ContainsKey("Fallback") -and $chain.Fallback) {
                $tools.Add("$($chain.Fallback)（兜底）")
            }
            if ($tools.Count -gt 0) {
                [void]$sb.Append("| $($chain.Scenario) | ``$($tools -join ' → ')`` |`n")
            }
        }
    }

    # 渲染 StaticRows（始终输出）
    if ($Category.ContainsKey("StaticRows") -and $Category.StaticRows) {
        foreach ($row in $Category.StaticRows) {
            [void]$sb.Append("| $($row.Scenario) | ``$($row.Tool)`` |`n")
        }
    }

    [void]$sb.Append("`n")

    # Tips
    if ($Category.ContainsKey("Tips") -and $Category.Tips -and @($Category.Tips).Count -gt 0) {
        [void]$sb.Append("**Tips**:`n")
        foreach ($tip in $Category.Tips) {
            [void]$sb.Append("- $tip`n")
        }
    }

    return $sb.ToString()
}

function Sync-McpRules {
    <#
    .SYNOPSIS
    同步 MCP Rules 文件（Install 链纯 PS 实现，对齐 mcp-manager.js syncRules）
    .DESCRIPTION
    读取 .claude.json 的 mcpServers 作为已启用列表，按契约分类渲染
    ~/.claude/rules/ccq-mcp-*.md；某分类无已启用 MCP 时删除对应文件。
    静默失败，不阻塞安装主流程。
    .OUTPUTS
    System.Boolean - 同步成功返回 $true
    #>
    try {
        if (-not $script:McpRulesCategories -or @($script:McpRulesCategories.Keys).Count -eq 0) {
            return $true
        }

        # 已启用 MCP = .claude.json 实际配置的 mcpServers
        $enabledIds = @()
        $claudeJsonPath = "$(Get-UserHome)\.claude.json"
        if (Test-Path $claudeJsonPath) {
            $claudeJson = Get-Content -Path $claudeJsonPath -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
            if ($claudeJson -and $claudeJson.ContainsKey("mcpServers") -and $claudeJson["mcpServers"]) {
                $enabledIds = @($claudeJson["mcpServers"].Keys)
            }
        }

        $rulesDir = "$(Get-UserHome)\.claude\rules"

        foreach ($catName in $script:McpRulesCategories.Keys) {
            $cat = $script:McpRulesCategories[$catName]
            $filePath = Join-Path $rulesDir $cat.FileName

            # 该分类下已启用的 MCP ID（契约里属于本分类且 .claude.json 已配置）
            $enabledForCat = @($script:McpServers.Keys | Where-Object {
                $script:McpServers[$_].Category -eq $catName -and $enabledIds -contains $_
            })

            # 无已启用 MCP → 删除文件
            if ($enabledForCat.Count -eq 0) {
                if (Test-Path $filePath) {
                    Remove-Item -Path $filePath -Force -ErrorAction SilentlyContinue
                }
                continue
            }

            $content = Format-McpRulesContent -Category $cat -EnabledMcpIds $enabledForCat
            if (-not $content) { continue }

            # 变更检测（规范化换行后比较）
            $existing = ""
            if (Test-Path $filePath) {
                $existing = Get-Content -Path $filePath -Raw -ErrorAction SilentlyContinue
            }
            $contentNorm = ($content -replace "`r`n", "`n").Trim()
            $existingNorm = ($existing -replace "`r`n", "`n").Trim()

            if ($contentNorm -ne $existingNorm) {
                if (-not (Test-Path $rulesDir)) {
                    New-Item -ItemType Directory -Path $rulesDir -Force | Out-Null
                }
                # 字节精确原子写（UTF-8 无 BOM，对齐 mcp-manager.js writeFileAtomic：
                # 不追加尾换行、不写 BOM，确保两条链生成的 rules 文件字节一致）
                $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
                $tempPath = "$filePath.tmp_$([guid]::NewGuid().ToString('N').Substring(0,8))"
                [IO.File]::WriteAllText($tempPath, $content, $utf8NoBom)
                Move-Item -Path $tempPath -Destination $filePath -Force
            }
        }
        return $true
    }
    catch {
        # 静默失败，不阻塞主流程
        return $false
    }
}

# ============================================================
# 基础工具函数
# ============================================================

function Get-UserHome {
    <#
    .SYNOPSIS
    获取用户主目录（跨平台兼容）
    #>
    if ($env:HOME) {
        return $env:HOME
    }
    return $env:USERPROFILE
}

function Get-ClaudeSettingsPath {
    <#
    .SYNOPSIS
    获取 Claude Code settings.json 路径（HC-12: ~/.claude/settings.json）
    #>
    return "$(Get-UserHome)\.claude\settings.json"
}

function ConvertTo-NormalizedVersion {
    <#
    .SYNOPSIS
    规范化版本号为 [int, int, int] 数组（用于版本比较）
    .PARAMETER Version
    版本号字符串（如 "1.2.3" 或 "v1.2.3"）
    .RETURNS
    int[] - [Major, Minor, Patch]
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Version
    )

    $cleaned = $Version -replace '^v', ''
    $parts = $cleaned -split '\.'
    $normalized = @(0, 0, 0)
    for ($i = 0; $i -lt [Math]::Min(3, $parts.Count); $i++) {
        $num = 0
        if ([int]::TryParse($parts[$i], [ref]$num)) {
            $normalized[$i] = $num
        }
    }
    return $normalized
}

function Read-McpCredentialValue {
    <#
    .SYNOPSIS
    读取 MCP 凭据值（支持明文/SecureString/文件路径）
    .PARAMETER Label
    提示标签
    .PARAMETER Secret
    是否使用 SecureString
    .PARAMETER Required
    是否必填
    .PARAMETER FilePath
    是否为文件路径
    .RETURNS
    string - 凭据值
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Label,
        [bool]$Secret = $false,
        [bool]$Required = $false,
        [bool]$FilePath = $false
    )

    $requiredTag = if ($Required) { " (必填)" } else { " (可选)" }
    $prompt = "  请输入 ${Label}${requiredTag}: "

    while ($true) {
        if ($Secret) {
            $secureValue = Read-Host -Prompt $prompt -AsSecureString
            if ($secureValue.Length -eq 0) {
                if ($Required) {
                    Write-UiWarning "此字段为必填项，请重新输入"
                    continue
                }
                return ""
            }
            $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
            try {
                return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
            }
            finally {
                [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
            }
        }
        else {
            $value = Read-Host -Prompt $prompt
            if ([string]::IsNullOrWhiteSpace($value)) {
                if ($Required) {
                    Write-UiWarning "此字段为必填项，请重新输入"
                    continue
                }
                return ""
            }
            if ($FilePath -and -not (Test-Path $value)) {
                Write-UiWarning "路径不存在: $value"
                continue
            }
            return $value
        }
    }
}

function Test-ObjectProperty {
    <#
    .SYNOPSIS
    安全检查对象属性是否存在（StrictMode 兼容）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject,
        [Parameter(Mandatory = $true)]
        [string]$PropertyName
    )

    return $null -ne $InputObject -and
        $null -ne $InputObject.PSObject -and
        ($InputObject.PSObject.Properties.Name -contains $PropertyName)
}

# ============================================================
# Vault 管理函数（Mutex + 读写 + 腐败恢复）
# ============================================================

function Ensure-CcqMetaDir {
    <#
    .SYNOPSIS
    确保 ~/.ccq/ 目录存在（首次使用时自动创建）
    .RETURNS
    目录绝对路径
    #>
    $dir = Join-Path (Get-UserHome) ".ccq"
    if (-not (Test-Path $dir)) {
        New-Item -Path $dir -ItemType Directory -Force | Out-Null
    }
    return $dir
}

function Get-McpMetaPath {
    <#
    .SYNOPSIS
    获取 mcp-meta.json 文件路径
    #>
    return Join-Path (Ensure-CcqMetaDir) $script:McpMetaFileName
}

function New-EmptyMcpMeta {
    <#
    .SYNOPSIS
    创建空的 v1 vault 结构
    .RETURNS
    hashtable - 合法的空 vault
    #>
    $now = (Get-Date).ToUniversalTime().ToString("o")
    return @{
        schemaVersion = $script:McpMetaSchemaVersion
        createdAt     = $now
        updatedAt     = $now
        servers       = @{}
    }
}

function Invoke-McpCorruptionRecovery {
    <#
    .SYNOPSIS
    vault 腐败恢复（备份 + 清理旧备份 + 返回空 vault）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath
    )

    # 生成时间戳备份
    $timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
    $backupPath = "${FilePath}.corrupt.${timestamp}"

    try {
        Copy-Item -Path $FilePath -Destination $backupPath -Force -ErrorAction SilentlyContinue
        Write-UiWarning "vault 腐败，已备份到: $backupPath" -Level Debug
    }
    catch {
        Write-UiWarning "vault 备份失败: $($_.Exception.Message)" -Level Debug
    }

    # 清理超过 N 个的腐败备份
    try {
        $dir = Split-Path $FilePath -Parent
        $baseName = Split-Path $FilePath -Leaf
        $corruptFiles = @(Get-ChildItem -Path $dir -Filter "${baseName}.corrupt.*" -File | Sort-Object Name -Descending)

        if ($corruptFiles.Count -gt $script:McpMaxCorruptBackups) {
            $toDelete = $corruptFiles | Select-Object -First ($corruptFiles.Count - $script:McpMaxCorruptBackups)
            foreach ($file in $toDelete) {
                Remove-Item -Path $file.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
        Write-UiWarning "清理旧备份失败: $($_.Exception.Message)" -Level Debug
    }

    return New-EmptyMcpMeta
}

function Read-McpMeta {
    <#
    .SYNOPSIS
    读取 MCP vault（含 schema 校验 + 腐败恢复）
    .RETURNS
    hashtable - vault 内容（可能包含 _readOnly 标记）
    #>

    $vaultPath = Get-McpMetaPath

    # Lazy create: 首次读取时不存在则返回空 vault（不写文件）
    if (-not (Test-Path $vaultPath)) {
        return New-EmptyMcpMeta
    }

    try {
        $json = Get-Content -Path $vaultPath -Raw -ErrorAction Stop
        $meta = $json | ConvertFrom-Json -AsHashtable -ErrorAction Stop

        # Schema 校验
        if (-not $meta -or -not $meta.ContainsKey("schemaVersion") -or $meta["schemaVersion"] -lt 1) {
            return Invoke-McpCorruptionRecovery -FilePath $vaultPath
        }

        if (-not $meta.ContainsKey("servers") -or -not ($meta["servers"] -is [hashtable])) {
            return Invoke-McpCorruptionRecovery -FilePath $vaultPath
        }

        # 高版本检测（只读标记）
        if ($meta["schemaVersion"] -gt $script:McpMetaSchemaVersion) {
            $meta["_readOnly"] = $true
            Write-UiWarning "vault schema 版本过高 ($($meta['schemaVersion']) > $($script:McpMetaSchemaVersion))，只读模式" -Level Debug
        }

        return $meta
    }
    catch {
        Write-UiWarning "vault 读取失败，使用腐败恢复: $($_.Exception.Message)" -Level Debug
        return Invoke-McpCorruptionRecovery -FilePath $vaultPath
    }
}

function Write-McpMeta {
    <#
    .SYNOPSIS
    写入 MCP vault（原子写入 + 只读检查）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Meta
    )

    # 高版本检查
    if ($Meta.ContainsKey("schemaVersion") -and $Meta["schemaVersion"] -gt $script:McpMetaSchemaVersion) {
        throw "schema version too high: $($Meta['schemaVersion']) > $($script:McpMetaSchemaVersion)"
    }

    # 只读检查
    if ($Meta.ContainsKey("_readOnly") -and $Meta["_readOnly"]) {
        throw "vault is read-only (newer schema version)"
    }

    # 更新根 updatedAt
    $now = (Get-Date).ToUniversalTime().ToString("o")
    $Meta["updatedAt"] = $now

    # 确保根 updatedAt >= max(servers[*].updatedAt)
    if ($Meta.ContainsKey("servers") -and $Meta["servers"] -is [hashtable]) {
        foreach ($serverId in $Meta["servers"].Keys) {
            $server = $Meta["servers"][$serverId]
            if ($server -is [hashtable] -and $server.ContainsKey("updatedAt")) {
                if ($server["updatedAt"] -gt $Meta["updatedAt"]) {
                    $Meta["updatedAt"] = $server["updatedAt"]
                }
            }
        }
    }

    # 删除内部标记字段（_readOnly 等）
    $cleanMeta = @{}
    foreach ($key in $Meta.Keys) {
        if (-not $key.StartsWith("_")) {
            $cleanMeta[$key] = $Meta[$key]
        }
    }

    # 原子写入
    $vaultPath = Get-McpMetaPath
    $json = $cleanMeta | ConvertTo-Json -Depth 10
    Write-FileAtomically -FilePath $vaultPath -Content @($json)
}

function Invoke-WithMcpLock {
    <#
    .SYNOPSIS
    Mutex 锁保护（防止并发冲突）
    .PARAMETER ScriptBlock
    要执行的脚本块
    .RETURNS
    脚本块的返回值
    #>
    param(
        [Parameter(Mandatory = $true)]
        [scriptblock]$ScriptBlock
    )

    $mutexName = "Global\CCQ-MCP-Vault-Lock"
    $mutex = $null
    $acquired = $false

    try {
        $mutex = New-Object System.Threading.Mutex($false, $mutexName)
        $acquired = $mutex.WaitOne($script:McpLockTimeoutMs)

        if (-not $acquired) {
            throw "无法获取 MCP 锁（30s 超时），可能有其他 CCQ 进程正在运行"
        }

        # 执行脚本块
        return & $ScriptBlock
    }
    finally {
        if ($acquired -and $mutex) {
            $mutex.ReleaseMutex()
        }
        if ($mutex) {
            $mutex.Dispose()
        }
    }
}

# ============================================================
# 哈希计算函数（用于检测 MCP 定义变更）
# ============================================================

function ConvertTo-CanonicalObject {
    <#
    .SYNOPSIS
    递归规范化对象：键按字母排序（用于稳定哈希计算）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [object]$InputObject
    )

    if ($InputObject -is [hashtable]) {
        $sorted = [ordered]@{}
        foreach ($key in ($InputObject.Keys | Sort-Object)) {
            $sorted[$key] = ConvertTo-CanonicalObject -InputObject $InputObject[$key]
        }
        return $sorted
    }
    elseif ($InputObject -is [System.Collections.IList]) {
        return @($InputObject | ForEach-Object { ConvertTo-CanonicalObject -InputObject $_ })
    }
    else {
        return $InputObject
    }
}

function Get-McpDefinitionHash {
    <#
    .SYNOPSIS
    计算 MCP Server 定义的哈希（SHA-256 前 8 位）
    .PARAMETER ServerDef
    MCP Server 定义对象
    .RETURNS
    string - 8 字符哈希
    #>
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$ServerDef
    )

    # 排除非运行时字段
    $excludeKeys = @("Description", "Category", "Priority", "Recommended", "Name", "RuntimeDeps")
    $runtimeFields = @{}
    foreach ($key in $ServerDef.Keys) {
        if ($excludeKeys -notcontains $key) {
            $runtimeFields[$key] = $ServerDef[$key]
        }
    }

    # 递归规范化（键排序）
    $canonical = ConvertTo-CanonicalObject -InputObject $runtimeFields

    # JSON 序列化
    $json = $canonical | ConvertTo-Json -Depth 10 -Compress

    # SHA-256
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $hashBytes = $hasher.ComputeHash($bytes)
    $hash = [BitConverter]::ToString($hashBytes).Replace("-", "").ToLower()

    # 取前 8 位
    return $hash.Substring(0, 8)
}

function Install-McpRuntimeDeps {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Server
    )

    # 确保 fnm 环境已初始化（前置步骤可能已安装 fnm 但当前会话未加载）
    if ((Test-CommandAvailable -Command "fnm") -and -not (Test-CommandAvailable -Command "node")) {
        Write-UiInfo "初始化 fnm 环境..."
        try {
            $fnmEnvOutput = & fnm env --use-on-cd 2>&1 | Out-String
            if ($fnmEnvOutput) {
                Invoke-Expression $fnmEnvOutput
            }
            Refresh-SessionPath
        } catch {
            Write-UiWarn "fnm 环境初始化失败: $($_.Exception.Message)"
        }
    }

    $deps = @()
    if ($Server.ContainsKey("RuntimeDeps") -and $Server["RuntimeDeps"]) {
        $deps = @($Server["RuntimeDeps"])
    }
    if ($deps.Count -eq 0) {
        return @{ Success = $true; Installed = @() }
    }

    $installedDeps = @()
    foreach ($dep in $deps) {
        $depName = if ($dep.Name) { $dep.Name } else { $dep.Command }
        $command = [string]$dep.Command
        $needsInstall = $false

        if (-not (Test-CommandAvailable -Command $command)) {
            $needsInstall = $true
            Write-UiWarn "$depName 未检测到，准备安装"
        }
        elseif ($dep.MinVersion) {
            $installedVersionText = Get-CommandVersion -Command $command
            $installedVersion = ConvertTo-NormalizedVersion -VersionText $installedVersionText
            $minVersion = ConvertTo-NormalizedVersion -VersionText ([string]$dep.MinVersion)

            if ($installedVersion -and $minVersion -and $installedVersion -lt $minVersion) {
                $needsInstall = $true
                Write-UiWarn "$depName 版本过低: $installedVersionText < $($dep.MinVersion)"
            }
        }

        if ($needsInstall) {
            if (-not $dep.WingetId) {
                $manualHint = if ($dep.ManualUrl) { "，请手动安装: $($dep.ManualUrl)" } else { "" }
                throw "依赖 $depName 缺少自动安装配置$manualHint"
            }

            if (-not (Test-CommandAvailable -Command "winget")) {
                $manualHint = if ($dep.ManualUrl) { "`n  手动安装: $($dep.ManualUrl)" } else { "" }
                throw "winget 不可用，无法自动安装依赖 $depName。请先运行「基础环境」安装，或手动安装后重试。$manualHint"
            }

            Invoke-WingetInstall -PackageId $dep.WingetId -PackageName $depName -AcceptLicense -Silent | Out-Null
            Refresh-SessionPath

            if (-not (Test-CommandAvailable -Command $command)) {
                throw "依赖 $depName 安装后仍不可用"
            }

            $installedDeps += $depName
        }
    }

    return @{ Success = $true; Installed = $installedDeps }
}

function Get-McpCredentials {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerId,
        [Parameter(Mandatory = $true)]
        [hashtable]$Server,
        [Parameter(Mandatory = $true)]
        [hashtable]$SharedCredentials
    )

    $result = @{
        Success = $true
        Values = @{}
        EnvFileValues = @{}
        Shared = @{}
        Skipped = $false
    }

    $credentialType = if ($Server.CredentialType) { [string]$Server.CredentialType } else { "none" }
    switch ($credentialType) {
        "none" {
            return $result
        }
        "single-key" {
            $apiKeyName = [string]$Server.ApiKeyName
            $apiKeyValue = Read-McpCredentialValue -Label $apiKeyName -Secret $true -Required $true
            $result.Values[$apiKeyName] = $apiKeyValue
        }
        "url-embedded" {
            foreach ($credential in @($Server.Credentials)) {
                $value = Read-McpCredentialValue `
                    -Label ([string]$credential.Label) `
                    -Secret ([bool]$credential.Secret) `
                    -Required ([bool]$credential.Required)

                if (-not [string]::IsNullOrWhiteSpace($value)) {
                    $result.Values[[string]$credential.Name] = $value
                }
            }
        }
        "multi-field" {
            foreach ($field in @($Server.Credentials)) {
                $fieldName = [string]$field.Name
                if ([string]::IsNullOrWhiteSpace($fieldName)) {
                    continue
                }

                $sharedFrom = if ($field.ContainsKey("SharedFrom")) { [string]$field.SharedFrom } else { "" }
                if (-not [string]::IsNullOrWhiteSpace($sharedFrom) -and $SharedCredentials.ContainsKey($sharedFrom)) {
                    $result.Values[$fieldName] = [string]$SharedCredentials[$sharedFrom]
                    continue
                }

                $defaultValue = if ($field.ContainsKey("Default")) { [string]$field.Default } else { "" }
                $required = if ($field.ContainsKey("Required")) { [bool]$field.Required } else { $false }
                $secret = if ($field.ContainsKey("Secret")) { [bool]$field.Secret } else { $false }
                $fieldLabel = if ($field.ContainsKey("Label") -and $field.Label) { [string]$field.Label } else { $fieldName }

                $value = Read-McpCredentialValue `
                    -Label $fieldLabel `
                    -Secret $secret `
                    -Required $required `
                    -DefaultValue $defaultValue

                if (-not [string]::IsNullOrWhiteSpace($value)) {
                    $result.Values[$fieldName] = $value
                    if ($field.ContainsKey("Shared") -and [bool]$field.Shared) {
                        $result.Shared[$fieldName] = $value
                    }
                }
            }
        }
        "args-multi" {
            foreach ($argCredential in @($Server.ArgsCredentials)) {
                if ($argCredential.ContainsKey("Url") -and $argCredential["Url"]) {
                    Write-UiInfo "$($argCredential.Label) 获取地址: $($argCredential["Url"])"
                }

                $value = Read-McpCredentialValue `
                    -Label ([string]$argCredential.Label) `
                    -Secret ([bool]$argCredential.Secret) `
                    -Required ([bool]$argCredential.Required)

                if (-not [string]::IsNullOrWhiteSpace($value)) {
                    $result.Values[[string]$argCredential.ArgName] = $value
                }
            }
        }
        "args-token" {
            $tokenLabel = if ($Server.TokenLabel) { [string]$Server.TokenLabel } else { "Token" }
            $tokenValue = Read-McpCredentialValue -Label $tokenLabel -Secret $true -Required $true
            $result.Values["token"] = $tokenValue
        }
        "env-file" {
            $envFile = $Server.EnvFile
            if (-not $envFile) {
                throw "$($Server.Name) 缺少 EnvFile 配置"
            }

            $sharedCredentialName = if ($envFile.ContainsKey("SharedCredentialName")) { [string]$envFile.SharedCredentialName } else { "" }
            $sharedKeyValue = ""

            if (-not [string]::IsNullOrWhiteSpace($sharedCredentialName) -and $SharedCredentials.ContainsKey($sharedCredentialName)) {
                $sharedKeyValue = [string]$SharedCredentials[$sharedCredentialName]
                Write-UiInfo "复用共享凭据: $sharedCredentialName"
            }
            else {
                $sharedLabel = if ($envFile.SharedKeyLabel) { [string]$envFile.SharedKeyLabel } else { "共享 API Key" }
                $sharedKeyValue = Read-McpCredentialValue -Label $sharedLabel -Secret $true -Required $true
                if (-not [string]::IsNullOrWhiteSpace($sharedCredentialName)) {
                    $result.Shared[$sharedCredentialName] = $sharedKeyValue
                }
            }

            foreach ($sharedKeyField in @($envFile.SharedKeyFields)) {
                if (-not [string]::IsNullOrWhiteSpace([string]$sharedKeyField)) {
                    $result.EnvFileValues[[string]$sharedKeyField] = $sharedKeyValue
                }
            }

            foreach ($field in @($envFile.Fields)) {
                $fieldKey = [string]$field.Key
                if ([string]::IsNullOrWhiteSpace($fieldKey)) {
                    continue
                }

                if ($result.EnvFileValues.ContainsKey($fieldKey)) {
                    continue
                }

                $defaultValue = if ($field.ContainsKey("Default")) { [string]$field.Default } else { "" }
                $required = if ($field.ContainsKey("Required")) { [bool]$field.Required } else { $false }
                $secret = if ($field.ContainsKey("Secret")) { [bool]$field.Secret } else { $false }
                $fieldLabel = if ($field.ContainsKey("Label") -and $field.Label) { [string]$field.Label } else { $fieldKey }

                $fieldValue = Read-McpCredentialValue -Label $fieldLabel -Secret $secret -Required $required -DefaultValue $defaultValue
                if (-not [string]::IsNullOrWhiteSpace($fieldValue)) {
                    $result.EnvFileValues[$fieldKey] = $fieldValue
                }
            }
        }
        default {
            throw "不支持的凭据类型: $credentialType"
        }
    }

    return $result
}

function New-McpSettingsEntry {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerId,
        [Parameter(Mandatory = $true)]
        [hashtable]$Server,
        [Parameter(Mandatory = $true)]
        [hashtable]$Credentials
    )

    $mcpType = if ($Server.McpType) { [string]$Server.McpType } else { "stdio" }
    $credentialType = if ($Server.CredentialType) { [string]$Server.CredentialType } else { "none" }

    switch ($mcpType) {
        "software" {
            return $null
        }
        "http" {
            if ($credentialType -eq "url-embedded") {
                if (-not $Server.UrlTemplate) {
                    throw "$ServerId 缺少 UrlTemplate"
                }

                $resolvedUrl = [string]$Server.UrlTemplate
                foreach ($credentialName in $Credentials.Keys) {
                    $placeholder = "{0}{1}{2}" -f "{", $credentialName, "}"
                    $escapedValue = [System.Uri]::EscapeDataString([string]$Credentials[$credentialName])
                    $resolvedUrl = $resolvedUrl -replace [regex]::Escape($placeholder), $escapedValue
                }

                if ($resolvedUrl -match "\{[A-Za-z0-9_]+\}") {
                    # HC-M10: 掩码凭据值，避免异常消息泄露敏感信息
                    $maskedUrl = $resolvedUrl
                    foreach ($credName in $Credentials.Keys) {
                        $escapedVal = [System.Uri]::EscapeDataString([string]$Credentials[$credName])
                        if ($escapedVal) {
                            $maskedUrl = $maskedUrl -replace [regex]::Escape($escapedVal), "***"
                        }
                    }
                    throw "$ServerId 的 URL 仍包含未替换占位符: $maskedUrl"
                }

                return @{
                    type = "http"
                    url = $resolvedUrl
                }
            }

            if (-not $Server.Url) {
                throw "$ServerId 缺少 Url"
            }

            return @{
                type = "http"
                url = [string]$Server.Url
            }
        }
        "stdio" {
            if (-not $Server.Command) {
                throw "$ServerId 缺少 Command"
            }

            $args = @()
            foreach ($arg in @($Server.Args)) {
                $args += [string]$arg
            }

            $entry = @{
                command = [string]$Server.Command
                args = $args
            }

            switch ($credentialType) {
                "single-key" {
                    $apiKeyName = [string]$Server.ApiKeyName
                    if (-not $Credentials.ContainsKey($apiKeyName)) {
                        throw "$ServerId 缺少凭据: $apiKeyName"
                    }

                    $entry["env"] = @{
                        $apiKeyName = [string]$Credentials[$apiKeyName]
                    }
                }
                "multi-field" {
                    $envMap = @{}
                    foreach ($credentialKey in $Credentials.Keys) {
                        $credentialValue = [string]$Credentials[$credentialKey]
                        if (-not [string]::IsNullOrWhiteSpace($credentialValue)) {
                            $envMap[$credentialKey] = $credentialValue
                        }
                    }
                    if ($envMap.Count -gt 0) {
                        $entry["env"] = $envMap
                    }
                }
                "args-multi" {
                    foreach ($argCredential in @($Server.ArgsCredentials)) {
                        $argName = [string]$argCredential.ArgName
                        $required = if ($argCredential.ContainsKey("Required")) { [bool]$argCredential.Required } else { $false }

                        if (-not $Credentials.ContainsKey($argName)) {
                            if ($required) {
                                throw "$ServerId 缺少参数凭据: $argName"
                            }
                            continue
                        }

                        $argValue = [string]$Credentials[$argName]
                        if ($required -and [string]::IsNullOrWhiteSpace($argValue)) {
                            throw "$ServerId 参数凭据为空: $argName"
                        }

                        if (-not [string]::IsNullOrWhiteSpace($argValue)) {
                            $entry["args"] += @($argName, $argValue)
                        }
                    }
                }
                "args-token" {
                    if (-not $Credentials.ContainsKey("token")) {
                        throw "$ServerId 缺少 token"
                    }

                    $tokenValue = [string]$Credentials["token"]
                    if ([string]::IsNullOrWhiteSpace($tokenValue)) {
                        throw "$ServerId token 为空"
                    }

                    $entry["args"] += "$($Server.TokenArg)=$tokenValue"
                }
            }

            return $entry
        }
        default {
            throw "不支持的 MCP 类型: $mcpType"
        }
    }
}

function Install-McpSoftware {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerId,
        [Parameter(Mandatory = $true)]
        [hashtable]$Server
    )

    $result = @{
        Success = $true
        Method = "none"
        Message = ""
    }

    if ($Server.McpType -ne "software") {
        return $result
    }

    $install = $Server.SoftwareInstall
    if (-not $install) {
        throw "$ServerId 缺少 SoftwareInstall 配置"
    }

    if (Test-CommandAvailable -Command "winget") {
        try {
            if ($install.WingetSearch) {
                $wingetArgs = @(
                    "install",
                    "--name", $install.WingetSearch,
                    "-e",
                    "--accept-package-agreements",
                    "--accept-source-agreements",
                    "--disable-interactivity"
                )
                $wingetResult = Invoke-ExternalCommand -Command "winget" -Arguments $wingetArgs -TimeoutSeconds 300
                if (-not $wingetResult.Success) {
                    throw "winget 按名称安装失败"
                }
            }
            else {
                throw "未配置 WingetSearch"
            }

            $result.Method = "winget"
            $result.Message = "winget 安装成功"
            return $result
        }
        catch {
            Write-UiWarn "$($Server.Name) winget 安装失败，将尝试下载方式: $($_.Exception.Message)"
        }
    }

    if ($install.DownloadUrl) {
        try {
            $downloadDir = "$env:TEMP\ClaudeEnvInstaller"
            if (-not (Test-Path $downloadDir)) {
                New-Item -Path $downloadDir -ItemType Directory -Force | Out-Null
            }

            $fileName = Split-Path -Path ([string]$install.DownloadUrl) -Leaf
            if ([string]::IsNullOrWhiteSpace($fileName)) {
                $fileName = "$ServerId-installer.exe"
            }
            $downloadPath = Join-Path $downloadDir $fileName

            # 使用统一的下载函数
            $downloadResult = Invoke-FileDownload -Url $install.DownloadUrl -OutputPath $downloadPath -Description "$($Server.Name) 安装程序"

            if (-not $downloadResult.Success) {
                throw "下载失败: $($downloadResult.ErrorMessage)"
            }

            $process = Start-Process -FilePath $downloadPath -PassThru -Wait

            if ($process -and $process.ExitCode -ne 0) {
                throw "安装程序退出码非 0: $($process.ExitCode)"
            }

            $result.Method = "download"
            $result.Message = "下载安装成功"
            return $result
        }
        catch {
            Write-UiWarn "$($Server.Name) 下载安装失败，将进入引导安装: $($_.Exception.Message)"
        }
    }

    Write-UiInfo "请手动安装 $($Server.Name)"
    if ($install.GuideUrl) {
        Write-UiInfo "安装指引: $($install.GuideUrl)"
    }
    Read-Host "安装完成后按回车继续..."

    $result.Method = "guide"
    $result.Message = "已切换为引导安装"
    return $result
}

function Write-McpEnvFile {
    param(
        [Parameter(Mandatory = $true)]
        [hashtable]$Server,
        [Parameter(Mandatory = $true)]
        [hashtable]$EnvValues
    )

    try {
        if (-not $Server.EnvFile) {
            throw "缺少 EnvFile 配置"
        }

        $envPath = [string]$Server.EnvFile.Path
        if ([string]::IsNullOrWhiteSpace($envPath)) {
            throw "EnvFile.Path 为空"
        }

        $envDir = Split-Path -Path $envPath -Parent
        if (-not [string]::IsNullOrWhiteSpace($envDir) -and -not (Test-Path $envDir)) {
            New-Item -Path $envDir -ItemType Directory -Force | Out-Null
        }

        $lines = @()
        if (Test-Path $envPath) {
            $existingLines = Get-Content -Path $envPath -ErrorAction SilentlyContinue
            if ($null -ne $existingLines) {
                $lines = @($existingLines)
            }
        }

        $keyLineIndex = @{}
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                $keyLineIndex[$matches[1]] = $i
            }
        }

        foreach ($key in $EnvValues.Keys) {
            $value = [string]$EnvValues[$key]
            $value = $value -replace "`r", "" -replace "`n", ""
            if ([string]::IsNullOrWhiteSpace($value)) {
                continue
            }

            $line = "$key=$value"
            if ($keyLineIndex.ContainsKey($key)) {
                $lines[[int]$keyLineIndex[$key]] = $line
            }
            else {
                $lines += $line
            }
        }

        $writeOk = Write-FileAtomically -FilePath $envPath -Content $lines
        if (-not $writeOk) {
            throw "env 文件原子写入失败: $envPath"
        }

        return @{ Success = $true; Path = $envPath }
    }
    catch {
        return @{
            Success = $false
            Path = ""
            ErrorMessage = $_.Exception.Message
        }
    }
}

function Install-McpSingleServer {
    <#
    .SYNOPSIS
    安装单个 MCP Server（完整 5 阶段管道）
    被 Invoke-McpToggle（Missing + 需凭据）和 Install-Mcp（批量循环）调用
    .PARAMETER ServerId
    注册表中的 Server ID
    .RETURNS
    @{ Success; ServerId; Status; ErrorMessage }
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$ServerId
    )

    if (-not $script:McpServers.Contains($ServerId)) {
        return @{ Success = $false; ServerId = $ServerId; Status = "Unknown"; ErrorMessage = "未在注册表中定义" }
    }

    $server = $script:McpServers[$ServerId]

    try {
        # Phase 1: 运行时依赖
        $depResult = Install-McpRuntimeDeps -Server $server
        if (@($depResult.Installed).Count -gt 0) {
            Write-UiSuccess "$($server.Name) 依赖安装完成: $(@($depResult.Installed) -join ', ')"
        }

        # Phase 3: 凭据收集（含 vault 历史凭据自动填充）
        $credentials = @{}
        $envFileValues = @{}
        $credentialType = if ($server.CredentialType) { [string]$server.CredentialType } else { "none" }

        if ($credentialType -ne "none") {
            # 先查 vault 历史凭据
            $useVaultCredentials = $false
            try {
                $meta = Read-McpMeta
                if ($meta.ContainsKey("servers") -and
                    $meta.servers -is [hashtable] -and
                    $meta.servers.ContainsKey($ServerId) -and
                    $meta.servers[$ServerId] -is [hashtable] -and
                    $meta.servers[$ServerId].ContainsKey("credentials") -and
                    $meta.servers[$ServerId].credentials -is [hashtable]) {

                    $vaultCred = $meta.servers[$ServerId].credentials
                    $hasValues = $vaultCred.ContainsKey("values") -and $vaultCred.values -is [hashtable] -and $vaultCred.values.Count -gt 0
                    $hasEnvValues = $vaultCred.ContainsKey("envFileValues") -and $vaultCred.envFileValues -is [hashtable] -and $vaultCred.envFileValues.Count -gt 0

                    if ($hasValues -or $hasEnvValues) {
                        $maskedKeys = @()
                        if ($hasValues) {
                            $maskedKeys += @($vaultCred.values.Keys | ForEach-Object { "$_=***" })
                        }
                        Write-UiInfo "检测到 $($server.Name) 的历史凭据 ($($maskedKeys -join ', '))"
                        Write-Host -NoNewline "  是否使用历史凭据？[Y/n]: "
                        $answer = Read-Host
                        if ([string]::IsNullOrWhiteSpace($answer) -or $answer -match '^[Yy]') {
                            if ($hasValues) { $credentials = $vaultCred.values }
                            if ($hasEnvValues) { $envFileValues = $vaultCred.envFileValues }
                            $useVaultCredentials = $true
                            Write-UiSuccess "$($server.Name) 已使用历史凭据"
                        }
                    }
                }
            }
            catch {
                Write-UiWarn "vault 读取失败，跳过历史凭据检测: $($_.Exception.Message)"
            }

            # 无历史则走交互式收集
            if (-not $useVaultCredentials) {
                $credentialResult = Get-McpCredentials -ServerId $ServerId -Server $server -SharedCredentials @{}
                $credentials = $credentialResult.Values
                $envFileValuesCount = if ($credentialResult.ContainsKey("EnvFileValues") -and $credentialResult.EnvFileValues) { @($credentialResult.EnvFileValues.Keys).Count } else { 0 }
                if ($envFileValuesCount -gt 0) {
                    $envFileValues = $credentialResult.EnvFileValues
                }
            }
        }

        # Phase 4: 软件安装（仅 software 类型）
        if ($server.McpType -eq "software") {
            Install-McpSoftware -ServerId $ServerId -Server $server | Out-Null
        }

        # Phase 5: 配置写入
        # 5a. env file（env-file 类型）
        if ($credentialType -eq "env-file" -and $envFileValues.Count -gt 0) {
            $envWriteResult = Write-McpEnvFile -Server $server -EnvValues $envFileValues
            if ($envWriteResult.Success) {
                Write-UiSuccess "已写入 $($server.Name) .env 文件: $($envWriteResult.Path)"
            }
            else {
                Write-UiWarn "$($server.Name) .env 写入失败: $($envWriteResult.ErrorMessage)"
            }
        }

        # 5b. .claude.json — New-McpSettingsEntry → 合并写入
        $entry = New-McpSettingsEntry -ServerId $ServerId -Server $server -Credentials $credentials
        if ($entry) {
            $cjPath = "$(Get-UserHome)\.claude.json"
            $cj = @{}
            if (Test-Path $cjPath) {
                $cj = Get-Content -Path $cjPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
                if (-not $cj) { $cj = @{} }
            }
            if (-not $cj.ContainsKey("mcpServers")) { $cj["mcpServers"] = @{} }
            $cj["mcpServers"][$ServerId] = $entry
            $writeOk = Write-FileAtomically -FilePath $cjPath -Content ($cj | ConvertTo-Json -Depth 10)
            if (-not $writeOk) {
                throw "更新 .claude.json 失败"
            }
        }

        # 5c. settings.json — 补充 mcp__${ServerId} 权限
        $settingsPath = Get-ClaudeSettingsPath
        $settings = @{}
        if (Test-Path $settingsPath) {
            $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
            if (-not $settings) { $settings = @{} }
        }
        if (-not $settings.ContainsKey("permissions")) { $settings["permissions"] = @{} }
        if (-not $settings["permissions"].ContainsKey("allow")) { $settings["permissions"]["allow"] = @() }
        if (-not ($settings["permissions"]["allow"] -is [System.Collections.IList])) {
            $settings["permissions"]["allow"] = @($settings["permissions"]["allow"])
        }
        $mcpPerm = "mcp__${ServerId}"
        if ($settings["permissions"]["allow"] -notcontains $mcpPerm) {
            $settings["permissions"]["allow"] += $mcpPerm
            $settingsJson = $settings | ConvertTo-Json -Depth 10
            $writeOk = Write-FileAtomically -FilePath $settingsPath -Content @($settingsJson)
            if (-not $writeOk) {
                Write-UiWarn "settings.json 权限写入失败"
            }
        }

        # 5d. vault — 持久化凭据 + definitionHash
        try {
            $null = Invoke-WithMcpLock {
                $vaultMeta = Read-McpMeta
                $cred = @{}
                if ($credentials.Count -gt 0) { $cred["values"] = $credentials }
                if ($envFileValues.Count -gt 0) { $cred["envFileValues"] = $envFileValues }
                $vaultMeta.servers[$ServerId] = @{
                    disabled       = $false
                    credentials    = $cred
                    definitionHash = Get-McpDefinitionHash $server
                    updatedAt      = (Get-Date).ToUniversalTime().ToString("o")
                }
                Write-McpMeta $vaultMeta
            }
        }
        catch {
            Write-UiWarn "vault 写入失败（不影响 MCP 配置）: $($_.Exception.Message)"
        }

        # 5e. 同步 MCP Rules（Install 链纯 PS 渲染，不依赖 mcp-manager.js）
        if (-not (Sync-McpRules)) {
            Write-UiWarn "MCP Rules 同步失败"
        }

        # 凭据清零（安全）
        foreach ($key in @($credentials.Keys)) { $credentials[$key] = $null }

        Write-UiSuccess "MCP Server '$ServerId' 安装完成"
        return @{ Success = $true; ServerId = $ServerId; Status = "Active" }
    }
    catch {
        Write-UiError "安装 MCP Server '$ServerId' 失败: $($_.Exception.Message)"
        return @{ Success = $false; ServerId = $ServerId; Status = "Failed"; ErrorMessage = $_.Exception.Message }
    }
}

# ============================================================
# 主要函数（安装/验证/更新）
# ============================================================

function Test-McpInstalled {
    <#
    .SYNOPSIS
    检测 MCP Server 是否已安装配置（支持 stdio/http/software）
    .RETURNS
    标准检测结果 hashtable（IsInstalled, Version, Data, Message）
    #>

    $claudeJsonPath = "$(Get-UserHome)\.claude.json"
    return Invoke-UnifiedCheck -StepId "Mcp" -DisplayName "MCP Server 配置" `
        -CustomVerify {
            if (-not (Test-Path $claudeJsonPath)) { return $false }

            $claudeJson = Get-Content -Path $claudeJsonPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
            if (-not $claudeJson) { return $false }

            $hasMcpServers = $claudeJson.ContainsKey("mcpServers") -and $claudeJson["mcpServers"]

            $stdioCount = 0
            $httpCount = 0
            if ($hasMcpServers) {
                foreach ($serverId in @($claudeJson["mcpServers"].Keys)) {
                    $serverConfig = $claudeJson["mcpServers"][$serverId]
                    $hasType = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("type")
                    $hasUrl = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("url")
                    $hasCommand = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("command")
                    $hasArgs = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("args")

                    if ($hasType -and [string]$serverConfig["type"] -eq "http" -and $hasUrl -and -not [string]::IsNullOrWhiteSpace([string]$serverConfig["url"])) {
                        $httpCount++
                        continue
                    }
                    if ($hasCommand -and $hasArgs -and -not [string]::IsNullOrWhiteSpace([string]$serverConfig["command"]) -and $serverConfig["args"]) {
                        $stdioCount++
                    }
                }
            }

            # 检查 settings.json 中的权限配置
            $settingsPath = Get-ClaudeSettingsPath
            $hasPermissions = $false
            if (Test-Path $settingsPath) {
                $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
                if ($settings) {
                    $hasPermissions = $settings -is [hashtable] -and $settings.ContainsKey("permissions") -and
                        $settings["permissions"] -is [hashtable] -and $settings["permissions"].ContainsKey("allow") -and
                        $settings["permissions"]["allow"]
                }
            }

            if (($stdioCount + $httpCount) -gt 0 -and $hasPermissions) {
                Write-UiInfo "  stdio: $stdioCount, http: $httpCount" -Level Detail
                return $true
            }
            return $false
        } -UseCache
}

function Install-Mcp {
    <#
    .SYNOPSIS
    安装 MCP Server 配置（管道模式：依赖 → 预安装 → 凭据 → 软件 → 配置）
    #>

    try {
        Write-UiPrimary "配置 MCP Server..." -Level Detail

        # 检测已安装的 MCP Server
        $claudeJsonPath = "$(Get-UserHome)\.claude.json"
        $existingServers = @()
        if (Test-Path $claudeJsonPath) {
            try {
                $claudeJson = Get-Content -Path $claudeJsonPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
                if ($claudeJson -and $claudeJson.ContainsKey("mcpServers") -and $claudeJson["mcpServers"]) {
                    $existingServers = @($claudeJson["mcpServers"].Keys)
                    if ($existingServers.Count -gt 0) {
                        Write-UiInfo "已安装的 MCP Server: $($existingServers -join ', ')" -Level Detail
                    }
                }
            }
            catch {
                Write-UiWarning "读取现有 MCP 配置时出错: $($_.Exception.Message)" -Level Debug
            }
        }

        $modeOptions = @(
            "一键模式 (推荐) - 自动安装核心 4 个 MCP Server",
            "自定义模式 - 手动选择需要的 MCP Server"
        )
        $modeIndex = Show-SingleSelectMenu -Options $modeOptions -Title "MCP Server 安装模式"
        if ($modeIndex -lt 0) {
            Write-UiInfo "已取消 MCP Server 安装模式选择"
            return $true
        }
        $selectedMode = if ($modeIndex -eq 0) { "quick" } else { "custom" }

        $orderedServerIds = @($script:McpServers.Keys | Sort-Object { [int]$script:McpServers[$_].Priority })
        if ($selectedMode -eq "quick") {
            $selectedServers = @($orderedServerIds | Where-Object {
                $script:McpServers[$_].Recommended
            })

            # 一键模式：选中所有推荐的 MCP Server（后续统一在确认环节显示详情）
        }
        else {
            $displayOptions = @()
            $serverMap = @()
            $defaultSelected = @()

            for ($i = 0; $i -lt $orderedServerIds.Count; $i++) {
                $serverId = $orderedServerIds[$i]
                $server = $script:McpServers[$serverId]
                $recommendedTag = if ($server.Recommended) { " (推荐)" } else { "" }
                $credentialTag = if ($server.CredentialType -ne "none") { " | 需凭据" } else { "" }
                $installedTag = if ($existingServers -contains $serverId) { "[已安装] " } else { "" }
                $displayOptions += "$installedTag$($server.Name)$recommendedTag$credentialTag - $($server.Description)"
                $serverMap += $serverId
                # 默认选中推荐的且未安装的
                if ($server.Recommended -and $existingServers -notcontains $serverId) {
                    $defaultSelected += $i
                }
            }

            Write-UiPrimary "请选择要安装的 MCP Server:"
            $selectedIndices = Show-MultiSelectMenu -Options $displayOptions -DefaultSelected $defaultSelected -Title "MCP Server 选择"

            # $null = 用户按 Esc 取消，优雅退出
            if ($null -eq $selectedIndices) {
                Write-UiInfo "已取消 MCP Server 选择"
                return $true
            }

            if (@($selectedIndices).Count -eq 0) {
                throw "未选择任何 MCP Server"
            }

            $selectedServers = @()
            foreach ($selectedIndex in $selectedIndices) {
                $selectedServers += $serverMap[[int]$selectedIndex]
            }
        }

        # 过滤掉已安装的 MCP Server（可选：用户可以选择重新安装）
        $newServers = @()
        $skippedServers = @()
        foreach ($serverId in $selectedServers) {
            if ($existingServers -contains $serverId) {
                Write-UiInfo "$($script:McpServers[$serverId].Name) 已安装，将跳过" -Level Detail
                $skippedServers += $serverId
            } else {
                $newServers += $serverId
            }
        }

        if ($newServers.Count -eq 0) {
            Write-UiSuccess "所有选择的 MCP Server 均已安装，无需重复安装" -Level Detail
            return $true
        }

        Write-UiInfo "将安装 $($newServers.Count) 个新的 MCP Server" -Level Detail
        $selectedServers = $newServers

        # 显示安装摘要并确认
        Write-Host ""
        Write-UiWarning "即将安装以下 MCP Server："
        foreach ($serverId in $selectedServers) {
            $server = $script:McpServers[$serverId]
            Write-UiInfo "  - $($server.Name): $($server.Description)" -Level Detail
        }
        Write-Host ""

        $confirmIndex = Show-SingleSelectMenu `
            -Title "确认安装？" `
            -Options @("是，开始安装", "否，取消")

        if ($confirmIndex -ne 0) {
            Write-UiInfo "已取消 MCP Server 安装"
            return $true
        }

        $serverStatus = @{}
        $successCount = 0
        $failureCount = 0

        # 使用 Install-McpSingleServer 逐个安装（已迁移到 core/McpManager.ps1）
        foreach ($serverId in $selectedServers) {
            $server = $script:McpServers[$serverId]
            Write-UiPrimary "安装 $($server.Name)..." -Level Detail

            $result = Install-McpSingleServer -ServerId $serverId
            $serverStatus[$serverId] = $result

            if ($result.Success) {
                $successCount++
            }
            else {
                $failureCount++
                Write-UiWarning "跳过 $($server.Name): $($result.ErrorMessage)" -Level Detail
            }
        }

        if ($successCount -eq 0) {
            throw "所有 MCP Server 均安装失败"
        }

        # 安装摘要
        Write-Host ""
        Write-UiPrimary "安装摘要:"
        Write-UiInfo "  - 选择: $($selectedServers.Count), 成功: $successCount, 失败: $failureCount"
        foreach ($serverId in $selectedServers) {
            $server = $script:McpServers[$serverId]
            $r = $serverStatus[$serverId]
            $statusText = if ($r.Success) { "✓ $($r.Status)" } else { "✗ $($r.ErrorMessage)" }
            Write-UiInfo "  - $($server.Name): $statusText"
        }

        return $true
    }
    catch {
        Write-UiDanger "配置 MCP Server 失败: $($_.Exception.Message)"
        return $false
    }
}

function Verify-Mcp {
    <#
    .SYNOPSIS
    验证 MCP Server 配置（stdio/http/software 多类型）
    #>

    try {
        # 验证 ~/.claude.json 中的 MCP Server 配置
        $claudeJsonPath = "$(Get-UserHome)\.claude.json"
        if (-not (Test-Path $claudeJsonPath)) {
            throw ".claude.json 不存在"
        }

        $claudeJson = Get-Content -Path $claudeJsonPath -Raw | ConvertFrom-Json -AsHashtable
        if (-not $claudeJson.ContainsKey("mcpServers") -or -not $claudeJson["mcpServers"]) {
            throw "缺少 MCP Server 配置"
        }

        $configuredServers = @($claudeJson["mcpServers"].Keys)
        if ($configuredServers.Count -eq 0) {
            throw "未配置任何 MCP Server"
        }

        $stdioCount = 0
        $httpCount = 0

        foreach ($serverId in $configuredServers) {
            $serverConfig = $claudeJson["mcpServers"][$serverId]
            if (-not $serverConfig) {
                Write-UiWarning "跳过空配置: $serverId" -Level Debug
                continue
            }

            $hasType = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("type")
            $hasUrl = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("url")
            $hasCommand = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("command")
            $hasArgs = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("args")
            $typeValue = if ($hasType) { [string]$serverConfig["type"] } else { "" }

            if ($typeValue -eq "http") {
                $httpCount++
                if (-not $hasUrl -or [string]::IsNullOrWhiteSpace([string]$serverConfig["url"])) {
                    throw "MCP Server '$serverId' 缺少 http.url"
                }
                if ([string]$serverConfig["url"] -match "\{[A-Za-z0-9_]+\}") {
                    throw "MCP Server '$serverId' URL 仍包含占位符: $($serverConfig["url"])"
                }
            }
            elseif ($hasCommand -and -not [string]::IsNullOrWhiteSpace([string]$serverConfig["command"])) {
                $stdioCount++
                if (-not $hasArgs -or -not $serverConfig["args"]) {
                    throw "MCP Server '$serverId' 缺少 stdio.args"
                }
            }
            else {
                Write-UiWarning "MCP Server '$serverId' 不是标准 stdio/http 配置，已跳过严格校验" -Level Debug
                continue
            }

            if (-not $script:McpServers.Contains($serverId)) {
                continue
            }

            $serverDef = $script:McpServers[$serverId]
            $credentialType = if ($serverDef.CredentialType) { [string]$serverDef.CredentialType } else { "none" }
            $argsList = if ($hasArgs) { @($serverConfig["args"]) } else { @() }

            switch ($credentialType) {
                "single-key" {
                    # 检查 settings.json 中的 API Key
                    $settingsPath = Get-ClaudeSettingsPath
                    if (Test-Path $settingsPath) {
                        $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json -AsHashtable
                        $apiKeyName = [string]$serverDef.ApiKeyName
                        $hasServerEnv = $serverConfig -is [hashtable] -and $serverConfig.ContainsKey("env") -and
                            $serverConfig["env"] -is [hashtable] -and
                            $serverConfig["env"].ContainsKey($apiKeyName) -and
                            -not [string]::IsNullOrWhiteSpace([string]$serverConfig["env"][$apiKeyName])
                        $hasGlobalEnv = $settings -is [hashtable] -and $settings.ContainsKey("env") -and
                            $settings["env"] -is [hashtable] -and
                            $settings["env"].ContainsKey($apiKeyName) -and
                            -not [string]::IsNullOrWhiteSpace([string]$settings["env"][$apiKeyName])
                        if (-not ($hasServerEnv -or $hasGlobalEnv)) {
                            Write-UiWarning "MCP Server '$serverId' 缺少 API Key: $apiKeyName" -Level Detail
                        }
                    }
                }
                "args-multi" {
                    foreach ($argCredential in @($serverDef.ArgsCredentials)) {
                        $argName = [string]$argCredential.ArgName
                        $required = if ($argCredential.ContainsKey("Required")) { [bool]$argCredential.Required } else { $false }
                        if (-not $required) {
                            continue
                        }

                        $argIndex = [array]::IndexOf($argsList, $argName)
                        if ($argIndex -lt 0 -or $argIndex -ge ($argsList.Count - 1)) {
                            throw "MCP Server '$serverId' 缺少必需参数: $argName"
                        }
                        if ([string]::IsNullOrWhiteSpace([string]$argsList[$argIndex + 1])) {
                            throw "MCP Server '$serverId' 参数值为空: $argName"
                        }
                    }
                }
                "args-token" {
                    $tokenPrefix = "$($serverDef.TokenArg)="
                    $hasToken = @($argsList | Where-Object {
                        $_ -is [string] -and $_.StartsWith($tokenPrefix) -and $_.Length -gt $tokenPrefix.Length
                    }).Count -gt 0
                    if (-not $hasToken) {
                        throw "MCP Server '$serverId' 缺少 token 参数: $($serverDef.TokenArg)"
                    }
                }
                "url-embedded" {
                    if ($serverConfig["type"] -ne "http") {
                        throw "MCP Server '$serverId' 应为 http 配置"
                    }
                    if ([string]$serverConfig["url"] -match "\{[A-Za-z0-9_]+\}") {
                        throw "MCP Server '$serverId' URL 占位符未替换: $($serverConfig["url"])"
                    }
                }
                "env-file" {
                    $envPath = [string]$serverDef.EnvFile.Path
                    if (-not (Test-Path $envPath)) {
                        throw "MCP Server '$serverId' 缺少 .env 文件: $envPath"
                    }

                    $envContent = Get-Content -Path $envPath -Raw
                    foreach ($sharedField in @($serverDef.EnvFile.SharedKeyFields)) {
                        if ($envContent -notmatch "(?m)^\s*$([regex]::Escape([string]$sharedField))\s*=\s*.+$") {
                            throw "MCP Server '$serverId' .env 缺少必填字段: $sharedField"
                        }
                    }
                    foreach ($field in @($serverDef.EnvFile.Fields)) {
                        if ($field.ContainsKey("Required") -and [bool]$field.Required) {
                            $fieldKey = [string]$field.Key
                            if ($envContent -notmatch "(?m)^\s*$([regex]::Escape($fieldKey))\s*=\s*.+$") {
                                throw "MCP Server '$serverId' .env 缺少必填字段: $fieldKey"
                            }
                        }
                    }
                }
            }
        }

        # 验证 settings.json 中的权限配置
        $settingsPath = Get-ClaudeSettingsPath
        if (-not (Test-Path $settingsPath)) {
            throw "settings.json 不存在"
        }

        $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json -AsHashtable
        if (-not $settings.ContainsKey("permissions") -or
            -not ($settings["permissions"] -is [hashtable]) -or
            -not $settings["permissions"].ContainsKey("allow") -or
            -not $settings["permissions"]["allow"]) {
            throw "缺少权限配置"
        }
        # 检查已安装的 MCP Server 是否有对应的 mcp__ 权限
        foreach ($serverId in $configuredServers) {
            $mcpPerm = "mcp__${serverId}"
            if ($settings["permissions"]["allow"] -notcontains $mcpPerm) {
                Write-UiWarning "⚠ 缺少 MCP 权限: $mcpPerm" -Level Detail
            }
        }

        Write-UiSuccess "✓ MCP Server 配置验证通过"
        Write-UiInfo "  - MCP 数量: $($configuredServers.Count)" -Level Detail
        Write-UiInfo "  - stdio: $stdioCount" -Level Detail
        Write-UiInfo "  - http: $httpCount" -Level Detail

        # TODO: ContextWeaver 验证逻辑，待 Python 环境支持后启用
        # if ($claudeJson.mcpServers.PSObject.Properties.Name -contains "contextweaver") {
        #     $envPath = $script:McpServers["contextweaver"].EnvFile.Path
        #     if (Test-Path $envPath) {
        #         Write-UiInfo "  - contextweaver .env: ✓ ($envPath)"
        #     }
        #     else {
        #         throw "contextweaver 已配置但缺少 .env 文件: $envPath"
        #     }
        # }

        return $true
    }
    catch {
        Write-UiDanger "验证 MCP Server 配置失败: $($_.Exception.Message)"
        return $false
    }
}

# 注: Get-ClaudeSettingsPath 已迁移到 core/McpManager.ps1

function Clear-NpxCache {
    <#
    .SYNOPSIS
    清理 npx 缓存目录（_npx）
    .DESCRIPTION
    主路径：删除 npm cache 下的 _npx 子目录
    回退：npm cache clean --force（仅主路径失败时执行）
    .RETURNS
    @{ Success; Skipped; Fallback; NoOp; Reason }
    #>

    # HC-13: 初始化完整属性集，防止 StrictMode 下访问缺失属性
    $base = @{ Success = $false; Skipped = $false; Fallback = $false; NoOp = $false; Reason = "" }

    # 1. 检测 npm 可用性
    if (-not (Test-CommandAvailable "npm")) {
        $base.Skipped = $true; $base.Reason = "npm-missing"
        return $base
    }

    # 2. 获取缓存路径
    $cacheResult = Invoke-ExternalCommand -Command "npm" -Arguments @("config", "get", "cache") -SuppressOutput
    if ($cacheResult.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($cacheResult.Output)) {
        $base.Skipped = $true; $base.Reason = "cache-path-unavailable"
        return $base
    }

    $cacheDir = $cacheResult.Output.Trim()
    $npxDir = Join-Path $cacheDir "_npx"

    # 3. 主路径：删除 _npx 目录
    if (Test-Path $npxDir) {
        try {
            Remove-Item $npxDir -Recurse -Force
            $base.Success = $true
            return $base
        }
        catch {
            # 4. Fallback：npm cache clean --force
            $cleanResult = Invoke-ExternalCommand -Command "npm" -Arguments @("cache", "clean", "--force") -SuppressOutput
            $base.Success = ($cleanResult.ExitCode -eq 0); $base.Fallback = $true
            return $base
        }
    }

    $base.Success = $true; $base.NoOp = $true
    return $base
}

function Update-Mcp {
    <#
    .SYNOPSIS
    更新已安装的 MCP Server 配置到最新定义
    .DESCRIPTION
    - Phase 0: npx 缓存清理 + PreInstall npm-global 更新
    - 已存在的 Server：对比 args/url/配置，变更则更新
    - 不存在的 Server：不自动添加（由 -OnMissing 控制）
    - 不删除用户手动添加的 Server
    - 同步更新 permissions.allow
    .RETURNS
    @{ Success; ErrorMessage; Data; UpdatedItems }
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
        UpdatedItems = @()
    }

    try {
        $updatedItems = [System.Collections.ArrayList]::new()

        # ── Phase 0: npx 缓存清理 + PreInstall npm-global 更新 ──
        $cacheResult = Clear-NpxCache
        if ($cacheResult.Skipped) {
            [void]$updatedItems.Add("skipped::npm-missing")
        }
        elseif ($cacheResult.Success -and -not $cacheResult.NoOp) {
            Write-UiSuccess "npx 缓存已清理" -Level Detail
            [void]$updatedItems.Add("cache::npx::cleared")
        }
        elseif (-not $cacheResult.Success) {
            Write-UiWarning "npx 缓存清理失败，继续更新..." -Level Debug
            [void]$updatedItems.Add("cache::npx::clear-failed")
        }

        # PreInstall npm-global 更新
        foreach ($serverId in $script:McpServers.Keys) {
            $serverDef = $script:McpServers[$serverId]
            if (-not $serverDef.ContainsKey("PreInstall") -or -not $serverDef["PreInstall"]) { continue }
            $pre = [hashtable]$serverDef["PreInstall"]
            if ($pre.Type -ne "npm-global") { continue }

            Write-UiPrimary "正在更新 $($pre.Package)..." -Level Detail
            $installResult = Invoke-NpmGlobalInstall -PackageName $pre.Package -Force
            if ($installResult.Success) {
                [void]$updatedItems.Add("npm::$($pre.Package)::updated")
            }
            else {
                Write-UiWarning "更新 $($pre.Package) 失败: $($installResult.Error)" -Level Debug
            }
        }

        # ── Phase 1+: 配置对齐（原有逻辑）──

        # 读取 .claude.json
        $claudeJsonPath = "$(Get-UserHome)\.claude.json"
        if (-not (Test-Path $claudeJsonPath)) {
            $result.UpdatedItems = @("noop::Mcp::no-change")
            $result.Success = $true
            Write-UiInfo "Mcp 配置文件不存在，跳过更新" -Level Detail
            return $result
        }

        # R-09: Mutex 保护配置文件读-改-写（防止与 Disable/Enable/Remove 并发冲突）
        $null = Invoke-WithMcpLock {

        $claudeJson = Get-Content -Path $claudeJsonPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if (-not $claudeJson) { $claudeJson = @{} }
        if (-not $claudeJson.ContainsKey("mcpServers")) {
            $claudeJson["mcpServers"] = @{}
        }

        $configChanged = $false

        # 遍历 CCQ 定义的 MCP Servers
        foreach ($serverId in $script:McpServers.Keys) {
            $serverDef = $script:McpServers[$serverId]

            # 仅更新已安装的 Server
            if (-not $claudeJson["mcpServers"].ContainsKey($serverId)) {
                continue
            }

            $existingConfig = $claudeJson["mcpServers"][$serverId]
            $needsUpdate = $false

            # 比较配置
            switch ($serverDef.McpType) {
                "stdio" {
                    $expectedArgs = @($serverDef.Args)
                    $currentArgs = if ($existingConfig.ContainsKey("args")) { @($existingConfig["args"]) } else { @() }
                    $expectedCommand = $serverDef.Command

                    # 只比较非凭据部分的 args（凭据部分保留用户原值）
                    if ($existingConfig.ContainsKey("command") -and [string]$existingConfig["command"] -ne $expectedCommand) {
                        $needsUpdate = $true
                    }

                    # 比较基础 args（不含凭据注入的部分）
                    $baseArgsChanged = $false
                    if ($expectedArgs.Count -ne $currentArgs.Count) {
                        if ($serverDef.CredentialType -eq "none") {
                            $baseArgsChanged = $true
                        } else {
                            # IDEM-1: 凭据型 Server args 数量漂移，记录警告以便排查
                            Write-UiWarning "MCP '$serverId' args 数量漂移 (期望 $($expectedArgs.Count), 实际 $($currentArgs.Count))，凭据型跳过自动更新" -Level Debug
                        }
                    } else {
                        for ($i = 0; $i -lt $expectedArgs.Count; $i++) {
                            if ($expectedArgs[$i] -ne $currentArgs[$i]) {
                                $baseArgsChanged = $true
                                break
                            }
                        }
                    }

                    if ($baseArgsChanged) { $needsUpdate = $true }
                }
                "http" {
                    # url-embedded 类型使用 UrlTemplate（含用户凭据），不比较 URL
                    if ($serverDef.CredentialType -ne "url-embedded") {
                        $expectedUrl = $serverDef.Url
                        $currentUrl = if ($existingConfig.ContainsKey("url")) { [string]$existingConfig["url"] } else { "" }
                        if ($currentUrl -ne $expectedUrl) {
                            $needsUpdate = $true
                        }
                    }
                }
            }

            if ($needsUpdate) {
                # 重新生成配置条目（保留已有凭据）
                $existingCredentials = @{}

                # 提取已有凭据
                if ($existingConfig.ContainsKey("env") -and $existingConfig["env"]) {
                    $existingCredentials = $existingConfig["env"]
                }

                # 生成新的基础配置（无凭据）
                try {
                    $newEntry = New-McpSettingsEntry -ServerId $serverId -Server $serverDef -Credentials @{}

                    # 恢复已有凭据
                    if ($existingCredentials.Count -gt 0 -and $newEntry) {
                        if (-not $newEntry.ContainsKey("env")) {
                            $newEntry["env"] = @{}
                        }
                        foreach ($key in $existingCredentials.Keys) {
                            $newEntry["env"][$key] = $existingCredentials[$key]
                        }
                    }

                    $claudeJson["mcpServers"][$serverId] = $newEntry
                    [void]$updatedItems.Add("config::mcpServers.${serverId}::updated")
                    $configChanged = $true
                } catch {
                    Write-UiWarning "更新 MCP Server '$serverId' 失败: $($_.Exception.Message)" -Level Debug
                }
            }
        }

        # 写入 .claude.json（如有变更）— 原子写入
        if ($configChanged) {
            $claudeJsonContent = $claudeJson | ConvertTo-Json -Depth 10
            $writeOk = Write-FileAtomically -FilePath $claudeJsonPath -Content @($claudeJsonContent)
            if (-not $writeOk) {
                throw ".claude.json 原子写入失败"
            }

            # CONS-2: 同步 vault 中已安装 Server 的 definitionHash
            try {
                $meta = Read-McpMeta
                $hashUpdated = $false
                foreach ($sid in $script:McpServers.Keys) {
                    if ($claudeJson["mcpServers"].ContainsKey($sid) -and $meta["servers"].ContainsKey($sid)) {
                        $newHash = Get-McpDefinitionHash -ServerDef $script:McpServers[$sid]
                        if ($meta["servers"][$sid]["definitionHash"] -ne $newHash) {
                            $meta["servers"][$sid]["definitionHash"] = $newHash
                            $meta["servers"][$sid]["updatedAt"] = (Get-Date).ToUniversalTime().ToString("o")
                            $hashUpdated = $true
                        }
                    }
                }
                if ($hashUpdated) {
                    Write-McpMeta $meta
                }
            } catch {
                Write-UiWarning "vault definitionHash 同步失败: $($_.Exception.Message)" -Level Debug
            }
        }

        # 同步 settings.json 权限
        $settingsPath = Get-ClaudeSettingsPath
        if (Test-Path $settingsPath) {
            $settings = Get-Content -Path $settingsPath -Raw | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
            if ($settings) {
                if (-not $settings.ContainsKey("permissions")) { $settings["permissions"] = @{} }
                if (-not $settings["permissions"].ContainsKey("allow")) { $settings["permissions"]["allow"] = @() }

                # 为已安装的 MCP Server 补齐 mcp__<serverId> 权限（存量自愈）
                $permChanged = $false
                foreach ($serverId in @($claudeJson["mcpServers"].Keys)) {
                    $mcpPerm = "mcp__${serverId}"
                    if ($settings["permissions"]["allow"] -notcontains $mcpPerm) {
                        $settings["permissions"]["allow"] += $mcpPerm
                        [void]$updatedItems.Add("config::permissions.allow.${mcpPerm}::added")
                        $permChanged = $true
                    }
                }

                if ($permChanged) {
                    $settingsJson = $settings | ConvertTo-Json -Depth 10
                    Write-FileAtomically -FilePath $settingsPath -Content @($settingsJson)
                }
            }
        }

        }  # End Invoke-WithMcpLock

        # 结果
        if ($updatedItems.Count -eq 0) {
            $result.UpdatedItems = @("noop::Mcp::no-change")
            Write-UiInfo "Mcp 配置已是最新，无需更新" -Level Detail
        } else {
            $result.UpdatedItems = @($updatedItems)
            Write-UiSuccess "✓ Mcp 已更新 ($($updatedItems.Count) 项变更)"
        }

        $result.Success = $true
    }
    catch {
        $result.ErrorMessage = "更新 Mcp 失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember

