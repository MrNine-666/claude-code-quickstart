#Requires -Version 7.0
# Test-Contracts.ps1 - 跨平台契约一致性检查
# 功能: 验证 installer/contracts JSON 契约与 Windows/macOS canonical runtime 不冲突

param(
    [string]$InstallerRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Issues = [System.Collections.Generic.List[string]]::new()
$script:InstallerRoot = (Resolve-Path $InstallerRoot).Path
$script:RepoRoot = (Split-Path -Parent $script:InstallerRoot)
$script:WindowsRoot = Join-Path $script:InstallerRoot 'windows'
$script:CoreRoot = Join-Path $script:WindowsRoot 'core'
$script:StepsRoot = Join-Path $script:WindowsRoot 'steps'

function Read-ContractJson {
    param([Parameter(Mandatory)][string]$RelativePath)

    $path = Join-Path $PSScriptRoot $RelativePath
    if (-not (Test-Path $path -PathType Leaf)) {
        throw "契约文件不存在: $path"
    }

    return (Get-Content -Path $path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable -ErrorAction Stop)
}

function ConvertTo-PlainObject {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return $null
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $result = [ordered]@{}
        foreach ($key in @($Value.Keys | Sort-Object)) {
            $result[[string]$key] = ConvertTo-PlainObject $Value[$key]
        }
        return $result
    }

    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
        return @($Value | ForEach-Object { ConvertTo-PlainObject $_ })
    }

    return $Value
}

function ConvertTo-ComparableJson {
    param([AllowNull()][object]$Value)

    return (ConvertTo-PlainObject $Value | ConvertTo-Json -Depth 80 -Compress)
}

function Add-Issue {
    param([Parameter(Mandatory)][string]$Message)

    [void]$script:Issues.Add($Message)
}

function Assert-Equal {
    param(
        [Parameter(Mandatory)][string]$Name,
        [AllowNull()][object]$Expected,
        [AllowNull()][object]$Actual
    )

    $expectedJson = ConvertTo-ComparableJson $Expected
    $actualJson = ConvertTo-ComparableJson $Actual
    if ($expectedJson -ne $actualJson) {
        Add-Issue "$Name 不一致`n  Expected: $expectedJson`n  Actual:   $actualJson"
    }
}

function Assert-PathExists {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Path,
        [ValidateSet('Leaf', 'Container')]
        [string]$PathType = 'Leaf'
    )

    if (-not (Test-Path $Path -PathType $PathType)) {
        Add-Issue "$Name 不存在: $Path"
    }
}

function Assert-PathAbsent {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Path
    )

    if (Test-Path $Path) {
        Add-Issue "$Name 不应作为支持路径存在: $Path"
    }
}

function Invoke-ContractCheck {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$ScriptBlock
    )

    try {
        & $ScriptBlock
    } catch {
        Add-Issue "$Name 失败: $($_.Exception.Message)"
    }
}

function New-IndexByKey {
    param(
        [Parameter(Mandatory)][array]$Items,
        [Parameter(Mandatory)][string]$KeyName
    )

    $index = @{}
    foreach ($item in @($Items)) {
        if ($item -isnot [System.Collections.IDictionary] -or -not $item.ContainsKey($KeyName)) {
            Add-Issue "索引项缺少字段 ${KeyName}: $(ConvertTo-ComparableJson $item)"
            continue
        }
        $key = [string]$item[$KeyName]
        if ($index.ContainsKey($key)) {
            Add-Issue "索引字段 ${KeyName} 重复: $key"
            continue
        }
        $index[$key] = $item
    }
    return $index
}

function Select-HashtableFields {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Item,
        [Parameter(Mandatory)][string[]]$Fields
    )

    $result = [ordered]@{}
    foreach ($field in $Fields) {
        if ($Item.ContainsKey($field)) {
            $result[$field] = $Item[$field]
        }
    }
    return $result
}

function Test-StepsContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    $registry = @(Get-StepRegistry)
    $contractSteps = @($Contract['Steps'])

    Assert-Equal 'steps.count' $registry.Count $contractSteps.Count

    $registryIndex = New-IndexByKey -Items $registry -KeyName 'StepId'
    $contractIndex = New-IndexByKey -Items $contractSteps -KeyName 'StepId'

    $stepFields = @(
        'StepId', 'StepName', 'Description', 'StepFile', 'SubModules',
        'TestFunction', 'InstallFunction', 'VerifyFunction', 'UpdateFunction',
        'SkipIfInstalled', 'SkipIfInstalledWhenAutoAdded', 'IsOptional',
        'Order', 'Dependencies', 'Group'
    )

    foreach ($stepId in @($registryIndex.Keys | Sort-Object)) {
        if (-not $contractIndex.ContainsKey($stepId)) {
            Add-Issue "steps.$stepId 缺少 contracts 条目"
            continue
        }
        $expected = Select-HashtableFields -Item $registryIndex[$stepId] -Fields $stepFields
        $actual = Select-HashtableFields -Item $contractIndex[$stepId] -Fields $stepFields
        Assert-Equal "steps.$stepId" $expected $actual
    }

    foreach ($stepId in @($contractIndex.Keys | Sort-Object)) {
        if (-not $registryIndex.ContainsKey($stepId)) {
            Add-Issue "steps.$stepId 未在 Registry.ps1 中定义"
        }
    }

    foreach ($step in $contractSteps) {
        $stepId = [string]$step['StepId']
        $stepFile = [string]$step['StepFile']
        if ($stepFile -notmatch '^windows/steps/.+\.ps1$') {
            Add-Issue "steps.$stepId StepFile 必须指向 windows/steps/*.ps1，实际: $stepFile"
        } else {
            Assert-PathExists "steps.$stepId StepFile" (Join-Path $script:InstallerRoot $stepFile)
        }

        if ($step.ContainsKey('SubModules') -and $null -ne $step['SubModules']) {
            foreach ($subModule in @($step['SubModules'])) {
                $subPath = [string]$subModule
                if ([string]::IsNullOrWhiteSpace($subPath)) { continue }
                if ($subPath -notmatch '^windows/steps/.+\.ps1$') {
                    Add-Issue "steps.$stepId SubModules 必须指向 windows/steps/*.ps1，实际: $subPath"
                } else {
                    Assert-PathExists "steps.$stepId SubModule" (Join-Path $script:InstallerRoot $subPath)
                }
            }
        }

        $macOSStepFile = [string]$step['MacOSStepFile']
        if ([string]::IsNullOrWhiteSpace($macOSStepFile)) {
            Add-Issue "steps.$stepId 缺少 MacOSStepFile"
        } elseif ($macOSStepFile -notmatch '^macos/steps/.+\.zsh$') {
            Add-Issue "steps.$stepId MacOSStepFile 必须指向 macos/steps/*.zsh，实际: $macOSStepFile"
        } else {
            Assert-PathExists "steps.$stepId MacOSStepFile" (Join-Path $script:InstallerRoot $macOSStepFile)
        }
    }

    $groups = Get-StepGroups
    Assert-Equal 'groups.Basic.Label' $groups['Basic']['Label'] $Contract['Groups']['Basic']['Label']
    Assert-Equal 'groups.Basic.Description' $groups['Basic']['Description'] $Contract['Groups']['Basic']['Description']
    Assert-Equal 'groups.Basic.InstallMode' $groups['Basic']['InstallMode'] $Contract['Groups']['Basic']['InstallMode']
    Assert-Equal 'groups.Basic.StepIds' @($groups['Basic']['StepIds']) @($Contract['Groups']['Basic']['StepIds'])
    Assert-Equal 'groups.Advanced.Label' $groups['Advanced']['Label'] $Contract['Groups']['Advanced']['Label']
    Assert-Equal 'groups.Advanced.Description' $groups['Advanced']['Description'] $Contract['Groups']['Advanced']['Description']
    Assert-Equal 'groups.Advanced.InstallMode' $groups['Advanced']['InstallMode'] $Contract['Groups']['Advanced']['InstallMode']
    Assert-Equal 'groups.Advanced.StepIds' @($groups['Advanced']['StepIds']) @($Contract['Groups']['Advanced']['StepIds'])

    Assert-Equal 'directory.installer-root' 'installer' $Contract['DirectoryPolicy']['InstallerRoot']
    Assert-Equal 'directory.must-not-rename' 'src' $Contract['DirectoryPolicy']['MustNotRenameTo']
    Assert-Equal 'directory.runtime-core.windows' 'installer/windows/core' $Contract['DirectoryPolicy']['RuntimeCoreDirectories']['Windows']
    Assert-Equal 'directory.runtime-core.macos' 'installer/macos/core' $Contract['DirectoryPolicy']['RuntimeCoreDirectories']['MacOS']
}

function Test-ProvidersContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    $managedEnv = $Contract['ManagedEnv']
    Assert-Equal 'providers.model-env-keys' @($script:ProviderManagedModelEnvKeys) @($managedEnv['ProviderManagedModelEnvKeys'])
    Assert-Equal 'providers.model-env-labels' $script:ProviderModelEnvLabels $managedEnv['ProviderModelEnvLabels']
    Assert-Equal 'providers.extra-env-keys' @($script:ProviderManagedExtraEnvKeys) @($managedEnv['ProviderManagedExtraEnvKeys'])
    Assert-Equal 'providers.legacy-model-key' $script:LegacyProviderModelKey $managedEnv['LegacyProviderModelKey']

    $providerFields = @(
        'Name', 'Description', 'BaseUrl', 'PlatformUrl',
        'ModelEnv', 'ExtraEnv', 'RequireModelConfig'
    )
    $contractProviders = $Contract['BuiltinProviders']
    Assert-Equal 'providers.keys' @($script:BuiltinProviders.Keys | Sort-Object) @($contractProviders.Keys | Sort-Object)

    foreach ($key in @($script:BuiltinProviders.Keys | Sort-Object)) {
        if (-not $contractProviders.ContainsKey($key)) {
            Add-Issue "providers.$key 缺少 contracts 条目"
            continue
        }
        $expected = Select-HashtableFields -Item $script:BuiltinProviders[$key] -Fields $providerFields
        $actual = Select-HashtableFields -Item $contractProviders[$key] -Fields $providerFields
        Assert-Equal "providers.$key" $expected $actual
    }

    Invoke-ContractCheck 'providers.fallback' {
        Assert-ProviderFallbackConsistency -ContractConfig (ConvertTo-ProviderRuntimeConfig -Contract $Contract)
    }
}

function Resolve-McpServerComparable {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Server)

    $fields = @(
        'Name', 'Description', 'McpType', 'Command', 'Args', 'CredentialType',
        'Url', 'UrlTemplate', 'Credentials', 'ApiKeyName', 'ApiKeyUrl',
        'ArgsCredentials', 'TokenArg', 'TokenLabel', 'TokenUrl', 'Note',
        'Category', 'Priority', 'Recommended'
    )
    $result = Select-HashtableFields -Item $Server -Fields $fields
    if ($Server.ContainsKey('RuntimeDeps')) {
        if ((ConvertTo-ComparableJson $Server['RuntimeDeps']) -eq (ConvertTo-ComparableJson $script:DefaultMcpRuntimeDeps)) {
            $result['RuntimeDepsRef'] = 'DefaultMcpRuntimeDeps'
        } else {
            $result['RuntimeDeps'] = $Server['RuntimeDeps']
        }
    }
    return $result
}

function Test-McpContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    # 契约即真理:直接从契约读取期望值,不依赖已删除的 McpManager.ps1 脚本级常量
    $mcpMeta = $Contract['McpMeta']
    $contractServers = $Contract['McpServers']
    $contractCategories = $Contract['McpRulesCategories']
    $contractRuntimeDeps = $Contract['DefaultMcpRuntimeDeps']

    # 验证 McpMeta 结构完整性
    if (-not $mcpMeta) {
        Add-Issue "mcp-servers.json: 缺少 McpMeta 节"
        return
    }
    if (-not $mcpMeta.ContainsKey('FileName') -or [string]::IsNullOrWhiteSpace($mcpMeta['FileName'])) {
        Add-Issue "mcp.meta.file-name: 未定义"
    }
    if (-not $mcpMeta.ContainsKey('SchemaVersion') -or $mcpMeta['SchemaVersion'] -lt 1) {
        Add-Issue "mcp.meta.schema-version: 无效值"
    }

    # 验证 DefaultMcpRuntimeDeps
    if (-not $contractRuntimeDeps -or $contractRuntimeDeps.Count -eq 0) {
        Add-Issue "mcp.runtime-deps: 未定义"
    }

    # 验证 McpServers
    if (-not $contractServers -or $contractServers.Count -eq 0) {
        Add-Issue "mcp.servers: 未定义"
        return
    }

    # 验证 McpRulesCategories
    if (-not $contractCategories -or $contractCategories.Count -eq 0) {
        Add-Issue "mcp.rules: 未定义"
        return
    }
}

function Test-ClaudeConfigContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    Assert-Equal 'claude-config.env-defaults' $script:ClaudeConfigEnvDefaults $Contract['ClaudeConfigEnvDefaults']
    Assert-Equal 'claude-config.deprecated-env-keys' @($script:ClaudeConfigDeprecatedEnvKeys) @($Contract['ClaudeConfigDeprecatedEnvKeys'])
    Assert-Equal 'claude-config.base-permissions' @($script:ClaudeConfigBasePermissions) @($Contract['ClaudeConfigBasePermissions'])
    Assert-Equal 'claude-config.language' '简体中文' $Contract['TopLevelDefaults']['language']
    Assert-Equal 'claude-config.always-thinking' $true $Contract['TopLevelDefaults']['alwaysThinkingEnabled']
    Assert-Equal 'claude-config.plans-directory' '.claude/plan' $Contract['TopLevelDefaults']['plansDirectory']

    Invoke-ContractCheck 'claude-config.fallback' {
        Assert-ClaudeConfigFallbackConsistency -ContractConfig (ConvertTo-ClaudeConfigRuntimeConfig -Contract $Contract)
    }
}

function Test-TemplatesContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    $templateIds = @($Contract['Templates'] | ForEach-Object { [string]$_['Id'] })
    foreach ($requiredId in @(
        'claude-md.global.windows',
        'claude-md.global.macos',
        'mcp-rules.search',
        'mcp-rules.documentation',
        'mcp-rules.development'
    )) {
        if ($templateIds -notcontains $requiredId) {
            Add-Issue "templates 缺少条目: $requiredId"
        }
    }

    foreach ($template in @($Contract['Templates'])) {
        $id = [string]$template['Id']
        $source = [string]$template['Source']
        if ($source -match '^installer/(core|steps)/') {
            Add-Issue "templates.$id Source 仍引用旧 Windows 路径: $source"
            continue
        }
        if ($source -match '^installer/windows/' -or $source -match '^installer/macos/') {
            Assert-PathExists "templates.$id Source" (Join-Path $script:RepoRoot $source)
        }
    }
}

function Get-MapValue {
    param(
        [Parameter(Mandatory)][System.Collections.IDictionary]$Item,
        [Parameter(Mandatory)][string]$Key,
        [AllowNull()][object]$DefaultValue = $null
    )

    $hasKey = if ($Item -is [hashtable]) { $Item.ContainsKey($Key) } else { $Item.Contains($Key) }
    if ($hasKey -and $null -ne $Item[$Key]) {
        return $Item[$Key]
    }
    return $DefaultValue
}

function ConvertTo-NormalizedSkillsEntry {
    param([Parameter(Mandatory)][System.Collections.IDictionary]$Entry)

    return [ordered]@{
        Id              = [string](Get-MapValue -Item $Entry -Key 'Id' -DefaultValue '')
        Name            = [string](Get-MapValue -Item $Entry -Key 'Name' -DefaultValue '')
        Source          = [string](Get-MapValue -Item $Entry -Key 'Source' -DefaultValue '')
        SkillName       = [string](Get-MapValue -Item $Entry -Key 'SkillName' -DefaultValue '')
        StaticSkillName = [string](Get-MapValue -Item $Entry -Key 'StaticSkillName' -DefaultValue '')
        SkipDiscovery   = [bool](Get-MapValue -Item $Entry -Key 'SkipDiscovery' -DefaultValue $false)
        Description     = [string](Get-MapValue -Item $Entry -Key 'Description' -DefaultValue '')
        Default         = [bool](Get-MapValue -Item $Entry -Key 'Default' -DefaultValue $false)
        Order           = [int](Get-MapValue -Item $Entry -Key 'Order' -DefaultValue 9999)
    }
}

function ConvertTo-NormalizedSkillsCatalogue {
    param([Parameter(Mandatory)][array]$Catalogue)

    return @($Catalogue | ForEach-Object { ConvertTo-NormalizedSkillsEntry -Entry $_ } | Sort-Object { [int]$_['Order'] })
}

function Get-MacOSSkillsContent {
    $skillsPath = Join-Path $script:InstallerRoot 'macos/steps/Skills.zsh'
    Assert-PathExists 'macos.skills' $skillsPath
    if (-not (Test-Path $skillsPath -PathType Leaf)) { return '' }
    return (Get-Content -Path $skillsPath -Raw -Encoding UTF8)
}

function ConvertFrom-MacOSSkillsFallback {
    $content = Get-MacOSSkillsContent
    if ([string]::IsNullOrWhiteSpace($content)) { return @() }

    $match = [regex]::Match($content, "(?ms)ccq_skills_catalogue_fallback\(\)\s*\{.*?cat <<'EOF'\r?\n(?<Body>.*?)\r?\nEOF")
    if (-not $match.Success) {
        Add-Issue 'macos.skills fallback catalogue 未找到 ccq_skills_catalogue_fallback here-doc'
        return @()
    }

    $items = @()
    foreach ($line in @($match.Groups['Body'].Value -split "\r?\n")) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $parts = @($line -split "`t")
        if ($parts.Count -lt 9) {
            Add-Issue "macos.skills fallback 行字段不足: $line"
            continue
        }
        $items += [ordered]@{
            Id              = [string]$parts[0]
            Name            = [string]$parts[1]
            Source          = [string]$parts[2]
            SkillName       = [string]$parts[3]
            Description     = [string]$parts[4]
            Default         = ([string]$parts[5] -eq 'true')
            StaticSkillName = [string]$parts[6]
            SkipDiscovery   = ([string]$parts[7] -eq 'true')
            Order           = [int]$parts[8]
        }
    }
    return @($items)
}

function ConvertFrom-MacOSSkillsIgnoredNamesFallback {
    $content = Get-MacOSSkillsContent
    if ([string]::IsNullOrWhiteSpace($content)) { return @() }

    $match = [regex]::Match($content, "(?ms)ccq_skills_ignored_names_fallback\(\)\s*\{.*?cat <<'EOF'\r?\n(?<Body>.*?)\r?\nEOF")
    if (-not $match.Success) {
        Add-Issue 'macos.skills ignored names fallback 未找到 ccq_skills_ignored_names_fallback here-doc'
        return @()
    }

    return @($match.Groups['Body'].Value -split "\r?\n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | ForEach-Object { [string]$_.Trim() })
}

function Test-SkillsContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    Assert-Equal 'skills.schema-version' 1 $Contract['SchemaVersion']

    if (-not $Contract.ContainsKey('IgnoredSkillNames')) {
        Add-Issue 'skills.IgnoredSkillNames 缺失'
    } else {
        $ignoredNames = @($Contract['IgnoredSkillNames'] | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        if ($ignoredNames.Count -eq 0) {
            Add-Issue 'skills.IgnoredSkillNames 不能为空'
        }
        Assert-Equal 'skills.windows-ignored-names-fallback' @($script:SkillsIgnoredNames) $ignoredNames
        Assert-Equal 'skills.macos-ignored-names-fallback' $ignoredNames @(ConvertFrom-MacOSSkillsIgnoredNamesFallback)
    }

    $catalogue = @(ConvertTo-NormalizedSkillsCatalogue -Catalogue @($Contract['Catalogue']))
    if ($catalogue.Count -eq 0) {
        Add-Issue 'skills.catalogue 不能为空'
        return
    }

    $seenIds = @{}
    $seenOrders = @{}
    foreach ($entry in $catalogue) {
        $id = [string]$entry['Id']
        if ([string]::IsNullOrWhiteSpace($id) -or $id -notmatch '^[a-z0-9-]+$') {
            Add-Issue "skills.$id Id 不合法"
        }
        if ($seenIds.ContainsKey($id)) {
            Add-Issue "skills.$id Id 重复"
        }
        $seenIds[$id] = $true

        $order = [string]$entry['Order']
        if ($seenOrders.ContainsKey($order)) {
            Add-Issue "skills.$id Order 重复: $order"
        }
        $seenOrders[$order] = $true

        foreach ($field in @('Name', 'Source', 'Description')) {
            if ([string]::IsNullOrWhiteSpace([string]$entry[$field])) {
                Add-Issue "skills.$id $field 不能为空"
            }
        }
        if ([bool]$entry['SkipDiscovery'] -and [string]::IsNullOrWhiteSpace([string]$entry['StaticSkillName']) -and [string]::IsNullOrWhiteSpace([string]$entry['SkillName'])) {
            Add-Issue "skills.$id SkipDiscovery=true 时必须提供 StaticSkillName 或 SkillName"
        }
    }

    $windowsFallback = @(ConvertTo-NormalizedSkillsCatalogue -Catalogue @($script:SkillsCatalogueFallback))
    Assert-Equal 'skills.windows-fallback' $catalogue $windowsFallback

    $macOSFallback = @(ConvertTo-NormalizedSkillsCatalogue -Catalogue @(ConvertFrom-MacOSSkillsFallback))
    Assert-Equal 'skills.macos-fallback' $catalogue $macOSFallback
}

function Test-UiContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    Assert-Equal 'ui.schema-version' 1 $Contract['SchemaVersion']
    $menus = $Contract['Menus']
    if (-not $menus.ContainsKey('AdvancedSelect')) {
        Add-Issue 'ui.Menus 缺少 AdvancedSelect'
        return
    }

    $advanced = $menus['AdvancedSelect']
    Assert-Equal 'ui.advanced.installed-badge' '【已安装】' $advanced['InstalledBadgeInSelectMenu']
    Assert-Equal 'ui.advanced.uninstalled-badge' '【未安装】' $advanced['UninstalledBadgeInSelectMenu']
    Assert-Equal 'ui.advanced.forbidden-badges' @('[PASS]', '[    ]') @($advanced['ForbiddenLegacyBadges'])

    if (-not $menus.ContainsKey('Skills')) {
        Add-Issue 'ui.Menus 缺少 Skills'
    } else {
        $copyOptions = @($menus['Skills']['CopyModeOptions'])
        Assert-Equal 'ui.skills.copy-options.count' 2 $copyOptions.Count
    }

    foreach ($relativePath in @('windows/Install.ps1', 'macos/Install.zsh')) {
        $path = Join-Path $script:InstallerRoot $relativePath
        Assert-PathExists "ui.$relativePath" $path
        if (-not (Test-Path $path -PathType Leaf)) { continue }
        $content = Get-Content -Path $path -Raw -Encoding UTF8
        if ($content -notmatch '【已安装】' -or $content -notmatch '【未安装】') {
            Add-Issue "ui.$relativePath Advanced Select 未使用中文状态徽标"
        }
        if ($content -match '\[\s{4}\]' -or $content -match '\[PASS\]') {
            Add-Issue "ui.$relativePath Advanced Select 仍包含旧式选择菜单徽标"
        }
    }
}

function Test-BuildManifestContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    Assert-Equal 'build.default-output-directory' 'dist' $Contract['DefaultOutputDirectory']

    $windowsArtifacts = @($Contract['Windows']['Artifacts'])
    $macOSArtifacts = @($Contract['MacOS']['Artifacts'])
    $windowsOutputs = @($windowsArtifacts | ForEach-Object { [string]$_['OutputFile'] })
    $macOSOutputs = @($macOSArtifacts | ForEach-Object { [string]$_['OutputFile'] })
    $allOutputs = @($windowsOutputs + $macOSOutputs)

    Assert-Equal 'build.windows.outputs' @('bootstrap.ps1', 'install.ps1', 'manage.ps1') $windowsOutputs
    Assert-Equal 'build.macos.outputs' @('install.sh', 'manage.sh') $macOSOutputs
    Assert-Equal 'build.release.outputs' @('bootstrap.ps1', 'install.ps1', 'manage.ps1', 'install.sh', 'manage.sh') $allOutputs

    $entrypoints = $Contract['BuildEntrypoints']
    Assert-Equal 'build.entrypoints.windows.script' 'installer/build.ps1' $entrypoints['Windows']['Script']
    Assert-Equal 'build.entrypoints.windows.allowed' @('Windows') @($entrypoints['Windows']['AllowedPlatforms'])
    Assert-Equal 'build.entrypoints.windows.artifacts' @('bootstrap.ps1', 'install.ps1', 'manage.ps1') @($entrypoints['Windows']['Artifacts'])
    Assert-Equal 'build.entrypoints.macos.script' 'installer/build.sh' $entrypoints['MacOS']['Script']
    Assert-Equal 'build.entrypoints.macos.allowed' @('macos') @($entrypoints['MacOS']['AllowedPlatforms'])
    Assert-Equal 'build.entrypoints.macos.artifacts' @('install.sh', 'manage.sh') @($entrypoints['MacOS']['Artifacts'])
    Assert-Equal 'build.entrypoints.release-artifacts' $allOutputs @($entrypoints['ReleaseArtifacts'])

    foreach ($output in $allOutputs) {
        if ($output -in @('ccq.ps1', 'ccq.sh') -or $output -match '^ccq-' -or $output -match '\.built\.') {
            Add-Issue "build artifact 名称不应使用旧支持形态: $output"
        }
    }

    foreach ($artifact in $windowsArtifacts) {
        $role = [string]$artifact['Role']
        $entryFile = [string]$artifact['EntryFile']
        if ($entryFile -notmatch '^windows/.+\.ps1$') {
            Add-Issue "build.Windows.$role EntryFile 必须指向 windows/*.ps1，实际: $entryFile"
        } else {
            Assert-PathExists "build.Windows.$role EntryFile" (Join-Path $script:InstallerRoot $entryFile)
        }
        foreach ($coreFile in @($artifact['CoreFiles'])) {
            $corePath = [string]$coreFile
            if ($corePath -notmatch '^windows/core/.+\.ps1$') {
                Add-Issue "build.Windows.$role CoreFiles 必须指向 windows/core/*.ps1，实际: $corePath"
            } else {
                Assert-PathExists "build.Windows.$role CoreFile" (Join-Path $script:InstallerRoot $corePath)
            }
        }
    }

    foreach ($artifact in $macOSArtifacts) {
        $role = [string]$artifact['Role']
        $entryFile = [string]$artifact['EntryFile']
        if ($entryFile -notmatch '^macos/.+\.zsh$') {
            Add-Issue "build.MacOS.$role EntryFile 必须指向 macos/*.zsh，实际: $entryFile"
        } else {
            Assert-PathExists "build.MacOS.$role EntryFile" (Join-Path $script:InstallerRoot $entryFile)
        }
    }

    Assert-PathExists 'build.ps1' (Join-Path $script:InstallerRoot 'build.ps1')
    Assert-PathExists 'build.sh' (Join-Path $script:InstallerRoot 'build.sh')

    $buildPs1 = Get-Content -Path (Join-Path $script:InstallerRoot 'build.ps1') -Raw -Encoding UTF8
    $buildSh = Get-Content -Path (Join-Path $script:InstallerRoot 'build.sh') -Raw -Encoding UTF8
    if ($buildPs1 -notmatch 'contracts[\\/]build\.json') {
        Add-Issue 'installer/build.ps1 未读取共享构建清单 contracts/build.json'
    }
    if ($buildSh -notmatch "readJson\('contracts/build\.json'\)") {
        Add-Issue 'installer/build.sh 未读取共享构建清单 contracts/build.json'
    }

    if ($buildPs1 -match "ValidateSet\('All'|ValidateSet\('MacOS'|Get-BuildArtifactConfig\s+-Platform\s+MacOS|Build-ZshSingleFileScript") {
        Add-Issue 'installer/build.ps1 仍包含 All/MacOS 构建路径'
    }
    if ($buildSh -match 'buildPowerShellArtifact|validatePowerShellArtifact|selectedPlatform === ''all''|selectedPlatform === ''windows''') {
        Add-Issue 'installer/build.sh 仍包含 Windows/all 构建路径'
    }
    if ($buildSh -notmatch 'CCQ_SKILLS_CONTRACT' -or $buildSh -notmatch 'CCQ_UI_CONTRACT') {
        Add-Issue 'installer/build.sh 未嵌入新增 skills/ui contracts'
    }
}

function Test-CanonicalSourceLayout {
    Assert-PathExists 'WindowsRoot' $script:WindowsRoot -PathType Container
    Assert-PathExists 'Windows core root' $script:CoreRoot -PathType Container
    Assert-PathExists 'Windows steps root' $script:StepsRoot -PathType Container

    foreach ($legacyPath in @(
        'Bootstrap.ps1',
        'Install.ps1',
        'Manage.ps1',
        'core',
        'steps',
        'build/Build-SingleFile.ps1'
    )) {
        Assert-PathAbsent "legacy.$legacyPath" (Join-Path $script:InstallerRoot $legacyPath)
    }

    $distPath = Join-Path $script:RepoRoot 'dist'
    if (Test-Path $distPath -PathType Container) {
        foreach ($file in @(Get-ChildItem -Path $distPath -File)) {
            if ($file.Name -in @('ccq.ps1', 'ccq.sh') -or $file.Name -match '^ccq-' -or $file.Name -match '\.built\.') {
                Add-Issue "dist 中存在旧 artifact: $($file.Name)"
            }
        }
    }
}

# dot-source 必须发生在脚本作用域；若放在函数内，Registry/Provider 等函数会随函数返回而失效。
. (Join-Path $script:CoreRoot 'Ui.ps1')
. (Join-Path $script:CoreRoot 'Process.ps1')
. (Join-Path $script:CoreRoot 'Profile.ps1')
. (Join-Path $script:CoreRoot 'Admin.ps1')
. (Join-Path $script:CoreRoot 'Net.ps1')
. (Join-Path $script:CoreRoot 'Registry.ps1')
. (Join-Path $script:CoreRoot 'Provider.ps1')
. (Join-Path $script:StepsRoot 'ClaudeConfig.ps1')
. (Join-Path $script:StepsRoot 'Skills.ps1')
. (Join-Path $script:StepsRoot 'CcgWorkflow.ps1')

function Test-CcgWorkflowContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    if (-not $Contract.ContainsKey('contract')) {
        Add-Issue "ccg-workflow.json: 缺少 contract 节"
        return
    }

    $c = $Contract['contract']

    # 验证 managedEnvDefaults 与 CcgWorkflow.ps1 fallback 一致
    if ($c.ContainsKey('managedEnvDefaults')) {
        $expected = @{
            "CODEAGENT_POST_MESSAGE_DELAY" = "1"
            "CODEX_TIMEOUT"                = "7200"
            "BASH_DEFAULT_TIMEOUT_MS"      = "600000"
            "BASH_MAX_TIMEOUT_MS"          = "3600000"
        }
        Assert-Equal 'CcgWorkflow managedEnvDefaults' $expected $c['managedEnvDefaults']
    } else {
        Add-Issue "ccg-workflow.json: 缺少 managedEnvDefaults 字段"
    }

    # 验证 managedRuleFiles 与 CcgWorkflow.ps1 fallback 一致
    if ($c.ContainsKey('managedRuleFiles')) {
        $expected = @('ccq-ccgworkflow.md', 'ccq-multimodel.md', 'ccq-tools.md', 'ccq-workflow.md')
        Assert-Equal 'CcgWorkflow managedRuleFiles' $expected $c['managedRuleFiles']
    } else {
        Add-Issue "ccg-workflow.json: 缺少 managedRuleFiles 字段"
    }

    # 验证 verifyItems 结构
    if ($c.ContainsKey('verifyItems')) {
        if ($c['verifyItems'] -isnot [array] -or $c['verifyItems'].Count -lt 7) {
            Add-Issue "ccg-workflow.json: verifyItems 应为至少 7 项的数组"
        }
    } else {
        Add-Issue "ccg-workflow.json: 缺少 verifyItems 字段"
    }
}

function Test-CleanupPolicyContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    if (-not $Contract.ContainsKey('contract')) {
        Add-Issue "cleanup-policy.json: 缺少 contract 节"
        return
    }

    $c = $Contract['contract']

    # 验证策略参数
    $requiredFields = @('maxSnapshots', 'maxAgeInDays', 'recentMinutesSkip', 'directoryPattern', 'baseDirectory')
    foreach ($field in $requiredFields) {
        if (-not $c.ContainsKey($field)) {
            Add-Issue "cleanup-policy.json: 缺少 $field 字段"
        }
    }

    # 验证默认值
    if ($c['maxSnapshots'] -ne 5) {
        Add-Issue "cleanup-policy.json: maxSnapshots 应为 5"
    }
    if ($c['maxAgeInDays'] -ne 30) {
        Add-Issue "cleanup-policy.json: maxAgeInDays 应为 30"
    }
    if ($c['recentMinutesSkip'] -ne 5) {
        Add-Issue "cleanup-policy.json: recentMinutesSkip 应为 5"
    }
    if ($c['directoryPattern'] -ne 'update_*') {
        Add-Issue "cleanup-policy.json: directoryPattern 应为 'update_*'"
    }
}

function Test-CjkWidthRangesContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    if (-not $Contract.ContainsKey('contract')) {
        Add-Issue "cjk-width-ranges.json: 缺少 contract 节"
        return
    }

    $c = $Contract['contract']

    # 验证 ranges 数组
    if (-not $c.ContainsKey('ranges') -or $c['ranges'] -isnot [array]) {
        Add-Issue "cjk-width-ranges.json: 缺少 ranges 数组"
        return
    }

    # 应有 8 段（7 段 CJK + 1 段 Emoji）
    if ($c['ranges'].Count -lt 8) {
        Add-Issue "cjk-width-ranges.json: ranges 应至少包含 8 段（含 Emoji 0x1F300-0x1FAFF）"
    }

    # 验证 Emoji 段存在
    $hasEmoji = $false
    foreach ($range in $c['ranges']) {
        if ($range['start'] -eq '0x1F300' -and $range['end'] -eq '0x1FAFF') {
            $hasEmoji = $true
            break
        }
    }
    if (-not $hasEmoji) {
        Add-Issue "cjk-width-ranges.json: 缺少 Emoji 段 0x1F300-0x1FAFF"
    }
}

function Main {
    if (-not (Test-Path $script:InstallerRoot -PathType Container)) {
        throw "InstallerRoot 不是有效目录: $script:InstallerRoot"
    }

    Test-CanonicalSourceLayout
    Test-StepsContract -Contract (Read-ContractJson 'steps.json')
    Test-ProvidersContract -Contract (Read-ContractJson 'providers.json')
    Test-McpContract -Contract (Read-ContractJson 'mcp-servers.json')
    Test-ClaudeConfigContract -Contract (Read-ContractJson 'claude-config.json')
    Test-TemplatesContract -Contract (Read-ContractJson 'templates/index.json')
    Test-BuildManifestContract -Contract (Read-ContractJson 'build.json')
    Test-SkillsContract -Contract (Read-ContractJson 'skills.json')
    Test-UiContract -Contract (Read-ContractJson 'ui.json')
    Test-CcgWorkflowContract -Contract (Read-ContractJson 'ccg-workflow.json')
    Test-CleanupPolicyContract -Contract (Read-ContractJson 'cleanup-policy.json')
    Test-CjkWidthRangesContract -Contract (Read-ContractJson 'cjk-width-ranges.json')

    if ($script:Issues.Count -gt 0) {
        Write-Host "[FAIL] contracts 一致性检查失败 ($($script:Issues.Count) 项)" -ForegroundColor Red
        foreach ($issue in $script:Issues) {
            Write-Host "- $issue" -ForegroundColor Red
        }
        exit 1
    }

    Write-Host "[PASS] contracts 一致性检查通过" -ForegroundColor Green
}

Main
