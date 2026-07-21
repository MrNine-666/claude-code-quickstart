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

/**
 * 收集契约中 env 类凭据键（single-key / multi-field），用于模板预填占位。
 * url-embedded 凭据嵌在 URL 占位符里（如 `?tavilyApiKey={TAVILY_API_KEY}`），
 * 不应写入 env——远程 HTTP MCP 不会读 env，用户应直接改 URL。
 */
function collectEnvCredentialKeys(def: McpServerDefinition): Record<string, string> {
	const env: Record<string, string> = {};
	const credentialType = def.CredentialType;
	if (credentialType === 'single-key' && def.ApiKeyName) {
		env[def.ApiKeyName] = '';
	} else if (credentialType === 'multi-field') {
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

/**
 * 收集凭据获取地址提示。
 * 多段用换行拼接（不用「；」同行）：TUI 窄宽软换行会把同行 URL 从中截断，
 * 终端/OSC8 链接触发时路径就不对；URL 独占一行可避免被中文说明挤断。
 */
function collectCredentialHint(def: McpServerDefinition): string | undefined {
	const parts: string[] = [];

	// url-embedded：凭据嵌在 URL 占位符中，明确提示用户把 {NAME} 换成真实 key。
	if (def.CredentialType === 'url-embedded') {
		const placeholders = (def.Credentials ?? []).map(cred => (cred.Name ? `{${cred.Name}}` : '')).filter(Boolean);
		if (placeholders.length > 0) {
			parts.push(`请将 URL 中的 ${placeholders.join('、')} 替换为真实 API Key`);
		}
	}

	if (def.ApiKeyUrl) {
		// URL 单独成行，避免「标签: url」在窄终端被软换行拆断
		parts.push(`${def.ApiKeyName ?? 'API Key'}：`);
		parts.push(String(def.ApiKeyUrl));
	}

	for (const cred of def.Credentials ?? []) {
		if (cred.Url) {
			parts.push(`${cred.Label ?? cred.Name ?? '凭据'}：`);
			parts.push(String(cred.Url));
		}
	}

	for (const cred of def.ArgsCredentials ?? []) {
		if (cred.Url) {
			parts.push(`${cred.Label ?? cred.ArgName ?? '参数'}：`);
			parts.push(String(cred.Url));
		}
	}

	if (def.TokenUrl) {
		parts.push(`${def.TokenLabel ?? 'Token'}：`);
		parts.push(String(def.TokenUrl));
	}

	for (const header of def.OptionalHeaders ?? []) {
		if (header.Url) {
			parts.push(`${header.Label ?? header.HeaderName}：`);
			parts.push(String(header.Url));
		}
	}

	return parts.length > 0 ? parts.join('\n') : undefined;
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
 * - http single-key/multi-field：{ type:'http', url, env(凭据键占位) }
 * - http url-embedded：{ type:'http', url(含 {NAME} 占位) }，无 env；用户直接改 URL
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

export type McpFormPayload = {
	readonly serverId: string;
	readonly config: McpConfigEntry;
	/** 解析期从 URL 占位符/env 兼容路径提取的 vault 凭据（url-embedded）。 */
	readonly credentials?: Record<string, string>;
};

export type McpFormParseResult = {readonly ok: true; readonly payload: McpFormPayload} | {readonly ok: false; readonly error: string};

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

type ConfigFromRawResult = {readonly ok: true; readonly config: McpConfigEntry} | {readonly ok: false; readonly error: string};

/**
 * 从解析后的 JSON 顶层对象判定 http/stdio 并产出 McpConfigEntry（统一 c/Claude 方言，透传式）。
 * 「JSON 即真源」：除必要规整外，用户填的任意字段原样透传（不再白名单裁剪），
 * 让 Codex 的 cwd / env_vars / startup_timeout_sec / enabled_tools 等合法字段能落到 vault 与 runtime。
 * - http（type==='http' 或含 url）：校验 url 非空；env/headers 做空值规整；其余键透传。
 * - stdio：校验 command 非空；args 过滤为 string[]；env 空值规整；其余键透传。
 * - 归一化由下游负责：codex 落盘时 toCodexMcpConfig 去 type、headers→http_headers。
 */
function buildConfigFromRaw(raw: Record<string, unknown>): ConfigFromRawResult {
	const isHttp = raw.type === 'http' || typeof raw.url === 'string';

	if (isHttp) {
		if (typeof raw.url !== 'string' || raw.url.trim() === '') {
			return {ok: false, error: 'http 类型 MCP 必须提供 url'};
		}

		// 透传全部键，再对已知需规整的字段覆盖：type 固定 http（.claude.json 语义），
		// headers 过滤空值（占位留空=匿名使用），env 剔除 null/undefined。
		const config: McpConfigEntry = {...raw, type: 'http', url: raw.url};
		applyBucketOrDelete(config, 'headers', normalizeHeaders(raw.headers));
		applyBucketOrDelete(config, 'env', normalizeEnv(raw.env));
		return {ok: true, config};
	}

	if (typeof raw.command !== 'string' || raw.command.trim() === '') {
		return {ok: false, error: 'stdio 类型 MCP 必须提供 command'};
	}

	const config: McpConfigEntry = {...raw, command: raw.command};
	const args = Array.isArray(raw.args) ? raw.args.filter((item): item is string => typeof item === 'string') : [];
	applyBucketOrDelete(config, 'args', args.length > 0 ? args : undefined);
	applyBucketOrDelete(config, 'env', normalizeEnv(raw.env));
	return {ok: true, config};
}

/** 规整后的值非空则写入对应键，否则删除该键（避免透传原始未规整值或写入空桶）。 */
function applyBucketOrDelete(config: McpConfigEntry, key: string, value: unknown): void {
	if (value === undefined) {
		delete config[key];
	} else {
		config[key] = value;
	}
}

/**
 * 校验表单输入（cc/JSON）：serverId + JSON 文本 → 合法 payload。
 * - JSON 必须为对象
 * - 类型由内容判定：type==='http' 或含 url → http（需 url）；否则 stdio（需 command）
 * - env 规整为 string→string，args 过滤为 string[]，headers 过滤空值
 * - http URL 若含 `{NAME}` 占位符：优先用 env[NAME] 做 encodeURIComponent 替换（兼容旧模板），
 *   成功后剥离对应 env；仍有未替换占位符则报错
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

	const result = buildConfigFromRaw(format.value);
	if (!result.ok) {
		return {ok: false, error: result.error};
	}

	const resolved = resolveUrlEmbeddedPlaceholders(result.config);
	if (!resolved.ok) {
		return {ok: false, error: resolved.error};
	}

	const payload: McpFormPayload = {
		serverId: trimmedId,
		config: resolved.config,
		...(Object.keys(resolved.credentials).length > 0 ? {credentials: resolved.credentials} : {})
	};
	return {ok: true, payload};
}

const URL_PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

type ResolveUrlResult =
	| {readonly ok: true; readonly config: McpConfigEntry; readonly credentials: Record<string, string>}
	| {readonly ok: false; readonly error: string};

/**
 * http URL 占位符解析（url-embedded 安全网）。
 * - 无 `{NAME}`：原样返回
 * - 有占位符：若 env[NAME] 非空，用 encodeURIComponent 替换并收集 credentials，再从 env 移除该键
 * - 替换后仍有占位符：返回明确错误（提示用户把 {NAME} 换成真实 API Key）
 * 对齐 buildMcpConfig 的 url-embedded 替换语义，但不依赖契约定义。
 */
function resolveUrlEmbeddedPlaceholders(config: McpConfigEntry): ResolveUrlResult {
	const url = config.url;
	if (typeof url !== 'string' || !URL_PLACEHOLDER_RE.test(url)) {
		// 重置 lastIndex：全局正则 test 会推进状态
		URL_PLACEHOLDER_RE.lastIndex = 0;
		return {ok: true, config, credentials: {}};
	}

	URL_PLACEHOLDER_RE.lastIndex = 0;
	const names = new Set<string>();
	for (const match of url.matchAll(URL_PLACEHOLDER_RE)) {
		names.add(match[1]!);
	}

	let resolvedUrl = url;
	const credentials: Record<string, string> = {};
	const env: Record<string, string> = {...(config.env ?? {})};

	for (const name of names) {
		const value = env[name];
		if (value == null || String(value).trim() === '') {
			continue;
		}

		credentials[name] = String(value);
		resolvedUrl = resolvedUrl.split(`{${name}}`).join(encodeURIComponent(String(value)));
		delete env[name];
	}

	const remaining = [...resolvedUrl.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => `{${match[1]!}}`);
	if (remaining.length > 0) {
		const unique = [...new Set(remaining)];
		return {
			ok: false,
			error: `URL 仍包含未替换占位符，请把 ${unique.join('、')} 换成真实 API Key`
		};
	}

	const next: McpConfigEntry = {...config, url: resolvedUrl};
	if (Object.keys(env).length > 0) {
		next.env = env;
	} else {
		delete next.env;
	}

	return {ok: true, config: next, credentials};
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
