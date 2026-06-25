import {loadContract} from './contracts.js';

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
