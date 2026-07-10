// ccq CLI 帮助文本（单一数据源）。
// 总帮助 + 各子命令帮助。新增子命令时在此注册一行 + 补一段 help 文本即可。

import { CCQ_VERSION } from '../version.js';

export const USAGE_HEADER = `ccq v${CCQ_VERSION} — Claude Code Quickstart 管理控制台`;

export const HELP_GENERAL = `${USAGE_HEADER}

用法:
  ccq                      进入交互式 TUI（默认）
  ccq <verb> [object] [--flags] [-- 透传...]

子命令:
  cc <name> [args...]     临时用指定 Claude provider 启动 claude（不写盘）
                          等价: claude --settings ~/.claude/providers/<name>.json [args...]
  cx [name] [args...]     启动 codex；有 name 时等价 codex --profile <name> [args...]
  ls [--tool <tool>]      列出 provider/profile 并标记当前默认（tool=claude|codex，默认 claude）
  use <name> [--tool <tool>]
                          设默认 provider/profile（默认 tool=claude）
  update [--check]        检查或更新 ccq 可执行文件
  tools update [name]     更新全部可更新工具，或更新指定工具
  tools uninstall <name> [--yes|-y]
                          卸载指定工具；默认要求 y/N 确认，传 --yes 或 -y 跳过确认
  uninstall [--yes|-y]    卸载 ccq 本体；默认要求 y/N 确认，传 --yes 或 -y 跳过确认
  help [verb]             显示总帮助或某子命令帮助

动词分类（设计约定）:
  启动类（cc/cx）  后续 token = provider/profile 名 + 透传给底层工具；用 -- 分隔透传
  管理类（ls/use/update/tools/uninstall 及未来 mcp/skills）  子命令 + ccq 自有 flag，不透传

通用 flag:
  -v, --version           输出版本号
  -h, --help              输出本帮助

透传:
  cc/cx 的后续参数原样传给 claude/codex。如与 ccq 自身 flag 冲突，用 -- 显式分隔:
    ccq cc glm -p "hi"              → claude --settings .../glm.json -p "hi"
    ccq cx dev -- -m gpt-5 --help    → codex --profile dev -m gpt-5 --help

说明:
  cc/cx = 临时跑（无副作用）
  use   = 设默认（侵入式，对应 TUI「设为默认」，写盘）
  卸载类命令默认交互确认；传 --yes 或 -y 才跳过 y/N。
`;

export const HELP_CC = `ccq cc — 临时用指定 Claude provider 启动 claude

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

export const HELP_CX = `ccq cx — 启动 Codex

用法:
  ccq cx [name] [codex-args...] [-- 透传...]

行为:
  - 不带 name 时直接启动 plain codex，让 Codex 读取 ~/.codex/config.toml
  - 带 name 时校验 ~/.codex/<name>.config.toml 存在，并启动 codex --profile <name>
  - 不读取 ccq vault，不注入 API key env；Codex 自行读取 profile TOML 或官方登录状态
  - codex 不在 PATH 时返回 127，并提示到 TUI 工具管理安装 CodexCli

示例:
  ccq cx                           # 交互式 codex，使用 Codex base config
  ccq cx deepseek                  # codex --profile deepseek
  ccq cx deepseek -m gpt-5          # 透传 -m
  ccq cx deepseek -- -m gpt-5       # 用 -- 显式分隔透传
`;

export const HELP_LS = `ccq ls — 列出 provider/profile

用法:
  ccq ls
  ccq ls --tool claude
  ccq ls --tool codex

行为:
  - 默认等价 ccq ls --tool claude
  - claude：扫描 ~/.claude/providers/*.json，列出 key + BaseUrl，并标记当前默认 provider
  - codex：扫描 ~/.codex 下的 <key>.config.toml，列出 profile 并标记当前默认
  - 非 TTY 友好（纯文本输出，可在管道/CI 中使用）
`;

export const HELP_USE = `ccq use — 设默认 provider/profile

用法:
  ccq use <name>
  ccq use <name> --tool claude
  ccq use <name> --tool codex

行为:
  - 默认等价 ccq use <name> --tool claude
  - claude：将 <name> 的 env 合并写入 ~/.claude/settings.json（持久生效）
  - codex：读取 ~/.codex/<name>.config.toml，并结构化写入 ~/.codex/config.toml
  - codex 不写 profile = "<name>" 或 [profiles.<name>]

与 cc/cx 的区别:
  use 改的是全局状态（写盘）；cc/cx 不写盘，仅本次会话生效。
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
		case 'cx':
			return HELP_CX;
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
