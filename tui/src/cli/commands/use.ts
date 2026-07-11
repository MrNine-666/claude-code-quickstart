// `ccq use <name>` — 设默认 provider/profile。
// Claude: 复用 core/provider.ts 的 switchProvider，写入 ~/.claude/settings.json。
// Codex: 复用 core/codex.ts 的 setDefaultCodexProfile，结构化写 ~/.codex/config.toml。
// 与 `ccq cc` / `ccq cx` 明确区分：use 写盘；启动类不写盘。

import { getProviderList, switchProvider } from '../../core/provider.js';
import { codexProfileExists, isOfficialLoginKey, safeCodexProfileKey, setDefaultCodexProfile } from '../../core/codex.js';
import { testProviderKey } from '../../core/text-utils.js';
import { listProvidersForDisplay } from './ls.js';
import type { ToolTarget } from '../argv.js';

function runClaudeUse(name: string): number {
	if (!testProviderKey(name)) {
		console.error(`无效 provider 名称: ${name}`);
		console.error('名称只能包含英文字母、数字、点号、下划线和短横线。');
		return 1;
	}

	const list = getProviderList();
	if (!list.some(p => p.key === name)) {
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
		return 1;
	}

	try {
		const result = switchProvider(name);
		console.log(`已设置默认 provider: ${result.providerName}`);
		console.log('后续 claude 调用将读取 ~/.claude/settings.json 中的 env 配置。');
		return 0;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`设置默认 provider 失败: ${msg}`);
		return 1;
	}
}

function runCodexUse(name: string): number {
	// official login 虚拟条目：无文件、不校验存在性，激活 = 清空 config.toml 供应商键回到登录态。
	if (isOfficialLoginKey(name)) {
		try {
			setDefaultCodexProfile(name);
			console.log('已切换默认为 official login（官方账号）。');
			console.log('已清空 ~/.codex/config.toml 供应商键；如未登录请先运行 `codex login`。');
			return 0;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`切换 official login 失败: ${msg}`);
			return 1;
		}
	}

	let safe: string;
	try {
		safe = safeCodexProfileKey(name);
	} catch {
		console.error(`无效 Codex profile 名称: ${name}`);
		console.error('名称只能包含英文字母、数字、点号、下划线和短横线，且不能为 . / .. 或以 - 开头。');
		return 1;
	}

	if (!codexProfileExists(safe)) {
		console.error(`未找到 Codex profile: ${safe}`);
		console.error('请运行 `ccq` 进入 TUI，在 Codex 上下文的供应商页中新建。');
		return 1;
	}

	try {
		setDefaultCodexProfile(safe);
		console.log(`已设置默认 Codex profile: ${safe}`);
		console.log('后续 codex 调用将读取 ~/.codex/config.toml。');
		return 0;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`设置默认 Codex profile 失败: ${msg}`);
		return 1;
	}
}

/** 执行 use 子命令。返回退出码。 */
export function runUse(name: string, tool: ToolTarget = 'claude'): number {
	return tool === 'codex' ? runCodexUse(name) : runClaudeUse(name);
}
