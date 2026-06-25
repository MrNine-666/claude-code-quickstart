# Json.ps1 - JSON 解析 helper（PS5.1 兼容）- CCQ
# 作者: 哈雷酱 (本小姐的 PS5.1 兼容杰作！)
# 功能: 提供 PS5.1 兼容的 ConvertFrom-JsonToHashtable，对齐 PS7 的 ConvertFrom-Json -AsHashtable。
#       PS5.1 的 ConvertFrom-Json 无 -AsHashtable，返回 PSCustomObject；本 helper 递归转 hashtable，
#       作为全栈单一真理源（DRY），须在任何使用方模块之前 dot-source。

#Requires -Version 5.1

Set-StrictMode -Version Latest

function ConvertTo-CcqHashtableNode {
    <#
    .SYNOPSIS
    递归将 ConvertFrom-Json 产物（PSCustomObject / 数组 / 标量）转为 hashtable 结构
    .DESCRIPTION
    PSCustomObject → [hashtable]（支持 -is [hashtable] 检查，对齐 PS7 -AsHashtable 类型）；
    数组 → 保序数组（递归每个元素，逗号防展开，HC-13）；标量与 $null 原样返回。
    #>
    param(
        [Parameter(Mandatory = $false, Position = 0)]
        $Node
    )

    if ($null -eq $Node) { return $null }

    if ($Node -is [System.Management.Automation.PSCustomObject]) {
        $result = @{}
        foreach ($property in $Node.PSObject.Properties) {
            $result[$property.Name] = ConvertTo-CcqHashtableNode $property.Value
        }
        return $result
    }

    if ($Node -is [System.Collections.IEnumerable] -and $Node -isnot [string]) {
        $items = @()
        foreach ($item in $Node) {
            $items += , (ConvertTo-CcqHashtableNode $item)
        }
        return , $items
    }

    return $Node
}

function ConvertFrom-JsonToHashtable {
    <#
    .SYNOPSIS
    PS5.1 兼容的 JSON → hashtable 解析，替代 PS7 的 ConvertFrom-Json -AsHashtable
    .DESCRIPTION
    支持管道与位置输入；经 CmdletBinding 通用参数 -ErrorAction 控制解析失败行为，
    与 ConvertFrom-Json -AsHashtable -ErrorAction <X> 语义一致：
      Stop（默认随 $ErrorActionPreference）→ 解析失败抛 terminating error（调用方 try/catch 捕获）
      SilentlyContinue → 解析失败返回 $null
    空/空白输入返回 $null（安全，HC-13 数组上下文）。
    .OUTPUTS
    [hashtable] / [object[]] / 标量 / $null
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $false, ValueFromPipeline = $true, Position = 0)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$InputObject
    )

    process {
        if ([string]::IsNullOrWhiteSpace($InputObject)) { return $null }

        $parsed = $null
        try {
            $parsed = ConvertFrom-Json -InputObject $InputObject -ErrorAction Stop
        } catch {
            Write-Error -ErrorRecord $_
            return $null
        }

        return ConvertTo-CcqHashtableNode $parsed
    }
}
