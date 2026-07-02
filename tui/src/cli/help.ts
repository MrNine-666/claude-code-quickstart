// ccq CLI 帮助文本（单一数据源）。
// 总帮助 + 各子命令帮助。新增子命令时在此注册一行 + 补一段 help 文本即可。

import { CCQ_VERSION } from '../version.js';

export const USAGE_HEADER = `ccq v${CCQ_VERSION} — Claude Code Quickstart 管理控制台`;

export const HELP_GENERAL = `${USAGE_HEADER}

用法:
  ccq                      进入交互式 TUI（默认）
  ccq <verb> [object] [--flags] [-- 透传...]

子命令:
  cc <name> [args...]     临时用指定 provider 启动 claude（不写盘，session 级覆盖）
                          等价: claude --settings ~/.claude/providers/<name>.json [args...]
  ls                      列出所有 provider 并标记当前默认
  use <name>              设默认 provider（写入 ~/.claude/settings.json，持久生效）
  update [--check]        检查或更新 ccq 可执行文件
  tools update [name]     更新全部可更新工具，或更新指定工具
  tools uninstall <name> [--yes|-y]
                          卸载指定工具；默认要求 y/N 确认，传 --yes 或 -y 跳过确认
  uninstall [--yes|-y]    卸载 ccq 本体；默认要求 y/N 确认，传 --yes 或 -y 跳过确认
  help [verb]             显示总帮助或某子命令帮助

多工具预留（未实现）:
  cx <name> [args...]     未来: 临时用 codex provider 启动 codex（codex --profile <name>）
  ls --tool <tool>        未来: 按工具筛选 provider（--tool 缺省=claude）
  use <name> --tool <t>   未来: 按工具设默认

动词分类（设计约定）:
  启动类（cc/cx）  后续 token = provider 名 + 透传给底层工具；用 -- 分隔透传
  管理类（ls/use/update/tools/uninstall 及未来 mcp/skills）  子命令 + ccq 自有 flag，不透传

通用 flag:
  -v, --version           输出版本号
  -h, --help              输出本帮助

透传:
  cc 的后续参数原样传给 claude。如与 ccq 自身 flag 冲突，用 -- 显式分隔:
    ccq cc glm -p "hi"              → claude --settings .../glm.json -p "hi"
    ccq cc glm -- -p "hi" --verbose → claude --settings .../glm.json -p "hi" --verbose

说明:
  cc  = 临时跑（无副作用，对应官方 --settings session 覆盖）
  use = 设默认（侵入式，对应 TUI「设为默认」，写盘）
  卸载类命令默认交互确认；传 --yes 或 -y 才跳过 y/N。
`;

export const HELP_CC = `ccq cc — 临时用指定 provider 启动 claude

用法:
  ccq cc <name> [claude-args...] [-- 透传...]

行为:
  - 读取 ~/.claude/providers/<name>.json 作为 claude 的 --settings（session 级，不写盘）
  - <name> 之后的参数原样透传给 claude
  - <name> 不存在或无效时，列出可用 provider 并以退出码 1 退出

示例:
  ccq cc glm                       # 交互式 claude，套用 providers/glm.json
  ccq cc glm -p "重构这段"          # 透传 -p
  ccq cc glm -- -p "x" --verbose   # 用 -- 显式分隔透传
`;

export const HELP_LS = `ccq ls — 列出所有 provider

用法:
  ccq ls

行为:
  - 扫描 ~/.claude/providers/*.json，列出 key + BaseUrl
  - 标记当前默认 provider（* 前缀，依据 ~/.claude/settings.json 的 env 匹配）
  - 非 TTY 友好（纯文本输出，可在管道/CI 中使用）
`;

export const HELP_USE = `ccq use — 设默认 provider

用法:
  ccq use <name>

行为:
  - 将 <name> 的 env 合并写入 ~/.claude/settings.json（持久生效）
  - 等价于 TUI「设为默认」操作（含旧格式迁移、严格字段所有权）
  - 后续所有 claude 调用自动套用该 provider

与 cc 的区别:
  use 改的是全局状态（写盘）；cc 不写盘，仅本次会话生效。
`;

export const HELP_UPDATE = `ccq update — 更新 ccq 可执行文件

用法:
  ccq update
  ccq update --check

行为:
  - --check 只检查 GitHub Release latest，不下载也不替换
  - 无 --check 时下载对应平台的 ccq 可执行文件并应用更新
  - Windows 下运行中 exe 无法直接替换，更新会在下次启动时尝试完成
`;

export const HELP_TOOLS = `ccq tools — 管理工具更新与卸载

用法:
  ccq tools update
  ccq tools update <name>
  ccq tools uninstall <name>
  ccq tools uninstall <name> --yes
  ccq tools uninstall <name> -y

行为:
  - update：更新所有检测到 hasUpdate=true 的工具
  - update <name>：只更新指定工具
  - uninstall <name>：卸载指定工具，默认要求输入 y/N 确认
  - uninstall <name> --yes / -y：跳过确认直接卸载（适合脚本/CI）

可用工具名:
  ClaudeCode / Ccline / CcgWorkflow / OpenSpec / CodeGraph / CodexCli / AntigravityCli
`;

export const HELP_UNINSTALL = `ccq uninstall — 卸载 ccq 本体

用法:
  ccq uninstall
  ccq uninstall --yes
  ccq uninstall -y

行为:
  - 删除 ~/.local/bin/ccq[.exe]
  - 默认要求输入 y/N 确认
  - 传 --yes / -y 时跳过确认直接执行
  - 非 TTY 环境必须传 --yes 或 -y，否则拒绝执行
`;

/** 取某动词的帮助文本；未知动词返回 null。 */
export function helpFor(verb?: string): string | null {
	switch (verb) {
		case 'cc':
			return HELP_CC;
		case 'ls':
			return HELP_LS;
		case 'use':
			return HELP_USE;
		case 'update':
			return HELP_UPDATE;
		case 'tools':
			return HELP_TOOLS;
		case 'uninstall':
			return HELP_UNINSTALL;
		case undefined:
			return HELP_GENERAL;
		default:
			return null;
	}
}
