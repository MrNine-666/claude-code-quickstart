// `ccq use <name>` — 设默认 provider/profile。
// Claude: 复用 core/provider.ts 的 switchProvider，写入 ~/.claude/settings.json。
// Codex: 复用 core/codex.ts 的 setDefaultCodexProfile，结构化写 ~/.codex/config.toml。
// use 会写盘，持久修改默认供应商。

import {getProviderList, CLAUDE_OFFICIAL_KEY} from '../../core/provider.js';
import {switchActiveProvider} from '../../services/provider-service.js';
import {switchActiveCodexProvider} from '../../services/codex-service.js';
import type {ClaudeAuthOptions} from '../../core/claude-auth.js';
import {
	codexProfileExists,
	isOfficialLoginKey,
	redactCodexTomlForOutput,
	safeCodexProfileKey,
	setDefaultCodexProfile
} from '../../core/codex.js';
import {testProviderKey} from '../../core/text-utils.js';
import {listProvidersForDisplay} from './ls.js';
import type {ToolTarget} from '../argv.js';

async function runClaudeUse(name: string, options: ClaudeAuthOptions): Promise<number> {
	if (name !== CLAUDE_OFFICIAL_KEY && !testProviderKey(name)) {
		console.error(`无效供应商名称: ${name}`);
		console.error('名称只能包含英文字母、数字、点号、下划线和短横线。');
		return 1;
	}

	const list = getProviderList();
	if (name !== CLAUDE_OFFICIAL_KEY && !list.some(p => p.key === name)) {
		console.error(`未找到供应商: ${name}`);
		if (list.length > 0) {
			console.error('');
			console.error('可用供应商:');
			for (const line of listProvidersForDisplay(list)) {
				console.error(`  ${line}`);
			}
		} else {
			console.error('当前没有任何供应商。请运行 `ccq` 进入 TUI 新建。');
		}
		return 1;
	}

	try {
		const result = await switchActiveProvider(name, options);
		if (!result.ok) {
			console.error(`设置默认供应商失败: ${result.error}`);
			return 1;
		}
		if (result.warning) console.error(`警告：${result.warning}`);
		else console.log(`已设置默认供应商: ${result.data.providerName}`);
		if (name !== CLAUDE_OFFICIAL_KEY) console.log('后续 claude 调用将读取 ~/.claude/settings.json 中的 env 配置。');
		return 0;
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`设置默认供应商失败: ${msg}`);
		return 1;
	}
}

function runCodexUse(name: string): number {
	// official login 虚拟条目：无文件、不校验存在性，激活 = 清空 config.toml 供应商键回到登录态。
	if (isOfficialLoginKey(name)) {
		const result = switchActiveCodexProvider(name);
		if (!result.ok) {
			console.error(`切换官方账号失败: ${result.error}`);
			return 1;
		}
		if (result.warning) console.error(`警告：${result.warning}`);
		else console.log(`已设置默认供应商: ${result.data.providerName}`);
		return 0;
	}

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
		console.error('请运行 `ccq` 进入 TUI，在 Codex 上下文的供应商页中新建。');
		return 1;
	}

	try {
		setDefaultCodexProfile(safe);
		console.log(`已设置默认供应商: ${safe}`);
		console.log('后续 codex 调用将读取 ~/.codex/config.toml。');
		return 0;
	} catch (error) {
		const msg = redactCodexTomlForOutput(error instanceof Error ? error.message : String(error));
		console.error(`设置默认供应商失败: ${msg}`);
		return 1;
	}
}

function runPiUse(): number {
	console.error('ccq 不再切换 Pi Provider；请在 Pi 配置页编辑 settings.json 的 defaultProvider。');
	return 1;
}

/** 执行 use 子命令。返回退出码。 */
export async function runUse(name: string, tool: ToolTarget = 'claude', options: ClaudeAuthOptions = {}): Promise<number> {
	return tool === 'codex' ? runCodexUse(name) : tool === 'pi' ? runPiUse() : runClaudeUse(name, options);
}
