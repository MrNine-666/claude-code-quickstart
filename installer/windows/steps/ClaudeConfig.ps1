# Claude Code 常用配置步骤 - CCQ
# 功能: 声明式字段管理，仅补缺失项，不覆盖 ApiKey/Ccline/用户已有配置

#Requires -Version 5.1

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 依赖: Ui.ps1, Profile.ps1（由入口脚本 dot-source 加载）

# ─── ClaudeConfig 契约初始化（contracts-first，fallback 自包含）────────────────────

$script:_claudeConfigContractCache = $null

function Get-ClaudeConfigWindowsRoot {
    <#
    .SYNOPSIS
    返回 Windows 平台根目录 installer/windows。
    #>
    param()

    if (Get-Variable -Name WindowsRoot -Scope Script -ErrorAction SilentlyContinue) {
        $windowsRoot = [string]$script:WindowsRoot
        if (-not [string]::IsNullOrWhiteSpace($windowsRoot)) { return $windowsRoot }
    }

    if (-not [string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        $currentRoot = $PSScriptRoot
        if ((Split-Path -Leaf $currentRoot) -ieq 'steps') {
            return (Split-Path -Parent $currentRoot)
        }
        return $currentRoot
    }

    return ''
}

function Get-ClaudeConfigInstallerRoot {
    <#
    .SYNOPSIS
    返回 installer 根目录，用于定位 contracts。
    #>
    param()

    if (Get-Variable -Name InstallerRoot -Scope Script -ErrorAction SilentlyContinue) {
        $installerRoot = [string]$script:InstallerRoot
        if (-not [string]::IsNullOrWhiteSpace($installerRoot)) { return $installerRoot }
    }

    $windowsRoot = Get-ClaudeConfigWindowsRoot
    if (-not [string]::IsNullOrWhiteSpace($windowsRoot)) {
        return (Split-Path -Parent $windowsRoot)
    }

    return ''
}

function Get-ClaudeConfigContractsRoot {
    <#
    .SYNOPSIS
    返回 contracts 根目录；内嵌 artifact 可通过环境变量指定。
    #>
    param()

    if (-not [string]::IsNullOrWhiteSpace($env:CCQ_CONTRACTS_DIR)) {
        return $env:CCQ_CONTRACTS_DIR
    }

    $installerRoot = Get-ClaudeConfigInstallerRoot
    if ([string]::IsNullOrWhiteSpace($installerRoot)) { return '' }
    return (Join-Path $installerRoot 'contracts')
}

function Get-ClaudeConfigContractPath {
    <#
    .SYNOPSIS
    返回 claude-config.json 契约路径。
    #>
    param()

    if (-not [string]::IsNullOrWhiteSpace($env:CCQ_CLAUDE_CONFIG_CONTRACT)) {
        return $env:CCQ_CLAUDE_CONFIG_CONTRACT
    }

    $contractsRoot = Get-ClaudeConfigContractsRoot
    if ([string]::IsNullOrWhiteSpace($contractsRoot)) { return '' }
    return (Join-Path $contractsRoot 'claude-config.json')
}

function Get-ClaudeConfigContractValue {
    <#
    .SYNOPSIS
    安全读取 IDictionary 字段，避免 StrictMode 下访问缺失键。
    #>
    param(
        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$Table,

        [Parameter(Mandatory)]
        [string]$Key,

        [object]$Default = $null
    )

    if ($Table.Contains($Key) -and $null -ne $Table[$Key]) { return $Table[$Key] }
    return $Default
}

function ConvertTo-ClaudeConfigRuntimeObject {
    <#
    .SYNOPSIS
    将 JSON 对象递归转换为 PowerShell 运行时 hashtable / array。
    #>
    param([object]$Value)

    if ($Value -is [System.Collections.IDictionary]) {
        $result = @{}
        foreach ($key in $Value.Keys) {
            $result[[string]$key] = ConvertTo-ClaudeConfigRuntimeObject -Value $Value[$key]
        }
        return $result
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        return @($Value | ForEach-Object { ConvertTo-ClaudeConfigRuntimeObject -Value $_ })
    }

    return $Value
}

function ConvertTo-ClaudeConfigStringHashtable {
    <#
    .SYNOPSIS
    将 JSON hashtable 规范化为 string → string hashtable。
    #>
    param([object]$Table)

    $result = @{}
    if ($Table -is [System.Collections.IDictionary]) {
        foreach ($entry in $Table.GetEnumerator()) {
            $result[[string]$entry.Key] = [string]$entry.Value
        }
    }
    return $result
}

function Get-ClaudeConfigContract {
    <#
    .SYNOPSIS
    优先读取 installer/contracts/claude-config.json；不可用时返回 $null。
    #>
    param()

    if ($null -ne $script:_claudeConfigContractCache) { return $script:_claudeConfigContractCache }

    $contractPath = Get-ClaudeConfigContractPath
    if ([string]::IsNullOrWhiteSpace($contractPath) -or -not (Test-Path $contractPath -PathType Leaf)) {
        return $null
    }

    try {
        $script:_claudeConfigContractCache = Get-Content -Path $contractPath -Encoding UTF8 -Raw | ConvertFrom-Json -AsHashtable
        return $script:_claudeConfigContractCache
    } catch {
        Write-Verbose "读取 ClaudeConfig 契约失败，改用内联 fallback: $($_.Exception.Message)"
        return $null
    }
}

function ConvertTo-ClaudeConfigRuntimeConfig {
    <#
    .SYNOPSIS
    将 claude-config.json 契约转换为 ClaudeConfig.ps1 运行时配置。
    #>
    param(
        [Parameter(Mandatory)]
        [System.Collections.IDictionary]$Contract
    )

    $ownership = Get-ClaudeConfigContractValue -Table $Contract -Key 'Ownership' -Default @{}
    return @{
        TopLevelDefaults               = [hashtable](ConvertTo-ClaudeConfigRuntimeObject -Value (Get-ClaudeConfigContractValue -Table $Contract -Key 'TopLevelDefaults' -Default @{}))
        ClaudeConfigEnvDefaults        = ConvertTo-ClaudeConfigStringHashtable -Table (Get-ClaudeConfigContractValue -Table $Contract -Key 'ClaudeConfigEnvDefaults' -Default @{})
        ClaudeConfigDeprecatedEnvKeys  = @(Get-ClaudeConfigContractValue -Table $Contract -Key 'ClaudeConfigDeprecatedEnvKeys' -Default @() | ForEach-Object { [string]$_ })
        ClaudeConfigBasePermissions    = @(Get-ClaudeConfigContractValue -Table $Contract -Key 'ClaudeConfigBasePermissions' -Default @() | ForEach-Object { [string]$_ })
        DoNotManageTopLevelKeys        = @(Get-ClaudeConfigContractValue -Table $ownership -Key 'DoNotManageTopLevelKeys' -Default @() | ForEach-Object { [string]$_ })
        DoNotManageEnvKeys             = @(Get-ClaudeConfigContractValue -Table $ownership -Key 'DoNotManageEnvKeys' -Default @() | ForEach-Object { [string]$_ })
        InstallStrategy                = [string](Get-ClaudeConfigContractValue -Table $ownership -Key 'InstallStrategy' -Default 'fill-missing-only')
        UpdateStrategy                 = [string](Get-ClaudeConfigContractValue -Table $ownership -Key 'UpdateStrategy' -Default 'align-owned-env-and-append-permissions')
    }
}

function Get-InlineClaudeConfigRuntimeConfig {
    <#
    .SYNOPSIS
    返回 release artifact 或 contracts 不可用时使用的内联 fallback 配置。
    #>
    param()

    return @{
        TopLevelDefaults = @{
            language = '简体中文'
            alwaysThinkingEnabled = $true
            plansDirectory = '.claude/plan'
            attribution = @{ commit = ''; pr = '' }
        }
        ClaudeConfigEnvDefaults = @{
            'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE'          = '90'
            'CLAUDE_CODE_ATTRIBUTION_HEADER'           = '0'
            'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC' = '1'
            'CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS'     = '1'
            'DISABLE_INSTALLATION_CHECKS'              = '1'
            'MAX_THINKING_TOKENS'                      = '31999'
        }
        ClaudeConfigDeprecatedEnvKeys = @()
        ClaudeConfigBasePermissions = @(
            'Bash',
            'BashOutput',
            'Edit',
            'Glob',
            'Grep',
            'KillShell',
            'NotebookEdit',
            'PowerShell',
            'Read',
            'SlashCommand',
            'Skill',
            'Task',
            'TodoWrite',
            'WebFetch',
            'WebSearch',
            'Write'
        )
        DoNotManageTopLevelKeys = @('model', 'statusLine', 'hooks', 'outputStyle', 'mcpServers')
        DoNotManageEnvKeys = @(
            'ANTHROPIC_AUTH_TOKEN',
            'ANTHROPIC_BASE_URL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_MODEL',
            'CLAUDE_CODE_SUBAGENT_MODEL',
            'CLAUDE_CODE_EFFORT_LEVEL',
            'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
            'API_TIMEOUT_MS',
            'ENABLE_TOOL_SEARCH',
            'CODEAGENT_POST_MESSAGE_DELAY',
            'CODEX_TIMEOUT',
            'BASH_DEFAULT_TIMEOUT_MS',
            'BASH_MAX_TIMEOUT_MS'
        )
        InstallStrategy = 'fill-missing-only'
        UpdateStrategy = 'align-owned-env-and-append-permissions'
    }
}

function ConvertTo-ClaudeConfigComparableObject {
    <#
    .SYNOPSIS
    递归生成稳定比较对象。
    #>
    param([object]$Value)

    if ($Value -is [System.Collections.IDictionary]) {
        $ordered = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $ordered[[string]$key] = ConvertTo-ClaudeConfigComparableObject -Value $Value[$key]
        }
        return $ordered
    }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string])) {
        return @($Value | ForEach-Object { ConvertTo-ClaudeConfigComparableObject -Value $_ })
    }

    return $Value
}

function ConvertTo-ClaudeConfigComparableJson {
    <#
    .SYNOPSIS
    生成用于比较 ClaudeConfig contract 与内联 fallback 的稳定 JSON。
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$Config
    )

    return (ConvertTo-ClaudeConfigComparableObject -Value $Config | ConvertTo-Json -Depth 20 -Compress)
}

function Assert-ClaudeConfigFallbackConsistency {
    <#
    .SYNOPSIS
    确保 claude-config.json 与 ClaudeConfig.ps1 内联 fallback 保持一致。
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$ContractConfig
    )

    $contractJson = ConvertTo-ClaudeConfigComparableJson -Config $ContractConfig
    $fallbackJson = ConvertTo-ClaudeConfigComparableJson -Config (Get-InlineClaudeConfigRuntimeConfig)
    if ($contractJson -ne $fallbackJson) {
        throw 'installer/contracts/claude-config.json 与 ClaudeConfig.ps1 内联 fallback 不一致，请同步更新二者。'
    }
}

function Initialize-ClaudeConfigRuntimeConfig {
    <#
    .SYNOPSIS
    初始化 ClaudeConfig 运行时常量；源码模式优先读取 claude-config.json。
    #>
    param()

    $contract = Get-ClaudeConfigContract
    if ($null -ne $contract) {
        $config = ConvertTo-ClaudeConfigRuntimeConfig -Contract $contract
        Assert-ClaudeConfigFallbackConsistency -ContractConfig $config
    } else {
        $config = Get-InlineClaudeConfigRuntimeConfig
    }

    $script:ClaudeConfigTopLevelDefaults = $config['TopLevelDefaults']
    $script:ClaudeConfigEnvDefaults = $config['ClaudeConfigEnvDefaults']
    $script:ClaudeConfigDeprecatedEnvKeys = @($config['ClaudeConfigDeprecatedEnvKeys'])
    $script:ClaudeConfigBasePermissions = @($config['ClaudeConfigBasePermissions'])
    $script:ClaudeConfigDoNotManageTopLevelKeys = @($config['DoNotManageTopLevelKeys'])
    $script:ClaudeConfigDoNotManageEnvKeys = @($config['DoNotManageEnvKeys'])
    $script:ClaudeConfigInstallStrategy = [string]$config['InstallStrategy']
    $script:ClaudeConfigUpdateStrategy = [string]$config['UpdateStrategy']
}

Initialize-ClaudeConfigRuntimeConfig

# ─── 顶层默认值应用 ────────────────────────────────────────────────────────────

function Set-ClaudeConfigTopLevelDefaults {
    <#
    .SYNOPSIS
    按契约补齐 ClaudeConfig 管辖的顶层默认值。
    #>
    param(
        [Parameter(Mandatory)]
        [hashtable]$Settings,

        [Parameter(Mandatory)]
        [System.Collections.ArrayList]$UpdatedItems,

        [switch]$AlignPlansDirectory
    )

    foreach ($entry in $script:ClaudeConfigTopLevelDefaults.GetEnumerator()) {
        $key = [string]$entry.Key
        if ($script:ClaudeConfigDoNotManageTopLevelKeys -contains $key) {
            continue
        }

        $value = $entry.Value
        if (-not $Settings.ContainsKey($key) -or $null -eq $Settings[$key] -or [string]::IsNullOrWhiteSpace([string]$Settings[$key])) {
            $Settings[$key] = ConvertTo-ClaudeConfigRuntimeObject -Value $value
            [void]$UpdatedItems.Add("config::${key}::added")
            continue
        }

        if ($AlignPlansDirectory -and $key -eq 'plansDirectory' -and [string]$Settings[$key] -ne [string]$value) {
            $oldValue = [string]$Settings[$key]
            $Settings[$key] = [string]$value
            [void]$UpdatedItems.Add("config::plansDirectory::${oldValue}->$value")
        }
    }
}

# ─── Fingerprint（供 Manage 更新指纹预检使用）─────────────────────────────────

function Get-ClaudeConfigFingerprint {
    <#
    .SYNOPSIS
    计算 ClaudeConfig 步骤的内容指纹（基于 env defaults + deprecated keys + permissions）
    .RETURNS
    string - SHA-256 指纹
    #>
    $parts = @()
    foreach ($key in ($script:ClaudeConfigEnvDefaults.Keys | Sort-Object)) {
        $parts += "${key}=$($script:ClaudeConfigEnvDefaults[$key])"
    }
    $parts += "deprecated:" + (($script:ClaudeConfigDeprecatedEnvKeys | Sort-Object) -join ",")
    $parts += "permissions:" + (($script:ClaudeConfigBasePermissions | Sort-Object) -join ",")
    foreach ($key in ($script:ClaudeConfigTopLevelDefaults.Keys | Sort-Object)) {
        $value = $script:ClaudeConfigTopLevelDefaults[$key]
        $valueText = if ($value -is [System.Collections.IDictionary]) {
            $value | ConvertTo-Json -Depth 10 -Compress
        } else {
            [string]$value
        }
        $parts += "top-level:${key}=${valueText}"
    }
    return Get-StringFingerprint -Text ($parts -join "`n")
}

# ─── Drift Analysis ─────────────────────────────────────────────────────────

function Compare-ClaudeConfigDrift {
    <#
    .SYNOPSIS
    逐项对比 settings.json 实际内容与 ClaudeConfig 声明式模板，返回漂移分析结果
    .RETURNS
    hashtable — { HasDrift, NeedsInstallCompletion, NeedsUpdateAlignment, Details }
    #>

    $result = @{
        HasDrift               = $false
        NeedsInstallCompletion = $false
        NeedsUpdateAlignment   = $false
        Details                = @{
            MissingEnvKeys               = @()
            DriftedEnvKeys               = @()
            MissingPermissions           = @()
            DeprecatedEnvKeys            = @()
            MissingLanguage              = $false
            MissingAlwaysThinkingEnabled = $false
            MissingPlansDirectory        = $false
        }
    }

    $settingsPath = Get-ClaudeSettingsPath
    if (-not (Test-Path $settingsPath)) {
        $result.HasDrift                             = $true
        $result.NeedsInstallCompletion               = $true
        $result.Details.MissingLanguage              = $true
        $result.Details.MissingAlwaysThinkingEnabled = $true
        $result.Details.MissingPlansDirectory        = $true
        $result.Details.MissingEnvKeys               = @($script:ClaudeConfigEnvDefaults.Keys)
        $result.Details.MissingPermissions           = @($script:ClaudeConfigBasePermissions)
        return $result
    }

    try {
        $content  = Get-Content $settingsPath -Raw -Encoding UTF8
        $settings = $content | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if (-not $settings) { $settings = @{} }
    } catch {
        $result.HasDrift               = $true
        $result.NeedsInstallCompletion = $true
        return $result
    }

    # 1. language / thinking 顶层配置检查
    if (-not $settings.ContainsKey("language") -or [string]::IsNullOrWhiteSpace([string]$settings["language"])) {
        $result.Details.MissingLanguage = $true
        $result.NeedsInstallCompletion  = $true
    }
    if (-not $settings.ContainsKey("alwaysThinkingEnabled")) {
        $result.Details.MissingAlwaysThinkingEnabled = $true
        $result.NeedsInstallCompletion               = $true
    }
    $defaultPlansDirectory = [string]$script:ClaudeConfigTopLevelDefaults['plansDirectory']
    if (-not $settings.ContainsKey("plansDirectory") -or [string]::IsNullOrWhiteSpace([string]$settings["plansDirectory"])) {
        $result.Details.MissingPlansDirectory = $true
        $result.NeedsInstallCompletion        = $true
    } elseif ([string]$settings["plansDirectory"] -ne $defaultPlansDirectory) {
        $result.NeedsUpdateAlignment = $true
    }

    # 2. env 键检查
    $envSection = if ($settings.ContainsKey("env") -and $settings["env"]) { $settings["env"] } else { @{} }
    foreach ($entry in $script:ClaudeConfigEnvDefaults.GetEnumerator()) {
        if (-not $envSection.ContainsKey($entry.Key) -or [string]::IsNullOrWhiteSpace([string]$envSection[$entry.Key])) {
            $result.Details.MissingEnvKeys += $entry.Key
            $result.NeedsInstallCompletion  = $true
        } elseif ([string]$envSection[$entry.Key] -ne [string]$entry.Value) {
            $result.Details.DriftedEnvKeys += @{ Key = $entry.Key; Expected = $entry.Value; Actual = [string]$envSection[$entry.Key] }
            $result.NeedsUpdateAlignment    = $true
        }
    }

    # 3. 废弃键检查
    foreach ($deprecatedKey in $script:ClaudeConfigDeprecatedEnvKeys) {
        if ($envSection.ContainsKey($deprecatedKey)) {
            $result.Details.DeprecatedEnvKeys += $deprecatedKey
            $result.NeedsUpdateAlignment       = $true
        }
    }

    # 4. permissions 检查
    $allowList = @()
    if ($settings.ContainsKey("permissions") -and $settings["permissions"] -and
        $settings["permissions"].ContainsKey("allow") -and $settings["permissions"]["allow"]) {
        $allowList = @($settings["permissions"]["allow"])
    }
    foreach ($perm in $script:ClaudeConfigBasePermissions) {
        if ($allowList -notcontains $perm) {
            $result.Details.MissingPermissions += $perm
            $result.NeedsInstallCompletion      = $true
        }
    }

    $result.HasDrift = $result.NeedsInstallCompletion -or $result.NeedsUpdateAlignment
    return $result
}

# ─── Test / Install / Verify ─────────────────────────────────────────────────

function Test-ClaudeConfigInstalled {
    <#
    .SYNOPSIS
    检测 ClaudeConfig 是否完整安装（声明式逐项对比，替代原 Exists 浅检测）
    .DESCRIPTION
    调用 Compare-ClaudeConfigDrift 进行完整漂移分析。
    NeedsInstallCompletion=true（缺失 env 键/permissions/language）→ IsInstalled=false。
    NeedsUpdateAlignment=true（值偏移/废弃键）→ IsInstalled=true，触发 Update 对齐。
    .RETURNS
    标准检测结果 hashtable（IsInstalled, Version, Data, Message）
    #>

    $result = @{ IsInstalled = $false; Version = ""; Data = @{}; Message = "" }

    $settingsPath = Get-ClaudeSettingsPath
    if (-not (Test-Path $settingsPath)) {
        $result.Message = "Claude Code 常用配置未安装: settings.json 不存在"
        return $result
    }

    $drift = Compare-ClaudeConfigDrift
    $result.Data["Drift"]                      = $drift
    $result.Data["MissingEnvKeys"]             = @($drift.Details.MissingEnvKeys)
    $result.Data["DriftedEnvKeys"]             = @($drift.Details.DriftedEnvKeys)
    $result.Data["MissingPermissions"]         = @($drift.Details.MissingPermissions)
    $result.Data["DeprecatedEnvKeys"]          = @($drift.Details.DeprecatedEnvKeys)
    $result.Data["MissingLanguage"]            = [bool]$drift.Details.MissingLanguage
    $result.Data["MissingAlwaysThinkingEnabled"] = [bool]$drift.Details.MissingAlwaysThinkingEnabled
    $result.Data["MissingPlansDirectory"]      = [bool]$drift.Details.MissingPlansDirectory

    if (-not $drift.NeedsInstallCompletion) {
        $result.IsInstalled = $true
        $result.Message = if ($drift.NeedsUpdateAlignment) {
            "Claude Code 常用配置已安装（检测到可对齐漂移）"
        } else {
            "Claude Code 常用配置已安装"
        }
        return $result
    }

    $issues = [System.Collections.ArrayList]::new()
    if (@($drift.Details.MissingEnvKeys).Count -gt 0) {
        [void]$issues.Add("env 缺少: $(@($drift.Details.MissingEnvKeys) -join ', ')")
    }
    if (@($drift.Details.MissingPermissions).Count -gt 0) {
        [void]$issues.Add("permissions.allow 缺少: $(@($drift.Details.MissingPermissions).Count) 项")
    }
    if ($drift.Details.MissingLanguage) {
        [void]$issues.Add("language 配置缺失")
    }
    if ($drift.Details.MissingAlwaysThinkingEnabled) {
        [void]$issues.Add("alwaysThinkingEnabled 配置缺失")
    }
    if ($drift.Details.MissingPlansDirectory) {
        [void]$issues.Add("plansDirectory 配置缺失")
    }
    $result.Message = if ($issues.Count -gt 0) {
        "Claude Code 常用配置不完整: $(@($issues) -join '; ')"
    } else {
        "Claude Code 常用配置未完成安装"
    }

    return $result
}

function Install-ClaudeConfig {
    <#
    .SYNOPSIS
    写入 Claude Code 常用配置（读取 -> 补缺失 -> 原子写入）
    .DESCRIPTION
    仅管理 ClaudeConfig 自有字段，不覆盖 ApiKey（供应商配置）、Ccline（statusLine）或用户自定义配置
    .RETURNS
    包含 Success 字段的结果对象
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
        UpdatedItems = @()
    }

    try {
        Write-UiPrimary "配置 Claude Code 常用设置..." -Level Detail

        $settingsPath = Get-ClaudeSettingsPath
        $settings = @{}
        $updatedItems = [System.Collections.ArrayList]::new()

        if (Test-Path $settingsPath) {
            try {
                $existingContent = Get-Content $settingsPath -Raw
                $settings = $existingContent | ConvertFrom-Json -AsHashtable -ErrorAction SilentlyContinue
                if (-not $settings) { $settings = @{} }
                Write-UiInfo "已读取现有配置，将按缺失项补全" -Level Detail
            }
            catch {
                throw "无法解析现有 settings.json，已停止写入以避免覆盖用户配置: $($_.Exception.Message)"
            }
        }

        # 确保 env 节存在
        if (-not $settings.ContainsKey("env")) {
            $settings["env"] = @{}
            [void]$updatedItems.Add("config::env::section-added")
        }

        # 补齐 ClaudeConfig 管辖的 env 键（仅缺失时写入）
        foreach ($entry in $script:ClaudeConfigEnvDefaults.GetEnumerator()) {
            if (-not $settings["env"].ContainsKey($entry.Key)) {
                $settings["env"][$entry.Key] = $entry.Value
                [void]$updatedItems.Add("config::env.$($entry.Key)::added")
            } elseif ([string]::IsNullOrWhiteSpace([string]$settings["env"][$entry.Key])) {
                $settings["env"][$entry.Key] = $entry.Value
                [void]$updatedItems.Add("config::env.$($entry.Key)::filled")
            }
        }

        # 顶层配置：按 contracts 仅补缺失，不触碰 DoNotManageTopLevelKeys
        Set-ClaudeConfigTopLevelDefaults -Settings $settings -UpdatedItems $updatedItems

        # 模型设置：不自动填充，由用户自行选择

        # 权限配置：保留用户已有项，补齐基础权限，保留 deny
        if (-not $settings.ContainsKey("permissions") -or -not $settings["permissions"]) {
            $settings["permissions"] = @{}
            [void]$updatedItems.Add("config::permissions::section-added")
        }
        if (-not $settings["permissions"].ContainsKey("allow") -or -not $settings["permissions"]["allow"]) {
            $settings["permissions"]["allow"] = @()
            [void]$updatedItems.Add("config::permissions.allow::section-added")
        }
        if (-not $settings["permissions"].ContainsKey("deny") -or $null -eq $settings["permissions"]["deny"]) {
            $settings["permissions"]["deny"] = @()
        }

        $allowList = [System.Collections.ArrayList]::new()
        foreach ($perm in @($settings["permissions"]["allow"])) {
            if (-not [string]::IsNullOrWhiteSpace([string]$perm) -and ($allowList -notcontains [string]$perm)) {
                [void]$allowList.Add([string]$perm)
            }
        }
        foreach ($perm in $script:ClaudeConfigBasePermissions) {
            if ($allowList -notcontains $perm) {
                [void]$allowList.Add($perm)
                [void]$updatedItems.Add("config::permissions.allow.$perm::added")
            }
        }
        $settings["permissions"]["allow"] = @($allowList)

        # 归因配置（仅缺失时填充）
        if (-not $settings.ContainsKey("attribution") -or -not $settings["attribution"]) {
            $settings["attribution"] = @{
                "commit" = ""
                "pr"     = ""
            }
            [void]$updatedItems.Add("config::attribution::added")
        }

        # 确保目录存在
        $settingsDir = Split-Path $settingsPath -Parent
        if (-not (Test-Path $settingsDir)) {
            New-Item -ItemType Directory -Path $settingsDir -Force | Out-Null
        }

        # 原子写入
        $tempPath = "$settingsPath.tmp"
        $settings | ConvertTo-Json -Depth 10 | Set-Content $tempPath -Encoding UTF8
        Move-Item $tempPath $settingsPath -Force

        Write-UiSuccess "✓ Claude Code 常用配置已写入 ~/.claude/settings.json" -Level Detail
        Write-UiInfo "配置路径: $settingsPath" -Level Detail
        Write-UiInfo "配置摘要:" -Level Detail
        Write-UiInfo "  - 语言: $($settings['language'])" -Level Detail
        Write-UiInfo "  - 默认模型: $($settings['model'])" -Level Detail
        Write-UiInfo "  - 权限项: $($settings['permissions']['allow'].Count) 项" -Level Detail
        Write-UiInfo "  - 环境变量: $($script:ClaudeConfigEnvDefaults.Count) 项" -Level Detail

        # 注册 ccq 快捷函数到 PowerShell Profile
        $ccqRegistered = Register-CcqShortcut
        if ($ccqRegistered) {
            [void]$updatedItems.Add("profile::ccq-function::registered")
        }

        if ($updatedItems.Count -eq 0) {
            $result.UpdatedItems = @("noop::ClaudeConfig::no-change")
        } else {
            $result.UpdatedItems = @($updatedItems)
        }
        $result.Data["UpdatedItems"] = @($result.UpdatedItems)
        $result.Success = $true
    }
    catch {
        $result.ErrorMessage = "配置 Claude Code 常用配置失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

function Verify-ClaudeConfig {
    <#
    .SYNOPSIS
    验证 ClaudeConfig 自有字段（不验证 ApiKey 的 ANTHROPIC_AUTH_TOKEN）
    .RETURNS
    包含 Success 字段的结果对象
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
    }

    try {
        $settingsPath = Get-ClaudeSettingsPath
        if (-not (Test-Path $settingsPath)) {
            throw "settings.json 文件不存在"
        }

        $settings = Get-Content $settingsPath -Raw | ConvertFrom-Json

        # 验证 language / thinking 顶层配置
        if (-not ($settings.PSObject.Properties.Name -contains "language") -or
            [string]::IsNullOrWhiteSpace([string]$settings.language)) {
            throw "language 配置缺失"
        }
        if (-not ($settings.PSObject.Properties.Name -contains "alwaysThinkingEnabled")) {
            throw "alwaysThinkingEnabled 配置缺失"
        }
        if ($settings.alwaysThinkingEnabled -isnot [bool]) {
            throw "alwaysThinkingEnabled 必须为布尔值，当前值: $($settings.alwaysThinkingEnabled)"
        }
        if (-not ($settings.PSObject.Properties.Name -contains "plansDirectory") -or
            [string]::IsNullOrWhiteSpace([string]$settings.plansDirectory)) {
            throw "plansDirectory 配置缺失"
        }

        # plansDirectory 的精确值对齐由 Update-ClaudeConfig 负责

        # 验证 permissions.allow 存在且包含基础权限
        if (-not $settings.permissions -or
            -not ($settings.permissions.PSObject.Properties.Name -contains "allow") -or
            -not ($settings.permissions.allow -is [System.Array])) {
            throw "permissions.allow 配置缺失"
        }

        $missingPerms = @()
        foreach ($perm in $script:ClaudeConfigBasePermissions) {
            if ($settings.permissions.allow -notcontains $perm) {
                $missingPerms += $perm
            }
        }
        if ($missingPerms.Count -gt 0) {
            throw "permissions.allow 缺少: $($missingPerms -join ', ')"
        }

        # 验证 ClaudeConfig 管辖 env 键已存在
        if (-not $settings.env) {
            throw "env 配置缺失"
        }
        $missingEnvKeys = @()
        foreach ($key in $script:ClaudeConfigEnvDefaults.Keys) {
            if (-not ($settings.env.PSObject.Properties.Name -contains $key) -or
                [string]::IsNullOrWhiteSpace([string]$settings.env.$key)) {
                $missingEnvKeys += $key
            }
        }
        if ($missingEnvKeys.Count -gt 0) {
            throw "env 缺少: $($missingEnvKeys -join ', ')"
        }

        Write-UiSuccess "✓ Claude Code 常用配置验证通过" -Level Detail
        Write-UiInfo "  - language: $($settings.language)" -Level Detail
        Write-UiInfo "  - alwaysThinkingEnabled: $($settings.alwaysThinkingEnabled)" -Level Detail
        Write-UiInfo "  - permissions.allow: $($settings.permissions.allow.Count) 项" -Level Detail
        Write-UiInfo "  - env: $($script:ClaudeConfigEnvDefaults.Count) 项" -Level Detail

        $result.Success = $true
    }
    catch {
        $result.ErrorMessage = "验证 Claude Code 常用配置失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

function Get-ClaudeConfigDriftScriptPath {
    <#
    .SYNOPSIS
    返回 claude-config-drift.js 脚本路径
    #>
    $contractsRoot = Get-ClaudeConfigContractsRoot
    if ([string]::IsNullOrWhiteSpace($contractsRoot)) {
        return ""
    }
    return Join-Path $contractsRoot "scripts\claude-config-drift.js"
}

function Invoke-ClaudeConfigDriftScript {
    <#
    .SYNOPSIS
    调用 claude-config-drift.js 脚本
    .PARAMETER Mode
    analyze / install / update
    .RETURNS
    PSCustomObject (已解析的 JSON)
    #>
    param(
        [Parameter(Mandatory=$true)]
        [ValidateSet("analyze", "install", "update")]
        [string]$Mode
    )

    $scriptPath = Get-ClaudeConfigDriftScriptPath
    if ([string]::IsNullOrWhiteSpace($scriptPath) -or -not (Test-Path $scriptPath)) {
        throw "claude-config-drift.js 脚本不存在: $scriptPath"
    }

    $contractPath = Get-ClaudeConfigContractPath
    if ([string]::IsNullOrWhiteSpace($contractPath) -or -not (Test-Path $contractPath)) {
        throw "ClaudeConfig 契约不存在: $contractPath"
    }

    $settingsPath = Get-ClaudeSettingsPath

    # 检测 node 可用性
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $nodeCmd) {
        throw "node 不可用，无法执行 claude-config-drift.js"
    }

    # 调用脚本
    $args = @(
        "`"$scriptPath`""
        "--contract-path `"$contractPath`""
        "--settings-path `"$settingsPath`""
        "--mode $Mode"
    )
    $output = & node $scriptPath --contract-path $contractPath --settings-path $settingsPath --mode $Mode 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "claude-config-drift.js 执行失败 (exit $LASTEXITCODE): $output"
    }

    # 解析 JSON
    try {
        return ($output | ConvertFrom-Json -AsHashtable)
    } catch {
        throw "claude-config-drift.js 输出无法解析为 JSON: $output"
    }
}

function Update-ClaudeConfig {
    <#
    .SYNOPSIS
    声明式对齐 ClaudeConfig 管辖的 env 键到最新默认值
    .DESCRIPTION
    优先使用 claude-config-drift.js (需要 node)，失败时回退到 PowerShell 实现。
    与 Install 的"仅补缺失"策略不同，Update 使用"声明式对齐"：
    - 白名单键：强制覆盖为最新值
    - 废弃键：从 env 中删除
    - 其他键：完全不触碰
    .RETURNS
    @{ Success; ErrorMessage; Data; UpdatedItems }
    #>

    $result = @{
        Success      = $false
        ErrorMessage = ""
        Data         = @{}
        UpdatedItems = @()
    }

    # 尝试使用 node 脚本（仅 Update/Manage 路径）
    try {
        $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
        $scriptPath = Get-ClaudeConfigDriftScriptPath

        if ($nodeCmd -and -not [string]::IsNullOrWhiteSpace($scriptPath) -and (Test-Path $scriptPath)) {
            Write-UiDim "使用 claude-config-drift.js 执行更新..." -Level Debug

            $driftResult = Invoke-ClaudeConfigDriftScript -Mode "update"

            if ($driftResult -and $driftResult.ContainsKey("applied")) {
                $applied = $driftResult["applied"]
                $newSettings = $applied["newSettings"]
                $updatedItems = $applied["updatedItems"]

                # 原子写入
                $settingsPath = Get-ClaudeSettingsPath
                $tempPath = "$settingsPath.tmp_$([guid]::NewGuid().ToString('N').Substring(0,8))"
                $newSettings | ConvertTo-Json -Depth 10 | Set-Content $tempPath -Encoding UTF8

                for ($retry = 0; $retry -lt 3; $retry++) {
                    try {
                        Move-Item $tempPath $settingsPath -Force
                        break
                    } catch {
                        if ($retry -eq 2) { throw }
                        Start-Sleep -Seconds ([math]::Pow(2, $retry))
                    }
                }

                if ($updatedItems -and $updatedItems.Count -gt 0 -and $updatedItems[0] -ne "noop::ClaudeConfig::no-change") {
                    $result.UpdatedItems = @($updatedItems)
                    Write-UiSuccess "✓ ClaudeConfig 已更新 ($($updatedItems.Count) 项变更)" -Level Detail
                } else {
                    $result.UpdatedItems = @("noop::ClaudeConfig::no-change")
                    Write-UiDim "ClaudeConfig 已是最新，无需更新" -Level Debug
                }

                $result.Success = $true
                return $result
            }
        }
    } catch {
        Write-UiWarning "node 脚本执行失败，回退到 PowerShell 实现: $($_.Exception.Message)" -Level Debug
    }

    # Fallback：PowerShell 原生实现
    Write-UiDim "使用 PowerShell 原生实现执行更新..." -Level Debug

    # 禁区键集合
    $forbiddenKeys = @("ANTHROPIC_AUTH_TOKEN")
    $forbiddenPattern = ".*_API_KEY$"

    try {
        $settingsPath = Get-ClaudeSettingsPath
        if (-not (Test-Path $settingsPath)) {
            throw "settings.json 不存在，请先执行安装"
        }

        $settingsRaw = Get-Content $settingsPath -Raw
        $settings = $settingsRaw | ConvertFrom-Json -AsHashtable -ErrorAction Stop
        if (-not $settings) { throw "settings.json 无法解析" }

        $updatedItems = [System.Collections.ArrayList]::new()

        # 确保 env 节存在
        if (-not $settings.ContainsKey("env")) {
            $settings["env"] = @{}
        }

        # 声明式对齐：白名单键强制覆盖
        foreach ($entry in $script:ClaudeConfigEnvDefaults.GetEnumerator()) {
            $key = $entry.Key

            # 禁区检查（区分大小写）
            if ($key -cin $forbiddenKeys -or $key -cmatch $forbiddenPattern) {
                continue
            }

            if (-not $settings["env"].ContainsKey($key)) {
                $settings["env"][$key] = $entry.Value
                [void]$updatedItems.Add("config::env.${key}::added")
            } elseif ($settings["env"][$key] -cne $entry.Value) {
                $oldVal = $settings["env"][$key]
                $settings["env"][$key] = $entry.Value
                [void]$updatedItems.Add("config::env.${key}::${oldVal}->$($entry.Value)")
            }
        }

        # 废弃键删除
        foreach ($depKey in $script:ClaudeConfigDeprecatedEnvKeys) {
            if ($depKey -cin $forbiddenKeys -or $depKey -cmatch $forbiddenPattern) {
                continue
            }
            if ($settings["env"].ContainsKey($depKey)) {
                $settings["env"].Remove($depKey)
                [void]$updatedItems.Add("config::env.${depKey}::removed")
            }
        }

        # permissions.allow：仅追加缺失项
        if (-not $settings.ContainsKey("permissions") -or -not $settings["permissions"]) {
            $settings["permissions"] = @{}
        }
        if (-not $settings["permissions"].ContainsKey("allow") -or -not $settings["permissions"]["allow"]) {
            $settings["permissions"]["allow"] = @()
        }

        $allowList = [System.Collections.ArrayList]::new()
        foreach ($perm in @($settings["permissions"]["allow"])) {
            if (-not [string]::IsNullOrWhiteSpace([string]$perm) -and ($allowList -notcontains [string]$perm)) {
                [void]$allowList.Add([string]$perm)
            }
        }
        foreach ($perm in $script:ClaudeConfigBasePermissions) {
            if ($allowList -notcontains $perm) {
                [void]$allowList.Add($perm)
                [void]$updatedItems.Add("config::permissions.allow.${perm}::added")
            }
        }
        $settings["permissions"]["allow"] = @($allowList)

        # 顶层配置：按 contracts 补缺失；Update 仅对 plansDirectory 做声明式对齐
        Set-ClaudeConfigTopLevelDefaults -Settings $settings -UpdatedItems $updatedItems -AlignPlansDirectory

        # 原子写入
        $tempPath = "$settingsPath.tmp_$([guid]::NewGuid().ToString('N').Substring(0,8))"
        $settings | ConvertTo-Json -Depth 10 | Set-Content $tempPath -Encoding UTF8
        for ($retry = 0; $retry -lt 3; $retry++) {
            try {
                Move-Item $tempPath $settingsPath -Force
                break
            } catch {
                if ($retry -eq 2) { throw }
                Start-Sleep -Seconds ([math]::Pow(2, $retry))
            }
        }

        # 结果
        if ($updatedItems.Count -eq 0) {
            $result.UpdatedItems = @("noop::ClaudeConfig::no-change")
            Write-UiDim "ClaudeConfig 已是最新，无需更新" -Level Debug
        } else {
            $result.UpdatedItems = @($updatedItems)
            Write-UiSuccess "✓ ClaudeConfig 已更新 ($($updatedItems.Count) 项变更)" -Level Detail
        }

        $result.Success = $true
    }
    catch {
        $result.ErrorMessage = "更新 ClaudeConfig 失败: $($_.Exception.Message)"
        Write-UiDanger $result.ErrorMessage
    }

    return $result
}

# 辅助函数：获取 Claude Code settings.json 路径（HC-12: ~/.claude/settings.json）
function Get-ClaudeSettingsPath {
    return "$(Get-UserHome)\.claude\settings.json"
}

# ─── CCQ 函数注册 ───────────────────────────────────────────────────────────

function Get-CcqFunctionTemplate {
    <#
    .SYNOPSIS
    读取 ccq 函数模板（优先从 contracts/templates，fallback 到内联）
    #>
    param()

    # 尝试从 contracts/templates 读取
    $contractsRoot = Get-ClaudeConfigContractsRoot
    if (-not [string]::IsNullOrWhiteSpace($contractsRoot)) {
        $templatePath = Join-Path $contractsRoot "templates\profile\ccq-function.ps1.txt"
        if (Test-Path $templatePath) {
            try {
                return Get-Content $templatePath -Raw -Encoding UTF8
            } catch {
                Write-Verbose "读取 ccq 函数模板失败: $($_.Exception.Message)"
            }
        }
    }

    # Fallback 到内联模板
    return @'
function ccq {
    <#
    .SYNOPSIS
    Claude Code Quickstart - 统一安装与管理面板入口

    .DESCRIPTION
    显示菜单供用户选择：
    [1] 安装面板 - 首次安装或重新安装
    [2] 管理面板 - Provider/Skills/Update/MCP 管理

    .EXAMPLE
    ccq
    显示菜单并等待用户选择
    #>

    Write-Host ""
    Write-Host "════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host " Claude Code Quickstart" -ForegroundColor White
    Write-Host "════════════════════════════════════════════" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  [1] 安装面板  - 首次安装或重新安装" -ForegroundColor Green
    Write-Host "  [2] 管理面板  - Provider/Skills/Update/MCP" -ForegroundColor Yellow
    Write-Host "  [Q] 退出" -ForegroundColor Gray
    Write-Host ""

    $choice = Read-Host "请选择"

    switch ($choice) {
        "1" {
            Write-Host ""
            Write-Host "正在启动安装面板..." -ForegroundColor Green
            $installUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.ps1"
            try {
                Invoke-RestMethod $installUrl | Invoke-Expression
            } catch {
                Write-Host "❌ 安装面板启动失败: $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "请检查网络连接后重试，或手动运行：" -ForegroundColor Yellow
                Write-Host "  irm $installUrl | iex" -ForegroundColor Gray
            }
        }
        "2" {
            Write-Host ""
            Write-Host "正在启动管理面板..." -ForegroundColor Yellow
            $manageUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.ps1"
            try {
                Invoke-RestMethod $manageUrl | Invoke-Expression
            } catch {
                Write-Host "❌ 管理面板启动失败: $($_.Exception.Message)" -ForegroundColor Red
                Write-Host "请检查网络连接后重试，或手动运行：" -ForegroundColor Yellow
                Write-Host "  irm $manageUrl | iex" -ForegroundColor Gray
            }
        }
        {$_ -in @("q", "Q")} {
            Write-Host ""
            Write-Host "再见！" -ForegroundColor Gray
            return
        }
        default {
            Write-Host ""
            Write-Host "无效选择，请重新运行 ccq" -ForegroundColor Red
        }
    }
}
'@
}

function Register-CcqShortcut {
    <#
    .SYNOPSIS
    在 PowerShell Profile 中注册 ccq 函数（使用 HC-4 标记块）
    #>
    param()

    try {
        $profilePath = Get-PowerShellProfilePath
        if ([string]::IsNullOrWhiteSpace($profilePath)) {
            throw "无法确定 PowerShell Profile 路径"
        }

        # 确保 Profile 目录存在
        $profileDir = Split-Path $profilePath -Parent
        if (-not (Test-Path $profileDir)) {
            New-Item -ItemType Directory -Path $profileDir -Force | Out-Null
        }

        # 读取 ccq 函数模板
        $ccqFunction = Get-CcqFunctionTemplate

        # 使用 Profile.ps1 的标记块写入函数
        Add-ManagedBlockToFile -FilePath $profilePath -Content $ccqFunction

        Write-UiSuccess "✓ ccq 快捷函数已注册到 PowerShell Profile" -Level Detail
        Write-UiInfo "Profile 路径: $profilePath" -Level Detail
        Write-UiInfo "使用方法: 在新终端中运行 'ccq' 打开菜单" -Level Detail

        return $true
    } catch {
        Write-UiWarning "注册 ccq 函数失败: $($_.Exception.Message)" -Level Detail
        return $false
    }
}

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用
