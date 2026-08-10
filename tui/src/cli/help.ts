// ccq CLI 帮助文本（单一数据源）。
// 总帮助 + 各子命令帮助。新增子命令时在此注册一行 + 补一段 help 文本即可。

import { CCQ_VERSION } from '../version.js';
import { TOOL_DEFINITIONS } from '../core/tools-install.js';

const AVAILABLE_TOOL_IDS = TOOL_DEFINITIONS.map(definition => definition.id).join(' / ');

export const USAGE_HEADER = `ccq v${CCQ_VERSION} — Claude Code Quickstart 管理控制台`;

export const HELP_GENERAL = `${USAGE_HEADER}

用法:
  ccq                      进入交互式 TUI（默认）
  ccq <verb> [object] [--flags]

子命令:
  ls [--tool <tool>]      列出供应商并标记当前默认（tool=claude|codex，默认 claude）
  use <name> [--tool <tool>]
                          设默认供应商（默认 tool=claude）
  update [--check]        检查或更新 ccq 可执行文件
  tools update [name]     更新全部可更新工具，或更新指定工具
  tools uninstall <name> [--yes|-y]
                          卸载指定工具；默认要求 y/N 确认，传 --yes 或 -y 跳过确认
  uninstall [--yes|-y]    卸载 ccq 本体；默认要求 y/N 确认，传 --yes 或 -y 跳过确认
  help [verb]             显示总帮助或某子命令帮助

通用 flag:
  -v, --version           输出版本号
  -h, --help              输出本帮助

说明:
  use 会设置全局默认供应商（对应 TUI「设为默认」，写盘）。
  卸载类命令默认交互确认；传 --yes 或 -y 才跳过 y/N。
`;

export const HELP_LS = `ccq ls — 列出供应商

用法:
  ccq ls
  ccq ls --tool claude
  ccq ls --tool codex

行为:
  - 默认等价 ccq ls --tool claude
  - claude：扫描 ~/.claude/providers/*.json，列出 key + BaseUrl，并标记当前默认供应商
  - codex：扫描 ~/.codex 下的 <key>.config.toml，列出供应商并标记当前默认
  - 非 TTY 友好（纯文本输出，可在管道/CI 中使用）
`;

export const HELP_USE = `ccq use — 设默认供应商

用法:
  ccq use <name>
  ccq use <name> --tool claude
  ccq use <name> --tool codex

行为:
  - 默认等价 ccq use <name> --tool claude
  - claude：将 <name> 的 env 合并写入 ~/.claude/settings.json（持久生效）
  - codex：读取 ~/.codex/<name>.config.toml，并结构化写入 ~/.codex/config.toml
  - codex 不写 profile = "<name>" 或 [profiles.<name>]
`;

export const HELP_UPDATE = `ccq update — 更新 ccq 可执行文件

用法:
  ccq update
  ccq update --check

行为:
  - --check 只检查 GitHub Release latest，不下载也不替换
  - 仅当 latest 语义化版本严格高于当前版本时更新，不会降级
  - 下载前要求 Release 提供合法 size 与 SHA-256 digest，下载后严格校验
  - macOS/Linux 校验通过后原子替换；命令退出后请重新运行 ccq
  - Windows 会安排 helper 在当前命令退出后完成替换，不会自动启动 TUI
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
  ${AVAILABLE_TOOL_IDS}
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
  - Windows 运行中的 ccq.exe 由 helper 在当前命令退出后延迟删除
  - 自卸载只删除 ccq 可执行文件，不删除配置、PATH 或其他工具，也不会重启 TUI
`;

/** 取某动词的帮助文本；未知动词返回 null。 */
export function helpFor(verb?: string): string | null {
	switch (verb) {
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
