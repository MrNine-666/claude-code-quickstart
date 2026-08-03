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
    Assert-Equal 'bootstrap-only.Basic.StepIds' @('NodeJS', 'Git') @($Contract['Groups']['Basic']['StepIds'])

    foreach ($removedToolStep in @('ClaudeCode', 'CodexCli')) {
        if (@($Contract['Groups']['Basic']['StepIds']) -contains $removedToolStep) {
            Add-Issue "bootstrap-only.Basic.StepIds 不得包含 $removedToolStep"
        }
        if (@($Contract['Steps'] | ForEach-Object { [string]$_['StepId'] }) -contains $removedToolStep) {
            Add-Issue "bootstrap-only.Steps 不得注册 $removedToolStep；该工具应由 ccq 工具管理安装"
        }
    }

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
        'claude-md-template.platform-windows',
        'codex-md-template.base'
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
    $windowsExeArtifacts = @('ccq-windows-x64.exe', 'ccq-windows-x64.exe.gz', 'ccq-windows-arm64.exe', 'ccq-windows-arm64.exe.gz')
    $macOSExeArtifacts = @('ccq-macos-x64', 'ccq-macos-x64.gz', 'ccq-macos-arm64', 'ccq-macos-arm64.gz')
    $releaseOutputs = @($allOutputs + $windowsExeArtifacts + $macOSExeArtifacts)

    Assert-Equal 'build.windows.outputs' @('install.ps1') $windowsOutputs
    Assert-Equal 'build.macos.outputs' @('install.sh') $macOSOutputs
    Assert-Equal 'build.release.outputs' @('install.ps1', 'install.sh', 'ccq-windows-x64.exe', 'ccq-windows-x64.exe.gz', 'ccq-windows-arm64.exe', 'ccq-windows-arm64.exe.gz', 'ccq-macos-x64', 'ccq-macos-x64.gz', 'ccq-macos-arm64', 'ccq-macos-arm64.gz') $releaseOutputs

    # raw -> gzip 映射是唯一文件名来源；client 传输层与 CI 都消费它。
    $gzipMappings = @($Contract['UpdateTransports']['GzipAssets'])
    Assert-Equal 'build.update-transports.count' 4 $gzipMappings.Count
    $expectedMappings = @(
        @{ Raw = 'ccq-windows-x64.exe'; Gzip = 'ccq-windows-x64.exe.gz' },
        @{ Raw = 'ccq-windows-arm64.exe'; Gzip = 'ccq-windows-arm64.exe.gz' },
        @{ Raw = 'ccq-macos-x64'; Gzip = 'ccq-macos-x64.gz' },
        @{ Raw = 'ccq-macos-arm64'; Gzip = 'ccq-macos-arm64.gz' }
    )
    for ($i = 0; $i -lt $expectedMappings.Count; $i++) {
        Assert-Equal "build.update-transports.$i.raw" $expectedMappings[$i].Raw ([string]$gzipMappings[$i]['Raw'])
        Assert-Equal "build.update-transports.$i.gzip" $expectedMappings[$i].Gzip ([string]$gzipMappings[$i]['Gzip'])
        if ("$($gzipMappings[$i]['Raw']).gz" -ne [string]$gzipMappings[$i]['Gzip']) {
            Add-Issue "gzip artifact 名称必须是 raw 名称加 .gz: $($gzipMappings[$i]['Gzip'])"
        }
    }
    Assert-Equal 'build.release.count' 10 $releaseOutputs.Count

    $entrypoints = $Contract['BuildEntrypoints']
    Assert-Equal 'build.entrypoints.windows.script' 'installer/build.ps1' $entrypoints['Windows']['Script']
    Assert-Equal 'build.entrypoints.windows.allowed' @('Windows') @($entrypoints['Windows']['AllowedPlatforms'])
    Assert-Equal 'build.entrypoints.windows.artifacts' @('install.ps1', 'ccq-windows-x64.exe', 'ccq-windows-x64.exe.gz', 'ccq-windows-arm64.exe', 'ccq-windows-arm64.exe.gz') @($entrypoints['Windows']['Artifacts'])
    Assert-Equal 'build.entrypoints.macos.script' 'installer/build.sh' $entrypoints['MacOS']['Script']
    Assert-Equal 'build.entrypoints.macos.allowed' @('macos') @($entrypoints['MacOS']['AllowedPlatforms'])
    Assert-Equal 'build.entrypoints.macos.artifacts' @('install.sh', 'ccq-macos-x64', 'ccq-macos-x64.gz', 'ccq-macos-arm64', 'ccq-macos-arm64.gz') @($entrypoints['MacOS']['Artifacts'])
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
    if ($buildPs1 -notmatch "BuildEntrypoints'\]\['Windows'\]\['Artifacts") {
        Add-Issue 'installer/build.ps1 未从 BuildEntrypoints.Windows.Artifacts 派生 raw/gzip 输出集合'
    }
    if ($buildSh -notmatch 'manifest\.BuildEntrypoints\.MacOS\.Artifacts') {
        Add-Issue 'installer/build.sh 未从 BuildEntrypoints.MacOS.Artifacts 派生 raw/gzip 输出集合'
    }
    if ($buildPs1 -notmatch "platformArtifacts\s*=\s*@\(\`$manifest\['BuildEntrypoints'\]\[\`$platformKey\]\['Artifacts'\]\)") {
        Add-Issue 'installer/build.ps1 清理未从当前平台 BuildEntrypoints artifacts 派生，旧 raw/gzip 可能伪装构建成功'
    }
    if ($buildSh -notmatch '(?s)function clearKnownBuildArtifacts\(manifest\).*?manifest\.BuildEntrypoints\.MacOS\.Artifacts') {
        Add-Issue 'installer/build.sh 清理未覆盖当前 macOS raw/gzip，旧文件可能伪装构建成功'
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
    $validReleaseArtifacts = @('ccq-windows-x64.exe', 'ccq-windows-x64.exe.gz', 'ccq-windows-arm64.exe', 'ccq-windows-arm64.exe.gz', 'ccq-macos-x64', 'ccq-macos-x64.gz', 'ccq-macos-arm64', 'ccq-macos-arm64.gz')
    if (Test-Path $distPath -PathType Container) {
        foreach ($file in @(Get-ChildItem -Path $distPath -File)) {
            if ($file.Name -in $validReleaseArtifacts) { continue }
            if ($file.Name -in @('ccq.ps1', 'ccq.sh') -or $file.Name -match '^ccq-' -or $file.Name -match '\.built\.') {
                Add-Issue "dist 中存在旧 artifact: $($file.Name)"
            }
        }
    }
}

function Test-CcqVersionHandoffContract {
    $normalizer = Get-Command -Name ConvertTo-CcqComparableVersion -ErrorAction SilentlyContinue
    if (-not $normalizer) {
        Add-Issue 'Windows ccq handoff 缺少 ConvertTo-CcqComparableVersion'
    } else {
        Assert-Equal 'ccq.version.normalize.release-tag' '1.2.3' (ConvertTo-CcqComparableVersion -Version 'v1.2.3')
        Assert-Equal 'ccq.version.normalize-command-output' '1.2.3-rc.1' (ConvertTo-CcqComparableVersion -Version 'ccq v1.2.3-rc.1')
    }

    $windowsInstall = Get-Content -Path (Join-Path $script:WindowsRoot 'Install.ps1') -Raw -Encoding UTF8
    foreach ($requiredPattern in @(
        'function\s+Get-CcqReleaseTargetVersion',
        '版本一致，无需覆盖',
        '检测到 ccq 版本不一致',
        '是否覆盖现有文件',
        '-DefaultIndex\s+1',
        '无法确定安装器目标版本，已保留现有 ccq'
    )) {
        if ($windowsInstall -notmatch $requiredPattern) {
            Add-Issue "Windows ccq version handoff 缺少契约片段: $requiredPattern"
        }
    }

    $macInstallPath = Join-Path $script:InstallerRoot 'macos\Install.zsh'
    $macProcessPath = Join-Path $script:InstallerRoot 'macos\core\Process.zsh'
    $macInstall = Get-Content -Path $macInstallPath -Raw -Encoding UTF8
    $macProcess = Get-Content -Path $macProcessPath -Raw -Encoding UTF8
    foreach ($requiredPattern in @(
        'ccq_get_release_target_version\(\)',
        '版本一致，无需覆盖',
        '检测到 ccq 版本不一致',
        '是否覆盖现有文件',
        'ccq_prompt_single[^\r\n]+\s1\s',
        '无法确定安装器目标版本，已保留现有 ccq'
    )) {
        if ($macInstall -notmatch $requiredPattern) {
            Add-Issue "macOS ccq version handoff 缺少契约片段: $requiredPattern"
        }
    }
    if ($macProcess -notmatch 'ccq_normalize_version\(\)') {
        Add-Issue 'macOS ccq handoff 缺少 ccq_normalize_version'
    }

    $parseTokens = $null
    $parseErrors = $null
    $windowsAst = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $script:WindowsRoot 'Install.ps1'),
        [ref]$parseTokens,
        [ref]$parseErrors
    )
    $confirmFunction = $windowsAst.Find({
        param($Node)
        $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $Node.Name -eq 'Confirm-CcqExecutableDownload'
    }, $true)
    if ($parseErrors.Count -gt 0 -or -not $confirmFunction) {
        Add-Issue 'Windows ccq handoff 行为探针无法解析 Confirm-CcqExecutableDownload'
        return
    }

    Invoke-Expression $confirmFunction.Extent.Text
    $script:CcqHandoffCurrentVersion = '1.2.3'
    $script:CcqHandoffTargetVersion = '1.2.3'
    $script:CcqHandoffDecision = 1
    $script:CcqHandoffMenuCount = 0
    $script:CcqHandoffDefaultIndex = -1
    $script:CcqHandoffInstallCalled = $false

    function Test-CcqExecutableInstalled {
        return @{ IsInstalled = $true; Version = $script:CcqHandoffCurrentVersion; Path = 'C:\fake\ccq.exe' }
    }
    function Get-CcqReleaseTargetVersion { return $script:CcqHandoffTargetVersion }
    function Get-CcqArchitecture { return 'windows-x64' }
    function Get-CcqReleaseDownloadBaseUrl { return 'https://example.invalid/release' }
    function Show-SingleSelectMenu {
        param([string]$Title, [string[]]$Options, [int]$DefaultIndex)
        $script:CcqHandoffMenuCount++
        $script:CcqHandoffDefaultIndex = $DefaultIndex
        return $script:CcqHandoffDecision
    }
    function Install-CcqExecutable {
        param([string]$DownloadUrl)
        $script:CcqHandoffInstallCalled = $true
        return @{ Success = $true; ErrorMessage = ''; Path = 'C:\fake\ccq.exe' }
    }
    function Write-Host { param([Parameter(ValueFromRemainingArguments)][object[]]$Object) }
    function Write-UiPrimary { param([string]$Message, [string]$Level) }
    function Write-UiInfo { param([string]$Message, [string]$Level) }
    function Write-UiDim { param([string]$Message, [string]$Level) }
    function Write-UiSuccess { param([string]$Message, [string]$Level) }
    function Write-UiWarning { param([string]$Message, [string]$Level) }

    Confirm-CcqExecutableDownload | Out-Null
    Assert-Equal 'ccq.handoff.same.menu-count' 0 $script:CcqHandoffMenuCount
    Assert-Equal 'ccq.handoff.same.install-called' $false $script:CcqHandoffInstallCalled

    $script:CcqHandoffCurrentVersion = '1.2.2'
    $script:CcqHandoffMenuCount = 0
    $script:CcqHandoffInstallCalled = $false
    $script:CcqHandoffDecision = 1
    Confirm-CcqExecutableDownload | Out-Null
    Assert-Equal 'ccq.handoff.different.menu-count' 1 $script:CcqHandoffMenuCount
    Assert-Equal 'ccq.handoff.different.default-preserve' 1 $script:CcqHandoffDefaultIndex
    Assert-Equal 'ccq.handoff.preserve.install-called' $false $script:CcqHandoffInstallCalled

    $script:CcqHandoffMenuCount = 0
    $script:CcqHandoffInstallCalled = $false
    $script:CcqHandoffDecision = 0
    Confirm-CcqExecutableDownload | Out-Null
    Assert-Equal 'ccq.handoff.overwrite.menu-count' 1 $script:CcqHandoffMenuCount
    Assert-Equal 'ccq.handoff.overwrite.install-called' $true $script:CcqHandoffInstallCalled
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

function Test-UserPathPreservationContract {
    <#
    验证 ccq PATH 追加不会展开 nvm 变量或降级用户 PATH 的注册表类型。
    通过覆盖注册表边界函数隔离真实 HKCU，避免契约测试修改测试机环境。
    #>
    param()

    $processSource = Get-Content -Path (Join-Path $script:CoreRoot 'Process.ps1') -Raw -Encoding UTF8
    if ($processSource -notmatch 'DoNotExpandEnvironmentNames') {
        Add-Issue 'user-path.source 缺少原始注册表值读取保护'
    }
    if ($processSource -notmatch '\.SetValue\("Path",\s*\$Value,\s*\$Kind\)') {
        Add-Issue 'user-path.source 缺少 RegistryValueKind 保持写入'
    }

    $pathFunctionTokens = $null
    $pathFunctionErrors = $null
    $processAst = [System.Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $script:CoreRoot 'Process.ps1'),
        [ref]$pathFunctionTokens,
        [ref]$pathFunctionErrors
    )
    $addPathFunction = $processAst.Find({
        param($Node)
        $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $Node.Name -eq 'Add-DirectoryToUserPath'
    }, $true)
    if ($pathFunctionErrors.Count -gt 0 -or -not $addPathFunction) {
        Add-Issue 'user-path.source 无法解析 Add-DirectoryToUserPath'
    } elseif ($addPathFunction.Extent.Text -match 'SetEnvironmentVariable') {
        Add-Issue 'user-path.source 禁止通过 SetEnvironmentVariable 覆盖完整用户 PATH'
    }

    $script:UserPathProbeState = @{
        Exists = $true
        Value = '%NVM_HOME%;%NVM_SYMLINK%;C:\Windows\System32'
        Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    $script:UserPathProbeWrites = @()

    function Get-UserPathRegistryState {
        return $script:UserPathProbeState
    }
    function Set-UserPathRegistryValue {
        param(
            [string]$Value,
            [Microsoft.Win32.RegistryValueKind]$Kind
        )
        $script:UserPathProbeWrites += @{
            Value = $Value
            Kind = $Kind
        }
    }

    $result = Add-DirectoryToUserPath -DirectoryPath 'C:\Users\ccq-test\.local\bin'
    Assert-Equal 'user-path.preserve.success' $true $result.Success
    Assert-Equal 'user-path.preserve.added' $true $result.Added
    Assert-Equal 'user-path.preserve.value' '%NVM_HOME%;%NVM_SYMLINK%;C:\Windows\System32;C:\Users\ccq-test\.local\bin' $script:UserPathProbeWrites[0].Value
    Assert-Equal 'user-path.preserve.kind' 'ExpandString' $script:UserPathProbeWrites[0].Kind.ToString()

    $script:UserPathProbeState = @{
        Exists = $true
        Value = 'C:\ccq-test\.local\bin;%NVM_HOME%'
        Kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    $script:UserPathProbeWrites = @()
    $result = Add-DirectoryToUserPath -DirectoryPath 'C:\ccq-test\.local\bin'
    Assert-Equal 'user-path.existing.success' $true $result.Success
    Assert-Equal 'user-path.existing.already-present' $true $result.AlreadyPresent
    Assert-Equal 'user-path.existing.no-write' 0 $script:UserPathProbeWrites.Count
}

function Test-ProfileLegacyCleanupContract {
    <#
    验证旧 ccq 函数清理只删除可确认的历史函数，不删除或折叠 fnm/用户 Profile 内容。
    所有读写均限制在独立临时目录，原子写与备份边界在函数作用域内替换。
    #>
    param()

    $installSource = Get-Content -Path (Join-Path $script:WindowsRoot 'Install.ps1') -Raw -Encoding UTF8
    if ($installSource -notmatch 'Remove-LegacyCcqFunctionFromFile') {
        Add-Issue 'profile-cleanup.source 未使用精确旧 ccq 函数清理入口'
    }
    if ($installSource -match 'Remove-ManagedBlockFromFile[^\r\n]*PreserveFnmSubsection') {
        Add-Issue 'profile-cleanup.source 禁止按通用标记块整体清理 Profile'
    }

    $probeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ccq-profile-contract-" + [Guid]::NewGuid().ToString('N'))
    $null = New-Item -Path $probeRoot -ItemType Directory -Force
    $script:ProfileProbeWriteCount = 0

    function Backup-FileWithTimestamp {
        param([string]$FilePath, [string]$BackupReason)
        return $null
    }
    function Write-FileAtomically {
        param(
            [string]$FilePath,
            [AllowEmptyString()]
            [AllowEmptyCollection()]
            [string[]]$Content,
            [string]$Encoding = 'UTF8'
        )

        $script:ProfileProbeWriteCount++
        [System.IO.File]::WriteAllLines(
            $FilePath,
            $Content,
            [System.Text.UTF8Encoding]::new($false)
        )
        return $true
    }
    function Write-ProfileProbeFile {
        param([string]$FilePath, [string[]]$Lines)

        [System.IO.File]::WriteAllLines(
            $FilePath,
            $Lines,
            [System.Text.UTF8Encoding]::new($false)
        )
    }

    $legacyCcqFunction = @(
        'function ccq {'
        '    $installUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.ps1"'
        '    $manageUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.ps1"'
        '    Invoke-RestMethod $installUrl | Invoke-Expression'
        '}'
    )
    $fnmLines = @(
        '# Node.js 环境初始化（fnm）'
        'if (Get-Command fnm -ErrorAction SilentlyContinue) {'
        '    fnm env --use-on-cd | Out-String | Invoke-Expression'
        '}'
    )

    try {
        $markedPath = Join-Path $probeRoot 'marked.ps1'
        $markedInput = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
            '# [CCQ:FNM:BEGIN]'
        ) + $fnmLines + @('# [CCQ:FNM:END]') + $legacyCcqFunction + @(
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Write-ProfileProbeFile -FilePath $markedPath -Lines $markedInput
        $script:ProfileProbeWriteCount = 0
        $markedResult = Remove-LegacyCcqFunctionFromFile -FilePath $markedPath
        $markedExpected = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
            '# [CCQ:FNM:BEGIN]'
        ) + $fnmLines + @(
            '# [CCQ:FNM:END]'
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Assert-Equal 'profile-cleanup.marked.success' $true $markedResult.Success
        Assert-Equal 'profile-cleanup.marked.changed' $true $markedResult.Changed
        Assert-Equal 'profile-cleanup.marked.write-count' 1 $script:ProfileProbeWriteCount
        Assert-Equal 'profile-cleanup.marked.preserved-lines' $markedExpected @(Get-Content -Path $markedPath -Encoding UTF8)

        $unmarkedPath = Join-Path $probeRoot 'unmarked.ps1'
        $unmarkedInput = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
        ) + $fnmLines + $legacyCcqFunction + @(
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Write-ProfileProbeFile -FilePath $unmarkedPath -Lines $unmarkedInput
        $script:ProfileProbeWriteCount = 0
        $unmarkedResult = Remove-LegacyCcqFunctionFromFile -FilePath $unmarkedPath
        $unmarkedExpected = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
        ) + $fnmLines + @(
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Assert-Equal 'profile-cleanup.unmarked.success' $true $unmarkedResult.Success
        Assert-Equal 'profile-cleanup.unmarked.changed' $true $unmarkedResult.Changed
        Assert-Equal 'profile-cleanup.unmarked.preserved-lines' $unmarkedExpected @(Get-Content -Path $unmarkedPath -Encoding UTF8)

        $fnmOnlyPath = Join-Path $probeRoot 'fnm-only.ps1'
        $fnmOnlyInput = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
        ) + $fnmLines + @(
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Write-ProfileProbeFile -FilePath $fnmOnlyPath -Lines $fnmOnlyInput
        $script:ProfileProbeWriteCount = 0
        $fnmOnlyResult = Remove-LegacyCcqFunctionFromFile -FilePath $fnmOnlyPath
        Assert-Equal 'profile-cleanup.fnm-only.success' $true $fnmOnlyResult.Success
        Assert-Equal 'profile-cleanup.fnm-only.changed' $false $fnmOnlyResult.Changed
        Assert-Equal 'profile-cleanup.fnm-only.no-write' 0 $script:ProfileProbeWriteCount
        Assert-Equal 'profile-cleanup.fnm-only.unchanged' $fnmOnlyInput @(Get-Content -Path $fnmOnlyPath -Encoding UTF8)

        $legacyOnlyPath = Join-Path $probeRoot 'legacy-only.ps1'
        $legacyOnlyInput = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
        ) + $legacyCcqFunction + @(
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Write-ProfileProbeFile -FilePath $legacyOnlyPath -Lines $legacyOnlyInput
        $script:ProfileProbeWriteCount = 0
        $legacyOnlyResult = Remove-LegacyCcqFunctionFromFile -FilePath $legacyOnlyPath
        Assert-Equal 'profile-cleanup.legacy-only.success' $true $legacyOnlyResult.Success
        Assert-Equal 'profile-cleanup.legacy-only.changed' $true $legacyOnlyResult.Changed
        Assert-Equal 'profile-cleanup.legacy-only.removed-block' @('before', 'after') @(Get-Content -Path $legacyOnlyPath -Encoding UTF8)

        $invalidPath = Join-Path $probeRoot 'invalid.ps1'
        $invalidInput = @(
            'before'
            '# >>> Claude Code Quickstart >>>'
            'function ccq {'
            '    $installUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.ps1"'
            '    $manageUrl = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.ps1"'
            '# <<< Claude Code Quickstart <<<'
            'after'
        )
        Write-ProfileProbeFile -FilePath $invalidPath -Lines $invalidInput
        $script:ProfileProbeWriteCount = 0
        $invalidResult = Remove-LegacyCcqFunctionFromFile -FilePath $invalidPath
        Assert-Equal 'profile-cleanup.invalid.successful-skip' $true $invalidResult.Success
        Assert-Equal 'profile-cleanup.invalid.changed' $false $invalidResult.Changed
        Assert-Equal 'profile-cleanup.invalid.no-write' 0 $script:ProfileProbeWriteCount
        Assert-Equal 'profile-cleanup.invalid.unchanged' $invalidInput @(Get-Content -Path $invalidPath -Encoding UTF8)
    } finally {
        if (Test-Path $probeRoot) {
            Remove-Item -LiteralPath $probeRoot -Recurse -Force
        }
    }
}

function Test-CcqGzipTransportContract {
    $processPath = Join-Path $script:CoreRoot 'Process.ps1'
    $processSource = Get-Content -Path $processPath -Raw -Encoding UTF8
    foreach ($requiredPattern in @(
        'function\s+Expand-CcqGzipFile',
        'System\.IO\.Compression\.GzipStream',
        '\$gzipUrl\s*=\s*"\$DownloadUrl\.gz"',
        'gzip 传输失败.+正在改用 raw 资产',
        'raw 下载失败:.+gzip 失败上下文',
        'Replace-CcqExecutable\s+-TempPath\s+\$tempPath'
    )) {
        if ($processSource -notmatch $requiredPattern) {
            Add-Issue "Windows ccq gzip transport 缺少契约片段: $requiredPattern"
        }
    }

    $macProcessPath = Join-Path $script:InstallerRoot 'macos\core\Process.zsh'
    $macProcessSource = Get-Content -Path $macProcessPath -Raw -Encoding UTF8
    foreach ($requiredPattern in @(
        'ccq_download_file\(\)',
        'gzip_url="\$\{download_url\}\.gz"',
        'gzip -dc -- "\$\{gzip_tmp_path\}"',
        '正在改用 raw 资产',
        'raw 下载失败:.+gzip 失败上下文'
    )) {
        if ($macProcessSource -notmatch $requiredPattern) {
            Add-Issue "macOS ccq gzip transport 缺少契约片段: $requiredPattern"
        }
    }

    $macProbePath = Join-Path $PSScriptRoot 'Test-MacOSGzipTransport.zsh'
    Assert-PathExists 'macOS gzip transport behavior probe' $macProbePath
    $buildShSource = Get-Content -Path (Join-Path $script:InstallerRoot 'build.sh') -Raw -Encoding UTF8
    if ($buildShSource -notmatch '(?m)^\s*zsh\s+"\$\{gzip_probe_path\}"\s*$') {
        Add-Issue 'installer/build.sh --check 未接入 macOS gzip transport behavior probe'
    }

    $parseTokens = $null
    $parseErrors = $null
    $processAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $processPath,
        [ref]$parseTokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -gt 0) {
        Add-Issue 'Windows ccq gzip transport 无法解析 Process.ps1'
        return
    }

    $installFunction = $processAst.Find({
        param($Node)
        $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $Node.Name -eq 'Install-CcqExecutable'
    }, $true)
    if (-not $installFunction) {
        Add-Issue 'Windows ccq gzip transport 无法找到 Install-CcqExecutable 函数'
        return
    }

    $probeDir = Join-Path $env:TEMP ("ccq-gzip-contract-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    try {
        $rawFixture = Join-Path $probeDir 'raw-fixture.exe'
        $gzipFixture = "$rawFixture.gz"
        $emptyGzipFixture = Join-Path $probeDir 'empty.gz'
        $corruptFixture = Join-Path $probeDir 'corrupt.gz'
        $roundtripOutput = Join-Path $probeDir 'roundtrip.exe'
        [System.IO.File]::WriteAllBytes(
            $rawFixture,
            [System.Text.Encoding]::UTF8.GetBytes("ccq gzip transport fixture`nline two`n")
        )

        $gzipOutput = $null
        $gzipWriter = $null
        $rawInput = $null
        try {
            $gzipOutput = [System.IO.File]::Create($gzipFixture)
            $gzipWriter = New-Object -TypeName System.IO.Compression.GzipStream -ArgumentList @(
                $gzipOutput,
                [System.IO.Compression.CompressionMode]::Compress
            )
            $rawInput = [System.IO.File]::OpenRead($rawFixture)
            $rawInput.CopyTo($gzipWriter)
        } finally {
            if ($null -ne $rawInput) { $rawInput.Dispose() }
            if ($null -ne $gzipWriter) { $gzipWriter.Dispose() }
            if ($null -ne $gzipOutput) { $gzipOutput.Dispose() }
        }

        $emptyOutput = $null
        $emptyWriter = $null
        try {
            $emptyOutput = [System.IO.File]::Create($emptyGzipFixture)
            $emptyWriter = New-Object -TypeName System.IO.Compression.GzipStream -ArgumentList @(
                $emptyOutput,
                [System.IO.Compression.CompressionMode]::Compress
            )
        } finally {
            if ($null -ne $emptyWriter) { $emptyWriter.Dispose() }
            if ($null -ne $emptyOutput) { $emptyOutput.Dispose() }
        }
        $corruptBytes = [System.IO.File]::ReadAllBytes($gzipFixture)
        if ($corruptBytes.Length -lt 9) {
            throw 'gzip fixture 太短，无法构造 CRC 损坏探针'
        }
        # gzip trailer 的前 4 bytes 是 CRC32。翻转其中一位，证明 helper 会读到尾部并校验 CRC。
        $corruptBytes[$corruptBytes.Length - 8] = $corruptBytes[$corruptBytes.Length - 8] -bxor 0x01
        [System.IO.File]::WriteAllBytes($corruptFixture, $corruptBytes)

        $roundtripResult = Expand-CcqGzipFile -GzipPath $gzipFixture -OutputPath $roundtripOutput
        Assert-Equal 'ccq.gzip.helper.roundtrip-success' $true $roundtripResult.Success
        Assert-Equal 'ccq.gzip.helper.roundtrip-size' (Get-Item -LiteralPath $rawFixture).Length $roundtripResult.OutputSize
        Assert-Equal 'ccq.gzip.helper.roundtrip-bytes' ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($rawFixture))) ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($roundtripOutput)))

        $corruptOutput = Join-Path $probeDir 'corrupt-output.exe'
        $corruptResult = Expand-CcqGzipFile -GzipPath $corruptFixture -OutputPath $corruptOutput
        Assert-Equal 'ccq.gzip.helper.corrupt-fails' $false $corruptResult.Success
        Assert-Equal 'ccq.gzip.helper.corrupt-cleans-output' $false (Test-Path -LiteralPath $corruptOutput)
        $corruptExclusiveStream = $null
        try {
            $corruptExclusiveStream = [System.IO.File]::Open(
                $corruptFixture,
                [System.IO.FileMode]::Open,
                [System.IO.FileAccess]::ReadWrite,
                [System.IO.FileShare]::None
            )
            Assert-Equal 'ccq.gzip.helper.corrupt-releases-input' $true ($null -ne $corruptExclusiveStream)
        } catch {
            Add-Issue "ccq.gzip.helper.corrupt-releases-input 无法独占打开 gzip fixture: $($_.Exception.Message)"
        } finally {
            if ($null -ne $corruptExclusiveStream) { $corruptExclusiveStream.Dispose() }
        }

        $emptyOutputPath = Join-Path $probeDir 'empty-output.exe'
        $emptyResult = Expand-CcqGzipFile -GzipPath $emptyGzipFixture -OutputPath $emptyOutputPath
        Assert-Equal 'ccq.gzip.helper.empty-fails' $false $emptyResult.Success
        Assert-Equal 'ccq.gzip.helper.empty-cleans-output' $false (Test-Path -LiteralPath $emptyOutputPath)

        # 只重新载入安装函数；解压 helper 使用上方已 dot-source 的真实实现。
        Invoke-Expression $installFunction.Extent.Text
        $script:CcqGzipRawFixture = $rawFixture
        $script:CcqGzipFixture = $gzipFixture
        $script:CcqGzipEmptyFixture = $emptyGzipFixture
        $script:CcqGzipCorruptFixture = $corruptFixture
        $script:CcqGzipScenario = ''
        $script:CcqGzipTargetPath = ''
        $script:CcqGzipDownloadCalls = @()
        $script:CcqGzipWarnings = @()
        $script:CcqGzipReplaceCalled = $false

        function Get-CcqExecutablePath { return $script:CcqGzipTargetPath }
        function Test-CcqExecutableLocked {
            param([string]$Path)
            return @{ Locked = $false; Processes = @(); Detail = '' }
        }
        function Invoke-FileDownload {
            param([string]$Url, [string]$OutputPath, [string]$Description)
            $script:CcqGzipDownloadCalls += , @{
                Url         = $Url
                OutputPath  = $OutputPath
                Description = $Description
            }

            if ($Url.EndsWith('.gz')) {
                switch ($script:CcqGzipScenario) {
                    'gzip-success' {
                        [System.IO.File]::Copy($script:CcqGzipFixture, $OutputPath, $true)
                        return @{ Success = $true; ErrorMessage = '' }
                    }
                    'gzip-download-fail' {
                        [System.IO.File]::WriteAllText($OutputPath, 'partial-gzip')
                        return @{ Success = $false; ErrorMessage = 'fixture gzip download failed' }
                    }
                    'gzip-corrupt' {
                        [System.IO.File]::Copy($script:CcqGzipCorruptFixture, $OutputPath, $true)
                        return @{ Success = $true; ErrorMessage = '' }
                    }
                    'gzip-empty' {
                        [System.IO.File]::Copy($script:CcqGzipEmptyFixture, $OutputPath, $true)
                        return @{ Success = $true; ErrorMessage = '' }
                    }
                    'double-fail' {
                        [System.IO.File]::WriteAllText($OutputPath, 'partial-gzip')
                        return @{ Success = $false; ErrorMessage = 'fixture gzip download failed' }
                    }
                    'double-fail-corrupt' {
                        [System.IO.File]::Copy($script:CcqGzipCorruptFixture, $OutputPath, $true)
                        return @{ Success = $true; ErrorMessage = '' }
                    }
                }
            }

            if ($script:CcqGzipScenario -eq 'gzip-success') {
                return @{ Success = $false; ErrorMessage = 'raw must not be requested after gzip success' }
            }
            if ($script:CcqGzipScenario -in @('double-fail', 'double-fail-corrupt')) {
                [System.IO.File]::WriteAllText($OutputPath, 'partial-raw')
                return @{ Success = $false; ErrorMessage = 'fixture raw download failed' }
            }

            [System.IO.File]::Copy($script:CcqGzipRawFixture, $OutputPath, $true)
            return @{ Success = $true; ErrorMessage = '' }
        }
        function Replace-CcqExecutable {
            param([string]$TempPath, [string]$TargetPath)
            $script:CcqGzipReplaceCalled = $true
            [System.IO.File]::Copy($TempPath, $TargetPath, $true)
            [System.IO.File]::Delete($TempPath)
            return @{ Success = $true; ErrorMessage = ''; BackupPath = '' }
        }
        function Add-DirectoryToUserPath {
            param([string]$DirectoryPath)
            return @{ Success = $true; Added = $false; AlreadyPresent = $true }
        }
        function Write-UiDanger { param([string]$Message, [string]$Level) }
        function Write-UiInfo { param([string]$Message, [string]$Level) }
        function Write-UiDim { param([string]$Message, [string]$Level) }
        function Write-UiSuccess { param([string]$Message, [string]$Level) }
        function Write-UiWarning {
            param([string]$Message, [string]$Level)
            $script:CcqGzipWarnings += $Message
        }

        function Invoke-CcqGzipInstallScenario {
            param(
                [string]$Scenario,
                [int]$ExpectedCalls,
                [bool]$ExpectSuccess,
                [bool]$ExpectWarning
            )

            $targetPath = Join-Path $probeDir "$Scenario.exe"
            $script:CcqGzipScenario = $Scenario
            $script:CcqGzipTargetPath = $targetPath
            $script:CcqGzipDownloadCalls = @()
            $script:CcqGzipWarnings = @()
            $script:CcqGzipReplaceCalled = $false
            [System.IO.File]::WriteAllText($targetPath, 'MUST-SURVIVE')
            $oldTarget = [System.IO.File]::ReadAllBytes($targetPath)

            $installResult = Install-CcqExecutable -DownloadUrl 'https://example.invalid/ccq-windows-x64.exe'
            Assert-Equal "ccq.gzip.$Scenario.success" $ExpectSuccess $installResult.Success
            Assert-Equal "ccq.gzip.$Scenario.download-count" $ExpectedCalls @($script:CcqGzipDownloadCalls).Count
            Assert-Equal "ccq.gzip.$Scenario.first-url" 'https://example.invalid/ccq-windows-x64.exe.gz' $script:CcqGzipDownloadCalls[0].Url
            Assert-Equal "ccq.gzip.$Scenario.first-output" "$targetPath.download.$PID.gz" $script:CcqGzipDownloadCalls[0].OutputPath
            if ($ExpectedCalls -eq 2) {
                Assert-Equal "ccq.gzip.$Scenario.second-url" 'https://example.invalid/ccq-windows-x64.exe' $script:CcqGzipDownloadCalls[1].Url
                Assert-Equal "ccq.gzip.$Scenario.second-output" "$targetPath.download.$PID" $script:CcqGzipDownloadCalls[1].OutputPath
            }

            if ($ExpectSuccess) {
                Assert-Equal "ccq.gzip.$Scenario.replace-called" $true $script:CcqGzipReplaceCalled
                Assert-Equal "ccq.gzip.$Scenario.target-bytes" ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($script:CcqGzipRawFixture))) ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($targetPath)))
            } else {
                Assert-Equal "ccq.gzip.$Scenario.replace-not-called" $false $script:CcqGzipReplaceCalled
                Assert-Equal "ccq.gzip.$Scenario.target-preserved" ([Convert]::ToBase64String($oldTarget)) ([Convert]::ToBase64String([System.IO.File]::ReadAllBytes($targetPath)))
                $expectedGzipContext = if ($Scenario -eq 'double-fail-corrupt') {
                    'gzip 失败上下文: gzip 解压失败:'
                } else {
                    'gzip 失败上下文: gzip 下载失败: fixture gzip download failed'
                }
                if ($installResult.ErrorMessage -notmatch 'raw 下载失败: fixture raw download failed' -or
                    $installResult.ErrorMessage -notmatch [regex]::Escape($expectedGzipContext)) {
                    Add-Issue "ccq.gzip.$Scenario 双失败错误上下文不完整: $($installResult.ErrorMessage)"
                }
            }

            Assert-Equal "ccq.gzip.$Scenario.raw-temp-clean" $false (Test-Path -LiteralPath "$targetPath.download.$PID")
            Assert-Equal "ccq.gzip.$Scenario.gzip-temp-clean" $false (Test-Path -LiteralPath "$targetPath.download.$PID.gz")
            $hasFallbackWarning = @($script:CcqGzipWarnings | Where-Object { $_ -match '正在改用 raw 资产' }).Count -gt 0
            Assert-Equal "ccq.gzip.$Scenario.warning" $ExpectWarning $hasFallbackWarning
        }

        Invoke-CcqGzipInstallScenario -Scenario 'gzip-success' -ExpectedCalls 1 -ExpectSuccess $true -ExpectWarning $false
        Invoke-CcqGzipInstallScenario -Scenario 'gzip-download-fail' -ExpectedCalls 2 -ExpectSuccess $true -ExpectWarning $true
        Invoke-CcqGzipInstallScenario -Scenario 'gzip-corrupt' -ExpectedCalls 2 -ExpectSuccess $true -ExpectWarning $true
        Invoke-CcqGzipInstallScenario -Scenario 'gzip-empty' -ExpectedCalls 2 -ExpectSuccess $true -ExpectWarning $true
        Invoke-CcqGzipInstallScenario -Scenario 'double-fail' -ExpectedCalls 2 -ExpectSuccess $false -ExpectWarning $true
        Invoke-CcqGzipInstallScenario -Scenario 'double-fail-corrupt' -ExpectedCalls 2 -ExpectSuccess $false -ExpectWarning $true
    } finally {
        Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Test-CcqLockedFileReplaceContract {
    $processPath = Join-Path $script:CoreRoot 'Process.ps1'
    $processSource = Get-Content -Path $processPath -Raw -Encoding UTF8

    # 正向断言：Process.ps1 含替换运行中映像所需的关键片段。
    # 注意：重试常量必须绑定到赋值处。裸 '20' / '250' 会被任意 PS 源码撞上，
    # 那种断言对空实现同样通过，等于没断言。
    foreach ($requiredPattern in @(
        '\[System\.IO\.File\]::Replace',
        'function\s+Test-CcqExecutableLocked',
        'function\s+Replace-CcqExecutable',
        'function\s+Restore-CcqExecutableBackup',
        'ccq 正在运行',
        '\$maxAttempts\s*=\s*20',
        '\$intervalMs\s*=\s*250',
        # PS5.1 下 File.Replace 的 backup 形参传 $null 会抛「路径的格式不合法」，
        # 必须是 [NullString]::Value，否则回滚是永远失败的死代码。
        '\[NullString\]::Value'
    )) {
        if ($processSource -notmatch $requiredPattern) {
            Add-Issue "Windows ccq locked-file replace 缺少契约片段: $requiredPattern"
        }
    }

    # 解析 AST 提取 Install-CcqExecutable 函数体，做反向断言与行为探针。
    $parseTokens = $null
    $parseErrors = $null
    $processAst = [System.Management.Automation.Language.Parser]::ParseFile(
        $processPath,
        [ref]$parseTokens,
        [ref]$parseErrors
    )
    if ($parseErrors.Count -gt 0) {
        Add-Issue 'Windows ccq locked-file replace 无法解析 Process.ps1'
        return
    }

    $installFunction = $processAst.Find({
        param($Node)
        $Node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
            $Node.Name -eq 'Install-CcqExecutable'
    }, $true)
    if (-not $installFunction) {
        Add-Issue 'Windows ccq locked-file replace 无法找到 Install-CcqExecutable 函数'
        return
    }

    $installBody = $installFunction.Extent.Text

    # 反向断言：Install-CcqExecutable 函数体不得再用 Move-Item 落盘 ccq.exe。
    # 注意参数顺序：被移除的旧代码是 `Move-Item -Path $tempPath -Destination $ccqPath -Force`，
    # -Path 在 -Destination 之前，所以 'Move-Item\s+-Destination' 这类正则根本命中不到它，
    # 那样的反向断言对真回归是空转。替换已委托给 Replace-CcqExecutable，
    # 该函数体内不存在任何 Move-Item 的正当用途，因此直接断言「一个都不许有」。
    # 必须带 \b 词边界：-match 默认大小写不敏感，裸 'Move-Item' 会命中 'Remove-Item'
    # 里的 'move-Item'，把正常的 temp 清理误报成回归。
    if ($installBody -match '\bMove-Item') {
        Add-Issue 'Windows ccq locked-file replace Install-CcqExecutable 仍含 Move-Item 落盘'
    }

    # 真实文件系统行为探针必须先跑：下方 mock 会遮蔽 Test-CcqExecutableLocked 等真函数。
    $probeDir = Join-Path $env:TEMP ("ccq-lock-contract-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $probeDir -Force | Out-Null
    $probeLockStream = $null
    try {
        # 预检探针 1：目标不存在 → 不算被锁，且进程列表 Count 必须为 0。
        # 这条守住 `return , $array` 与调用方 @() 的双重包裹 —— 一旦再套一层，
        # 空列表会被包成 @(@()) 使 Count 变 1，用户会看到空的「检测到 ccq 进程: 」括号。
        $absentState = Test-CcqExecutableLocked -Path (Join-Path $probeDir 'absent.exe')
        Assert-Equal 'ccq.locked.absent-not-locked' $false $absentState.Locked
        Assert-Equal 'ccq.locked.absent-empty-processes' 0 @($absentState.Processes).Count

        # 预检探针 2：目标空闲 → 放行；FileShare.None 独占持锁 → 判定被锁。
        $freeFile = Join-Path $probeDir 'free.exe'
        Set-Content -LiteralPath $freeFile -Value 'FREE' -NoNewline -Encoding ASCII
        Assert-Equal 'ccq.locked.free-target-passes' $false (Test-CcqExecutableLocked -Path $freeFile).Locked

        $probeLockStream = [System.IO.File]::Open(
            $freeFile,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        Assert-Equal 'ccq.locked.detects-exclusive-lock' $true (Test-CcqExecutableLocked -Path $freeFile).Locked
        $probeLockStream.Close(); $probeLockStream.Dispose(); $probeLockStream = $null

        # 替换探针共用的 Start-Sleep 遮蔽：既让 20 次重试瞬间跑完（不真睡 5 秒），
        # 又用 sleep 次数证明确实走过重试路径（否则探针可能被「一次就成功」空转通过）。
        $script:CcqRetryLockStream = $null
        $script:CcqRetrySleepCount = 0
        $script:CcqRetryReleaseOnSleep = $false
        function Start-Sleep {
            param([int]$Milliseconds, [int]$Seconds)
            $script:CcqRetrySleepCount++
            if ($script:CcqRetryReleaseOnSleep -and $null -ne $script:CcqRetryLockStream) {
                $script:CcqRetryLockStream.Close()
                $script:CcqRetryLockStream.Dispose()
                $script:CcqRetryLockStream = $null
            }
        }

        # 替换探针 0：同一 PID 的旧 backup 可能来自上次失败回滚，且可能是唯一旧版本。
        # 新事务必须在修改 target 前中止，只清理自己的 temp，绝不能删除该 backup。
        $collisionTarget = Join-Path $probeDir 'collision.exe'
        $collisionTemp = "$collisionTarget.download.$PID"
        $collisionBackup = "$collisionTarget.backup.$PID"
        Set-Content -LiteralPath $collisionTarget -Value 'CURRENTBUILD' -NoNewline -Encoding ASCII
        Set-Content -LiteralPath $collisionTemp -Value 'NEXTBUILD' -NoNewline -Encoding ASCII
        Set-Content -LiteralPath $collisionBackup -Value 'ONLYRECOVERY' -NoNewline -Encoding ASCII
        $collisionResult = Replace-CcqExecutable -TempPath $collisionTemp -TargetPath $collisionTarget
        Assert-Equal 'ccq.locked.backup-collision-fails-closed' $false $collisionResult.Success
        Assert-Equal 'ccq.locked.backup-collision-keeps-target' 'CURRENTBUILD' (Get-Content -LiteralPath $collisionTarget -Raw)
        Assert-Equal 'ccq.locked.backup-collision-preserves-recovery' 'ONLYRECOVERY' (Get-Content -LiteralPath $collisionBackup -Raw)
        Assert-Equal 'ccq.locked.backup-collision-cleans-new-temp' $false (Test-Path -LiteralPath $collisionTemp)
        if ($collisionResult.ErrorMessage -notmatch [regex]::Escape($collisionBackup)) {
            Add-Issue "ccq.locked.backup-collision 错误未指出保留的备份: $($collisionResult.ErrorMessage)"
        }

        # 替换探针 1：锁在重试窗口内释放 → 替换成功，target 变成新产物。
        # 对应 PRD 验收「锁在重试窗口内释放时，替换能成功完成而无需用户重跑」。
        $retryTarget = Join-Path $probeDir 'retry.exe'
        $retryTemp = "$retryTarget.download.$PID"
        Set-Content -LiteralPath $retryTarget -Value 'OLDBUILD' -NoNewline -Encoding ASCII
        Set-Content -LiteralPath $retryTemp -Value 'NEWBUILDNEWBUILD' -NoNewline -Encoding ASCII
        $script:CcqRetryReleaseOnSleep = $true
        $script:CcqRetrySleepCount = 0
        $script:CcqRetryLockStream = [System.IO.File]::Open(
            $retryTarget,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $retryResult = Replace-CcqExecutable -TempPath $retryTemp -TargetPath $retryTarget
        if ($null -ne $script:CcqRetryLockStream) {
            $script:CcqRetryLockStream.Close(); $script:CcqRetryLockStream.Dispose()
            $script:CcqRetryLockStream = $null
        }
        Assert-Equal 'ccq.locked.retry-succeeds-after-release' $true $retryResult.Success
        Assert-Equal 'ccq.locked.retry-target-is-new-build' 'NEWBUILDNEWBUILD' (Get-Content -LiteralPath $retryTarget -Raw)
        Assert-Equal 'ccq.locked.retry-temp-consumed' $false (Test-Path -LiteralPath $retryTemp)
        Assert-Equal 'ccq.locked.retry-no-backup-residue' $false (Test-Path -LiteralPath "$retryTarget.backup.$PID")
        if ($script:CcqRetrySleepCount -lt 1) {
            Add-Issue 'ccq.locked.retry 未经过重试路径，探针可能空转'
        }

        # 替换探针 2：锁始终不释放 → 替换失败，但原 target 必须完好且不留 temp/backup。
        # 对应 PRD 验收「替换彻底失败时，原有 ccq.exe 仍可用，且不留残留 temp」。
        $keepTarget = Join-Path $probeDir 'keep.exe'
        $keepTemp = "$keepTarget.download.$PID"
        Set-Content -LiteralPath $keepTarget -Value 'MUSTSURVIVE' -NoNewline -Encoding ASCII
        Set-Content -LiteralPath $keepTemp -Value 'NEWNEWNEWNEW' -NoNewline -Encoding ASCII
        $script:CcqRetryReleaseOnSleep = $false
        $script:CcqRetrySleepCount = 0
        $probeLockStream = [System.IO.File]::Open(
            $keepTarget,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $keepResult = Replace-CcqExecutable -TempPath $keepTemp -TargetPath $keepTarget
        $probeLockStream.Close(); $probeLockStream.Dispose(); $probeLockStream = $null
        Assert-Equal 'ccq.locked.fail-reports-failure' $false $keepResult.Success
        Assert-Equal 'ccq.locked.fail-preserves-old-target' 'MUSTSURVIVE' (Get-Content -LiteralPath $keepTarget -Raw)
        Assert-Equal 'ccq.locked.fail-no-temp-residue' $false (Test-Path -LiteralPath $keepTemp)
        Assert-Equal 'ccq.locked.fail-no-backup-residue' $false (Test-Path -LiteralPath "$keepTarget.backup.$PID")
        Assert-Equal 'ccq.locked.fail-exhausts-retries' 19 $script:CcqRetrySleepCount
        # 用户可见错误不得是「当文件已存在时，无法创建该文件」这类无信息量文案。
        if ($keepResult.ErrorMessage -notmatch '被占用|保留现有版本') {
            Add-Issue "ccq.locked.fail 缺少可操作错误: $($keepResult.ErrorMessage)"
        }

        # 回滚探针：Restore-CcqExecutableBackup 必须真能把旧版本搬回 target。
        # PS5.1 下 File.Replace 传 $null backup 会抛「路径的格式不合法」，
        # 这条断言守住 [NullString]::Value，避免回滚退化成永远失败的死代码。
        $rbTarget = Join-Path $probeDir 'rollback.exe'
        $rbBackup = "$rbTarget.backup.$PID"
        Set-Content -LiteralPath $rbTarget -Value 'BADBUILD' -NoNewline -Encoding ASCII
        Set-Content -LiteralPath $rbBackup -Value 'GOODOLDBUILD' -NoNewline -Encoding ASCII
        Assert-Equal 'ccq.locked.rollback-succeeds' $true (Restore-CcqExecutableBackup -BackupPath $rbBackup -TargetPath $rbTarget)
        Assert-Equal 'ccq.locked.rollback-restores-old' 'GOODOLDBUILD' (Get-Content -LiteralPath $rbTarget -Raw)
        Assert-Equal 'ccq.locked.rollback-consumes-backup' $false (Test-Path -LiteralPath $rbBackup)
    } finally {
        if ($null -ne $probeLockStream) { $probeLockStream.Close(); $probeLockStream.Dispose() }
        Remove-Item -LiteralPath $probeDir -Recurse -Force -ErrorAction SilentlyContinue
    }

    # 行为探针：mock Test-CcqExecutableLocked 返回 Locked=$true，断言 Invoke-FileDownload 不被调用。
    # 沿用 Test-CcqVersionHandoffContract 的 Invoke-Expression + mock 函数覆盖手法。
    Invoke-Expression $installFunction.Extent.Text

    $script:CcqLockedDownloadCalled = $false

    function Get-CcqExecutablePath { return 'C:\fake\ccq.exe' }
    function Test-CcqExecutableLocked {
        param([string]$Path)
        return @{ Locked = $true; Processes = @(@{ ProcessId = 99999; CommandLine = '"C:\fake\ccq.exe" cc aether' }); Detail = '目标被占用' }
    }
    function Invoke-FileDownload {
        $script:CcqLockedDownloadCalled = $true
        return @{ Success = $true; ErrorMessage = '' }
    }
    function Add-DirectoryToUserPath {
        return @{ Success = $true; Added = $false; AlreadyPresent = $true }
    }
    function Write-UiDanger { param([string]$Message, [string]$Level) }
    function Write-UiInfo { param([string]$Message, [string]$Level) }
    function Write-UiDim { param([string]$Message, [string]$Level) }
    function Write-UiSuccess { param([string]$Message, [string]$Level) }
    function Write-UiWarning { param([string]$Message, [string]$Level) }

    $installResult = Install-CcqExecutable -DownloadUrl 'https://example.invalid/ccq.exe'
    Assert-Equal 'ccq.locked.preview-blocks-install' $false $script:CcqLockedDownloadCalled
    Assert-Equal 'ccq.locked.preview-returns-failure' $false $installResult.Success
    if ($installResult.ErrorMessage -notmatch 'ccq 正在运行') {
        Add-Issue "ccq.locked.preview 缺少可读错误: $($installResult.ErrorMessage)"
    }
}

function Main {
    if (-not (Test-Path $script:InstallerRoot -PathType Container)) {
        throw "InstallerRoot 不是有效目录: $script:InstallerRoot"
    }

    Test-CanonicalSourceLayout
    Test-CcqVersionHandoffContract
    Test-CcqGzipTransportContract
    Test-CcqLockedFileReplaceContract
    # installer 契约（installer/contracts/）
    Test-StepsContract -Contract (Read-ContractJson 'steps.json')
    Test-BuildManifestContract -Contract (Read-ContractJson 'build.json')
    Test-CleanupPolicyContract -Contract (Read-ContractJson 'cleanup-policy.json')
    # TUI 契约（tui/contracts/，TDR-10 拆分）
    Test-McpContract -Contract (Read-TuiContractJson 'mcp-servers.json')
    Test-ClaudeConfigContract -Contract (Read-TuiContractJson 'claude-config.json')
    Test-TemplatesContract -Contract (Read-TuiContractJson 'templates/index.json')
    Test-UserPathPreservationContract
    Test-ProfileLegacyCleanupContract

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
