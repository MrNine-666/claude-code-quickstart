// ccq CLI 子命令骨架的 argv 三段式解析（动词路由 + 对象解析 + `--` 透传）。
// 长远命名空间：cc | ls | use | rm | add | config | mcp | skills | tools | update
// 本次实现路由：tui(无参) / --version / --help / help / cc / ls / use；未知动词 → 提示 help。
//
// 设计要点：
// - process.argv 前两项是 bun 路径与脚本路径，调用方传入 argv.slice(2)。
// - `cc` 后第一个非 flag token 为 provider name；遇到 `--` 则其后全数透传，否则 name 之后全部透传。
// - 无参 → kind:'tui'，由入口落现有 TUI 路径（零破坏）。

export type CliIntent =
	| { kind: 'tui' }
	| { kind: 'version' }
	| { kind: 'help'; verb?: string }
	| { kind: 'cc'; name: string; passthrough: string[] }
	| { kind: 'ls' }
	| { kind: 'use'; name: string }
	| { kind: 'unknown'; verb: string; args: string[] };

const VERBS = new Set(['cc', 'ls', 'use', 'help']);

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

	if (first === 'ls') {
		return { kind: 'ls' };
	}

	if (first === 'use') {
		const name = argv[1];
		if (!name) {
			// use 缺 name：当作 unknown 处理，让分发层报用法错误
			return { kind: 'unknown', verb: 'use', args: argv.slice(1) };
		}

		return { kind: 'use', name };
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

	const afterName = rest.slice(1);
	const ddIndex = afterName.indexOf('--');
	let passthrough: string[];
	if (ddIndex >= 0) {
		// `--` 之后原样透传，`--` 自身丢弃
		passthrough = afterName.slice(ddIndex + 1);
	} else {
		passthrough = afterName;
	}

	return { kind: 'cc', name, passthrough };
}