import {definitionHash} from './mcp-vault.js';
import type {McpServerDefinition} from './mcp-contract.js';

// buildMcpConfig：生成 .claude.json mcpServers[id] config、vault meta、permissions、definitionHash。
// 与 Windows installer New-McpSettingsEntry（installer/windows/steps/Mcp.ps1）输出 parity（design D10）。

export type McpConfigEntry = {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	type?: string;
	url?: string;
	// http 类可选凭据 header（如 context7 的 CONTEXT7_API_KEY、exa 的 x-api-key）。
	// cc 写 .claude.json mcpServers[id].headers；cx 用 Codex 原生 http_headers（见下）。
	headers?: Record<string, string>;
	// Codex 原生 http header 字段（config.toml [mcp_servers.<id>.http_headers]）。
	// cx TOML 编辑路径直接使用；toCodexMcpConfig 白名单透传。
	http_headers?: Record<string, string>;
};

export type BuildMcpConfigOk = {
	readonly ok: true;
	readonly config: McpConfigEntry;
	readonly permission: string;
	readonly definitionHash: string;
	readonly credentials: Record<string, string>;
};

export type BuildMcpConfigErr = {readonly ok: false; readonly error: string};

export type BuildMcpConfigResult = BuildMcpConfigOk | BuildMcpConfigErr;

function isBlank(value: unknown): boolean {
	return value == null || String(value).trim() === '';
}

/**
 * 生成 MCP config entry。`values` 为表单收集的凭据键值（key 对齐契约凭据 Name/ArgName/token）。
 * env-file 类型在此拒绝（design D10：本期只读）。
 */
export function buildMcpConfig(
	serverId: string,
	definition: McpServerDefinition,
	values: Record<string, string>
): BuildMcpConfigResult {
	const mcpType = definition.McpType || 'stdio';
	const credentialType = definition.CredentialType || 'none';

	if (credentialType === 'env-file') {
		return {ok: false, error: `${serverId} 使用 env-file 凭据，由安装链管理，本面板不支持编辑保存`};
	}

	if (mcpType === 'software') {
		return {ok: false, error: `${serverId} 为 software 类型，不生成 mcpServers 配置`};
	}

	const credentials: Record<string, string> = {};

	if (mcpType === 'http') {
		const result = buildHttpEntry(serverId, definition, credentialType, values, credentials);
		if (!result.ok) {
			return result;
		}

		return finalize(definition, result.config, credentials, serverId);
	}

	if (mcpType === 'stdio') {
		const result = buildStdioEntry(serverId, definition, credentialType, values, credentials);
		if (!result.ok) {
			return result;
		}

		return finalize(definition, result.config, credentials, serverId);
	}

	return {ok: false, error: `不支持的 MCP 类型: ${mcpType}`};
}

function finalize(
	definition: McpServerDefinition,
	config: McpConfigEntry,
	credentials: Record<string, string>,
	serverId: string
): BuildMcpConfigOk {
	return {
		ok: true,
		config,
		permission: `mcp__${serverId}`,
		definitionHash: definitionHash(definition),
		credentials
	};
}

type EntryResult = {ok: true; config: McpConfigEntry} | BuildMcpConfigErr;

function buildHttpEntry(
	serverId: string,
	definition: McpServerDefinition,
	credentialType: string,
	values: Record<string, string>,
	credentials: Record<string, string>
): EntryResult {
	if (credentialType === 'url-embedded') {
		if (!definition.UrlTemplate) {
			return {ok: false, error: `${serverId} 缺少 UrlTemplate`};
		}

		let resolvedUrl = String(definition.UrlTemplate);
		for (const field of definition.Credentials ?? []) {
			const name = field.Name;
			if (!name) {
				continue;
			}

			const value = values[name];
			if (field.Required && isBlank(value)) {
				return {ok: false, error: `${serverId} 缺少凭据: ${name}`};
			}

			if (!isBlank(value)) {
				credentials[name] = String(value);
				const placeholder = `{${name}}`;
				resolvedUrl = resolvedUrl.split(placeholder).join(encodeURIComponent(String(value)));
			}
		}

		if (/\{[A-Za-z0-9_]+\}/.test(resolvedUrl)) {
			return {ok: false, error: `${serverId} 的 URL 仍包含未替换占位符`};
		}

		return {ok: true, config: {type: 'http', url: resolvedUrl}};
	}

	if (!definition.Url) {
		return {ok: false, error: `${serverId} 缺少 Url`};
	}

	return {ok: true, config: {type: 'http', url: String(definition.Url)}};
}

function buildStdioEntry(
	serverId: string,
	definition: McpServerDefinition,
	credentialType: string,
	values: Record<string, string>,
	credentials: Record<string, string>
): EntryResult {
	if (!definition.Command) {
		return {ok: false, error: `${serverId} 缺少 Command`};
	}

	const args = (definition.Args ?? []).map(String);
	const config: McpConfigEntry = {command: String(definition.Command), args};

	switch (credentialType) {
		case 'single-key': {
			const apiKeyName = String(definition.ApiKeyName ?? '');
			const value = values[apiKeyName];
			if (isBlank(value)) {
				return {ok: false, error: `${serverId} 缺少凭据: ${apiKeyName}`};
			}

			credentials[apiKeyName] = String(value);
			config.env = {[apiKeyName]: String(value)};
			break;
		}

		case 'multi-field': {
			const envMap: Record<string, string> = {};
			for (const field of definition.Credentials ?? []) {
				const name = field.Name;
				if (!name) {
					continue;
				}

				const value = values[name];
				if (field.Required && isBlank(value)) {
					return {ok: false, error: `${serverId} 缺少凭据: ${name}`};
				}

				if (!isBlank(value)) {
					envMap[name] = String(value);
					credentials[name] = String(value);
				}
			}

			if (Object.keys(envMap).length > 0) {
				config.env = envMap;
			}

			break;
		}

		case 'args-multi': {
			for (const field of definition.ArgsCredentials ?? []) {
				const argName = String(field.ArgName ?? '');
				const required = Boolean(field.Required);
				const value = values[argName];

				if (isBlank(value)) {
					if (required) {
						return {ok: false, error: `${serverId} 缺少参数凭据: ${argName}`};
					}

					continue;
				}

				credentials[argName] = String(value);
				config.args!.push(argName, String(value));
			}

			break;
		}

		case 'args-token': {
			const value = values.token;
			if (isBlank(value)) {
				return {ok: false, error: `${serverId} token 为空`};
			}

			credentials.token = String(value);
			config.args!.push(`${definition.TokenArg}=${String(value)}`);
			break;
		}

		default:
			break;
	}

	return {ok: true, config};
}

// ── 自定义 MCP 新增（无契约定义，直接由结构化字段构造） ──────────────────────

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type CustomMcpConfigResult =
	| {readonly ok: true; readonly serverId: string; readonly config: McpConfigEntry; readonly permission: string}
	| {readonly ok: false; readonly error: string};

/** 校验 Server ID（非空 + 合法字符；与已存在 ID 冲突由调用方处理）。供表单/自定义 builder 复用。 */
export function validateServerId(serverId: string): string | null {
	if (isBlank(serverId)) {
		return 'Server ID 不能为空';
	}

	if (!SERVER_ID_PATTERN.test(serverId)) {
		return 'Server ID 只能包含字母、数字、点、下划线、短横线，且需以字母或数字开头';
	}

	return null;
}

/** 解析空格分隔的 args 字符串为数组（连续空白折叠，去除空段）。 */
function parseArgs(raw: string): string[] {
	return raw
		.trim()
		.split(/\s+/)
		.filter(token => token.length > 0);
}

/** 构造自定义 stdio MCP 配置（Server ID + command + args + env key/value）。 */
export function buildCustomStdioConfig(
	serverId: string,
	command: string,
	argsRaw: string,
	env: Record<string, string>
): CustomMcpConfigResult {
	const idError = validateServerId(serverId);
	if (idError) {
		return {ok: false, error: idError};
	}

	if (isBlank(command)) {
		return {ok: false, error: `${serverId} 缺少 Command`};
	}

	const config: McpConfigEntry = {command: command.trim(), args: parseArgs(argsRaw)};
	const cleanEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (!isBlank(key) && !isBlank(value)) {
			cleanEnv[key] = String(value);
		}
	}

	if (Object.keys(cleanEnv).length > 0) {
		config.env = cleanEnv;
	}

	return {ok: true, serverId, config, permission: `mcp__${serverId}`};
}

/** 构造自定义 http MCP 配置（Server ID + URL，要求 http(s):// 前缀）。 */
export function buildCustomHttpConfig(serverId: string, url: string): CustomMcpConfigResult {
	const idError = validateServerId(serverId);
	if (idError) {
		return {ok: false, error: idError};
	}

	const trimmed = url.trim();
	if (isBlank(trimmed)) {
		return {ok: false, error: `${serverId} 缺少 URL`};
	}

	if (!/^https?:\/\//.test(trimmed)) {
		return {ok: false, error: 'URL 必须以 http:// 或 https:// 开头'};
	}

	return {ok: true, serverId, config: {type: 'http', url: trimmed}, permission: `mcp__${serverId}`};
}
