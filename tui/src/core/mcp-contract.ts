import {loadContract} from './contracts.js';
import type {AgentContext} from '../state/manage-state.js';

// MCP 契约类型（对齐 contracts/mcp-servers.json 的 PascalCase schema）。

export type McpCredentialType =
	| 'none'
	| 'single-key'
	| 'url-embedded'
	| 'multi-field'
	| 'args-multi'
	| 'args-token'
	| 'env-file';

export type McpCredentialField = {
	readonly Name?: string;
	readonly ArgName?: string;
	readonly Label?: string;
	readonly Secret?: boolean;
	readonly Required?: boolean;
	readonly Url?: string;
};

export type McpServerDefinition = {
	readonly Name?: string;
	readonly Description?: string;
	readonly McpType?: 'stdio' | 'http' | 'software';
	readonly Command?: string;
	readonly Args?: readonly string[];
	readonly Url?: string;
	readonly UrlTemplate?: string;
	readonly CredentialType?: McpCredentialType;
	readonly ApiKeyName?: string;
	readonly ApiKeyUrl?: string;
	readonly Credentials?: readonly McpCredentialField[];
	readonly ArgsCredentials?: readonly McpCredentialField[];
	readonly TokenArg?: string;
	readonly TokenLabel?: string;
	readonly TokenUrl?: string;
	readonly EnvFileFields?: readonly McpCredentialField[];
	readonly Category?: string;
	readonly Priority?: number;
	readonly Recommended?: boolean;
	readonly Note?: string;
	/**
	 * 按 agentContext 覆盖 base 定义的字段（effective definition）。
	 * 例：某 MCP 对 Codex 走 remote HTTP、对 Claude Code 走 stdio 时，
	 * base 写通用形态，AgentConfigs.cx / AgentConfigs.cc 覆盖差异字段。
	 */
	readonly AgentConfigs?: Partial<Record<AgentContext, Partial<McpServerDefinition>>>;
	readonly [key: string]: unknown;
};

export type McpContract = {
	readonly servers: Readonly<Record<string, McpServerDefinition>>;
};

type RawMcpContract = {
	McpServers?: Record<string, McpServerDefinition>;
};

let contractCache: McpContract | null = null;

/** 加载 MCP 契约（根级 contracts/mcp-servers.json，带缓存）。 */
export function loadMcpContract(): McpContract {
	if (contractCache) {
		return contractCache;
	}

	const raw = loadContract<RawMcpContract>('mcp-servers.json');
	contractCache = {
		servers: raw.McpServers ?? {}
	};
	return contractCache;
}

/** 仅供测试：重置契约缓存。 */
export function resetMcpContractCache(): void {
	contractCache = null;
}

/**
 * 解析 effective definition：把 base 定义与 AgentConfigs.<agentContext> 的覆盖浅合并，
 * 返回当前 agent 适用的最终定义。未覆盖字段继承 base；AgentConfigs 字段本身不出现在结果中。
 *
 * 设计：AgentConfigs 是可选的 per-agent 覆盖（如 Codex 走 http、Claude 走 stdio）。
 * 无 AgentConfigs 时 pass-through base，不制造差异（避免破坏无差异 MCP 的契约简单性）。
 */
export function resolveEffectiveDefinition(
	definition: McpServerDefinition,
	agentContext: AgentContext
): McpServerDefinition {
	const overrides = definition.AgentConfigs?.[agentContext];
	if (!overrides) {
		const {AgentConfigs: _unused, ...rest} = definition;
		void _unused;
		return rest as McpServerDefinition;
	}

	const {AgentConfigs: _unused, ...base} = definition;
	void _unused;
	return {...base, ...overrides} as McpServerDefinition;
}
