import {mergeTransferDocuments} from './config-transfer-sections.js';
import {type SectionMergeReport, type TransferResult, transferFail, transferOk} from './config-transfer.js';
import {portableCodexConfig, readCodexConfigDocumentStrict} from './codex-config.js';
import {readJsonFileStrict, SECRET_FILE_MODE, writeJsonAtomic} from './fs-utils.js';
import {normalizeVaultCredentials} from './mcp.js';
import {MCP_META_SCHEMA_VERSION, saveVault, withVaultLock, type McpVault, type McpVaultServerEntry} from './mcp-vault.js';
import {
	PI_MCP_NATIVE_DIALECT,
	nativeManagedServers,
	nativeOwnershipDocument,
	piMcpMergeBase,
	readPiMcpAdapterOverride,
	readPiMcpConfig,
	validatePiMcpServer,
	validatePiMcpServerIds,
	writePiMcpDocuments
} from './pi-mcp-adapter.js';
import {claudeJsonPath, codexConfigPath, settingsPath, vaultPath} from './paths.js';
import {atomicWrite as atomicWriteToml, setPath, type TomlDocument} from './toml-edit.js';

// MCP 导入导出 seam（Phase 2 Part B）：CCQ 共享定义、Claude/Codex/Pi runtime 配置。
// 领域语义仍归原 owner：vault 读写走 mcp-vault.ts 的锁与 saveVault，Codex 本机绑定过滤
// 复用 portableCodexConfig，Pi 标准配置/sidecar 复用 pi-mcp-adapter 的严格读取器。
// 未选择敏感凭据时 env/headers/http_headers 值与 bearerToken 整键移除，只报告 identity/键名；
// OAuth 静态参数可迁移；clientSecret 按凭据开关处理；登录态永不进入包。
// activation 永不从 vault 推导：各侧 runtime 配置是独立分类，导入按 owner identity 深度合并。

type JsonObject = Record<string, unknown>;

/** MCP config 中的凭据桶；桶内值属于敏感内容。 */
const MCP_CREDENTIAL_BUCKETS = ['env', 'headers', 'http_headers'] as const;
/** 直接以值形式保存的文件型凭据。 */
const MCP_DIRECT_CREDENTIAL_KEYS = ['bearerToken'] as const;
/** 登录/OAuth/凭据存储引用：除原生 auth.provider 外永不迁移。 */
const MCP_AUTH_STATE_KEYS = ['bearerTokenStore'] as const;

export type McpCredentialExclusion = {readonly id: string; readonly keys: readonly string[]};

export type McpServerEntry = {
	readonly id: string;
	readonly config: JsonObject;
	readonly permissions?: readonly string[];
	readonly credentials?: Readonly<Record<string, string>>;
	readonly definitionHash?: string;
	readonly updatedAt?: string;
};

export type McpLibrarySection = {
	readonly schemaVersion: number;
	readonly containsCredentials: boolean;
	readonly servers: readonly McpServerEntry[];
	readonly excludedCredentials: readonly McpCredentialExclusion[];
};

export type McpClaudeSection = {
	readonly containsCredentials: boolean;
	readonly servers: readonly McpServerEntry[];
	readonly permissions: readonly string[];
	readonly excludedCredentials: readonly McpCredentialExclusion[];
};

export type McpCodexSection = {
	readonly containsCredentials: boolean;
	readonly servers: readonly McpServerEntry[];
	/** 被 portableCodexConfig 过滤的本机绑定条目 id（绝不携带路径值）。 */
	readonly excluded: readonly string[];
	readonly excludedCredentials: readonly McpCredentialExclusion[];
};

export type McpPiSection = {
	readonly dialect: typeof PI_MCP_NATIVE_DIALECT;
	readonly autoEnableCodemode?: boolean;
	readonly managedServers: readonly string[];
	readonly containsCredentials: boolean;
	readonly servers: readonly McpServerEntry[];
	readonly overrides: readonly McpServerEntry[];
	readonly excludedCredentials: readonly McpCredentialExclusion[];
	readonly excludedAuth: readonly string[];
};

function isRecord(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return isRecord(value) && Object.values(value).every(item => typeof item === 'string');
}

function sortedEntries(value: Readonly<Record<string, unknown>>): readonly (readonly [string, unknown])[] {
	return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

// ── 凭据剥离 ────────────────────────────────────────────────────────────────

type StrippedServerConfig = {
	readonly config: JsonObject;
	readonly credentialKeys: readonly string[];
	readonly authKeys: readonly string[];
};

/** 克隆 config 并按需剥离凭据值；返回只含键名的剥离事实。 */
function stripServerConfig(config: JsonObject, includeCredentials: boolean): StrippedServerConfig {
	const next = structuredClone(config) as JsonObject;
	const credentialKeys: string[] = [];

	for (const bucket of MCP_CREDENTIAL_BUCKETS) {
		const values = next[bucket];
		if (!isRecord(values) || Object.keys(values).length === 0) {
			continue;
		}

		credentialKeys.push(...Object.keys(values).map(key => `${bucket}:${key}`));
		if (!includeCredentials) {
			delete next[bucket];
		}
	}

	for (const key of MCP_DIRECT_CREDENTIAL_KEYS) {
		if (next[key] === undefined) {
			continue;
		}

		credentialKeys.push(key);
		if (!includeCredentials) {
			delete next[key];
		}
	}

	const authKeys: string[] = [];
	if (next.auth !== undefined) {
		if (!isRecord(next.auth) || typeof next.auth.provider !== 'string' || next.auth.provider.trim() === '') {
			authKeys.push('auth');
			delete next.auth;
		} else {
			const auth = {provider: next.auth.provider};
			for (const key of Object.keys(next.auth)) {
				if (key !== 'provider') authKeys.push(`auth:${key}`);
			}
			next.auth = auth;
		}
	}
	if (next.oauth !== undefined) {
		if (!isRecord(next.oauth)) {
			authKeys.push('oauth');
			delete next.oauth;
		} else {
			const oauth = {...next.oauth};
			for (const key of Object.keys(oauth)) {
				if (
					!['clientId', 'clientSecret', 'callbackPort', 'callbackUrl', 'scope', 'clientName', 'authServerMetadataUrl'].includes(
						key
					)
				) {
					delete oauth[key];
					authKeys.push(`oauth:${key}`);
				}
			}
			if (oauth.clientSecret !== undefined) {
				credentialKeys.push('oauth:clientSecret');
				if (!includeCredentials) delete oauth.clientSecret;
			}
			next.oauth = oauth;
		}
	}
	for (const key of MCP_AUTH_STATE_KEYS) {
		if (next[key] === undefined) {
			continue;
		}

		authKeys.push(key);
		delete next[key];
	}

	return {config: next, credentialKeys, authKeys};
}

type SnapshotServersResult = {
	readonly servers: readonly McpServerEntry[];
	readonly containsCredentials: boolean;
	readonly excludedCredentials: readonly McpCredentialExclusion[];
	readonly excludedAuth: readonly string[];
};

function snapshotServerEntries(rawServers: Readonly<Record<string, unknown>>, includeCredentials: boolean): SnapshotServersResult {
	const servers: McpServerEntry[] = [];
	const excludedCredentials: McpCredentialExclusion[] = [];
	const excludedAuth: string[] = [];
	let containsCredentials = false;

	for (const [id, rawConfig] of sortedEntries(rawServers)) {
		if (!isRecord(rawConfig)) {
			continue;
		}

		const stripped = stripServerConfig(rawConfig, includeCredentials);
		servers.push({id, config: stripped.config});
		if (stripped.credentialKeys.length > 0) {
			if (includeCredentials) {
				containsCredentials = true;
			} else {
				excludedCredentials.push({id, keys: stripped.credentialKeys});
			}
		}

		excludedAuth.push(...stripped.authKeys.map(key => `${id}:${key}`));
	}

	return {servers, containsCredentials, excludedCredentials, excludedAuth};
}

function parseServerConfigObject(value: unknown): TransferResult<JsonObject> {
	if (!isRecord(value)) {
		return transferFail('validation', 'MCP 服务器配置必须是对象');
	}

	return transferOk(structuredClone(value) as JsonObject);
}

function parseServerEntries(value: unknown): TransferResult<readonly McpServerEntry[]> {
	if (!Array.isArray(value)) {
		return transferFail('validation', 'MCP 分类缺少服务器列表');
	}

	const entries: McpServerEntry[] = [];
	const seen = new Set<string>();
	for (const raw of value) {
		if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') {
			return transferFail('validation', 'MCP 分类包含无效服务器条目');
		}

		if (seen.has(raw.id)) {
			return transferFail('validation', 'MCP 分类包含重复服务器');
		}

		seen.add(raw.id);
		const config = parseServerConfigObject(raw.config);
		if (!config.ok) {
			return config;
		}

		entries.push({id: raw.id, config: config.data});
	}

	return transferOk(entries);
}

function mergePermissions(local: readonly string[] | undefined, incoming: readonly string[] | undefined): readonly string[] {
	const merged = [...(local ?? [])];
	for (const permission of incoming ?? []) {
		if (!merged.includes(permission)) {
			merged.push(permission);
		}
	}

	return merged;
}

function mergeServerMap(
	local: Readonly<Record<string, unknown>>,
	incoming: readonly McpServerEntry[],
	piNative = false,
	defaultDisabled = piNative
): {readonly servers: JsonObject; readonly added: string[]; readonly replaced: string[]; readonly unchanged: string[]} {
	const servers: JsonObject = {...local};
	const added: string[] = [];
	const replaced: string[] = [];
	const unchanged: string[] = [];

	for (const entry of incoming) {
		const localEntry = isRecord(local[entry.id]) ? (local[entry.id] as JsonObject) : undefined;
		const base = piNative ? piMcpMergeBase(localEntry ?? {}, entry.config) : {...localEntry};
		// Native omission means enabled, not inheritance of a local enabled:false.
		if (piNative) delete base.enabled;
		const merged = mergeTransferDocuments(base, entry.config) as JsonObject;
		// Imported configuration is not consent to activate a previously absent server.
		if (defaultDisabled && !localEntry) merged.enabled = false;
		if (localEntry && JSON.stringify(localEntry) === JSON.stringify(merged)) {
			unchanged.push(entry.id);
			continue;
		}

		(localEntry ? replaced : added).push(entry.id);
		servers[entry.id] = merged;
	}

	return {servers, added, replaced, unchanged};
}

function mcpReport(
	added: readonly string[],
	replaced: readonly string[],
	unchanged: readonly string[],
	skipped: readonly string[],
	warnings: readonly string[]
): SectionMergeReport {
	return {added, replaced, unchanged, skipped, warnings};
}

/** 明文包声称不含凭据时，导入前再次剥离包内 env/headers/bearer 值（防篡改/误标）。 */
function sanitizeIncomingServers(servers: readonly McpServerEntry[], containsCredentials: boolean): readonly McpServerEntry[] {
	if (containsCredentials) {
		return servers;
	}

	return servers.map(entry => ({...entry, config: stripServerConfig(entry.config, false).config}));
}

// ── CCQ 共享定义（vault） ───────────────────────────────────────────────────

type VaultRead = {
	readonly schemaVersion: number;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly servers: Record<string, McpVaultServerEntry>;
};

function readVaultDocument(): TransferResult<VaultRead> {
	const result = readJsonFileStrict<unknown>(vaultPath());
	if (result.status === 'missing') {
		return transferOk({schemaVersion: MCP_META_SCHEMA_VERSION, createdAt: '', updatedAt: '', servers: {}});
	}

	if (result.status === 'invalid') {
		return transferFail('conflict', '本机 MCP 共享库损坏，已停止读取');
	}

	const value = result.value;
	if (!isRecord(value) || typeof value.schemaVersion !== 'number' || value.schemaVersion < 1 || !isRecord(value.servers)) {
		return transferFail('conflict', '本机 MCP 共享库结构无效，已停止读取');
	}

	if (value.schemaVersion > MCP_META_SCHEMA_VERSION) {
		return transferFail('conflict', '本机 MCP 共享库版本高于当前支持版本，已停止读取');
	}

	const servers: Record<string, McpVaultServerEntry> = {};
	for (const [id, entry] of Object.entries(value.servers)) {
		if (isRecord(entry)) {
			servers[id] = entry as McpVaultServerEntry;
		}
	}

	return transferOk({
		schemaVersion: value.schemaVersion,
		createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
		updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
		servers
	});
}

/** 快照 `~/.ccq/mcp-meta.json` 的共享定义与元数据；activation 与 self-update 缓存永不采集。 */
export function snapshotMcpLibrarySection(options: {readonly includeCredentials: boolean}): TransferResult<McpLibrarySection> {
	const vault = readVaultDocument();
	if (!vault.ok) {
		return transferOk({schemaVersion: MCP_META_SCHEMA_VERSION, containsCredentials: false, servers: [], excludedCredentials: []}, [
			vault.error
		]);
	}

	const servers: McpServerEntry[] = [];
	const excludedCredentials: McpCredentialExclusion[] = [];
	let containsCredentials = false;

	for (const [id, entry] of sortedEntries(vault.data.servers)) {
		if (!isRecord(entry)) {
			continue;
		}

		const rawConfig = isRecord(entry.config) ? entry.config : {};
		const stripped = stripServerConfig(rawConfig, options.includeCredentials);
		const credentialValues = normalizeVaultCredentials(entry as McpVaultServerEntry);
		const credentialKeys = [...stripped.credentialKeys, ...Object.keys(credentialValues).map(key => `credentials:${key}`)];
		if (credentialKeys.length > 0) {
			if (options.includeCredentials) {
				containsCredentials = true;
			} else {
				excludedCredentials.push({id, keys: credentialKeys});
			}
		}

		servers.push({
			id,
			config: stripped.config,
			permissions: Array.isArray(entry.permissions)
				? entry.permissions.filter((item): item is string => typeof item === 'string')
				: [],
			...(typeof entry.definitionHash === 'string' ? {definitionHash: entry.definitionHash} : {}),
			...(typeof entry.updatedAt === 'string' ? {updatedAt: entry.updatedAt} : {}),
			...(options.includeCredentials && Object.keys(credentialValues).length > 0 ? {credentials: credentialValues} : {})
		});
	}

	return transferOk({schemaVersion: vault.data.schemaVersion, containsCredentials, servers, excludedCredentials});
}

/** 校验包中的 CCQ MCP 共享库分类（导入边界；不信任包内容）。 */
export function parseMcpLibrarySection(value: unknown): TransferResult<McpLibrarySection> {
	if (!isRecord(value)) {
		return transferFail('validation', 'MCP 共享库分类内容无效');
	}

	if (typeof value.schemaVersion !== 'number' || value.schemaVersion < 1 || value.schemaVersion > MCP_META_SCHEMA_VERSION) {
		return transferFail('validation', 'MCP 共享库分类版本不受支持');
	}

	if (typeof value.containsCredentials !== 'boolean') {
		return transferFail('validation', 'MCP 共享库分类缺少凭据标记');
	}

	const rawEntries = value.servers;
	if (!Array.isArray(rawEntries)) {
		return transferFail('validation', 'MCP 共享库分类缺少服务器列表');
	}

	const parsed = parseServerEntries(rawEntries);
	if (!parsed.ok) {
		return parsed;
	}

	const sources = new Map<string, JsonObject>();
	for (const raw of rawEntries) {
		if (isRecord(raw) && typeof raw.id === 'string') {
			sources.set(raw.id, raw);
		}
	}

	const servers: McpServerEntry[] = [];
	for (const entry of parsed.data) {
		const source = sources.get(entry.id);
		if (!source) {
			return transferFail('validation', 'MCP 共享库分类包含无效条目');
		}

		const permissions = source.permissions;
		if (permissions !== undefined && (!Array.isArray(permissions) || permissions.some(item => typeof item !== 'string'))) {
			return transferFail('validation', 'MCP 共享库分类包含无效 permissions');
		}

		const credentials = source.credentials;
		if (credentials !== undefined && !isStringRecord(credentials)) {
			return transferFail('validation', 'MCP 共享库分类包含无效凭据');
		}

		servers.push({
			id: entry.id,
			config: entry.config,
			permissions: (permissions ?? []) as readonly string[],
			...(typeof source.definitionHash === 'string' ? {definitionHash: source.definitionHash} : {}),
			...(typeof source.updatedAt === 'string' ? {updatedAt: source.updatedAt} : {}),
			...(credentials ? {credentials: {...credentials}} : {})
		});
	}

	return transferOk({
		schemaVersion: value.schemaVersion,
		containsCredentials: value.containsCredentials,
		servers,
		excludedCredentials: []
	});
}

function mergeVaultEntry(local: McpVaultServerEntry | undefined, incoming: McpServerEntry): McpVaultServerEntry {
	const localConfig = isRecord(local?.config) ? (local.config as JsonObject) : {};
	const endpointChanged =
		(incoming.config.url !== undefined && incoming.config.url !== localConfig.url) ||
		(localConfig.url !== undefined && incoming.config.command !== undefined && incoming.config.url === undefined);
	const credentials = {...(endpointChanged ? {} : normalizeVaultCredentials(local)), ...(incoming.credentials ?? {})};
	const next: McpVaultServerEntry = {
		...local,
		config: mergeTransferDocuments(piMcpMergeBase(localConfig, incoming.config), incoming.config) as JsonObject,
		permissions: [...mergePermissions(local?.permissions, incoming.permissions)],
		...(incoming.definitionHash !== undefined ? {definitionHash: incoming.definitionHash} : {}),
		...(incoming.updatedAt !== undefined ? {updatedAt: incoming.updatedAt} : {}),
		...(Object.keys(credentials).length > 0 ? {credentials: {values: credentials}} : {})
	};
	if (endpointChanged && Object.keys(credentials).length === 0) delete next.credentials;
	delete next.config?.enabled;
	delete next.config?.disabled;
	return next;
}

/** 合并导入 CCQ MCP 共享库：同 id 覆盖定义，本机其他定义、凭据与未知字段保留。 */
export function importMcpLibrarySection(
	data: unknown,
	options: {readonly containsCredentials: boolean; readonly dryRun?: boolean}
): TransferResult<SectionMergeReport> {
	const parsed = parseMcpLibrarySection(data);
	if (!parsed.ok) {
		return parsed;
	}

	if (!options.containsCredentials && parsed.data.servers.some(entry => Object.keys(entry.credentials ?? {}).length > 0)) {
		return transferFail('validation', '导出包包含未声明的凭据');
	}

	return withVaultLock(() => {
		const current = readVaultDocument();
		if (!current.ok) {
			return transferFail('conflict', '本机 MCP 共享库损坏或版本不受支持，已停止导入');
		}

		const added: string[] = [];
		const replaced: string[] = [];
		const unchanged: string[] = [];
		const meta: McpVault = {
			schemaVersion: current.data.schemaVersion,
			createdAt: current.data.createdAt,
			updatedAt: current.data.updatedAt,
			servers: {...current.data.servers}
		};

		for (const entry of sanitizeIncomingServers(parsed.data.servers, options.containsCredentials)) {
			const local = current.data.servers[entry.id];
			const next = mergeVaultEntry(local, entry);
			if (local && JSON.stringify(local) === JSON.stringify(next)) {
				unchanged.push(entry.id);
				continue;
			}

			(local ? replaced : added).push(entry.id);
			if (!options.dryRun) {
				meta.servers[entry.id] = next;
			}
		}

		if (!options.dryRun && added.length + replaced.length > 0) {
			try {
				saveVault(meta);
			} catch {
				return transferFail('io', 'MCP 共享库写入失败');
			}
		}

		return transferOk(mcpReport(added, replaced, unchanged, [], parsed.warnings));
	});
}

// ── Claude runtime（.claude.json + settings permissions） ────────────────────

function mcpPermissionsOf(settings: JsonObject, ids: readonly string[]): readonly string[] {
	const permissions = settings.permissions;
	if (!isRecord(permissions) || !Array.isArray(permissions.allow)) {
		return [];
	}

	const wanted = new Set(ids.map(id => `mcp__${id}`));
	return permissions.allow.filter((item): item is string => typeof item === 'string' && wanted.has(item));
}

/** 快照 `~/.claude.json` mcpServers 与对应 `settings.json` permissions。 */
export function snapshotClaudeMcpSection(options: {readonly includeCredentials: boolean}): TransferResult<McpClaudeSection> {
	const warnings: string[] = [];
	let rawServers: Readonly<Record<string, unknown>> = {};

	const claudeJson = readJsonFileStrict<unknown>(claudeJsonPath());
	if (claudeJson.status === 'invalid') {
		warnings.push('Claude .claude.json 损坏，未包含 MCP 配置');
	} else if (claudeJson.status === 'valid') {
		if (!isRecord(claudeJson.value)) {
			warnings.push('Claude .claude.json 结构无效，未包含 MCP 配置');
		} else if (isRecord(claudeJson.value.mcpServers)) {
			rawServers = claudeJson.value.mcpServers;
		}
	}

	const snapshot = snapshotServerEntries(rawServers, options.includeCredentials);
	let permissions: readonly string[] = [];
	const settings = readJsonFileStrict<unknown>(settingsPath());
	if (settings.status === 'invalid') {
		warnings.push('Claude settings.json 损坏，未包含 MCP permissions');
	} else if (settings.status === 'valid' && isRecord(settings.value)) {
		permissions = mcpPermissionsOf(
			settings.value,
			snapshot.servers.map(entry => entry.id)
		);
	}

	return transferOk(
		{
			containsCredentials: snapshot.containsCredentials,
			servers: snapshot.servers,
			permissions,
			excludedCredentials: snapshot.excludedCredentials
		},
		warnings
	);
}

/** 校验包中的 Claude MCP 分类（导入边界；不信任包内容）。 */
export function parseClaudeMcpSection(value: unknown): TransferResult<McpClaudeSection> {
	if (!isRecord(value)) {
		return transferFail('validation', 'MCP 分类内容无效');
	}

	const parsed = parseServerEntries(value.servers);
	if (!parsed.ok) {
		return parsed;
	}

	const permissions = value.permissions ?? [];
	if (!Array.isArray(permissions) || permissions.some(item => typeof item !== 'string')) {
		return transferFail('validation', 'MCP 分类包含无效 permissions');
	}

	return transferOk({
		containsCredentials: value.containsCredentials === true,
		servers: parsed.data,
		permissions: permissions as readonly string[],
		excludedCredentials: []
	});
}

/** 合并导入 Claude MCP：同 server id 覆盖 config，其他 .claude.json 键与本机 server 原样保留。 */
export function importClaudeMcpSection(
	data: unknown,
	options: {readonly containsCredentials: boolean; readonly dryRun?: boolean}
): TransferResult<SectionMergeReport> {
	const parsed = parseClaudeMcpSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const claudeJson = readJsonFileStrict<unknown>(claudeJsonPath());
	if (claudeJson.status === 'invalid' || (claudeJson.status === 'valid' && !isRecord(claudeJson.value))) {
		return transferFail('conflict', '本机 .claude.json 损坏，已停止导入 MCP');
	}

	const settings = readJsonFileStrict<unknown>(settingsPath());
	if (settings.status === 'invalid' || (settings.status === 'valid' && !isRecord(settings.value))) {
		return transferFail('conflict', '本机 settings.json 损坏，已停止导入 MCP');
	}

	const document = claudeJson.status === 'valid' ? (claudeJson.value as JsonObject) : {};
	const localServers = isRecord(document.mcpServers) ? document.mcpServers : {};
	const merged = mergeServerMap(localServers, sanitizeIncomingServers(parsed.data.servers, options.containsCredentials));

	const settingsDocument = settings.status === 'valid' ? (settings.value as JsonObject) : {};
	const permissions = isRecord(settingsDocument.permissions) ? settingsDocument.permissions : {};
	const allow = Array.isArray(permissions.allow) ? permissions.allow.filter((item): item is string => typeof item === 'string') : [];
	const nextAllow = [...allow];
	for (const permission of parsed.data.permissions) {
		if (!nextAllow.includes(permission)) {
			nextAllow.push(permission);
		}
	}

	if (!options.dryRun) {
		if (merged.added.length + merged.replaced.length > 0) {
			try {
				writeJsonAtomic(claudeJsonPath(), {...document, mcpServers: merged.servers});
			} catch {
				return transferFail('io', '.claude.json 写入失败');
			}
		}

		if (nextAllow.length !== allow.length) {
			try {
				writeJsonAtomic(
					settingsPath(),
					{...settingsDocument, permissions: {...permissions, allow: nextAllow}},
					{mode: SECRET_FILE_MODE}
				);
			} catch {
				return transferFail('io', 'settings.json 写入失败');
			}
		}
	}

	return transferOk(mcpReport(merged.added, merged.replaced, merged.unchanged, [], parsed.warnings));
}

// ── Codex runtime（config.toml [mcp_servers]） ──────────────────────────────

function codexMcpServersOf(document: TomlDocument): Readonly<Record<string, unknown>> {
	return isRecord(document.mcp_servers) ? document.mcp_servers : {};
}

function codexExcludedIds(excluded: readonly {readonly key: string}[]): readonly string[] {
	const prefix = 'mcp_servers.';
	return excluded.filter(item => item.key.startsWith(prefix)).map(item => item.key.slice(prefix.length));
}

/** 快照 `~/.codex/config.toml [mcp_servers]`；本机绑定条目整条排除（复用 portableCodexConfig）。 */
export function snapshotCodexMcpSection(options: {readonly includeCredentials: boolean}): TransferResult<McpCodexSection> {
	const document = readCodexConfigDocumentStrict();
	const warnings: string[] = [];
	let rawServers: Readonly<Record<string, unknown>> = {};
	let excluded: readonly string[] = [];

	if (document.status === 'invalid') {
		warnings.push('Codex config.toml 损坏，未包含 MCP 配置');
	} else if (document.status === 'valid') {
		const portable = portableCodexConfig({mcp_servers: codexMcpServersOf(document.value)});
		rawServers = codexMcpServersOf(portable.config);
		excluded = codexExcludedIds(portable.excluded);
	}

	const snapshot = snapshotServerEntries(rawServers, options.includeCredentials);
	return transferOk(
		{
			containsCredentials: snapshot.containsCredentials,
			servers: snapshot.servers,
			excluded,
			excludedCredentials: snapshot.excludedCredentials
		},
		warnings
	);
}

/** 校验包中的 Codex MCP 分类（导入边界；再次应用 portableCodexConfig 本机绑定过滤）。 */
export function parseCodexMcpSection(value: unknown): TransferResult<McpCodexSection> {
	if (!isRecord(value)) {
		return transferFail('validation', 'MCP 分类内容无效');
	}

	const parsed = parseServerEntries(value.servers);
	if (!parsed.ok) {
		return parsed;
	}

	const servers: Record<string, JsonObject> = {};
	for (const entry of parsed.data) {
		servers[entry.id] = entry.config;
	}

	const portable = portableCodexConfig({mcp_servers: servers});
	const filtered = codexMcpServersOf(portable.config);
	return transferOk({
		containsCredentials: value.containsCredentials === true,
		servers: sortedEntries(filtered).flatMap(([id, config]) =>
			isRecord(config) ? [{id, config: structuredClone(config) as JsonObject}] : []
		),
		excluded: codexExcludedIds(portable.excluded),
		excludedCredentials: []
	});
}

/** 合并导入 Codex MCP：同 server id 覆盖，其他 TOML section 与本机 server 原样保留。 */
export function importCodexMcpSection(
	data: unknown,
	options: {readonly containsCredentials: boolean; readonly dryRun?: boolean}
): TransferResult<SectionMergeReport> {
	const parsed = parseCodexMcpSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const document = readCodexConfigDocumentStrict();
	if (document.status === 'invalid') {
		return transferFail('conflict', '本机 Codex config.toml 损坏，已停止导入 MCP');
	}

	const current = document.status === 'valid' ? document.value : {};
	const merged = mergeServerMap(
		codexMcpServersOf(current),
		sanitizeIncomingServers(parsed.data.servers, options.containsCredentials),
		false,
		true
	);
	if (!options.dryRun && merged.added.length + merged.replaced.length > 0) {
		try {
			atomicWriteToml(codexConfigPath(), setPath(current, ['mcp_servers'], merged.servers), {mode: SECRET_FILE_MODE});
		} catch {
			return transferFail('io', 'Codex config.toml 写入失败');
		}
	}

	return transferOk(mcpReport(merged.added, merged.replaced, merged.unchanged, parsed.data.excluded, parsed.warnings));
}

// ── Pi native runtime（mcp.json + CCQ ownership sidecar） ─────────────────

function parsePiOverrides(value: unknown): TransferResult<readonly McpServerEntry[]> {
	const parsed = parseServerEntries(value ?? []);
	if (!parsed.ok) return parsed;
	if (parsed.data.some(entry => typeof entry.config.enabled !== 'boolean'))
		return transferFail('validation', 'Pi override enabled 必须是布尔值');
	// Sidecar holds ownership, never arbitrary config/secrets or activation authority.
	return transferOk(parsed.data.map(entry => ({id: entry.id, config: {enabled: entry.config.enabled}})));
}

export function snapshotPiMcpSection(options: {readonly includeCredentials: boolean}): TransferResult<McpPiSection> {
	const warnings: string[] = [];
	const native = readPiMcpConfig();
	const rawServers: Record<string, unknown> = {};
	if (!native.ok) warnings.push('Pi 原生 mcp.json 损坏，未包含 MCP 配置');
	else {
		for (const [id, config] of Object.entries(native.document.mcpServers)) {
			if (validatePiMcpServer(id, config)) warnings.push(`Pi MCP ${id} schema 不受支持，未导出`);
			else rawServers[id] = config;
		}
	}
	const idError = validatePiMcpServerIds(Object.keys(rawServers));
	if (idError) return transferFail('validation', idError);
	const override = readPiMcpAdapterOverride();
	if (!override.ok) warnings.push('Pi MCP ownership sidecar 损坏，未包含所有权');
	const managedServers = override.ok
		? nativeManagedServers(override.document)
				.filter(id => Object.hasOwn(rawServers, id))
				.toSorted()
		: [];
	const snapshot = snapshotServerEntries(rawServers, options.includeCredentials);
	return transferOk(
		{
			dialect: PI_MCP_NATIVE_DIALECT,
			...(native.ok && typeof native.document.autoEnableCodemode === 'boolean'
				? {autoEnableCodemode: native.document.autoEnableCodemode}
				: {}),
			managedServers,
			containsCredentials: snapshot.containsCredentials,
			servers: snapshot.servers,
			overrides: managedServers.map(id => ({id, config: {enabled: (rawServers[id] as JsonObject).enabled !== false}})),
			excludedCredentials: snapshot.excludedCredentials,
			excludedAuth: snapshot.excludedAuth
		},
		warnings
	);
}

export function parsePiMcpSection(value: unknown): TransferResult<McpPiSection> {
	if (!isRecord(value) || value.dialect !== PI_MCP_NATIVE_DIALECT)
		return transferFail('validation', 'Pi MCP bundle 必须声明 dialect: pi-native');
	if (value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== 'boolean')
		return transferFail('validation', 'autoEnableCodemode 必须是布尔值');
	const parsed = parseServerEntries(value.servers);
	if (!parsed.ok) return parsed;
	const idError = validatePiMcpServerIds(parsed.data.map(entry => entry.id));
	if (idError) return transferFail('validation', idError);
	const overrides = parsePiOverrides(value.overrides);
	if (!overrides.ok) return overrides;
	const ids = new Set(parsed.data.map(entry => entry.id));
	if (overrides.data.some(entry => !ids.has(entry.id))) return transferFail('validation', 'Pi ownership 引用了包外服务器');
	const managed = value.managedServers ?? overrides.data.map(entry => entry.id);
	if (!Array.isArray(managed) || managed.some(id => typeof id !== 'string' || !ids.has(id)) || new Set(managed).size !== managed.length)
		return transferFail('validation', 'Pi managedServers 无效');
	const servers: McpServerEntry[] = [];
	for (const entry of parsed.data) {
		const error = validatePiMcpServer(entry.id, entry.config);
		if (error) return transferFail('validation', `Pi MCP schema 不受支持：${error}`);
		servers.push(entry);
	}
	return transferOk(
		{
			dialect: PI_MCP_NATIVE_DIALECT,
			...(typeof value.autoEnableCodemode === 'boolean' ? {autoEnableCodemode: value.autoEnableCodemode} : {}),
			managedServers: managed as string[],
			containsCredentials: value.containsCredentials === true,
			servers,
			overrides: overrides.data,
			excludedCredentials: [],
			excludedAuth: []
		},
		[]
	);
}

export function importPiMcpSection(
	data: unknown,
	options: {readonly containsCredentials: boolean; readonly dryRun?: boolean}
): TransferResult<SectionMergeReport> {
	const parsed = parsePiMcpSection(data);
	if (!parsed.ok) return parsed;
	const native = readPiMcpConfig();
	if (!native.ok) return transferFail('conflict', '本机 Pi 原生 mcp.json 损坏，已停止导入');
	const override = readPiMcpAdapterOverride();
	if (!override.ok) return transferFail('conflict', '本机 Pi MCP ownership sidecar 损坏，已停止导入');
	const incoming = sanitizeIncomingServers(parsed.data.servers, options.containsCredentials);
	const merged = mergeServerMap(native.document.mcpServers, incoming, true);
	for (const entry of incoming) {
		const error = validatePiMcpServer(entry.id, merged.servers[entry.id] as JsonObject);
		if (error) return transferFail('conflict', `Pi MCP 合并配置无效：${error}`);
	}
	const nextNative = {
		...native.document,
		...(parsed.data.autoEnableCodemode !== undefined ? {autoEnableCodemode: parsed.data.autoEnableCodemode} : {}),
		mcpServers: merged.servers as Record<string, JsonObject>
	};
	const owned = nativeOwnershipDocument(override.document);
	const servers = {...owned.servers};
	const managed = new Set(nativeManagedServers(owned));
	// Import is explicit user consent for bundled ownership only; unrelated legacy ids stay unowned.
	for (const id of parsed.data.managedServers) {
		managed.add(id);
		servers[id] = {...servers[id], enabled: (merged.servers[id] as JsonObject).enabled !== false};
	}
	const nextOverride = {...owned, servers, managedServers: [...managed]};
	if (parsed.data.autoEnableCodemode !== undefined && parsed.data.autoEnableCodemode !== native.document.autoEnableCodemode)
		merged.replaced.push('autoEnableCodemode');
	if (parsed.data.managedServers.length && JSON.stringify(override.document) !== JSON.stringify(nextOverride))
		merged.replaced.push('ownership');
	if (!options.dryRun) {
		const result = writePiMcpDocuments(nextNative, parsed.data.managedServers.length ? nextOverride : override.document);
		if (!result.Success) return transferFail('io', result.Status);
	}
	return transferOk(mcpReport(merged.added, merged.replaced, merged.unchanged, [], parsed.warnings));
}
