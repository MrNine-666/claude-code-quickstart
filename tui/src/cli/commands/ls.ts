// `ccq ls` — 列出所有 provider 并标记当前默认。
// 非 TTY 友好纯文本输出。复用 getProviderList + getActiveProvider，零业务改写。

import { getProviderList, getActiveProvider } from '../../core/provider.js';
import type { ProviderListItem } from '../../core/provider.js';

/** 列出 provider 展示行（含活跃标记）。供 ls 命令与 cc 未找到时复用。 */
export function listProvidersForDisplay(list: ProviderListItem[], activeKey?: string): string[] {
	return list.map(p => {
		const marker = p.key === activeKey ? '*' : ' ';
		return `${marker} ${p.key.padEnd(12)} ${p.baseUrl || '(未配置 BaseUrl)'}`;
	});
}

/** 执行 ls 子命令。返回退出码。 */
export function runLs(): number {
	const list = getProviderList();
	const active = getActiveProvider();
	const activeKey = active?.key;

	if (list.length === 0) {
		console.log('当前没有任何 provider。');
		console.log('运行 `ccq` 进入 TUI 新建供应商，或使用 `ccq add`（待实现）。');
		return 0;
	}

	console.log('Providers（* = 当前默认）:');
	for (const line of listProvidersForDisplay(list, activeKey)) {
		console.log(`  ${line}`);
	}

	return 0;
}