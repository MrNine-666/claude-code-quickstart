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
	/**
	 * Claude 侧接入限制说明（套餐门槛、上下文档位约束等），呈现为表单 providerType 字段的 helpText。
	 * 与 codex.note 平行：前者说 Claude 侧、后者说 Codex 侧，二者互不回退。
	 */
	readonly note?: string;
	/**
	 * Codex 侧接入形态。缺省即「该供应商不能被 Codex 原生接入」，不在 Codex 表单出现。
	 * Codex CLI 当前仅支持 Responses，故仅自身提供 Responses 兼容端点者才声明本字段；
	 * 仅暴露 Chat Completions 的供应商（当前 Kimi）直连会 404/空流，需经网关转协议。
	 * baseUrl/model 与 Claude 侧不同源：Responses 端点与模型 ID 常与 Anthropic 兼容端点不一致。
	 */
	readonly codex?: CodexProviderTemplate;
};

/**
 * 内置供应商的 Codex 侧一键模板（对应契约 `Codex` 段）。
 * baseUrl/model 为必要字段——缺一即生成不出合法 profile TOML，规范化时整段丢弃。
 * note 可选，记录该供应商的接入限制（如仅某模型支持 Responses）。
 */
export type CodexProviderTemplate = {
	readonly baseUrl: string;
	readonly model: string;
	readonly note?: string;
};

export type ProviderRuntimeConfig = {
	readonly managedModelEnvKeys: readonly string[];
	readonly modelEnvLabels: Readonly<Record<string, string>>;
	readonly legacyModelKey: string;
	readonly builtinProviders: Readonly<Record<string, BuiltinProvider>>;
};

// providers.json 契约形态（PascalCase）。
type RawProviderContract = {
	ManagedEnv?: {
		ProviderManagedModelEnvKeys?: string[];
		ProviderModelEnvLabels?: Record<string, string>;
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
	Note?: string;
	Codex?: {
		BaseUrl?: string;
		Model?: string;
		Note?: string;
	};
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
			note?: string;
			codex?: CodexProviderTemplate;
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

		if (!isNullOrWhiteSpace(p?.Note)) {
			item.note = String(p.Note);
		}

		// Codex 段：baseUrl 与 model 皆非空才视为可接入，缺一即无法生成合法 profile TOML。
		if (p?.Codex && typeof p.Codex === 'object' && !isNullOrWhiteSpace(p.Codex.BaseUrl) && !isNullOrWhiteSpace(p.Codex.Model)) {
			const codex: {baseUrl: string; model: string; note?: string} = {
				baseUrl: String(p.Codex.BaseUrl),
				model: String(p.Codex.Model)
			};
			if (!isNullOrWhiteSpace(p.Codex.Note)) {
				codex.note = String(p.Codex.Note);
			}

			item.codex = codex;
		}

		builtinProviders[key] = item;
	}

	return {
		managedModelEnvKeys: (managedEnv.ProviderManagedModelEnvKeys ?? []).map(String),
		modelEnvLabels,
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
export function getManagedModelEnvFromLegacyAliases(legacyAliases: Record<string, string> | undefined | null): Record<string, string> {
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
