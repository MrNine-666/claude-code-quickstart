import {existsSync, readFileSync, unlinkSync} from 'node:fs';
import {execCommand} from './exec.js';
import {atomicWrite, readJsonFileStrict, writeJsonAtomic, SECRET_FILE_MODE} from './fs-utils.js';
import {piMcpAdapterOverridesPath, piMcpConfigPath} from './paths.js';
import {detectTool, isVersionAtLeast, TOOL_DEFINITIONS} from './tools-install.js';
import type {McpServerDefinition} from './mcp-contract.js';

// Historical module/sidecar filename retained; this owner manages native MCP only.
export const PI_MCP_NATIVE_DIALECT = 'pi-native';
export const PI_MCP_MIN_VERSION = '1.0.0';
export type PiMcpUnsupportedReason =
	| 'pi-not-installed'
	| 'pi-version-unsupported'
	| 'pi-not-detected'
	| 'definition-not-expressible'
	| 'override-read-failed'
	| 'config-read-failed';
export type PiMcpNativeFact = {
	readonly piInstalled: boolean;
	readonly version: string;
	readonly overrideReadable: boolean;
	readonly configReadable: boolean;
	readonly supported: boolean;
	readonly reason?: PiMcpUnsupportedReason;
};
export type PiMcpOverrideEntry = {readonly enabled: boolean; readonly [key: string]: unknown};
export type PiMcpOverrideDocument = {
	readonly schemaVersion: number;
	readonly dialect?: typeof PI_MCP_NATIVE_DIALECT;
	readonly servers: Readonly<Record<string, PiMcpOverrideEntry>>;
	readonly managedServers?: readonly string[];
	readonly [key: string]: unknown;
};
export type PiMcpOverrideRead =
	| {readonly ok: true; readonly document: PiMcpOverrideDocument}
	| {readonly ok: false; readonly reason: 'override-read-failed'; readonly detail: string};
export type PiMcpConfigDocument = {
	readonly mcpServers: Readonly<Record<string, Record<string, unknown>>>;
	readonly [key: string]: unknown;
};
type PiMcpConfigRead =
	| {readonly ok: true; readonly document: PiMcpConfigDocument}
	| {readonly ok: false; readonly reason: 'config-read-failed'; readonly detail: string};
export type PiMcpConfigSyncResult =
	| {readonly Success: true; readonly Status: 'Synced' | 'Unchanged'}
	| {readonly Success: false; readonly Status: string};
export type PiMcpMutationResult = {readonly Success: boolean; readonly ServerId: string; readonly Status: string};
let detectedFact: PiMcpNativeFact | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

export function readPiMcpAdapterOverride(): PiMcpOverrideRead {
	const result = readJsonFileStrict<unknown>(piMcpAdapterOverridesPath());
	if (result.status === 'missing') return {ok: true, document: {schemaVersion: 1, servers: {}}};
	const value = result.status === 'valid' ? result.value : null;
	if (
		!isRecord(value) ||
		(value.schemaVersion !== undefined && value.schemaVersion !== 1) ||
		(value.dialect !== undefined && value.dialect !== PI_MCP_NATIVE_DIALECT) ||
		(value.servers !== undefined && !isRecord(value.servers)) ||
		(value.managedServers !== undefined &&
			(!Array.isArray(value.managedServers) || value.managedServers.some(id => typeof id !== 'string')))
	)
		return {ok: false, reason: 'override-read-failed', detail: 'Pi MCP ownership sidecar 无法读取或结构无效'};
	const servers = (value.servers ?? {}) as Record<string, PiMcpOverrideEntry>;
	if (Object.values(servers).some(entry => !isRecord(entry) || typeof entry.enabled !== 'boolean')) {
		return {ok: false, reason: 'override-read-failed', detail: 'Pi MCP ownership sidecar 结构无效'};
	}
	return {ok: true, document: {...value, schemaVersion: 1, servers}};
}

export function readPiMcpConfig(): PiMcpConfigRead {
	const result = readJsonFileStrict<unknown>(piMcpConfigPath());
	if (result.status === 'missing') return {ok: true, document: {mcpServers: {}}};
	const value = result.status === 'valid' ? result.value : null;
	if (
		!isRecord(value) ||
		Object.hasOwn(value, 'mcp-servers') ||
		(value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== 'boolean') ||
		(value.mcpServers !== undefined && !isRecord(value.mcpServers))
	)
		return {ok: false, reason: 'config-read-failed', detail: 'Pi 原生 mcp.json 无法读取或结构无效'};
	const mcpServers = (value.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
	const idError = validatePiMcpServerIds(Object.keys(mcpServers));
	if (idError) return {ok: false, reason: 'config-read-failed', detail: idError};
	if (Object.values(mcpServers).some(entry => !isRecord(entry))) {
		return {ok: false, reason: 'config-read-failed', detail: 'Pi 原生 mcp.json 服务器必须是对象'};
	}
	return {ok: true, document: {...value, mcpServers}};
}

export function nativeManagedServers(document: PiMcpOverrideDocument): readonly string[] {
	return document.dialect === PI_MCP_NATIVE_DIALECT ? (document.managedServers ?? []) : [];
}

/** Old adapter ownership never grants authority over native entries with the same id. */
export function nativeOwnershipDocument(document: PiMcpOverrideDocument): PiMcpOverrideDocument {
	return document.dialect === PI_MCP_NATIVE_DIALECT
		? document
		: {...document, dialect: PI_MCP_NATIVE_DIALECT, servers: {}, managedServers: []};
}

export function currentPiMcpNativeFact(): PiMcpNativeFact {
	const override = readPiMcpAdapterOverride();
	const config = readPiMcpConfig();
	const base: PiMcpNativeFact = detectedFact ?? {
		piInstalled: false,
		version: '',
		overrideReadable: true,
		configReadable: true,
		supported: false,
		reason: 'pi-not-detected'
	};
	return {
		...base,
		overrideReadable: override.ok,
		configReadable: config.ok,
		supported: base.supported && override.ok && config.ok,
		...(!override.ok ? {reason: override.reason} : !config.ok ? {reason: config.reason} : {})
	};
}

export async function detectPiMcpNative(exec: typeof execCommand = execCommand): Promise<PiMcpNativeFact> {
	const definition = TOOL_DEFINITIONS.find(item => item.id === 'PiCli');
	if (!definition) throw new Error('Pi CLI registry entry missing');
	let versionOutput = '';
	const status = await detectTool(definition, async (command, args, options) => {
		const result = await exec(command, args, options);
		versionOutput = (result.stdout || result.stderr || '').trim();
		return result;
	});
	// Reject diagnostics containing unrelated semvers, partial/pre-release versions; never connect servers.
	const supported =
		/^(?:pi(?: version)?\s+)?v?\d+\.\d+\.\d+(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/i.test(versionOutput) &&
		isVersionAtLeast(status.version, PI_MCP_MIN_VERSION);
	detectedFact = {
		piInstalled: status.installed,
		version: status.version,
		overrideReadable: true,
		configReadable: true,
		supported: status.installed && supported,
		...(!status.installed ? {reason: 'pi-not-installed' as const} : !supported ? {reason: 'pi-version-unsupported' as const} : {})
	};
	return currentPiMcpNativeFact();
}
export function resetPiMcpNativeFact(): void {
	detectedFact = undefined;
}

const ADAPTER_ONLY_KEYS = [
	'disabled',
	'removed',
	'bearerToken',
	'bearerTokenEnv',
	'bearerTokenStore',
	'httpUrl',
	'http_headers',
	'httpTransport',
	'socket',
	'requestHeadersCommand',
	'requestTimeoutMs',
	'caFile',
	'inheritEnv',
	'literalEnv',
	'idleTimeout',
	'lifecycle',
	'directTools',
	'includeTools',
	'excludeTools',
	'toolPrefix',
	'approveTools',
	'exposeResources',
	'searchKeywords',
	'debug',
	'trace',
	'pluginDataDir',
	'protocolVersion',
	'tasks'
];
const EXPOSURES = ['codemode', 'codemode-deferred', 'deferred', 'direct', 'hidden'];
const OAUTH_KEYS = ['clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl'];
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isPiSafeUrl(value: unknown): value is string {
	if (typeof value !== 'string' || !URL.canParse(value)) return false;
	const url = new URL(value);
	return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

export function validatePiMcpServerIds(ids: readonly string[]): string | undefined {
	const normalized = new Map<string, string>();
	for (const id of ids) {
		const key = id.replaceAll('-', '_');
		const previous = normalized.get(key);
		if (previous && previous !== id) return `Pi server ID 冲突：${previous} 与 ${id} 归一化后相同`;
		normalized.set(key, id);
	}
	return undefined;
}

/** Pi 1.0.0 native schema plus fail-closed checks for ignored adapter semantics. Never returns values/secrets. */
export function validatePiMcpServer(serverId: string, config: Record<string, unknown>): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/.test(serverId)) return 'Pi server ID 仅支持字母、数字、_、-';
	if (ADAPTER_ONLY_KEYS.some(key => Object.hasOwn(config, key))) return '配置含 Pi 原生无法表达的 adapter 字段';
	if (config.type !== undefined && (typeof config.type !== 'string' || !['stdio', 'http', 'streamable-http'].includes(config.type)))
		return 'Pi 仅支持 stdio/streamable HTTP（不支持 SSE）';
	if (config.enabled !== undefined && typeof config.enabled !== 'boolean') return 'enabled 必须是布尔值';
	if (config.timeout !== undefined && (typeof config.timeout !== 'number' || !Number.isFinite(config.timeout) || config.timeout <= 0))
		return 'timeout 必须是正数秒';
	if (config.exposure !== undefined && (typeof config.exposure !== 'string' || !EXPOSURES.includes(config.exposure)))
		return 'exposure 无效';
	if (
		config.toolExposure !== undefined &&
		(!isStringRecord(config.toolExposure) || Object.values(config.toolExposure).some(value => !EXPOSURES.includes(value)))
	)
		return 'toolExposure 无效';
	for (const key of ['env', 'headers']) {
		if (config[key] !== undefined && !isStringRecord(config[key])) return `${key} 必须是字符串映射`;
	}
	if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some(arg => typeof arg !== 'string')))
		return 'args 必须是字符串数组';
	if (config.cwd !== undefined && typeof config.cwd !== 'string') return 'cwd 必须是字符串';
	if (config.url !== undefined) {
		if (
			typeof config.url !== 'string' ||
			!URL.canParse(config.url) ||
			!/^https?:$/.test(new URL(config.url).protocol) ||
			config.type === 'stdio' ||
			config.command !== undefined
		)
			return 'Pi HTTP url/transport 无效';
	} else if (typeof config.command !== 'string' || !config.command.trim() || (config.type !== undefined && config.type !== 'stdio'))
		return 'Pi 配置缺少有效 command/url';
	if (config.description !== undefined && typeof config.description !== 'string') return 'description 必须是字符串';
	if (config.auth !== undefined) {
		if (
			!isRecord(config.auth) ||
			typeof config.auth.provider !== 'string' ||
			!config.auth.provider.trim() ||
			Object.keys(config.auth).some(key => key !== 'provider') ||
			config.url === undefined
		)
			return 'auth.provider 仅允许 HTTP MCP 且必须是非空字符串';
		if (!isPiSafeUrl(config.url)) return 'auth.provider 仅允许 HTTPS 或 loopback HTTP URL';
	}

	if (config.oauth !== undefined) {
		if (!isRecord(config.oauth) || config.url === undefined || Object.keys(config.oauth).some(key => !OAUTH_KEYS.includes(key)))
			return 'oauth 必须是原生 HTTP 静态配置（不含登录态）';
		const oauth = config.oauth;
		for (const key of ['clientId', 'clientSecret', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl']) {
			if (oauth[key] !== undefined && typeof oauth[key] !== 'string') return `oauth.${key} 必须是字符串`;
		}
		if (typeof oauth.authServerMetadataUrl === 'string' && !isPiSafeUrl(oauth.authServerMetadataUrl))
			return 'oauth.authServerMetadataUrl 必须是 HTTPS 或 loopback HTTP URL';
		const port = oauth.callbackPort;
		if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535))
			return 'oauth.callbackPort 无效';
		if (typeof oauth.callbackUrl === 'string') {
			if (!URL.canParse(oauth.callbackUrl)) return 'oauth.callbackUrl 无效';
			const url = new URL(oauth.callbackUrl);
			if (
				url.protocol !== 'http:' ||
				!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
				url.search ||
				url.hash ||
				(url.port && port !== undefined && Number(url.port) !== port)
			)
				return 'oauth.callbackUrl 必须是无 query/hash 的同端口 loopback HTTP URL';
		}
	}
	return undefined;
}

/** A changed endpoint must never inherit credentials bound to the previous URL. */
export function piMcpMergeBase(local: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
	const next = {...local};
	const toStdio = incoming.command !== undefined && incoming.url === undefined && local.url !== undefined;
	const toHttp = incoming.url !== undefined && incoming.command === undefined && local.command !== undefined;
	if (toStdio) delete next.url;
	if (toHttp) for (const key of ['command', 'args', 'env', 'cwd']) delete next[key];
	if (toStdio || toHttp) delete next.type;
	if (toStdio || (incoming.url !== undefined && incoming.url !== local.url)) {
		for (const key of ['headers', 'http_headers', 'oauth', 'auth', 'bearerToken', 'bearerTokenEnv', 'bearerTokenStore'])
			delete next[key];
	}
	return next;
}

function toPiNativeConfig(config: Record<string, unknown>): Record<string, unknown> {
	const next = {...config};
	if (next.headers === undefined && isRecord(next.http_headers)) next.headers = next.http_headers;
	if (typeof next.auth === 'string') next.auth = {provider: next.auth};
	if (typeof next.disabled === 'boolean' && next.enabled === undefined) next.enabled = !next.disabled;
	delete next.http_headers;
	delete next.disabled;
	return next;
}
export function buildPiMcpServerEntry(
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null,
	credentials: Readonly<Record<string, string>> = {}
): Record<string, unknown> {
	const nativeConfig = toPiNativeConfig(config ?? {});
	const entry = {...nativeConfig};
	if (definition?.Command && entry.command === undefined && entry.url === undefined) entry.command = definition.Command;
	if (definition?.Url && entry.command === undefined && entry.url === undefined) entry.url = definition.Url;
	if (entry.args === undefined && definition?.Args) entry.args = [...definition.Args];
	const bucket = entry.url !== undefined ? 'headers' : 'env';
	if (Object.keys(credentials).length && !['args-token', 'args-multi', 'url-embedded'].includes(definition?.CredentialType ?? '')) {
		entry[bucket] = {...credentials, ...(isRecord(entry[bucket]) ? entry[bucket] : {})};
	}
	return entry;
}

export function piMcpUnsupportedReason(
	fact: PiMcpNativeFact,
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null,
	serverId: string,
	configDialect: 'shared' | 'pi-native' = 'shared'
): PiMcpUnsupportedReason | undefined {
	if (!fact.supported) return fact.reason ?? 'pi-not-detected';
	// Existing native entries must pass raw schema checks, not implicit legacy conversion.
	if (configDialect === 'pi-native' && config && validatePiMcpServer(serverId, config)) return 'definition-not-expressible';
	// Validate shared aliases before conversion removes them; never erase malformed or conflicting semantics.
	if (configDialect === 'shared' && config) {
		if (
			Object.hasOwn(config, 'disabled') &&
			(typeof config.disabled !== 'boolean' || (config.enabled !== undefined && config.enabled !== !config.disabled))
		) {
			return 'definition-not-expressible';
		}
		if (Object.hasOwn(config, 'http_headers')) {
			const alias = config.http_headers;
			const headers = config.headers;
			if (
				!isStringRecord(alias) ||
				(headers !== undefined &&
					(!isStringRecord(headers) ||
						Object.keys(headers).length !== Object.keys(alias).length ||
						Object.entries(alias).some(([key, value]) => headers[key] !== value)))
			) {
				return 'definition-not-expressible';
			}
		}
	}
	// Shared CC/CX definitions may use their own dialects; only these are projected.
	const nativeConfig = config ? toPiNativeConfig(config) : null;
	if (nativeConfig && ADAPTER_ONLY_KEYS.some(key => Object.hasOwn(nativeConfig, key))) return 'definition-not-expressible';
	if (validatePiMcpServer(serverId, buildPiMcpServerEntry(definition, nativeConfig))) return 'definition-not-expressible';
	return undefined;
}
export function piMcpDisplayReason(reason: PiMcpUnsupportedReason): string {
	return {
		'pi-not-installed': '需先安装 Pi Agent CLI',
		'pi-version-unsupported': '需 Pi >=1.0.0 正式版（当前版本过旧或无法确认）',
		'pi-not-detected': 'Pi 原生 MCP 能力尚未检测',
		'definition-not-expressible': 'Pi 原生不支持该 ID/transport/schema',
		'override-read-failed': 'Pi MCP ownership sidecar 无法读取',
		'config-read-failed': 'Pi 原生 mcp.json 无法读取'
	}[reason];
}

/** Two-file transaction, byte-exact rollback, no credential-bearing parser/write diagnostics. */
export function writePiMcpDocuments(nextNative: PiMcpConfigDocument, nextOverride: PiMcpOverrideDocument): PiMcpConfigSyncResult {
	const nativeIds = Object.keys(nextNative.mcpServers);
	const overrideIds = Object.keys(nextOverride.servers).filter(id => !Object.hasOwn(nextNative.mcpServers, id));
	const idError = validatePiMcpServerIds([...nativeIds, ...overrideIds]);
	if (idError) return {Success: false, Status: `Unsupported: ${idError}`};
	const native = readPiMcpConfig();
	const override = readPiMcpAdapterOverride();
	if (!native.ok || !override.ok) return {Success: false, Status: 'Unsupported: Pi MCP 文件无法读取'};
	const targets = [
		{path: piMcpConfigPath(), before: native.document, after: nextNative},
		{path: piMcpAdapterOverridesPath(), before: override.document, after: nextOverride}
	].filter(target => JSON.stringify(target.before) !== JSON.stringify(target.after));
	if (!targets.length) return {Success: true, Status: 'Unchanged'};
	try {
		const snapshots = targets.map(target => ({...target, bytes: existsSync(target.path) ? readFileSync(target.path) : undefined}));
		try {
			for (const target of snapshots) writeJsonAtomic(target.path, target.after, {mode: SECRET_FILE_MODE});
			const nativePost = readPiMcpConfig();
			const overridePost = readPiMcpAdapterOverride();
			if (
				!nativePost.ok ||
				!overridePost.ok ||
				JSON.stringify(nativePost.document) !== JSON.stringify(nextNative) ||
				JSON.stringify(overridePost.document) !== JSON.stringify(nextOverride)
			)
				throw new Error('postflight');
			return {Success: true, Status: 'Synced'};
		} catch {
			for (const target of snapshots) {
				try {
					if (target.bytes) atomicWrite(target.path, target.bytes, {mode: SECRET_FILE_MODE});
					else if (existsSync(target.path)) unlinkSync(target.path);
				} catch {
					// Attempt every target; restoration is decided by byte facts below, not write exit status.
				}
			}
			const restored = snapshots.every(target => {
				try {
					return target.bytes ? readFileSync(target.path).equals(target.bytes) : !existsSync(target.path);
				} catch {
					return false;
				}
			});
			return {
				Success: false,
				Status: restored ? 'WriteFailed: Pi MCP 写入失败，已回滚' : 'WriteFailed: Pi MCP 写入及回滚失败，请检查文件'
			};
		}
	} catch {
		return {Success: false, Status: 'WriteFailed: Pi MCP 快照或回滚失败，请检查文件'};
	}
}

export function writePiMcpOverride(
	serverId: string,
	enabled: boolean,
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null,
	credentials: Readonly<Record<string, string>> = {}
): PiMcpMutationResult {
	const reason = piMcpUnsupportedReason(currentPiMcpNativeFact(), definition, config, serverId);
	if (reason) return {Success: false, ServerId: serverId, Status: `Unsupported: ${piMcpDisplayReason(reason)}`};
	const native = readPiMcpConfig();
	const override = readPiMcpAdapterOverride();
	if (!native.ok || !override.ok) return {Success: false, ServerId: serverId, Status: 'Unsupported: Pi MCP 文件无法读取'};
	const existing = native.document.mcpServers[serverId];
	if (existing && validatePiMcpServer(serverId, existing)) {
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${piMcpDisplayReason('definition-not-expressible')}`};
	}
	const entry = buildPiMcpServerEntry(definition, config, credentials);
	const schemaError = validatePiMcpServer(serverId, entry);
	if (schemaError) return {Success: false, ServerId: serverId, Status: `Unsupported: ${schemaError}`};
	if (enabled) delete entry.enabled;
	else entry.enabled = false;
	const owned = nativeOwnershipDocument(override.document);
	const nextOverride = {
		...owned,
		servers: {...owned.servers, [serverId]: {...owned.servers[serverId], enabled}},
		managedServers: [...new Set([...nativeManagedServers(owned), serverId])]
	};
	const result = writePiMcpDocuments({...native.document, mcpServers: {...native.document.mcpServers, [serverId]: entry}}, nextOverride);
	return {Success: result.Success, ServerId: serverId, Status: result.Success ? (enabled ? 'Active' : 'Disabled') : result.Status};
}

export function removePiMcpOverrideRecord(serverId: string, confirmedFullDelete = false): PiMcpMutationResult {
	const override = readPiMcpAdapterOverride();
	if (!override.ok) return {Success: false, ServerId: serverId, Status: `Unsupported: ${override.detail}`};
	if (!confirmedFullDelete && !nativeManagedServers(override.document).includes(serverId)) {
		return {Success: true, ServerId: serverId, Status: 'Removed'};
	}
	const native = readPiMcpConfig();
	if (!native.ok) return {Success: false, ServerId: serverId, Status: `Unsupported: ${native.detail}`};
	if (
		!Object.hasOwn(native.document.mcpServers, serverId) &&
		!Object.hasOwn(override.document.servers, serverId) &&
		!nativeManagedServers(override.document).includes(serverId)
	)
		return {Success: true, ServerId: serverId, Status: 'Removed'};
	const mcpServers = {...native.document.mcpServers};
	delete mcpServers[serverId];
	const servers = {...override.document.servers};
	delete servers[serverId];
	const result = writePiMcpDocuments(
		{...native.document, mcpServers},
		{...override.document, servers, managedServers: (override.document.managedServers ?? []).filter(id => id !== serverId)}
	);
	return {Success: result.Success, ServerId: serverId, Status: result.Success ? 'Removed' : result.Status};
}

/** Per-agent removal keeps a disabled native entry, matching existing UI semantics. */
export function removePiMcpOverride(
	serverId: string,
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null,
	credentials: Readonly<Record<string, string>> = {}
): PiMcpMutationResult {
	return writePiMcpOverride(serverId, false, definition, config, credentials);
}
