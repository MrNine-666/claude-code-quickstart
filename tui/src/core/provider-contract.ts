import {loadContract} from './contracts.js';
import {isNullOrWhiteSpace} from './text-utils.js';

// Provider 受管 env 与内置供应商运行时配置（camelCase，对齐旧 provider-manager.js RUNTIME_CONFIG）。

export type BuiltinProvider = {
	readonly name: string;
	readonly description: string;
	readonly baseUrl: string;
	readonly platformUrl: string;
	readonly modelEnv?: Readonly<Record<string, string>>;
	readonly extraEnv?: Readonly<Record<string, string>>;
	readonly requireModelConfig?: boolean;
};

export type ProviderRuntimeConfig = {
	readonly managedModelEnvKeys: readonly string[];
	readonly modelEnvLabels: Readonly<Record<string, string>>;
	readonly managedExtraEnvKeys: readonly string[];
	readonly legacyModelKey: string;
	readonly builtinProviders: Readonly<Record<string, BuiltinProvider>>;
};

// providers.json 契约形态（PascalCase）。
type RawProviderContract = {
	ManagedEnv?: {
		ProviderManagedModelEnvKeys?: string[];
		ProviderModelEnvLabels?: Record<string, string>;
		ProviderManagedExtraEnvKeys?: string[];
		LegacyProviderModelKey?: string;
	};
	BuiltinProviders?: Record<string, RawBuiltinProvider>;
};

type RawBuiltinProvider = {
	Name?: string;
	Description?: string;
	BaseUrl?: string;
	PlatformUrl?: string;
	ModelEnv?: Record<string, string>;
	ExtraEnv?: Record<string, string>;
	RequireModelConfig?: boolean;
};

/** 将 providers.json 契约（PascalCase）规范化为运行时配置（camelCase）。 */
function normalizeContract(raw: RawProviderContract): ProviderRuntimeConfig {
	const managedEnv = raw.ManagedEnv ?? {};
	const modelEnvLabels: Record<string, string> = {};
	for (const [k, v] of Object.entries(managedEnv.ProviderModelEnvLabels ?? {})) {
		modelEnvLabels[String(k)] = String(v);
	}

	const builtinProviders: Record<string, BuiltinProvider> = {};
	for (const [key, p] of Object.entries(raw.BuiltinProviders ?? {})) {
		const item: {
			name: string;
			description: string;
			baseUrl: string;
			platformUrl: string;
			modelEnv?: Record<string, string>;
			extraEnv?: Record<string, string>;
			requireModelConfig?: boolean;
		} = {
			name: String(p?.Name ?? ''),
			description: String(p?.Description ?? ''),
			baseUrl: String(p?.BaseUrl ?? ''),
			platformUrl: String(p?.PlatformUrl ?? '')
		};

		if (p?.ModelEnv && typeof p.ModelEnv === 'object') {
			item.modelEnv = {};
			for (const [mk, mv] of Object.entries(p.ModelEnv)) {
				item.modelEnv[String(mk)] = String(mv);
			}
		}

		if (p?.ExtraEnv && typeof p.ExtraEnv === 'object') {
			item.extraEnv = {};
			for (const [ek, ev] of Object.entries(p.ExtraEnv)) {
				item.extraEnv[String(ek)] = String(ev);
			}
		}

		if (p?.RequireModelConfig !== undefined) {
			item.requireModelConfig = Boolean(p.RequireModelConfig);
		}

		builtinProviders[key] = item;
	}

	return {
		managedModelEnvKeys: (managedEnv.ProviderManagedModelEnvKeys ?? []).map(String),
		modelEnvLabels,
		managedExtraEnvKeys: (managedEnv.ProviderManagedExtraEnvKeys ?? []).map(String),
		legacyModelKey: String(managedEnv.LegacyProviderModelKey ?? 'modelMapping'),
		builtinProviders
	};
}

let runtimeConfig: ProviderRuntimeConfig | null = null;

/**
 * 加载 Provider 契约：从根级 contracts/providers.json 读取并规范化（带缓存）。
 * 契约缺失时由 loadContract 抛错——TUI 始终注入根级 contracts，不再维护内联 fallback 副本。
 */
export function loadProviderContract(): ProviderRuntimeConfig {
	if (runtimeConfig) {
		return runtimeConfig;
	}

	const raw = loadContract<RawProviderContract>('providers.json');
	runtimeConfig = normalizeContract(raw);
	return runtimeConfig;
}

/** 仅供测试：重置契约缓存，强制下次重新加载。 */
export function resetProviderContractCache(): void {
	runtimeConfig = null;
}

/** 旧版别名映射（opus/sonnet/haiku）→ 受管模型 env 键。 */
export function getManagedModelEnvFromLegacyAliases(
	legacyAliases: Record<string, string> | undefined | null
): Record<string, string> {
	const result: Record<string, string> = {};
	if (!legacyAliases) {
		return result;
	}

	const map: Record<string, string> = {
		haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
		opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
		sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL'
	};

	for (const [alias, envKey] of Object.entries(map)) {
		if (!isNullOrWhiteSpace(legacyAliases[alias])) {
			result[envKey] = String(legacyAliases[alias]);
		}
	}

	return result;
}
