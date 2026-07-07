// ccq CLI 子命令骨架的 argv 三段式解析（动词路由 + 对象解析 + `--` 透传）。
// 长远命名空间：cc | cx | ls | use | rm | add | config | mcp | skills | tools | update
// 本次实现路由：tui(无参) / --version / --help / help / cc / cx / ls / use / update / tools / uninstall；未知动词 → 提示 help。
//
// 设计要点：
// - process.argv 前两项是 bun 路径与脚本路径，调用方传入 argv.slice(2)。
// - `cc`/`cx` 是启动类：对象名之后全部透传给底层 claude/codex，遇到 `--` 则丢弃分隔符。
// - `ls`/`use` 是管理类：`--tool claude|codex` 是 ccq 自有 flag，不透传。
// - 管理类命令（update/tools/uninstall）不使用 `--` 透传；卸载类使用 --yes / -y 跳过 y/n 确认。
// - 无参 → kind:'tui'，由入口落现有 TUI 路径（零破坏）。

export type ToolTarget = 'claude' | 'codex';

export type CliIntent =
	| { kind: 'tui' }
	| { kind: 'version' }
	| { kind: 'help'; verb?: string }
	| { kind: 'cc'; name: string; passthrough: string[] }
	| { kind: 'cx'; name?: string; passthrough: string[] }
	| { kind: 'ls'; tool: ToolTarget }
	| { kind: 'use'; name: string; tool: ToolTarget }
	| { kind: 'update'; checkOnly: boolean }
	| { kind: 'tools'; action: 'update' | 'uninstall'; name?: string; assumedYes: boolean }
	| { kind: 'uninstall'; assumedYes: boolean }
	| { kind: 'unknown'; verb: string; args: string[] };

const VERBS = new Set(['cc', 'cx', 'ls', 'use', 'update', 'tools', 'uninstall', 'help']);

/** 将 argv（已 slice(2)）解析为 CliIntent。纯函数，无副作用。 */
export function parseCli(argv: string[]): CliIntent {
	// 无参 → 进 TUI
	if (argv.length === 0) {
		return { kind: 'tui' };
	}

	const first = argv[0]!;

	// 全局 flag
	if (first === '--version' || first === '-v') {
		return { kind: 'version' };
	}

	if (first === '--help' || first === '-h') {
		return { kind: 'help' };
	}

	// help [verb]
	if (first === 'help') {
		const verb = argv[1];
		if (verb && VERBS.has(verb)) {
			return { kind: 'help', verb };
		}

		return { kind: 'help' };
	}

	// 子命令动词
	if (first === 'cc') {
		return parseCc(argv.slice(1));
	}

	if (first === 'cx') {
		return parseCx(argv.slice(1));
	}

	if (first === 'ls') {
		return parseLs(argv.slice(1));
	}

	if (first === 'use') {
		return parseUse(argv.slice(1));
	}

	if (first === 'update') {
		return parseUpdate(argv.slice(1));
	}

	if (first === 'tools') {
		return parseTools(argv.slice(1));
	}

	if (first === 'uninstall') {
		return parseUninstall(argv.slice(1));
	}

	return { kind: 'unknown', verb: first, args: argv.slice(1) };
}

/** 解析 `cc [name] [-- ...透传]` 或 `cc [name] ...透传`。 */
function parseCc(rest: string[]): CliIntent {
	const name = rest[0];
	if (!name || name === '--' || name.startsWith('-')) {
		// 缺 name；provider 名称不允许以 `-` 开头，避免 `ccq cc -p hi` 被误判为 provider=hi。
		return { kind: 'unknown', verb: 'cc', args: rest };
	}

	return { kind: 'cc', name, passthrough: parsePassthrough(rest.slice(1)) };
}

/** 解析 `cx [name] [-- ...透传]` 或 `cx [name] ...透传`；无 name 时启动 plain codex。 */
function parseCx(rest: string[]): CliIntent {
	const first = rest[0];
	if (!first) {
		return { kind: 'cx', passthrough: [] };
	}

	if (first === '--') {
		return { kind: 'cx', passthrough: rest.slice(1) };
	}

	if (first.startsWith('-')) {
		return { kind: 'cx', passthrough: rest };
	}

	return { kind: 'cx', name: first, passthrough: parsePassthrough(rest.slice(1)) };
}

function parsePassthrough(rest: string[]): string[] {
	const ddIndex = rest.indexOf('--');
	return ddIndex >= 0 ? rest.slice(ddIndex + 1) : rest;
}

function parseToolTarget(value: string | undefined): ToolTarget | null {
	if (value === undefined || value === 'claude') {
		return 'claude';
	}

	if (value === 'codex') {
		return 'codex';
	}

	return null;
}

function parseToolFlag(rest: string[], verb: string): ToolTarget | null {
	if (rest.length === 0) {
		return 'claude';
	}

	if (rest.length === 2 && rest[0] === '--tool') {
		return parseToolTarget(rest[1]);
	}

	return verb === 'ls' || verb === 'use' ? null : 'claude';
}

function parseLs(rest: string[]): CliIntent {
	const tool = parseToolFlag(rest, 'ls');
	if (!tool) {
		return { kind: 'unknown', verb: 'ls', args: rest };
	}

	return { kind: 'ls', tool };
}

function parseUse(rest: string[]): CliIntent {
	const name = rest[0];
	if (!name || name === '--' || name.startsWith('-')) {
		return { kind: 'unknown', verb: 'use', args: rest };
	}

	const tool = parseToolFlag(rest.slice(1), 'use');
	if (!tool) {
		return { kind: 'unknown', verb: 'use', args: rest };
	}

	return { kind: 'use', name, tool };
}

/** 解析 `update [--check]`。 */
function parseUpdate(rest: string[]): CliIntent {
	if (rest.length === 0) {
		return { kind: 'update', checkOnly: false };
	}

	if (rest.length === 1 && rest[0] === '--check') {
		return { kind: 'update', checkOnly: true };
	}

	return { kind: 'unknown', verb: 'update', args: rest };
}

/** 解析 `tools update [name]` 与 `tools uninstall <name> [--yes|-y]`。 */
function parseTools(rest: string[]): CliIntent {
	const action = rest[0];
	if (action !== 'update' && action !== 'uninstall') {
		return { kind: 'unknown', verb: 'tools', args: rest };
	}

	if (action === 'update') {
		if (rest.length > 2) {
			return { kind: 'unknown', verb: 'tools', args: rest };
		}

		return { kind: 'tools', action, name: rest[1], assumedYes: false };
	}

	const name = rest[1];
	const yesFlag = rest[2];
	const assumedYes = yesFlag === '--yes' || yesFlag === '-y';
	if (!name || rest.length > (assumedYes ? 3 : 2)) {
		return { kind: 'unknown', verb: 'tools', args: rest };
	}

	return { kind: 'tools', action, name, assumedYes };
}

/** 解析 `uninstall [--yes|-y]`。 */
function parseUninstall(rest: string[]): CliIntent {
	if (rest.length === 0) {
		return { kind: 'uninstall', assumedYes: false };
	}

	if (rest.length === 1 && (rest[0] === '--yes' || rest[0] === '-y')) {
		return { kind: 'uninstall', assumedYes: true };
	}

	return { kind: 'unknown', verb: 'uninstall', args: rest };
}
