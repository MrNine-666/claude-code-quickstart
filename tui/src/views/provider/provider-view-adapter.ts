import {truncateToWidth} from '../../core/text-utils.js';
import {
	getMigrationResult,
	loadProviderDisplay,
	loadProviderProfile,
	modelSummary,
	removeProvider,
	switchActiveProvider
} from '../../services/provider-service.js';
import {
	codexModelSummary,
	isCodexOfficialLoggedIn,
	loadCodexProviderDisplay,
	loadCodexProviderProfile,
	removeCodexProvider,
	switchActiveCodexProvider
} from '../../services/codex-service.js';
import {isOfficialLoginKey} from '../../core/codex.js';
import type {ProviderDisplayData, ProviderDisplayProfile} from '../../core/provider.js';
import type {AgentContext} from '../../state/manage-state.js';
import type {ProviderServiceResult} from '../../services/provider-service.js';

export type ProviderHomeRow = {
	readonly key: string;
	readonly baseUrl: string;
	readonly maskedApiKey: string;
	readonly isActive: boolean;
	readonly summary: string;
};

export type ProviderViewAdapter = {
	readonly isCodex: boolean;
	readonly loadDisplay: () => ProviderDisplayData;
	readonly migrationFailures: readonly {readonly key: string; readonly reason?: string}[];
	readonly toHomeRow: (profile: ProviderDisplayProfile) => ProviderHomeRow;
	readonly isOfficial: (profile: ProviderDisplayProfile | null) => boolean;
	readonly isOfficialLoggedIn: () => boolean;
	readonly switchActive: (key: string) => ProviderServiceResult<{readonly providerName: string}>;
	readonly remove: (key: string) => ProviderServiceResult<{readonly clearedSettings: boolean}>;
};

export function createProviderViewAdapter(agentContext: AgentContext): ProviderViewAdapter {
	const isCodex = agentContext === 'cx';
	const migrationFailures = isCodex ? [] : (getMigrationResult()?.failed ?? []);

	return {
		isCodex,
		loadDisplay: isCodex ? loadCodexProviderDisplay : loadProviderDisplay,
		migrationFailures,
		toHomeRow: profile => ({
			key: profile.key,
			baseUrl: profile.baseUrl,
			maskedApiKey: profile.maskedApiKey,
			isActive: profile.isActive,
			summary: truncateToWidth(
				`${profile.baseUrl || '未配置 Base URL'} · ${profile.maskedApiKey} · ${
					isCodex
						? codexModelSummary(loadCodexProviderProfile(profile.profilePath))
						: modelSummary(loadProviderProfile(profile.profilePath))
				}`,
				64
			)
		}),
		isOfficial: profile => (isCodex && profile ? isOfficialLoginKey(profile.key) : false),
		isOfficialLoggedIn: () => isCodex && isCodexOfficialLoggedIn(),
		switchActive: isCodex ? switchActiveCodexProvider : switchActiveProvider,
		remove: isCodex ? removeCodexProvider : removeProvider
	};
}
