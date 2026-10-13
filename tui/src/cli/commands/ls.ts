// `ccq ls` — 列出 Claude provider 或 Codex profile，并标记当前默认。
// 非 TTY 友好纯文本输出。Claude 使用只读 display + 原生授权查询。

import {CLAUDE_OFFICIAL_KEY} from '../../core/provider.js';
import {refreshClaudeProviderDisplay} from '../../services/provider-service.js';
import {CLAUDE_NATIVE_AUTH_GUIDANCE, type ClaudeAuthOptions} from '../../core/claude-auth.js';
import {scanCodexProfiles, type CodexProfileListItem} from '../../core/codex.js';
import type {ProviderListItem} from '../../core/provider.js';
import type {ToolTarget} from '../argv.js';
import {loadPiProviderDisplay} from '../../core/pi-provider.js';

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
		if (p.providerType === 'officialLogin') return `${marker} ${p.key.padEnd(12)} 官方账号 · 已授权登录`;
		const auth = p.hasApiKey ? 'api key' : 'custom';
		return `${marker} ${p.key.padEnd(12)} ${p.baseUrl || '(未配置 BaseUrl)'} ${auth}`;
	});
}

async function runClaudeLs(options: ClaudeAuthOptions): Promise<number> {
	const display = await refreshClaudeProviderDisplay(options);
	console.log(display.hasProviders ? '供应商（* = 当前默认）:' : '当前没有任何供应商。');
	for (const profile of display.profiles) {
		const marker = profile.isActive ? '*' : ' ';
		const summary =
			profile.key === CLAUDE_OFFICIAL_KEY
				? '官方账号 · 已授权登录'
				: profile.baseUrl || '(未配置 BaseUrl)';
		console.log(`  ${marker} ${profile.key.padEnd(12)} ${summary}`);
		if (profile.authReason) console.error(`警告：${profile.authReason}`);
	}
	for (const failure of display.loadFailures ?? []) console.error(`警告：${failure.key}：${failure.reason}`);
	console.log(CLAUDE_NATIVE_AUTH_GUIDANCE);
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

function runPiLs(): number {
	const display = loadPiProviderDisplay();
	for (const failure of display.loadFailures ?? []) {
		console.error(`警告：Pi ${failure.key} 无法读取：${failure.reason}`);
	}
	if (display.profiles.length === 0) {
		console.log('当前没有任何 Pi Provider。');
		console.log('运行 `ccq` 进入 TUI，在 Pi 上下文的供应商页中新建。');
		return 0;
	}

	console.log('Pi Provider（* = 当前默认）:');
	for (const profile of display.profiles) {
		const marker = profile.isActive ? '*' : ' ';
		const auth = profile.authKind === 'oauth' ? 'OAuth' : profile.authKind === 'api_key' ? 'API Key' : '未认证';
		const modelCount = `${profile.modelCount ?? 0} models`;
		console.log(`  ${marker} ${profile.key.padEnd(24)} ${(profile.displayName ?? '').padEnd(28)} ${auth.padEnd(8)} ${modelCount}`);
	}
	return 0;
}

/** 执行 ls 子命令。返回退出码。 */
export async function runLs(tool: ToolTarget = 'claude', options: ClaudeAuthOptions = {}): Promise<number> {
	return tool === 'codex' ? runCodexLs() : tool === 'pi' ? runPiLs() : runClaudeLs(options);
}
