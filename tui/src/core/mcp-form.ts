import {loadMcpContract, type McpServerDefinition} from './mcp-contract.js';
import {validateServerId, type McpConfigEntry} from './mcp-config-builder.js';
import {parse as parseToml, stringify as stringifyToml, type TomlDocument} from './toml-edit.js';
import {toCodexMcpConfig} from './mcp-codex-schema.js';

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

/** 收集可选 header 占位（如 context7/exa 的可选 API key）：{HeaderName: ''}，值留空表示匿名使用。 */
function collectOptionalHeaderKeys(def: McpServerDefinition): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const field of def.OptionalHeaders ?? []) {
		if (field.HeaderName) {
			headers[field.HeaderName] = '';
		}
	}

	return headers;
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

	for (const header of def.OptionalHeaders ?? []) {
		if (header.Url) {
			parts.push(`${header.Label ?? header.HeaderName}: ${header.Url}`);
		}
	}

	return parts.length > 0 ? parts.join('；') : undefined;
}

/**
 * 收集 args 类凭据占位（args-multi 的 ArgName + 空值 / args-token 的 TokenArg= 空值）。
 * 对齐 buildMcpConfig 的 args 拼装：args-multi 按 [argName, value] 顺序追加，args-token 按 `${TokenArg}=value` 追加。
 * 模板预填时 value 留空占位，用户填值即可直接保存（格式与契约保存一致，填完无需再手动补前缀）。
 */
function collectArgsCredentialPlaceholders(def: McpServerDefinition): string[] {
	const credentialType = def.CredentialType;
	const placeholders: string[] = [];

	if (credentialType === 'args-multi') {
		for (const cred of def.ArgsCredentials ?? []) {
			const argName = cred.ArgName;
			if (argName) {
				placeholders.push(argName, '');
			}
		}
	} else if (credentialType === 'args-token') {
		const tokenArg = def.TokenArg;
		if (tokenArg) {
			placeholders.push(`${tokenArg}=`);
		}
	}

	return placeholders;
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

		// 可选 header 占位（如 context7/exa 的可选 API key）：留空即匿名使用，填值即带 header 保存。
		const headers = collectOptionalHeaderKeys(def);
		if (Object.keys(headers).length > 0) {
			config.headers = headers;
		}

		return {json: stringifyConfig(config), credHint};
	}

	const config: McpConfigEntry = {
		command: def.Command ?? '',
		args: [...(def.Args ?? []), ...collectArgsCredentialPlaceholders(def)]
	};
	if (Object.keys(env).length > 0) {
		config.env = env;
	}

	return {json: stringifyConfig(config), credHint};
}

export type McpTomlTemplateResult = {readonly toml: string; readonly credHint?: string};

/**
 * 内置 MCP 模板（cx/Codex TOML）：从契约派生 config → toCodexMcpConfig（去 type、白名单）→ TOML 文本。
 * - http：url + [http_headers]（OptionalHeaders 占位，Codex 原生字段）
 * - stdio：command / args / env
 * - software / 无契约：返回 null（自定义场景由调用方给空白 TOML）
 * 复用 getMcpTemplateJson 的 config 派生：JSON 模板的 headers（Claude 语义）改写为 http_headers（Codex 语义）。
 */
export function getMcpTemplateToml(serverId: string): McpTomlTemplateResult | null {
	const jsonTemplate = getMcpTemplateJson(serverId);
	if (!jsonTemplate) {
		return null;
	}

	const config = JSON.parse(jsonTemplate.json) as McpConfigEntry;
	// JSON 模板用 headers（Claude 语义），Codex 用 http_headers；改名后交给 toCodexMcpConfig 白名单过滤。
	if (config.headers) {
		config.http_headers = config.headers;
		delete config.headers;
	}

	// 带 [mcp_servers.<id>] 头，与真实 config.toml 片段一致（add 内置模板即预填 table 名 = serverId）。
	return {toml: tomlFromConfig(config as Record<string, unknown>, serverId), credHint: jsonTemplate.credHint};
}

/** config 对象 → pretty JSON 文本（末尾换行，便于 textarea 编辑）。 */
export function configToJson(config: Record<string, unknown> | null): string {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return stringifyConfig({});
	}

	return stringifyConfig(config);
}

/**
 * config 对象 → Codex TOML 文本（编辑回显用）。
 * 先 toCodexMcpConfig（去 type、白名单，含 http_headers 透传），再序列化为 TOML。
 * 传入 serverId 时包上 `[mcp_servers.<id>]` table 头，与真实 ~/.codex/config.toml 片段一致，
 * 让用户在编辑区直接看到 MCP 身份（id 不在字段正文里，是 table 名）。
 * 空/非法 config 返回空串（对齐 cx add 模式空白模板）。
 */
export function configToToml(config: Record<string, unknown> | null, serverId?: string): string {
	if (!config || typeof config !== 'object' || Array.isArray(config)) {
		return '';
	}

	return tomlFromConfig(config, serverId);
}

function stringifyConfig(config: unknown): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * config → Codex TOML 文本（去 type、白名单过滤后 stringify）。空对象返回空串。
 * 传入 serverId 时把 config 嵌进 `{mcp_servers: {<id>: config}}` 再序列化，
 * 产出带 `[mcp_servers.<id>]` 头的完整片段（嵌套 env/http_headers 由 stringifyToml 正确处理为子表）。
 */
function tomlFromConfig(config: Record<string, unknown>, serverId?: string): string {
	const codexConfig = toCodexMcpConfig(config);
	if (Object.keys(codexConfig).length === 0) {
		return '';
	}

	const id = serverId?.trim();
	if (id) {
		return stringifyToml({mcp_servers: {[id]: codexConfig}} as TomlDocument);
	}

	return stringifyToml(codexConfig as TomlDocument);
}

export type McpFormPayload = {readonly serverId: string; readonly config: McpConfigEntry};

export type McpFormParseResult =
	| {readonly ok: true; readonly payload: McpFormPayload}
	| {readonly ok: false; readonly error: string};

export type McpJsonFormatResult =
	| {readonly ok: true; readonly value: Record<string, unknown>}
	| {readonly ok: false; readonly error: string};

/**
 * 仅校验 JSON 文本格式（语法 + 顶层对象），不校验 serverId / 业务字段。
 * 供表单 textarea 实时校验：编辑即提示格式错误，无需等到保存（对齐供应商表单实时校验）。
 */
export function parseMcpJsonFormat(json: string): McpJsonFormatResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return {ok: false, error: '配置必须是 JSON 对象'};
	}

	return {ok: true, value: parsed as Record<string, unknown>};
}

/**
 * 仅校验 TOML 文本格式（语法 + 顶层 table），不校验 serverId / 业务字段。
 * 供 cx 表单 textarea 实时校验（对齐 parseMcpJsonFormat）。空文本解析为 {}，
 * 由后续 buildConfigFromRaw 给出「需 command/url」的既有错误语义。
 */
export function parseMcpTomlFormat(toml: string): McpJsonFormatResult {
	let parsed: TomlDocument;
	try {
		parsed = parseToml(toml);
	} catch (error) {
		return {ok: false, error: `TOML 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	return {ok: true, value: unwrapMcpServersTable(parsed as Record<string, unknown>)};
}

/**
 * 剥掉 `[mcp_servers.<id>]` 外层包裹，取回内层字段。
 * textarea 回显/模板都以真实 config.toml 片段形态展示（含 table 头），但内部解析/落盘只认字段级 config，
 * 故解析时统一还原：若顶层只有 mcp_servers.<id> 一层包裹，返回内层；否则原样返回（兼容用户直接贴裸字段）。
 */
function unwrapMcpServersTable(raw: Record<string, unknown>): Record<string, unknown> {
	const mcpServers = raw.mcp_servers;
	if (!mcpServers || typeof mcpServers !== 'object' || Array.isArray(mcpServers)) {
		return raw;
	}

	const entries = Object.values(mcpServers as Record<string, unknown>);
	const inner = entries[0];
	if (entries.length === 1 && inner && typeof inner === 'object' && !Array.isArray(inner)) {
		return inner as Record<string, unknown>;
	}

	return raw;
}

// TOML 里 `[mcp_servers.<id>]` / `[mcp_servers.<id>.env]` 等 table 头前缀的 id 段。
// id 段 = mcp_servers. 之后、下一个 . 或 ] 之前的内容（不跨点，兼容 id 自身不含点的主流命名）。
const MCP_SERVERS_TABLE_ID_PATTERN = /(\[\s*mcp_servers\.)([^.\]\s]+)/g;

/**
 * 读出 cx TOML 文本里 `[mcp_servers.<id>]` 的首个 table id（供 Server ID 字段回填联动）。
 * 无 table 头（用户贴裸字段）返回 undefined。
 */
export function readMcpServersTableId(toml: string): string | undefined {
	MCP_SERVERS_TABLE_ID_PATTERN.lastIndex = 0;
	const match = MCP_SERVERS_TABLE_ID_PATTERN.exec(toml);
	return match ? match[2] : undefined;
}

/**
 * 把 cx TOML 文本里所有 `[mcp_servers.<旧id>...]` table 头前缀改写为新 id（供 Server ID 字段 → TOML 联动）。
 * 只改写 table 头的 id 段，保留正文/注释/子表后缀（如 .env / .http_headers）；无 table 头则原样返回。
 * newId 为空/空白时不改写（避免写出 `[mcp_servers.]` 非法头）。
 */
export function rewriteMcpServersTableId(toml: string, newId: string): string {
	const trimmed = newId.trim();
	if (trimmed === '') {
		return toml;
	}

	return toml.replace(MCP_SERVERS_TABLE_ID_PATTERN, (_full, prefix: string) => `${prefix}${trimmed}`);
}

type ConfigFromRawResult = {readonly ok: true; readonly config: McpConfigEntry} | {readonly ok: false; readonly error: string};

/**
 * 从解析后的顶层对象（JSON 或 TOML 均可）判定 http/stdio 并产出 McpConfigEntry。
 * 供 cc（JSON）与 cx（TOML）两条解析路径共享，差异仅两点：
 * - headerField：cc 用 'headers'（Claude 语义），cx 用 'http_headers'（Codex 原生字段）。
 * - includeType：cc 保留 type:'http'（.claude.json 语义）；cx 不写 type（Codex 靠 url 判定）。
 */
function buildConfigFromRaw(
	raw: Record<string, unknown>,
	options: {readonly headerField: 'headers' | 'http_headers'; readonly includeType: boolean}
): ConfigFromRawResult {
	const isHttp = raw.type === 'http' || typeof raw.url === 'string';

	if (isHttp) {
		if (typeof raw.url !== 'string' || raw.url.trim() === '') {
			return {ok: false, error: 'http 类型 MCP 必须提供 url'};
		}

		const config: McpConfigEntry = options.includeType ? {type: 'http', url: raw.url} : {url: raw.url};
		// 保留可选凭据 header（如 context7/exa 的 API key）；留空值（匿名使用）不写入 header。
		const headers = normalizeHeaders(raw[options.headerField]);
		if (headers) {
			config[options.headerField] = headers;
		}

		return {ok: true, config};
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

	return {ok: true, config};
}

/**
 * 校验表单输入（cc/JSON）：serverId + JSON 文本 → 合法 payload。
 * - JSON 必须为对象
 * - 类型由内容判定：type==='http' 或含 url → http（需 url）；否则 stdio（需 command）
 * - env 规整为 string→string，args 过滤为 string[]，headers 过滤空值
 */
export function parseMcpFormInput(serverId: string, json: string): McpFormParseResult {
	const trimmedId = serverId.trim();
	const idError = validateServerId(trimmedId);
	if (idError) {
		return {ok: false, error: idError};
	}

	const format = parseMcpJsonFormat(json);
	if (!format.ok) {
		return {ok: false, error: format.error};
	}

	const result = buildConfigFromRaw(format.value, {headerField: 'headers', includeType: true});
	if (!result.ok) {
		return {ok: false, error: result.error};
	}

	return {ok: true, payload: {serverId: trimmedId, config: result.config}};
}

/**
 * 校验表单输入（cx/TOML）：serverId + TOML 文本 → 合法 payload。
 * 与 parseMcpFormInput 同构，差异：header 字段用 Codex 原生 http_headers，http 不写 type（Codex 靠 url 判定）。
 */
export function parseMcpFormInputToml(serverId: string, toml: string): McpFormParseResult {
	const trimmedId = serverId.trim();
	const idError = validateServerId(trimmedId);
	if (idError) {
		return {ok: false, error: idError};
	}

	const format = parseMcpTomlFormat(toml);
	if (!format.ok) {
		return {ok: false, error: format.error};
	}

	const result = buildConfigFromRaw(format.value, {headerField: 'http_headers', includeType: false});
	if (!result.ok) {
		return {ok: false, error: result.error};
	}

	return {ok: true, payload: {serverId: trimmedId, config: result.config}};
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

/**
 * 规整 headers：与 normalizeEnv 不同，过滤空字符串值。
 * 可选 header 占位（如 context7/exa 的 key）用户留空即匿名使用，留空时不应写入空 header。
 */
function normalizeHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined;
	}

	const headers: Record<string, string> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (val === undefined || val === null) {
			continue;
		}

		const str = String(val);
		if (str.trim() === '') {
			continue;
		}

		headers[key] = str;
	}

	return Object.keys(headers).length > 0 ? headers : undefined;
}
