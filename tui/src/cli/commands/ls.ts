// `ccq ls` — 列出 Claude provider 或 Codex profile，并标记当前默认。
// 非 TTY 友好纯文本输出。Claude 路径复用 getProviderList + getActiveProvider。

import { getProviderList, getActiveProvider } from '../../core/provider.js';
import { scanCodexProfiles, type CodexProfileListItem } from '../../core/codex.js';
import type { ProviderListItem } from '../../core/provider.js';
import type { ToolTarget } from '../argv.js';

/** 列出 provider 展示行（含活跃标记）。供 ls 命令与 cc 未找到时复用。 */
export function listProvidersForDisplay(list: ProviderListItem[], activeKey?: string): string[] {
	return list.map(p => {
		const marker = p.key === activeKey ? '*' : ' ';
		return `${marker} ${p.key.padEnd(12)} ${p.baseUrl || '(未配置 BaseUrl)'}`;
	});
}

export function listCodexProfilesForDisplay(list: readonly CodexProfileListItem[]): string[] {
	return list.map(p => {
		const marker = p.isDefault ? '*' : ' ';
		const auth = p.providerType === 'officialLogin' ? 'official login' : (p.hasApiKey ? 'api key' : 'custom');
		return `${marker} ${p.key.padEnd(12)} ${p.baseUrl || '(official/default)'} ${auth}`;
	});
}

function runClaudeLs(): number {
	const list = getProviderList();
	const active = getActiveProvider();
	const activeKey = active?.key;

	if (list.length === 0) {
		console.log('当前没有任何供应商。');
		console.log('运行 `ccq` 进入 TUI 新建供应商，或使用 `ccq add`（待实现）。');
		return 0;
	}

	console.log('供应商（* = 当前默认）:');
	for (const line of listProvidersForDisplay(list, activeKey)) {
		console.log(`  ${line}`);
	}

	return 0;
}

function runCodexLs(): number {
	const scan = scanCodexProfiles();
	const list = scan.profiles;
	for (const failure of scan.failures) {
		console.error(`警告：供应商 ${failure.key} 无法读取：${failure.reason}`);
	}
	if (list.length === 0) {
		console.log('当前没有任何供应商。');
		console.log('运行 `ccq` 进入 TUI，在 Codex 上下文的供应商页中新建。');
		return 0;
	}

	console.log('供应商（* = 当前默认）:');
	for (const line of listCodexProfilesForDisplay(list)) {
		console.log(`  ${line}`);
	}

	return 0;
}

/** 执行 ls 子命令。返回退出码。 */
export function runLs(tool: ToolTarget = 'claude'): number {
	return tool === 'codex' ? runCodexLs() : runClaudeLs();
}
