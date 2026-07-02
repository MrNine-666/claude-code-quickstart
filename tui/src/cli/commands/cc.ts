// `ccq cc <name> [args...]` — 临时用指定 provider 启动 claude。
// 不写盘：直接 `claude --settings <profilePath> [args...]`，对应官方 session 级覆盖。
// 透传 TTY：stdio 全 inherit，保证 claude 交互式正常。

import { getProviderList } from '../../core/provider.js';
import { testProviderKey } from '../../core/text-utils.js';
import { listProvidersForDisplay } from './ls.js';

export type ClaudeRunner = (args: readonly string[]) => Promise<number>;

async function runClaudeWithInheritedTty(args: readonly string[]): Promise<number> {
	const proc = Bun.spawn(['claude', ...args], {
		stdio: ['inherit', 'inherit', 'inherit']
	});
	return await proc.exited;
}

/** 执行 cc 子命令。返回退出码（透传 claude 的退出码）。 */
export async function runCc(
	name: string,
	passthrough: string[],
	runClaude: ClaudeRunner = runClaudeWithInheritedTty
): Promise<number> {
	// 名称白名单校验（^[A-Za-z0-9._-]+$，天然防路径穿越：不含 / 与 ..）
	if (!testProviderKey(name)) {
		console.error(`无效 provider 名称: ${name}`);
		console.error('名称只能包含英文字母、数字、点号、下划线和短横线。');
		console.error('提示: 文件名即 provider 名（~/.claude/providers/<name>.json）');
		return 1;
	}

	// 复用 getProviderList 的有效性判定（含 ANTHROPIC_AUTH_TOKEN 校验）
	const list = getProviderList();
	const found = list.find(p => p.key === name);
	if (!found) {
		console.error(`未找到 provider: ${name}`);
		if (list.length > 0) {
			console.error('');
			console.error('可用 provider:');
			for (const line of listProvidersForDisplay(list)) {
				console.error(`  ${line}`);
			}
		} else {
			console.error('当前没有任何 provider。请运行 `ccq` 进入 TUI 新建。');
		}

		console.error('');
		console.error('提示: 文件名即 provider 名（~/.claude/providers/<name>.json）');
		return 1;
	}

	// 透传 claude；profilePath 来自 getProviderList，必在 providersDir 内。
	// runClaude 默认用 Bun.spawn + stdio inherit 透传 TTY；测试可注入 fake runner 捕获参数。
	const args = ['--settings', found.profilePath, ...passthrough];
	try {
		return await runClaude(args);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		// claude 不在 PATH / 启动失败
		if (msg.includes('ENOENT') || msg.toLowerCase().includes('not found') || msg.includes('spawn')) {
			console.error('未检测到 claude 命令。请先完成 Claude Code 安装（运行 `ccq` 进入 TUI 的工具管理）。');
			return 127;
		}

		console.error(`启动 claude 失败: ${msg}`);
		return 1;
	}
}