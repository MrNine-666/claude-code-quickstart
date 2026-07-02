// `ccq use <name>` — 设默认 provider。
// 这是持久操作：复用 core/provider.ts 的 switchProvider，写入 ~/.claude/settings.json。
// 与 `ccq cc <name>` 明确区分：use 写盘；cc 不写盘，仅 session 级覆盖。

import { getProviderList, switchProvider } from '../../core/provider.js';
import { testProviderKey } from '../../core/text-utils.js';
import { listProvidersForDisplay } from './ls.js';

/** 执行 use 子命令。返回退出码。 */
export function runUse(name: string): number {
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