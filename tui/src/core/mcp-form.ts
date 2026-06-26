import {loadMcpContract, type McpServerDefinition} from './mcp-contract.js';
import {validateServerId, type McpConfigEntry} from './mcp-config-builder.js';

// MCP 表单 core（JSON 即真源范式）：模板生成、config↔JSON、保存校验。
// 取代旧字段集/字段↔JSON 联动——表单直接编辑最终 config JSON，落盘前由 parseMcpFormInput 校验。
// 内置 MCP 仅作「模板」提供初始 JSON；保存统一走 persistMcpServer（service 层）。

/** 内置 MCP 列表选项（模板 select 用）：label=Name，value=serverId，排除 software。 */
export function listBuiltinMcpOptions(): {value: string; label: string}[] {
	const servers = loadMcpContract().servers;
	return Object.entries(servers)
		.filter(([, def]) => def.McpType !== 'software')
		.map(([id, def]) => ({value: id, label: def.Name || id}))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** 收集契约中 env 类凭据键（single-key/multi-field/url-embedded），用于模板预填占位。 */
function collectEnvCredentialKeys(def: McpServerDefinition): Record<string, string> {
	const env: Record<string, string> = {};
	const credentialType = def.CredentialType;
	if (credentialType === 'single-key' && def.ApiKeyName) {
		env[def.ApiKeyName] = '';
	} else if (credentialType === 'multi-field' || credentialType === 'url-embedded') {
		for (const cred of def.Credentials ?? []) {
			if (cred.Name) {
				env[cred.Name] = '';
			}
		}
	}

	return env;
}

/** 收集凭据获取地址提示（按字段拼成「字段: URL」分号串）。 */
function collectCredentialHint(def: McpServerDefinition): string | undefined {
	const parts: string[] = [];
	if (def.ApiKeyUrl) {
		parts.push(`${def.ApiKeyName ?? 'API Key'}: ${def.ApiKeyUrl}`);
	}

	for (const cred of def.Credentials ?? []) {
		if (cred.Url) {
			parts.push(`${cred.Label ?? cred.Name ?? '凭据'}: ${cred.Url}`);
		}
	}

	for (const cred of def.ArgsCredentials ?? []) {
		if (cred.Url) {
			parts.push(`${cred.Label ?? cred.ArgName ?? '参数'}: ${cred.Url}`);
		}
	}

	if (def.TokenUrl) {
		parts.push(`${def.TokenLabel ?? 'Token'}: ${def.TokenUrl}`);
	}

	return parts.length > 0 ? parts.join('；') : undefined;
}

export type McpTemplateResult = {readonly json: string; readonly credHint?: string};

/**
 * 内置 MCP 模板：从契约 definition 派生初始 config JSON + 凭据提示。
 * - stdio：{ command, args, env(凭据键占位) }
 * - http：{ type:'http', url, env(凭据键占位) }
 * - software / 无契约：返回 null（自定义场景由调用方给空白模板）
 */
export function getMcpTemplateJson(serverId: string): McpTemplateResult | null {
	const def = loadMcpContract().servers[serverId];
	if (!def) {
		return null;
	}

	const mcpType = def.McpType || 'stdio';
	if (mcpType === 'software') {
		return null;
	}

	const credHint = collectCredentialHint(def);
	const env = collectEnvCredentialKeys(def);

	if (mcpType === 'http') {
		const url = def.Url ?? def.UrlTemplate ?? '';
		const config: McpConfigEntry = url ? {type: 'http', url} : {type: 'http'};
		if (Object.keys(env).length > 0) {
			config.env = env;
		}

		return {json: stringifyConfig(config), credHint};
	}

	const config: McpConfigEntry = {
		command: def.Command ?? '',
		args: [...(def.Args ?? [])]
	};
	if (Object.keys(env).length > 0) {
		config.env = env;
	}

	return {json: stringifyConfig(config), credHint};
}

/** config 对象 → pretty JSON 文本（末尾换行，便于 textarea 编辑）。 */
export function configToJson(config: Record<string, unknown> | null): string {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return stringifyConfig({});
	}

	return stringifyConfig(config);
}

function stringifyConfig(config: unknown): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

export type McpFormPayload = {readonly serverId: string; readonly config: McpConfigEntry};

export type McpFormParseResult =
	| {readonly ok: true; readonly payload: McpFormPayload}
	| {readonly ok: false; readonly error: string};

/**
 * 校验表单输入：serverId + JSON 文本 → 合法 payload。
 * - JSON 必须为对象
 * - 类型由内容判定：type==='http' 或含 url → http（需 url）；否则 stdio（需 command）
 * - env 规整为 string→string，args 过滤为 string[]
 */
export function parseMcpFormInput(serverId: string, json: string): McpFormParseResult {
	const trimmedId = serverId.trim();
	const idError = validateServerId(trimmedId);
	if (idError) {
		return {ok: false, error: idError};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {ok: false, error: '配置必须是 JSON 对象'};
	}

	const raw = parsed as Record<string, unknown>;
	const isHttp = raw.type === 'http' || typeof raw.url === 'string';

	if (isHttp) {
		if (typeof raw.url !== 'string' || raw.url.trim() === '') {
			return {ok: false, error: 'http 类型 MCP 必须提供 url'};
		}

		return {ok: true, payload: {serverId: trimmedId, config: {type: 'http', url: raw.url}}};
	}

	if (typeof raw.command !== 'string' || raw.command.trim() === '') {
		return {ok: false, error: 'stdio 类型 MCP 必须提供 command'};
	}

	const config: McpConfigEntry = {command: raw.command};
	if (Array.isArray(raw.args)) {
		const args = raw.args.filter((item): item is string => typeof item === 'string');
		if (args.length > 0) {
			config.args = args;
		}
	}

	const env = normalizeEnv(raw.env);
	if (env) {
		config.env = env;
	}

	return {ok: true, payload: {serverId: trimmedId, config}};
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const env: Record<string, string> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (val === undefined || val === null) {
			continue;
		}

		env[key] = String(val);
	}

	return Object.keys(env).length > 0 ? env : undefined;
}
