# TUI 组件库 - CCQ
# 作者: 哈雷酱 (本小姐的杰作！)
# 功能: 提供终端用户界面组件，包括彩色输出、菜单、进度条等

#Requires -Version 5.1

# 严格模式
Set-StrictMode -Version Latest

# 终端能力检测
$script:IsWindowsTerminal = $false
$script:SupportsAnsi = $false
$script:SupportsEmoji = $false

function Enable-VirtualTerminalProcessing {
    <#
    .SYNOPSIS
    经 kernel32 SetConsoleMode 启用控制台 VT 处理（PS5.1 普通 conhost 默认关闭）
    .DESCRIPTION
    置位 ENABLE_VIRTUAL_TERMINAL_PROCESSING (0x0004)，使 ANSI 转义（菜单箭头键重绘 / 彩色输出）
    在 PS5.1 conhost 生效（Win10 1607+）。已启用或 PS6+ 返回 $true；无控制台 / 输出重定向返回 $false。
    .OUTPUTS
    [bool] VT 是否可用
    #>
    try {
        if (-not ([System.Management.Automation.PSTypeName]'_CcqKernel32Vt').Type) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class _CcqKernel32Vt {
    [DllImport("kernel32.dll", SetLastError = true)] public static extern System.IntPtr GetStdHandle(int nStdHandle);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetConsoleMode(System.IntPtr hConsoleHandle, out uint lpMode);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleMode(System.IntPtr hConsoleHandle, uint dwMode);
    public const int STD_OUTPUT_HANDLE = -11;
    public const uint ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004;
    public static bool TryEnable() {
        System.IntPtr handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if (handle == System.IntPtr.Zero || handle == new System.IntPtr(-1)) { return false; }
        uint mode;
        if (!GetConsoleMode(handle, out mode)) { return false; }
        if ((mode & ENABLE_VIRTUAL_TERMINAL_PROCESSING) != 0) { return true; }
        return SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_PROCESSING);
    }
}
'@ -ErrorAction SilentlyContinue
        }
        return [_CcqKernel32Vt]::TryEnable()
    } catch {
        return $false
    }
}

function Initialize-TerminalCapabilities {
    <#
    .SYNOPSIS
    检测终端能力并初始化 ANSI / Emoji 支持（不以 PS 版本为准，按 VT 启用结果判定）
    #>

    # 检测 Windows Terminal
    $script:IsWindowsTerminal = $null -ne $env:WT_SESSION

    # 启用并检测 ANSI 支持：主动启用控制台 VT；成功或 Windows Terminal 即支持
    $script:SupportsAnsi = (Enable-VirtualTerminalProcessing) -or $script:IsWindowsTerminal

    # Emoji 仅 Windows Terminal 字体可靠渲染（普通 conhost / PS7 conhost 不保证，避免乱码）
    $script:SupportsEmoji = $script:IsWindowsTerminal
}

# Emoji 映射表（Emoji -> 纯文本替代）
$script:EmojiMap = @{
    "🔍" = "[检测]"
    "🖥️" = "[终端]"
    "⚡" = "[PS7]"
    "🔧" = "[配置]"
    "🚀" = "[启动]"
    "📋" = "[摘要]"
    "💡" = "[提示]"
    "🎉" = "[完成]"
    "⚠" = "[警告]"
    "✓" = "[成功]"
    "✗" = "[失败]"
    "🔐" = "[权限]"
    "🔄" = "[执行]"
    "✅" = "[通过]"
    "❌" = "[错误]"
    "📦" = "[安装]"
    "❓" = "[确认]"
    "⏭" = "[跳过]"
    "⚪" = "[运行]"
    "►" = ">"
    "↑" = "Up"
    "↓" = "Down"
    "→" = "->"
    "←" = "<-"
    "•" = "-"
    "━" = "-"
    "─" = "-"
    "│" = "|"
    "╔" = "+"
    "═" = "-"
    "╗" = "+"
    "║" = "|"
    "╚" = "+"
    "╝" = "+"
    "┌" = "+"
    "┬" = "+"
    "┐" = "+"
    "├" = "+"
    "┼" = "+"
    "┤" = "+"
    "└" = "+"
    "┴" = "+"
    "┘" = "+"
}

function Convert-EmojiToText {
    <#
    .SYNOPSIS
    将 Emoji 和 Unicode 符号转换为纯文本（如果终端不支持）
    .PARAMETER Text
    包含 Emoji 或 Unicode 符号的文本
    .RETURNS
    转换后的文本
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Text
    )

    if ($script:SupportsEmoji) {
        return $Text
    }

    # 替换所有 Emoji 和 Unicode 符号
    $result = $Text
    foreach ($emoji in $script:EmojiMap.Keys) {
        $result = $result -replace [regex]::Escape($emoji), $script:EmojiMap[$emoji]
    }

    return $result
}

# ANSI 颜色代码定义
# 注意：PowerShell 5.1 不支持 `e 转义序列，需要使用 [char]27
$script:EscapeChar = [char]27
$script:AnsiColors = @{
    Reset         = "$script:EscapeChar[0m"
    Bold          = "$script:EscapeChar[1m"

    # 6 色语义系统
    Success       = "$script:EscapeChar[92m"                    # BrightGreen
    Primary       = "$script:EscapeChar[38;2;217;119;87m"       # Claude #D97757
    BrightPrimary = "$script:EscapeChar[38;2;232;148;106m"      # Claude #E8946A（横幅高亮）
    Warning       = "$script:EscapeChar[93m"                    # BrightYellow
    Danger        = "$script:EscapeChar[91m"                    # BrightRed
    Info          = "$script:EscapeChar[97m"                    # White
    Dim           = "$script:EscapeChar[90m"                    # Gray
}

# ─── 输出模式控制 ────────────────────────────────────────────────────────────

enum CcqOutputMode {
    Normal = 0
    Developer = 1
}

enum CcqOutputLevel {
    Essential = 0
    Detail = 1
    Debug = 2
}

if (-not (Get-Variable -Scope Script -Name CcqOutputMode -ErrorAction SilentlyContinue)) {
    $script:CcqOutputMode = [CcqOutputMode]::Normal
}

# ─── 基础输出函数（DRY：统一 Emoji 转换 + ANSI 着色 + Write-Host）────────

function Write-UiBase {
    <#
    .SYNOPSIS
    内部基础输出函数，所有 Write-Ui* 函数的统一实现
    .PARAMETER Message
    要输出的消息
    .PARAMETER ColorCode
    ANSI 颜色代码
    .PARAMETER NoNewline
    不添加换行符
    .PARAMETER Level
    输出级别：Essential（必要）, Detail（详细）, Debug（调试）
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [Parameter(Mandatory = $true)]
        [string]$ColorCode,

        [switch]$NoNewline,

        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )

    # 级别过滤：Normal 模式下仅 Essential 通过
    if ($script:CcqOutputMode -eq [CcqOutputMode]::Normal -and $Level -gt [CcqOutputLevel]::Essential) {
        return
    }

    $Message = Convert-EmojiToText -Text $Message

    $output = if ($script:SupportsAnsi) {
        "$ColorCode$Message$($script:AnsiColors.Reset)"
    } else {
        $Message
    }

    if ($NoNewline) {
        Write-Host $output -NoNewline
    } else {
        Write-Host $output
    }
}

function Write-UiSuccess {
    <#
    .SYNOPSIS
    输出成功级别的彩色文本（亮绿色）
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$NoNewline,
        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )
    Write-UiBase $Message $script:AnsiColors.Success -NoNewline:$NoNewline -Level $Level
}

function Write-UiPrimary {
    <#
    .SYNOPSIS
    输出主色调文本（Claude 橙色），用于标题、品牌、活跃操作
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$NoNewline,
        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )
    Write-UiBase $Message $script:AnsiColors.Primary -NoNewline:$NoNewline -Level $Level
}

function Write-UiWarning {
    <#
    .SYNOPSIS
    输出警告级别的彩色文本（亮黄色）
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$NoNewline,
        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )
    Write-UiBase $Message $script:AnsiColors.Warning -NoNewline:$NoNewline -Level $Level
}

function Write-UiDanger {
    <#
    .SYNOPSIS
    输出错误级别的彩色文本（亮红色）
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$NoNewline,
        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )
    Write-UiBase $Message $script:AnsiColors.Danger -NoNewline:$NoNewline -Level $Level
}

function Write-UiInfo {
    <#
    .SYNOPSIS
    输出信息级别的彩色文本（白色），用于数据、路径、指令
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$NoNewline,
        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )
    Write-UiBase $Message $script:AnsiColors.Info -NoNewline:$NoNewline -Level $Level
}

function Write-UiDim {
    <#
    .SYNOPSIS
    输出弱化文本（灰色），用于装饰、元信息
    #>
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [switch]$NoNewline,
        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential
    )
    Write-UiBase $Message $script:AnsiColors.Dim -NoNewline:$NoNewline -Level $Level
}

function Clear-UiScreen {
    <#
    .SYNOPSIS
    清屏并将光标归位（统一由 Ui.ps1 管理 ANSI）
    #>
    param()

    if ($script:SupportsAnsi) {
        Write-Host "$script:EscapeChar[2J$script:EscapeChar[H" -NoNewline
    } else {
        Clear-Host
    }
}

# ─── 输出级别控制函数 ────────────────────────────────────────────────────────

function Write-UiOutput {
    <#
    .SYNOPSIS
    带级别控制的统一输出函数，根据当前输出模式过滤
    .PARAMETER Message
    要输出的消息
    .PARAMETER Level
    输出级别：Essential（必要）, Detail（详细）, Debug（调试）
    .PARAMETER Type
    输出类型：Primary, Info, Success, Warning, Danger, Dim
    .PARAMETER NoNewline
    不添加换行符
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message,

        [CcqOutputLevel]$Level = [CcqOutputLevel]::Essential,

        [ValidateSet('Primary', 'Info', 'Success', 'Warning', 'Danger', 'Dim')]
        [string]$Type = 'Info',

        [switch]$NoNewline
    )

    if ($script:CcqOutputMode -eq [CcqOutputMode]::Normal) {
        if ($Level -gt [CcqOutputLevel]::Essential) {
            return
        }
    }

    switch ($Type) {
        'Primary' { Write-UiPrimary $Message -NoNewline:$NoNewline }
        'Info'    { Write-UiInfo $Message -NoNewline:$NoNewline }
        'Success' { Write-UiSuccess $Message -NoNewline:$NoNewline }
        'Warning' { Write-UiWarning $Message -NoNewline:$NoNewline }
        'Danger'  { Write-UiDanger $Message -NoNewline:$NoNewline }
        'Dim'     { Write-UiDim $Message -NoNewline:$NoNewline }
    }
}

function Set-CcqOutputMode {
    <#
    .SYNOPSIS
    设置全局输出模式
    #>
    param(
        [Parameter(Mandatory = $true)]
        [CcqOutputMode]$Mode
    )
    $script:CcqOutputMode = $Mode
}

function Get-CcqOutputMode {
    <#
    .SYNOPSIS
    获取当前输出模式
    #>
    return $script:CcqOutputMode
}

function Get-StringDisplayWidth {
    <#
    .SYNOPSIS
    计算字符串在终端中的显示宽度（CJK 全角字符占 2 列）
    .DESCRIPTION
    合并 CJK 统一汉字、扩展区 A、部首、兼容表意、兼容形式、符号标点、全角 ASCII 等范围。
    .PARAMETER Text
    要计算的字符串
    .RETURNS
    int - 显示宽度
    #>
    param(
        [Parameter(Position = 0)]
        [AllowEmptyString()][AllowNull()]
        [string]$Text
    )

    if ([string]::IsNullOrEmpty($Text)) { return 0 }

    $width = 0
    foreach ($char in $Text.ToCharArray()) {
        $code = [int][char]$char
        if (($code -ge 0x2E80 -and $code -le 0x9FFF) -or    # CJK 部首 + 康熙部首 + 统一汉字
            ($code -ge 0x3000 -and $code -le 0x303F) -or    # CJK 符号和标点
            ($code -ge 0x3400 -and $code -le 0x4DBF) -or    # CJK 扩展 A
            ($code -ge 0xF900 -and $code -le 0xFAFF) -or    # CJK 兼容表意文字
            ($code -ge 0xFE30 -and $code -le 0xFE4F) -or    # CJK 兼容形式
            ($code -ge 0xFF00 -and $code -le 0xFF60) -or    # 全角 ASCII / 全角标点
            ($code -ge 0xFFE0 -and $code -le 0xFFE6) -or    # 全角符号
            ($code -ge 0x1F300 -and $code -le 0x1FAFF)) {   # Emoji（扩展象形文字，对齐 macOS）
            $width += 2
        } else {
            $width += 1
        }
    }
    return $width
}

function Format-DisplayPad {
    <#
    .SYNOPSIS
    按显示宽度右填充字符串（CJK 感知），用于对齐表格列
    .PARAMETER Text
    要填充的字符串
    .PARAMETER Width
    目标显示宽度
    .RETURNS
    string - 填充后的字符串
    #>
    param(
        [Parameter(Position = 0)]
        [AllowEmptyString()][AllowNull()]
        [string]$Text,

        [Parameter(Position = 1)]
        [int]$Width
    )

    if ([string]::IsNullOrEmpty($Text)) { return (' ' * $Width) }
    $displayWidth = Get-StringDisplayWidth $Text
    $padding = [Math]::Max(0, $Width - $displayWidth)
    return "$Text$(' ' * $padding)"
}

function Show-AsciiBanner {
    <#
    .SYNOPSIS
    显示 ASCII Art 横幅，自适应终端宽度
    .PARAMETER Title
    横幅标题
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title
    )

    # 转换 Emoji
    $Title = Convert-EmojiToText -Text $Title

    # 获取终端宽度
    $terminalWidth = 80
    try {
        $terminalWidth = [Console]::WindowWidth
        if ($terminalWidth -lt 40) { $terminalWidth = 80 }
    } catch {
        # 如果无法获取宽度，使用默认值
    }

    # 计算边框和内容宽度
    $borderWidth = [Math]::Min($terminalWidth - 4, 76)
    $contentWidth = $borderWidth - 4

    # 创建横幅
    $topBorder = "╔" + ("═" * $borderWidth) + "╗"
    $bottomBorder = "╚" + ("═" * $borderWidth) + "╝"
    $emptyLine = "║" + (" " * $borderWidth) + "║"

    # 处理标题文本（使用显示宽度而非字符长度）
    $titleLines = @()
    $titleDisplayWidth = Get-StringDisplayWidth -Text $Title

    if ($titleDisplayWidth -le $contentWidth) {
        $padding = [Math]::Floor(($contentWidth - $titleDisplayWidth) / 2)
        $remainingSpace = $contentWidth - $titleDisplayWidth - $padding
        $titleLine = "║  " + (" " * $padding) + $Title + (" " * $remainingSpace) + "  ║"
        $titleLines += $titleLine
    } else {
        # 如果标题太长，分行显示
        $words = $Title -split ' '
        $currentLine = ""

        foreach ($word in $words) {
            $testLine = if ($currentLine) { $currentLine + " " + $word } else { $word }
            $testWidth = Get-StringDisplayWidth -Text $testLine

            if ($testWidth -le $contentWidth) {
                $currentLine = $testLine
            } else {
                if ($currentLine) {
                    $lineWidth = Get-StringDisplayWidth -Text $currentLine
                    $padding = [Math]::Floor(($contentWidth - $lineWidth) / 2)
                    $remainingSpace = $contentWidth - $lineWidth - $padding
                    $titleLine = "║  " + (" " * $padding) + $currentLine + (" " * $remainingSpace) + "  ║"
                    $titleLines += $titleLine
                }
                $currentLine = $word
            }
        }

        if ($currentLine) {
            $lineWidth = Get-StringDisplayWidth -Text $currentLine
            $padding = [Math]::Floor(($contentWidth - $lineWidth) / 2)
            $remainingSpace = $contentWidth - $lineWidth - $padding
            $titleLine = "║  " + (" " * $padding) + $currentLine + (" " * $remainingSpace) + "  ║"
            $titleLines += $titleLine
        }
    }

    # 输出横幅
    Write-UiPrimary $topBorder
    Write-UiPrimary $emptyLine

    foreach ($line in $titleLines) {
        Write-UiPrimary $line
    }

    Write-UiPrimary $emptyLine
    Write-UiPrimary $bottomBorder
    Write-Host ""
}

function Show-CcqLogo {
    <#
    .SYNOPSIS
    显示 CCQ ASCII Art Logo + 副标题
    .PARAMETER Subtitle
    Logo 下方的副标题文字（可选）
    #>
    param(
        [string]$Subtitle = ""
    )

    $logoLines = @(
        "  ██████╗  ██████╗  ██████╗ "
        " ██╔════╝ ██╔════╝ ██╔═══██╗"
        " ██║      ██║      ██║   ██║"
        " ██║      ██║      ██║▄▄ ██║"
        "  ╚██████╗ ╚██████╗ ╚██████╔╝"
        "  ╚═════╝  ╚═════╝  ╚══▀▀═╝ "
    )

    Write-Host ""
    foreach ($line in $logoLines) {
        Write-UiPrimary $line
    }

    if ($Subtitle) {
        $Subtitle = Convert-EmojiToText -Text $Subtitle
        Write-Host ""
        Write-UiPrimary "  $Subtitle"
    }
    Write-Host ""
}

function Get-MenuItemPhysicalLines {
    <#
    .SYNOPSIS
    计算菜单项在终端中占用的物理行数（考虑自动换行和中日韩宽字符）
    #>
    param(
        [string]$Prefix,
        [string]$OptionText
    )

    $displayWidth = (Get-StringDisplayWidth -Text $Prefix) + (Get-StringDisplayWidth -Text $OptionText)
    $termWidth = 80
    try { $termWidth = [Console]::WindowWidth } catch { }
    if ($termWidth -le 0) { $termWidth = 80 }

    return [int][Math]::Max(1, [Math]::Ceiling($displayWidth / $termWidth))
}

function Show-SingleSelectMenu {
    <#
    .SYNOPSIS
    显示箭头键单选菜单
    .PARAMETER Title
    菜单标题
    .PARAMETER Options
    选项数组
    .PARAMETER DefaultIndex
    默认选中的索引
    .RETURNS
    选中的索引
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title,

        [Parameter(Mandatory = $true)]
        [string[]]$Options,

        [int]$DefaultIndex = 0
    )

    if ($Options.Count -eq 0) {
        throw "选项数组不能为空"
    }

    $selectedIndex = [Math]::Max(0, [Math]::Min($DefaultIndex, $Options.Count - 1))

    # 如果不支持 ANSI，使用简化版本
    if (-not $script:SupportsAnsi) {
        Write-UiPrimary $Title
        Write-Host ""

        for ($i = 0; $i -lt $Options.Count; $i++) {
            Write-Host "  $($i + 1). $($Options[$i])"
        }

        do {
            Write-Host ""
            $input = Read-Host "请选择 (1-$($Options.Count))"
            $choice = 0
            if ([int]::TryParse($input, [ref]$choice) -and $choice -ge 1 -and $choice -le $Options.Count) {
                return $choice - 1
            }
            Write-UiDanger "无效选择，请输入 1 到 $($Options.Count) 之间的数字"
        } while ($true)
    }

    # 支持 ANSI 的交互式菜单
    Write-UiPrimary $Title
    Write-Host ""

    function Show-Menu {
        Write-Host "$script:EscapeChar[J" -NoNewline
        for ($i = 0; $i -lt $Options.Count; $i++) {
            if ($i -eq $selectedIndex) {
                $selectedPrefix = Convert-EmojiToText -Text "►"
                Write-UiSuccess "  $selectedPrefix $($Options[$i])"
            } else {
                Write-Host "    $($Options[$i])"
            }
        }
    }

    $totalPhysicalLines = 0
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $totalPhysicalLines += Get-MenuItemPhysicalLines -Prefix "    " -OptionText $Options[$i]
    }

    # 隐藏光标
    try { [Console]::CursorVisible = $false } catch { }

    try {
        Show-Menu

        while ($true) {
            $key = [Console]::ReadKey($true)

            switch ($key.Key) {
                'UpArrow' {
                    $selectedIndex = ($selectedIndex - 1 + $Options.Count) % $Options.Count
                    # 向上移动到菜单起始位置（按物理行数而非选项数）
                    for ($i = 0; $i -lt $totalPhysicalLines; $i++) {
                        Write-Host "$script:EscapeChar[A" -NoNewline
                    }
                    Show-Menu
                }
                'DownArrow' {
                    $selectedIndex = ($selectedIndex + 1) % $Options.Count
                    # 向上移动到菜单起始位置（按物理行数而非选项数）
                    for ($i = 0; $i -lt $totalPhysicalLines; $i++) {
                        Write-Host "$script:EscapeChar[A" -NoNewline
                    }
                    Show-Menu
                }
                'Enter' {
                    Write-Host ""
                    return $selectedIndex
                }
                'Escape' {
                    Write-Host ""
                    return -1
                }
            }
        }
    } finally {
        # 恢复光标
        try { [Console]::CursorVisible = $true } catch { }
    }
}

function Show-MultiSelectMenu {
    <#
    .SYNOPSIS
    显示箭头键多选菜单
    .PARAMETER Title
    菜单标题
    .PARAMETER Options
    选项数组
    .PARAMETER DefaultSelected
    默认选中的索引数组
    .PARAMETER OptionHints
    可选的着色后缀数组，每项为 @{ Text = "..."; Color = "Yellow" }。
    按索引对应 Options，渲染时追加在选项文本后方。
    .RETURNS
    选中的索引数组
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$Title,

        [Parameter(Mandatory = $true)]
        [string[]]$Options,

        [int[]]$DefaultSelected = @(),

        [hashtable[]]$OptionHints = @()
    )

    if ($Options.Count -eq 0) {
        throw "选项数组不能为空"
    }

    $selectedIndex = 0
    $selectedItems = @{}

    # 初始化默认选中项
    foreach ($index in $DefaultSelected) {
        if ($index -ge 0 -and $index -lt $Options.Count) {
            $selectedItems[$index] = $true
        }
    }

    # 如果不支持 ANSI，使用简化版本
    if (-not $script:SupportsAnsi) {
        Write-UiPrimary $Title
        Write-Host ""

        for ($i = 0; $i -lt $Options.Count; $i++) {
            $checked = if ($selectedItems.ContainsKey($i)) { Convert-EmojiToText -Text "[✓]" } else { "[ ]" }
            $hintText = if ($OptionHints.Count -gt $i -and $OptionHints[$i]) { " $($OptionHints[$i].Text)" } else { "" }
            Write-Host "  $($i + 1). $checked $($Options[$i])$hintText"
        }

        Write-Host ""
        Write-Host "输入要切换的选项编号（用空格分隔），或直接按 Enter 确认："

        $input = Read-Host
        if ($input.Trim()) {
            $choices = $input -split '\s+' | Where-Object { $_ }
            foreach ($choice in $choices) {
                $index = 0
                if ([int]::TryParse($choice, [ref]$index) -and $index -ge 1 -and $index -le $Options.Count) {
                    $index--
                    if ($selectedItems.ContainsKey($index)) {
                        $selectedItems.Remove($index)
                    } else {
                        $selectedItems[$index] = $true
                    }
                }
            }
        }

        return @($selectedItems.Keys | Sort-Object)
    }

    # 支持 ANSI 的交互式菜单
    Write-UiPrimary $Title
    Write-Host ""
    $navHint = Convert-EmojiToText -Text "使用 ↑↓ 导航，空格键选择/取消，Enter 确认，Esc 取消"
    Write-UiDim $navHint
    Write-Host ""

    function Show-Menu {
        Write-Host "$script:EscapeChar[J" -NoNewline
        for ($i = 0; $i -lt $Options.Count; $i++) {
            $checked = if ($selectedItems.ContainsKey($i)) { Convert-EmojiToText -Text "[✓]" } else { "[ ]" }
            $hasHint = $OptionHints.Count -gt $i -and $OptionHints[$i]

            if ($i -eq $selectedIndex) {
                $selectedPrefix = Convert-EmojiToText -Text "►"
                Write-UiSuccess "  $selectedPrefix $checked $($Options[$i])" -NoNewline
                if ($hasHint) {
                    Write-Host " $($OptionHints[$i].Text)" -ForegroundColor $OptionHints[$i].Color
                } else {
                    Write-Host ""
                }
            } else {
                Write-Host "    $checked $($Options[$i])" -NoNewline
                if ($hasHint) {
                    Write-Host " $($OptionHints[$i].Text)" -ForegroundColor $OptionHints[$i].Color
                } else {
                    Write-Host ""
                }
            }
        }
    }

    $totalPhysicalLines = 0
    for ($i = 0; $i -lt $Options.Count; $i++) {
        $hintSuffix = if ($OptionHints.Count -gt $i -and $OptionHints[$i]) { " $($OptionHints[$i].Text)" } else { "" }
        $totalPhysicalLines += Get-MenuItemPhysicalLines -Prefix "    [ ] " -OptionText "$($Options[$i])$hintSuffix"
    }

    # 隐藏光标
    try { [Console]::CursorVisible = $false } catch { }

    try {
        Show-Menu

        while ($true) {
            $key = [Console]::ReadKey($true)

            switch ($key.Key) {
                'UpArrow' {
                    $selectedIndex = ($selectedIndex - 1 + $Options.Count) % $Options.Count
                    # 向上移动到菜单起始位置（按物理行数而非选项数）
                    for ($i = 0; $i -lt $totalPhysicalLines; $i++) {
                        Write-Host "$script:EscapeChar[A" -NoNewline
                    }
                    Show-Menu
                }
                'DownArrow' {
                    $selectedIndex = ($selectedIndex + 1) % $Options.Count
                    # 向上移动到菜单起始位置（按物理行数而非选项数）
                    for ($i = 0; $i -lt $totalPhysicalLines; $i++) {
                        Write-Host "$script:EscapeChar[A" -NoNewline
                    }
                    Show-Menu
                }
                'Spacebar' {
                    if ($selectedItems.ContainsKey($selectedIndex)) {
                        $selectedItems.Remove($selectedIndex)
                    } else {
                        $selectedItems[$selectedIndex] = $true
                    }
                    # 向上移动到菜单起始位置（按物理行数而非选项数）
                    for ($i = 0; $i -lt $totalPhysicalLines; $i++) {
                        Write-Host "$script:EscapeChar[A" -NoNewline
                    }
                    Show-Menu
                }
                'Enter' {
                    Write-Host ""
                    $result = @($selectedItems.Keys | Sort-Object)
                    return $result
                }
                'Escape' {
                    Write-Host ""
                    return $null
                }
            }
        }
    } finally {
        # 恢复光标
        try { [Console]::CursorVisible = $true } catch { }
    }
}

function Show-StepProgress {
    <#
    .SYNOPSIS
    显示步骤进度条或统一结果文案
    .PARAMETER StepName
    步骤名称
    .PARAMETER Status
    状态：Running, Success, Failed, Skipped
    .PARAMETER ShowSpinner
    是否显示 Spinner 动画
    .PARAMETER Message
    自定义展示文案；为空时回退为默认状态指示器
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$StepName,

        [Parameter(Mandatory = $true)]
        [ValidateSet('Running', 'Success', 'Failed', 'Skipped')]
        [string]$Status,

        [switch]$ShowSpinner,

        [string]$Message = ''
    )

    $statusIcon = switch ($Status) {
        'Running' { if ($ShowSpinner) { '......' } else { '⚪' } }
        'Success' { '✅' }
        'Failed'  { '❌' }
        'Skipped' { '⏭' }
    }

    $displayMessage = if ([string]::IsNullOrWhiteSpace($Message)) {
        "  $statusIcon $StepName"
    } else {
        "  $Message"
    }

    switch ($Status) {
        'Running' { Write-UiPrimary $displayMessage }
        'Success' { Write-UiSuccess $displayMessage }
        'Skipped' { Write-UiSuccess $displayMessage }
        'Failed'  { Write-UiDanger $displayMessage }
    }
}

function Show-InstallSummary {
    <#
    .SYNOPSIS
    显示安装摘要表格
    .PARAMETER Items
    安装项目数组，每个项目包含 Name, Status, Version 属性
    #>
    param(
        [Parameter(Mandatory = $true)]
        [PSCustomObject[]]$Items
    )

    if ($Items.Count -eq 0) {
        Write-UiWarning "没有安装项目"
        return
    }

    # 计算列宽（CJK 感知：按显示宽度而非字符数）
    $nameWidth = ($Items | ForEach-Object { Get-StringDisplayWidth $_.Name } | Measure-Object -Maximum).Maximum
    $statusWidth = ($Items | ForEach-Object { Get-StringDisplayWidth $_.Status } | Measure-Object -Maximum).Maximum
    $versionWidth = ($Items | ForEach-Object { Get-StringDisplayWidth $_.Version } | Measure-Object -Maximum).Maximum

    # 确保最小宽度（表头中文字符占双倍宽度）
    $nameWidth = [Math]::Max($nameWidth, 10)
    $statusWidth = [Math]::Max($statusWidth, 8)
    $versionWidth = [Math]::Max($versionWidth, 8)

    # 表格边框组件
    $topBorder = Convert-EmojiToText -Text ("┌" + ("─" * ($nameWidth + 2)) + "┬" + ("─" * ($statusWidth + 2)) + "┬" + ("─" * ($versionWidth + 2)) + "┐")
    $midBorder = Convert-EmojiToText -Text ("├" + ("─" * ($nameWidth + 2)) + "┼" + ("─" * ($statusWidth + 2)) + "┼" + ("─" * ($versionWidth + 2)) + "┤")
    $bottomBorder = Convert-EmojiToText -Text ("└" + ("─" * ($nameWidth + 2)) + "┴" + ("─" * ($statusWidth + 2)) + "┴" + ("─" * ($versionWidth + 2)) + "┘")

    # 表头（使用 CJK 感知填充）
    Write-UiDim $topBorder
    $header = Convert-EmojiToText -Text "│ $(Format-DisplayPad "组件" $nameWidth) │ $(Format-DisplayPad "状态" $statusWidth) │ $(Format-DisplayPad "版本" $versionWidth) │"
    Write-UiInfo $header
    Write-UiDim $midBorder

    # 数据行（使用 CJK 感知填充）
    foreach ($item in $Items) {
        $name = Format-DisplayPad $item.Name $nameWidth
        $status = Format-DisplayPad $item.Status $statusWidth
        $version = Format-DisplayPad $item.Version $versionWidth

        $row = "│ $name │ $status │ $version │"
        $row = Convert-EmojiToText -Text $row

        # 根据状态着色
        switch ($item.Status) {
            { $_ -match "成功|已安装|✓|✅" } { Write-UiSuccess $row }
            { $_ -match "失败|错误|✗|❌" } { Write-UiDanger $row }
            { $_ -match "警告|跳过|⏭" } { Write-UiWarning $row }
            default { Write-UiInfo $row }
        }
    }

    Write-UiDim $bottomBorder
}

function Show-ErrorDetails {
    <#
    .SYNOPSIS
    显示错误详情，支持友好信息和可展开详情
    .PARAMETER FriendlyMessage
    用户友好的错误信息
    .PARAMETER TechnicalDetails
    技术详情
    .PARAMETER ShowDetails
    是否默认显示详情
    #>
    param(
        [Parameter(Mandatory = $true)]
        [string]$FriendlyMessage,

        [string]$TechnicalDetails,

        [switch]$ShowDetails
    )

    Write-UiDanger "❌ $FriendlyMessage"

    if ($TechnicalDetails) {
        if ($ShowDetails) {
            Write-Host ""
            Write-UiInfo "技术详情："
            Write-UiDim $TechnicalDetails
        } else {
            Write-Host ""
            Write-UiDim "按 [D] 键查看技术详情，或其他键跳过..."

            $key = [Console]::ReadKey($true)
            if ($key.KeyChar -eq 'd' -or $key.KeyChar -eq 'D') {
                Write-Host ""
                Write-UiInfo "技术详情："
                Write-UiDim $TechnicalDetails
            }
        }
    }

    Write-Host ""
}

# 初始化终端能力
Initialize-TerminalCapabilities

# 注意：此脚本通过 dot-source 加载，不需要 Export-ModuleMember
# 所有函数在 dot-source 后自动可用