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
import {
	loadPiProviderDisplayData,
	loadPiProviderProfileByRef,
	removePiProvider,
	switchActivePiProvider
} from '../../services/pi-provider-service.js';
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
	readonly switchActive: (key: string) => ProviderServiceResult<{readonly providerName: string}>;
	readonly remove: (key: string) => ProviderServiceResult<{
		readonly clearedSettings?: boolean;
		readonly deleted?: boolean;
		readonly removedModels?: boolean;
		readonly removedAuth?: boolean;
	}>;
};

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
				`${profile.baseUrl || '未配置 Base URL'} · ${profile.maskedApiKey} · ${
					isPi
						? `${profile.modelCount ?? 0} 个模型 · ${profile.source ?? 'unknown'}`
						: isCodex
							? codexModelSummary(loadCodexProviderProfile(profile.profilePath))
							: modelSummary(loadProviderProfile(profile.profilePath))
				}`,
				64
			)
		}),
		isOfficial: profile => (isCodex && profile ? isOfficialLoginKey(profile.key) : false),
		isOfficialLoggedIn: () => isCodex && isCodexOfficialLoggedIn(),
		switchActive: isPi ? switchActivePiProvider : isCodex ? switchActiveCodexProvider : switchActiveProvider,
		remove: isPi ? removePiProvider : isCodex ? removeCodexProvider : removeProvider
	};
}

export {loadPiProviderProfileByRef};
