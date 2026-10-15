import {isDeepStrictEqual} from 'node:util';
import {type SectionMergeReport, type TransferResult, transferFail, transferOk} from './config-transfer.js';
import {readCodexConfigDocumentStrict} from './codex-config.js';
import type {execCommand} from './exec.js';
import {readJsonFileStrict} from './fs-utils.js';
import {
	backfillRuntimeMcpToVault,
	checkRuntimeTargetsReadable,
	disableServer,
	enableServer,
	normalizeVaultCredentials,
	piProjectionBlocker,
	piToggleBlocker,
	projectSharedDefinitionToRuntimes
} from './mcp.js';
import {MCP_META_SCHEMA_VERSION, saveVault, withVaultLock, type McpVault, type McpVaultServerEntry} from './mcp-vault.js';
import {
	PI_MCP_NATIVE_DIALECT,
	currentPiMcpNativeFact,
	detectPiMcpNative,
	piMcpDisplayReason,
	readPiMcpAdapterOverride,
	readPiMcpConfig,
	writePiMcpDocuments
} from './pi-mcp-adapter.js';
import {claudeJsonPath, settingsPath, vaultPath} from './paths.js';

// MCP 导入导出 seam：CCQ 共享契约（vault）承载全部配置，cc/cx/pi 分类只承载开关。
// 领域语义仍归原 owner：vault 读写走 mcp-vault.ts 的锁与 saveVault，投影与启停复用 mcp.ts，
// Pi 标准配置/sidecar 复用 pi-mcp-adapter 的严格读取器与双文件事务。
// 未选择敏感凭据时 env/headers/http_headers 值与 bearerToken 整键移除，只报告 identity/键名；
// OAuth 静态参数可迁移；clientSecret 按凭据开关处理；登录态永不进入包。
// 导入按 server id 整体覆盖或跳过，绝不与本机条目字段合并，也不删除包外 id。

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

const MCP_ACTIVATION_FORMAT = 'activation';

type McpAgent = 'cc' | 'cx' | 'pi';

/** Agent MCP 分类：只迁移开关；配置一律来自共享契约。 */
export type McpActivationSection = {
	readonly format: typeof MCP_ACTIVATION_FORMAT;
	readonly dialect?: typeof PI_MCP_NATIVE_DIALECT;
	readonly autoEnableCodemode?: boolean;
	readonly servers: readonly {readonly id: string; readonly enabled: boolean}[];
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

/** 契约 id：vault 中带 config 的条目；开关分类只对这些 id 生效。 */
function vaultContractIds(servers: Readonly<Record<string, McpVaultServerEntry>>): ReadonlySet<string> {
	return new Set(Object.keys(servers).filter(id => isRecord(servers[id]?.config)));
}

/** 预览用契约 id：本机 vault ∪ 包内共享库（若包含该分类）；apply 时以真实 vault 为准。 */
export function previewMcpContractIds(libraryData: unknown): ReadonlySet<string> {
	const vault = readVaultDocument();
	const ids = new Set(vault.ok ? vaultContractIds(vault.data.servers) : []);
	const library = libraryData === undefined ? undefined : parseMcpLibrarySection(libraryData);
	for (const entry of library?.ok ? library.data.servers : []) ids.add(entry.id);
	return ids;
}

/** 导出前把 runtime-only id 补入契约（只补缺）；共享库损坏时不写，由快照自行告警。 */
export function backfillMcpLibraryForExport(): readonly string[] {
	if (!readVaultDocument().ok) return [];
	try {
		backfillRuntimeMcpToVault();
		return [];
	} catch {
		return ['MCP runtime 条目补录到共享库失败，导出仅包含已有契约条目'];
	}
}

/** 包条目 → 完整 vault 条目：不继承本机任何字段或凭据，activation 字段不进入定义。 */
function vaultEntryOf(entry: McpServerEntry): McpVaultServerEntry {
	const {enabled: _enabled, disabled: _disabled, ...config} = entry.config;
	void _enabled;
	void _disabled;
	return {
		config,
		permissions: [...(entry.permissions ?? [])],
		...(Object.keys(entry.credentials ?? {}).length > 0 ? {credentials: {values: {...entry.credentials}}} : {}),
		...(entry.definitionHash !== undefined ? {definitionHash: entry.definitionHash} : {}),
		...(entry.updatedAt !== undefined ? {updatedAt: entry.updatedAt} : {})
	};
}

/** vault 条目中的凭据键名（不含值）。 */
function vaultCredentialKeys(entry: McpVaultServerEntry): readonly string[] {
	return [
		...stripServerConfig(isRecord(entry.config) ? entry.config : {}, true).credentialKeys,
		...Object.keys(normalizeVaultCredentials(entry)).map(key => `credentials:${key}`)
	];
}

/** 覆盖导入 CCQ MCP 共享库：包内 id 整体替换并投影到各 Agent；包外 id 不变。 */
export async function importMcpLibrarySection(
	data: unknown,
	options: {readonly containsCredentials: boolean; readonly dryRun?: boolean; readonly exec?: typeof execCommand}
): Promise<TransferResult<SectionMergeReport>> {
	const parsed = parseMcpLibrarySection(data);
	if (!parsed.ok) {
		return parsed;
	}

	if (!options.containsCredentials && parsed.data.servers.some(entry => Object.keys(entry.credentials ?? {}).length > 0)) {
		return transferFail('validation', '导出包包含未声明的凭据');
	}

	const unreadable = checkRuntimeTargetsReadable('');
	if (unreadable) {
		return transferFail('conflict', `本机 MCP 配置无法读取，已停止导入：${unreadable.Status}`);
	}

	await detectPiMcpNative(options.exec);
	let written: TransferResult<SectionMergeReport>;
	try {
		written = withVaultLock(() => {
			const current = readVaultDocument();
			if (!current.ok) {
				return transferFail('conflict', '本机 MCP 共享库损坏或版本不受支持，已停止导入');
			}

			const added: string[] = [];
			const replaced: string[] = [];
			const unchanged: string[] = [];
			const warnings: string[] = [...parsed.warnings];
			const meta: McpVault = {
				schemaVersion: current.data.schemaVersion,
				createdAt: current.data.createdAt,
				updatedAt: current.data.updatedAt,
				servers: {...current.data.servers}
			};

			for (const entry of sanitizeIncomingServers(parsed.data.servers, options.containsCredentials)) {
				const local = current.data.servers[entry.id];
				const next = vaultEntryOf(entry);
				if (local && isDeepStrictEqual(local, next)) {
					unchanged.push(entry.id);
					continue;
				}

				const piBlocker = piProjectionBlocker(entry.id, next.config ?? {}, false);
				if (piBlocker) {
					return transferFail('conflict', `MCP ${entry.id} 无法同步到本机 Pi 条目：${piBlocker}`);
				}

				if (local) {
					replaced.push(entry.id);
					const kept = new Set(vaultCredentialKeys(next));
					const cleared = vaultCredentialKeys(local).filter(key => !kept.has(key));
					if (cleared.length > 0) warnings.push(`MCP ${entry.id} 将清除本机凭据：${cleared.join(', ')}`);
				} else {
					added.push(entry.id);
				}

				meta.servers[entry.id] = next;
			}

			if (!options.dryRun && added.length + replaced.length > 0) {
				saveVault(meta);
			}

			return transferOk(mcpReport(added, replaced, unchanged, [], warnings));
		});
	} catch {
		return transferFail('io', 'MCP 共享库写入失败');
	}

	if (!written.ok || options.dryRun) {
		return written;
	}

	// 与编辑保存同语义：各 Agent 同 id 配置被替换，activation 保持。
	for (const id of [...written.data.added, ...written.data.replaced]) {
		try {
			const projected = projectSharedDefinitionToRuntimes(id);
			if (!projected.Success) return transferFail('io', `MCP ${id} 同步到 Agent 配置失败：${projected.Status}`);
		} catch {
			return transferFail('io', `MCP ${id} 同步到 Agent 配置失败`);
		}
	}

	return written;
}

// ── Agent 开关分类（cc/cx/pi） ──────────────────────────────────────────────

type AgentRuntime = {
	readonly servers: Readonly<Record<string, unknown>>;
	readonly autoEnableCodemode?: boolean;
};

function readAgentRuntime(tool: McpAgent): TransferResult<AgentRuntime> {
	if (tool === 'cc') {
		const claudeJson = readJsonFileStrict<unknown>(claudeJsonPath());
		if (claudeJson.status === 'invalid' || (claudeJson.status === 'valid' && !isRecord(claudeJson.value))) {
			return transferFail('conflict', '本机 .claude.json 损坏或结构无效');
		}

		const servers = claudeJson.status === 'valid' ? (claudeJson.value as JsonObject).mcpServers : undefined;
		return transferOk({servers: isRecord(servers) ? servers : {}});
	}

	if (tool === 'cx') {
		const document = readCodexConfigDocumentStrict();
		if (document.status === 'invalid') {
			return transferFail('conflict', '本机 Codex config.toml 损坏');
		}

		const servers = document.status === 'valid' ? document.value.mcp_servers : undefined;
		return transferOk({servers: isRecord(servers) ? servers : {}});
	}

	const native = readPiMcpConfig();
	if (!native.ok) {
		return transferFail('conflict', native.detail);
	}

	const {autoEnableCodemode} = native.document;
	return transferOk({
		servers: native.document.mcpServers,
		...(typeof autoEnableCodemode === 'boolean' ? {autoEnableCodemode} : {})
	});
}

/** Claude 存在即开启；Codex/Pi `enabled !== false`，旧 Pi `disabled:true` 视为禁用。 */
function isRuntimeActive(tool: McpAgent, config: unknown): boolean {
	return isRecord(config) && (tool === 'cc' || (config.enabled !== false && config.disabled !== true));
}

/** 快照 Agent MCP 开关：id 集合 = 契约 ∪ runtime，不含任何 config 或凭据。 */
export function snapshotMcpActivationSection(tool: McpAgent): TransferResult<McpActivationSection> {
	const base: Pick<McpActivationSection, 'format' | 'dialect'> = {
		format: MCP_ACTIVATION_FORMAT,
		...(tool === 'pi' ? {dialect: PI_MCP_NATIVE_DIALECT} : {})
	};
	const runtime = readAgentRuntime(tool);
	if (!runtime.ok) {
		return transferOk({...base, servers: []}, [`${runtime.error}，未包含 MCP 开关`]);
	}

	const vault = readVaultDocument();
	const ids = new Set([...(vault.ok ? vaultContractIds(vault.data.servers) : []), ...Object.keys(runtime.data.servers)]);
	return transferOk(
		{
			...base,
			...(runtime.data.autoEnableCodemode !== undefined ? {autoEnableCodemode: runtime.data.autoEnableCodemode} : {}),
			servers: [...ids].sort().map(id => ({id, enabled: isRuntimeActive(tool, runtime.data.servers[id])}))
		},
		vault.ok ? [] : [vault.error]
	);
}

/** 校验包中的 Agent MCP 分类；无 format 的旧包只推导开关，config 一律丢弃且不做 schema 校验。 */
export function parseMcpActivationSection(tool: McpAgent, value: unknown): TransferResult<McpActivationSection> {
	if (!isRecord(value) || !Array.isArray(value.servers)) {
		return transferFail('validation', 'MCP 分类缺少服务器列表');
	}

	if (value.format !== undefined && value.format !== MCP_ACTIVATION_FORMAT) {
		return transferFail('validation', 'MCP 分类格式不受支持');
	}

	if (tool === 'pi' && value.autoEnableCodemode !== undefined && typeof value.autoEnableCodemode !== 'boolean') {
		return transferFail('validation', 'autoEnableCodemode 必须是布尔值');
	}

	const legacy = value.format === undefined;
	const servers: {readonly id: string; readonly enabled: boolean}[] = [];
	const seen = new Set<string>();
	for (const raw of value.servers) {
		if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') {
			return transferFail('validation', 'MCP 分类包含无效服务器条目');
		}

		if (seen.has(raw.id)) {
			return transferFail('validation', 'MCP 分类包含重复服务器');
		}

		seen.add(raw.id);
		const enabled = legacy ? isRuntimeActive(tool, isRecord(raw.config) ? raw.config : {}) : raw.enabled;
		if (typeof enabled !== 'boolean') {
			return transferFail('validation', 'MCP 分类开关必须是布尔值');
		}

		servers.push({id: raw.id, enabled});
	}

	return transferOk({
		format: MCP_ACTIVATION_FORMAT,
		...(tool === 'pi' ? {dialect: PI_MCP_NATIVE_DIALECT} : {}),
		...(tool === 'pi' && typeof value.autoEnableCodemode === 'boolean' ? {autoEnableCodemode: value.autoEnableCodemode} : {}),
		servers
	});
}

/** Pi 开关写入前的拒绝原因；仅包内契约有、本机尚无的 id 只能检查 Pi 能力。 */
function piBlocker(id: string, known: boolean): string | undefined {
	if (known) return piToggleBlocker(id);
	const fact = currentPiMcpNativeFact();
	return fact.supported ? undefined : piMcpDisplayReason(fact.reason ?? 'pi-not-detected');
}

/** 覆盖导入 Agent MCP 开关：包内 id 按包内状态启用/禁用（配置来自契约）；包外 id 不变。 */
export async function importMcpActivationSection(
	tool: McpAgent,
	data: unknown,
	options: {readonly dryRun?: boolean; readonly contractIds?: ReadonlySet<string>; readonly exec?: typeof execCommand}
): Promise<TransferResult<SectionMergeReport>> {
	const parsed = parseMcpActivationSection(tool, data);
	if (!parsed.ok) {
		return parsed;
	}

	const runtime = readAgentRuntime(tool);
	if (!runtime.ok) {
		return transferFail('conflict', `${runtime.error}，已停止导入 MCP`);
	}

	const vault = readVaultDocument();
	if (!vault.ok) {
		return transferFail('conflict', '本机 MCP 共享库损坏或版本不受支持，已停止导入');
	}

	if (tool === 'cc') {
		const settings = readJsonFileStrict<unknown>(settingsPath());
		if (settings.status === 'invalid' || (settings.status === 'valid' && !isRecord(settings.value))) {
			return transferFail('conflict', '本机 settings.json 损坏，已停止导入 MCP');
		}
	}

	if (tool === 'pi') {
		const override = readPiMcpAdapterOverride();
		if (!override.ok) {
			return transferFail('conflict', `${override.detail}，已停止导入 MCP`);
		}

		await detectPiMcpNative(options.exec);
	}

	const contract = options.contractIds ?? vaultContractIds(vault.data.servers);
	const added: string[] = [];
	const replaced: string[] = [];
	const unchanged: string[] = [];
	const skipped: string[] = [];
	const warnings: string[] = [];
	const changes: {readonly id: string; readonly enabled: boolean}[] = [];

	for (const {id, enabled} of parsed.data.servers) {
		if (!contract.has(id)) {
			skipped.push(id);
			warnings.push(`MCP ${id} 不在共享库契约中，已跳过`);
			continue;
		}

		const present = Object.hasOwn(runtime.data.servers, id);
		// Claude 关闭即条目缺失，因此缺失 + 目标关闭已是目标状态；Codex/Pi 缺失需写 enabled:false。
		if (isRuntimeActive(tool, runtime.data.servers[id]) === enabled && (present || tool === 'cc')) {
			unchanged.push(id);
			continue;
		}

		const blocker = tool === 'pi' ? piBlocker(id, present || Object.hasOwn(vault.data.servers, id)) : undefined;
		if (blocker) {
			skipped.push(id);
			warnings.push(`MCP ${id} 已跳过：${blocker}`);
			continue;
		}

		(present ? replaced : added).push(id);
		changes.push({id, enabled});
	}

	const codemode = parsed.data.autoEnableCodemode;
	const codemodeChanged = codemode !== undefined && codemode !== runtime.data.autoEnableCodemode;
	if (codemodeChanged) {
		replaced.push('autoEnableCodemode');
	}

	if (!options.dryRun) {
		for (const {id, enabled} of changes) {
			try {
				const result = enabled ? enableServer(id, tool) : disableServer(id, tool);
				if (!result.Success) return transferFail('io', `MCP ${id} ${enabled ? '开启' : '禁用'}失败：${result.Status}`);
			} catch {
				return transferFail('io', `MCP ${id} ${enabled ? '开启' : '禁用'}失败`);
			}
		}

		if (codemodeChanged) {
			const native = readPiMcpConfig();
			const override = readPiMcpAdapterOverride();
			if (!native.ok || !override.ok) return transferFail('conflict', 'Pi MCP 文件无法读取，已停止导入');
			const result = writePiMcpDocuments({...native.document, autoEnableCodemode: codemode}, override.document);
			if (!result.Success) return transferFail('io', result.Status);
		}
	}

	return transferOk(mcpReport(added, replaced, unchanged, skipped, warnings));
}
