import {truncateToWidth} from '../../core/text-utils.js';
import {getMigrationResult, loadProviderDisplay, removeProvider, switchActiveProvider} from '../../services/provider-service.js';
import {
	isCodexOfficialLoggedIn,
	loadCodexProviderDisplay,
	removeCodexProvider,
	switchActiveCodexProvider
} from '../../services/codex-service.js';
import {loadPiProviderDisplayData, loadPiProviderProfileByRef, removePiProvider} from '../../services/pi-provider-service.js';
import {isOfficialLoginKey} from '../../core/codex.js';
import type {ProviderDisplayData, ProviderDisplayProfile} from '../../core/provider.js';
import type {AgentContext} from '../../state/manage-state.js';
import type {ProviderServiceResult} from '../../services/provider-service.js';

export type ProviderHomeRow = {
	readonly title?: string;
	readonly key: string;
	readonly baseUrl: string;
	readonly maskedApiKey: string;
	readonly isActive: boolean;
	readonly summary: string;
};

export type ProviderViewAdapter = {
	readonly kind: 'claude' | 'codex' | 'pi';
	readonly isCodex: boolean;
	readonly isPi: boolean;
	readonly loadDisplay: () => ProviderDisplayData;
	readonly migrationFailures: readonly {readonly key: string; readonly reason?: string}[];
	readonly toHomeRow: (profile: ProviderDisplayProfile) => ProviderHomeRow;
	readonly isOfficial: (profile: ProviderDisplayProfile | null) => boolean;
	readonly isOfficialLoggedIn: () => boolean;
	readonly switchActive?: (key: string) => ProviderServiceResult<{readonly providerName: string}>;
	readonly remove: (key: string) => ProviderServiceResult<{
		readonly clearedSettings?: boolean;
		readonly deleted?: boolean;
		readonly removedModels?: boolean;
		readonly removedAuth?: boolean;
	}>;
};

/**
 * 授权登录行（Codex official / Pi OAuth）只展示登录状态文案，不再拼 URL、密钥或模型。
 * 已登录与凭据不完整必须可区分，否则凭据损坏会被误读为可用。
 */
function loginSummary(status: ProviderDisplayProfile['authStatus']): string {
	return status === 'configured' ? '已授权登录' : '授权凭据不完整，请通过 /login 修复';
}

/**
 * Pi 凭据类型：仅 models.json 自定义 Provider 记为「自定义」，内置/内置覆盖/仅 auth 来源记为「官方」。
 */
function piCredentialTypeLabel(source: ProviderDisplayProfile['source']): string {
	return source === 'custom' ? '自定义' : '官方';
}

/**
 * 供应商卡片描述行：Claude Code / Codex / Pi 分别只展示各自必需的凭据事实，不再拼接模型摘要。
 */
function providerHomeSummary(
	profile: ProviderDisplayProfile,
	context: {readonly isPi: boolean; readonly isCodex: boolean; readonly official: boolean}
): string {
	const credential = `${profile.baseUrl || '未配置 Base URL'} · ${profile.maskedApiKey}`;
	if (context.isPi) {
		// 卡片只展示凭据事实（`baseUrl · 掩码凭据 · 类型` / 登录状态），不拼请求头状态。
		return profile.authKind === 'oauth' ? loginSummary(profile.authStatus) : `${credential} · ${piCredentialTypeLabel(profile.source)}`;
	}
	if (context.isCodex && context.official) {
		return isCodexOfficialLoggedIn() ? '已授权登录' : '未授权登录';
	}
	return credential;
}

export function createProviderViewAdapter(agentContext: AgentContext): ProviderViewAdapter {
	const isCodex = agentContext === 'cx';
	const isPi = agentContext === 'pi';
	const migrationFailures = isCodex || isPi ? [] : (getMigrationResult()?.failed ?? []);
	const kind = isPi ? 'pi' : isCodex ? 'codex' : 'claude';

	return {
		kind,
		isCodex,
		isPi,
		loadDisplay: isPi ? loadPiProviderDisplayData : isCodex ? loadCodexProviderDisplay : loadProviderDisplay,
		migrationFailures,
		toHomeRow: profile => ({
			title:
				isPi && profile.displayName?.trim() && profile.displayName.trim() !== profile.key
					? `${profile.displayName.trim()} · ${profile.key}`
					: isPi
						? profile.key
						: undefined,
			key: profile.key,
			baseUrl: profile.baseUrl,
			maskedApiKey: profile.maskedApiKey,
			isActive: profile.isActive,
			summary: truncateToWidth(
				providerHomeSummary(profile, {isPi, isCodex, official: isCodex && isOfficialLoginKey(profile.key)}),
				64
			)
		}),
		isOfficial: profile => (isCodex && profile ? isOfficialLoginKey(profile.key) : false),
		isOfficialLoggedIn: () => isCodex && isCodexOfficialLoggedIn(),
		...(isPi ? {} : {switchActive: isCodex ? switchActiveCodexProvider : switchActiveProvider}),
		remove: isPi ? removePiProvider : isCodex ? removeCodexProvider : removeProvider
	};
}

export {loadPiProviderProfileByRef};
