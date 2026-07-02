#Requires -Version 7.0
# Test-Contracts.ps1 - 跨平台契约一致性检查
# 功能: 验证 installer/contracts/ + tui/contracts/ 契约与 Windows/macOS canonical runtime 不冲突
# 位置：installer/contracts/（TDR-10 拆分后 installer 契约本地，TUI 契约跨目录读 tui/contracts/）

param(
    [string]$InstallerRoot = (Resolve-Path "$PSScriptRoot\..").Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:Issues = [System.Collections.Generic.List[string]]::new()
$script:InstallerRoot = (Resolve-Path $InstallerRoot).Path
$script:RepoRoot = (Split-Path -Parent $script:InstallerRoot)
$script:TuiContractsRoot = Join-Path $script:RepoRoot 'tui\contracts'
$script:WindowsRoot = Join-Path $script:InstallerRoot 'windows'
$script:CoreRoot = Join-Path $script:WindowsRoot 'core'
$script:StepsRoot = Join-Path $script:WindowsRoot 'steps'

function Read-ContractJson {
    param([Parameter(Mandatory)][string]$RelativePath)

    # installer 契约（steps/build/cleanup-policy）位于 installer/contracts/（$PSScriptRoot）
    $path = Join-Path $PSScriptRoot $RelativePath
    if (-not (Test-Path $path -PathType Leaf)) {
        throw "installer 契约文件不存在: $path"
    }

    return (Get-Content -Path $path -Raw -Encoding UTF8 | ConvertFrom-Json -AsHashtable -ErrorAction Stop)
}

function Read-TuiContractJson {
    param([Parameter(Mandatory)][string]$RelativePath)

    # TUI 契约（claude-config/mcp-servers/providers/templates）位于 tui/contracts/（TDR-10 拆分）
    $path = Join-Path $script:TuiContractsRoot $RelativePath
    if (-not (Test-Path $path -PathType Leaf)) {
        throw "TUI 契约文件不存在: $path"
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

    Assert-Equal 'directory.installer-root' 'installer' $Contract['DirectoryPolicy']['InstallerRoot']
    Assert-Equal 'directory.must-not-rename' 'src' $Contract['DirectoryPolicy']['MustNotRenameTo']
    Assert-Equal 'directory.runtime-core.windows' 'installer/windows/core' $Contract['DirectoryPolicy']['RuntimeCoreDirectories']['Windows']
    Assert-Equal 'directory.runtime-core.macos' 'installer/macos/core' $Contract['DirectoryPolicy']['RuntimeCoreDirectories']['MacOS']
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
}

function Assert-ClaudeConfigDescriptionsCoverMap {
    <#
    .SYNOPSIS
    校验 description 映射覆盖受管 key 的每一项且非空，且无多余项。
    #>
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][System.Collections.IDictionary]$Source,
        [AllowNull()][object]$Descriptions
    )

    if ($null -eq $Descriptions -or $Descriptions -isnot [System.Collections.IDictionary]) {
        Add-Issue "$Name 缺少 description 映射"
        return
    }

    foreach ($key in @($Source.Keys)) {
        $keyName = [string]$key
        if (-not $Descriptions.ContainsKey($keyName)) {
            Add-Issue "$Name.$keyName 缺少 description"
        } elseif ([string]::IsNullOrWhiteSpace([string]$Descriptions[$keyName])) {
            Add-Issue "$Name.$keyName 的 description 为空"
        }
    }

    foreach ($key in @($Descriptions.Keys)) {
        if (-not $Source.ContainsKey([string]$key)) {
            Add-Issue "$Name.$([string]$key) 的 description 无对应配置项"
        }
    }
}

function Test-ClaudeConfigContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    # claude-config 为 TUI 链契约（由 tui/ runtime 消费），installer 侧仅做 JSON 自洽校验，
    # 不再 dot-source 已迁移的 ClaudeConfig 步骤做 runtime fallback 对照。
    Assert-Equal 'claude-config.language' '简体中文' $Contract['TopLevelDefaults']['language']
    Assert-Equal 'claude-config.always-thinking' $true $Contract['TopLevelDefaults']['alwaysThinkingEnabled']
    Assert-Equal 'claude-config.plans-directory' '.claude/plan' $Contract['TopLevelDefaults']['plansDirectory']

    $descriptions = $Contract['Descriptions']
    if ($null -eq $descriptions -or $descriptions -isnot [System.Collections.IDictionary]) {
        Add-Issue 'claude-config.descriptions 缺少 Descriptions 节'
        return
    }
    Assert-ClaudeConfigDescriptionsCoverMap 'claude-config.descriptions.top-level' $Contract['TopLevelDefaults'] $descriptions['TopLevelDefaults']
    Assert-ClaudeConfigDescriptionsCoverMap 'claude-config.descriptions.env-defaults' $Contract['ClaudeConfigEnvDefaults'] $descriptions['ClaudeConfigEnvDefaults']
    if (-not $descriptions.ContainsKey('ClaudeConfigBasePermissions') -or [string]::IsNullOrWhiteSpace([string]$descriptions['ClaudeConfigBasePermissions'])) {
        Add-Issue 'claude-config.descriptions.base-permissions 缺少或为空'
    }
}

function Test-TemplatesContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    $templateIds = @($Contract['Templates'] | ForEach-Object { [string]$_['Id'] })
    foreach ($requiredId in @(
        'claude-md-template.base',
        'claude-md-template.platform-windows'
    )) {
        if ($templateIds -notcontains $requiredId) {
            Add-Issue "templates 缺少条目: $requiredId"
        }
    }

    foreach ($template in @($Contract['Templates'])) {
        $id = [string]$template['Id']
        $source = [string]$template['Source']
        if ($source -match '^installer/(core|steps)/') {
            Add-Issue "templates.$id Source 仍引用旧 installer 路径: $source"
            continue
        }
        if ($source -match '^tui/') {
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

function Test-BuildManifestContract {
    param([Parameter(Mandatory)][hashtable]$Contract)

    Assert-Equal 'build.default-output-directory' 'dist' $Contract['DefaultOutputDirectory']

    $windowsArtifacts = @($Contract['Windows']['Artifacts'])
    $macOSArtifacts = @($Contract['MacOS']['Artifacts'])
    $windowsOutputs = @($windowsArtifacts | ForEach-Object { [string]$_['OutputFile'] })
    $macOSOutputs = @($macOSArtifacts | ForEach-Object { [string]$_['OutputFile'] })
    $allOutputs = @($windowsOutputs + $macOSOutputs)
    $windowsExeArtifacts = @('ccq-windows-x64.exe', 'ccq-windows-arm64.exe')
    $macOSExeArtifacts = @('ccq-macos-x64', 'ccq-macos-arm64')
    $releaseOutputs = @($allOutputs + $windowsExeArtifacts + $macOSExeArtifacts)

    Assert-Equal 'build.windows.outputs' @('install.ps1') $windowsOutputs
    Assert-Equal 'build.macos.outputs' @('install.sh') $macOSOutputs
    Assert-Equal 'build.release.outputs' @('install.ps1', 'install.sh', 'ccq-windows-x64.exe', 'ccq-windows-arm64.exe', 'ccq-macos-x64', 'ccq-macos-arm64') $releaseOutputs

    $entrypoints = $Contract['BuildEntrypoints']
    Assert-Equal 'build.entrypoints.windows.script' 'installer/build.ps1' $entrypoints['Windows']['Script']
    Assert-Equal 'build.entrypoints.windows.allowed' @('Windows') @($entrypoints['Windows']['AllowedPlatforms'])
    Assert-Equal 'build.entrypoints.windows.artifacts' @('install.ps1', 'ccq-windows-x64.exe', 'ccq-windows-arm64.exe') @($entrypoints['Windows']['Artifacts'])
    Assert-Equal 'build.entrypoints.macos.script' 'installer/build.sh' $entrypoints['MacOS']['Script']
    Assert-Equal 'build.entrypoints.macos.allowed' @('macos') @($entrypoints['MacOS']['AllowedPlatforms'])
    Assert-Equal 'build.entrypoints.macos.artifacts' @('install.sh', 'ccq-macos-x64', 'ccq-macos-arm64') @($entrypoints['MacOS']['Artifacts'])
    Assert-Equal 'build.entrypoints.release-artifacts' $releaseOutputs @($entrypoints['ReleaseArtifacts'])

    foreach ($output in $releaseOutputs) {
        if ($output -in @('ccq.ps1', 'ccq.sh') -or $output -match '\.built\.') {
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

        if ($role -eq 'Install') {
            Assert-Equal 'build.Windows.Install.OutputEncoding' 'asciiTrampoline' ([string]$artifact['OutputEncoding'])
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
    if ($buildSh -notmatch "readJson\('installer/contracts/build\.json'\)") {
        Add-Issue 'installer/build.sh 未读取共享构建清单 installer/contracts/build.json'
    }

    if ($buildPs1 -match "ValidateSet\('All'|ValidateSet\('MacOS'|Get-BuildArtifactConfig\s+-Platform\s+MacOS|Build-ZshSingleFileScript") {
        Add-Issue 'installer/build.ps1 仍包含 All/MacOS 构建路径'
    }
    if ($buildSh -match 'buildPowerShellArtifact|validatePowerShellArtifact|selectedPlatform === ''all''|selectedPlatform === ''windows''') {
        Add-Issue 'installer/build.sh 仍包含 Windows/all 构建路径'
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
    $validReleaseArtifacts = @('ccq-windows-x64.exe', 'ccq-windows-arm64.exe', 'ccq-macos-x64', 'ccq-macos-arm64')
    if (Test-Path $distPath -PathType Container) {
        foreach ($file in @(Get-ChildItem -Path $distPath -File)) {
            if ($file.Name -in $validReleaseArtifacts) { continue }
            if ($file.Name -in @('ccq.ps1', 'ccq.sh') -or $file.Name -match '^ccq-' -or $file.Name -match '\.built\.') {
                Add-Issue "dist 中存在旧 artifact: $($file.Name)"
            }
        }
    }
}

# dot-source 必须发生在脚本作用域；若放在函数内，Registry 等函数会随函数返回而失效。
# 注意：claude-config 现为纯 TUI 链契约（runtime 实现在 tui/src/core/config-recommend.ts，
#       由 tui/scripts/verify-contracts.mjs 校验），installer 侧不再 dot-source 已删除的
#       windows/steps/ClaudeConfig.ps1，仅做 JSON 自洽校验。
. (Join-Path $script:CoreRoot 'Ui.ps1')
. (Join-Path $script:CoreRoot 'Process.ps1')
. (Join-Path $script:CoreRoot 'Profile.ps1')
. (Join-Path $script:CoreRoot 'Admin.ps1')
. (Join-Path $script:CoreRoot 'Net.ps1')
. (Join-Path $script:CoreRoot 'Registry.ps1')

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

function Main {
    if (-not (Test-Path $script:InstallerRoot -PathType Container)) {
        throw "InstallerRoot 不是有效目录: $script:InstallerRoot"
    }

    Test-CanonicalSourceLayout
    # installer 契约（installer/contracts/）
    Test-StepsContract -Contract (Read-ContractJson 'steps.json')
    Test-BuildManifestContract -Contract (Read-ContractJson 'build.json')
    Test-CleanupPolicyContract -Contract (Read-ContractJson 'cleanup-policy.json')
    # TUI 契约（tui/contracts/，TDR-10 拆分）
    Test-McpContract -Contract (Read-TuiContractJson 'mcp-servers.json')
    Test-ClaudeConfigContract -Contract (Read-TuiContractJson 'claude-config.json')
    Test-TemplatesContract -Contract (Read-TuiContractJson 'templates/index.json')

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
