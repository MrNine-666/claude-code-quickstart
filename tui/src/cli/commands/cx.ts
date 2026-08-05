// `ccq cx [key] [args...]` — 启动 Codex。
// 有 key 时使用官方 `codex --profile <key>`；无 key 时 plain `codex` 读取 base config。
// 不写盘、不注入 ccq vault/env；Codex 自行读取 ~/.codex/profile TOML。

import {codexProfileExists, isOfficialLoginKey, safeCodexProfileKey} from '../../core/codex.js';
import {runWithInheritedTty} from '../process-runner.js';

export type CodexRunner = (args: readonly string[]) => Promise<number>;

async function runCodexWithInheritedTty(args: readonly string[]): Promise<number> {
	return await runWithInheritedTty('codex', args);
}

/** 执行 cx 子命令。返回退出码（透传 codex 的退出码）。 */
export async function runCx(
	name: string | undefined,
	passthrough: string[],
	runCodex: CodexRunner = runCodexWithInheritedTty
): Promise<number> {
	let args: string[] = [...passthrough];
	// official login 虚拟条目无 profile 文件：codex 不认 `--profile official`，等价 plain codex 读 base config。
	if (name && !isOfficialLoginKey(name)) {
		let safe: string;
		try {
			safe = safeCodexProfileKey(name);
		} catch {
			console.error(`无效供应商名称: ${name}`);
			console.error('名称只能包含英文字母、数字、点号、下划线和短横线，且不能为 . / .. 或以 - 开头。');
			return 1;
		}

		if (!codexProfileExists(safe)) {
			console.error(`未找到供应商: ${safe}`);
			console.error('请运行 `ccq` 进入 TUI 的供应商页新建。');
			return 1;
		}

		args = ['--profile', safe, ...passthrough];
	}

	try {
		return await runCodex(args);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (msg.includes('ENOENT') || msg.toLowerCase().includes('not found') || msg.includes('spawn')) {
			console.error('未检测到 codex 命令。请运行 `ccq` 进入 TUI 的工具管理安装 CodexCli。');
			return 127;
		}

		console.error(`启动 codex 失败: ${msg}`);
		return 1;
	}
}
