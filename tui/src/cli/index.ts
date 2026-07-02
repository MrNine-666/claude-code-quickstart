// ccq CLI 子命令分发入口。
// 由 index.tsx 在 argv 路由后调用，返回退出码；纯命令分发，不含 TUI 逻辑。
// 新增子命令：在 argv.ts 注册动词 + 在 help.ts 加帮助 + 在此 switch 一支。

import type { CliIntent } from './argv.js';
import { helpFor, HELP_GENERAL } from './help.js';
import { runCc } from './commands/cc.js';
import { runLs } from './commands/ls.js';
import { runUse } from './commands/use.js';

/** 执行已解析的 CliIntent，返回退出码。仅处理非 tui 意图。 */
export async function runCli(intent: CliIntent): Promise<number> {
	switch (intent.kind) {
		case 'tui':
			// 不应进入此函数；由入口直接落 TUI 路径
			return 0;

		case 'version': {
			const { CCQ_VERSION } = await import('../version.js');
			console.log(CCQ_VERSION);
			return 0;
		}

		case 'help': {
			const text = helpFor(intent.verb);
			if (text) {
				console.log(text);
				return 0;
			}

			// help <未知动词>
			console.error(`未知子命令: ${intent.verb}`);
			console.error('');
			console.error(HELP_GENERAL);
			return 1;
		}

		case 'cc':
			return runCc(intent.name, intent.passthrough);

		case 'ls':
			return runLs();

		case 'use':
			return runUse(intent.name);

		case 'unknown': {
			// 未知动词或缺参数的已知动词
			if (intent.verb === 'cc') {
				console.error('cc 缺少 provider 名称。');
				console.error('用法: ccq cc <name> [claude-args...]');
				return 1;
			}

			if (intent.verb === 'use') {
				console.error('use 缺少 provider 名称。');
				console.error('用法: ccq use <name>');
				return 1;
			}

			console.error(`未知命令: ${intent.verb}`);
			console.error('');
			console.error(HELP_GENERAL);
			return 1;
		}

		default: {
			// 穷尽性检查
			const _exhaustive: never = intent;
			void _exhaustive;
			return 1;
		}
	}
}