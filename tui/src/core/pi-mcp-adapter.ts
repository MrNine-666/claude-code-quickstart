import {existsSync, unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {execCommand, type ExecResult} from './exec.js';
import {readJsonFile, readJsonFileStrict, writeJsonAtomic, SECRET_FILE_MODE} from './fs-utils.js';
import {piAgentDir, piMcpAdapterOverridesPath, piMcpConfigPath} from './paths.js';
import {detectTool, TOOL_DEFINITIONS} from './tools-install.js';
import type {McpServerDefinition} from './mcp-contract.js';

export const PI_MCP_ADAPTER_ID = 'pi-mcp-adapter';

export type PiMcpUnsupportedReason =
	| 'pi-not-installed'
	| 'adapter-not-installed'
	| 'definition-not-expressible'
	| 'override-read-failed'
	| 'config-read-failed'
	| 'adapter-detection-failed';

export type PiMcpAdapterFact = {
	readonly piInstalled: boolean;
	readonly adapterInstalled: boolean;
	readonly overrideReadable: boolean;
	readonly configReadable: boolean;
	readonly supported: boolean;
	readonly reason?: PiMcpUnsupportedReason;
	readonly detail?: string;
};

export type PiMcpOverrideEntry = {
	readonly enabled: boolean;
	readonly [key: string]: unknown;
};

export type PiMcpOverrideDocument = {
	readonly schemaVersion: number;
	readonly servers: Readonly<Record<string, PiMcpOverrideEntry>>;
	readonly managedServers?: readonly string[];
	readonly [key: string]: unknown;
};

export type PiMcpOverrideRead =
	| {readonly ok: true; readonly document: PiMcpOverrideDocument}
	| {readonly ok: false; readonly reason: 'override-read-failed'; readonly detail: string};

const EMPTY_OVERRIDE: PiMcpOverrideDocument = {schemaVersion: 1, servers: {}};
let detectedFact: PiMcpAdapterFact | undefined;

export type PiMcpServerProjection = {
	readonly serverId: string;
	readonly definition: McpServerDefinition | null;
	readonly config: Record<string, unknown>;
	readonly credentials?: Readonly<Record<string, string>>;
	readonly enabled: boolean;
};

export type PiMcpConfigDocument = {
	readonly mcpServers: Readonly<Record<string, Record<string, unknown>>>;
	readonly [key: string]: unknown;
};

export type PiMcpConfigSyncResult =
	| {readonly Success: true; readonly Status: 'Synced' | 'Unchanged'}
	| {readonly Success: false; readonly Status: string};

type PiMcpConfigRead =
	| {readonly ok: true; readonly document: PiMcpConfigDocument}
	| {readonly ok: false; readonly reason: 'config-read-failed'; readonly detail: string};

function rememberDetectedFact(fact: PiMcpAdapterFact): PiMcpAdapterFact {
	detectedFact = fact;
	return fact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function packageName(value: unknown): string {
	if (typeof value === 'string') {
		const normalized = value
			.replace(/^npm:/, '')
			.replace(/@latest$/, '')
			.trim();
		const versioned = normalized.match(
			/^(?<name>(?:@[^/]+\/)?[^@/]+)@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/
		);
		return versioned?.groups?.name ?? normalized;
	}

	if (!isRecord(value)) return '';
	for (const key of ['name', 'package', 'id', 'spec']) {
		const candidate = packageName(value[key]);
		if (candidate) return candidate;
	}

	return '';
}

/** 解析 `pi list --no-approve` 的已安装 package 名称，供检测和 focused gate 共用。 */
export function parsePiPackageNames(raw: string): readonly string[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const names = raw
			.split(/\r?\n/)
			.map(line => line.replace(/[│├└─]/g, ''))
			.map(line => {
				const source = line.trim();
				const indentation = line.match(/^\s*/)?.[0].length ?? 0;
				if (!source || (indentation > 2 && /^(?:[A-Za-z]:[\\/]|\/)/.test(source))) return '';
				if (!/^(?:npm:|git:|https?:\/\/|file:|\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(source)) return '';
				return packageName(source.split(/\s+/)[0] ?? '');
			})
			.filter(Boolean);
		return [...new Set(names)];
	}

	const values: unknown[] = [];
	if (Array.isArray(parsed)) {
		values.push(...parsed);
	} else if (isRecord(parsed)) {
		for (const key of ['packages', 'extensions', 'items']) {
			if (Array.isArray(parsed[key])) values.push(...(parsed[key] as unknown[]));
		}
		if (values.length === 0) values.push(parsed);
	}

	return [...new Set(values.map(packageName).filter(Boolean))];
}

export function hasPiMcpAdapterPackage(raw: string): boolean {
	return parsePiPackageNames(raw).some(name => name === PI_MCP_ADAPTER_ID || name.endsWith(`/${PI_MCP_ADAPTER_ID}`));
}

function validateOverrideDocument(value: unknown): PiMcpOverrideDocument | undefined {
	if (!isRecord(value)) return undefined;
	if (value.schemaVersion !== undefined && (typeof value.schemaVersion !== 'number' || value.schemaVersion < 1)) return undefined;
	if (value.servers !== undefined && !isRecord(value.servers)) return undefined;
	if (
		value.managedServers !== undefined &&
		(!Array.isArray(value.managedServers) || value.managedServers.some(item => typeof item !== 'string'))
	)
		return undefined;

	const servers: Record<string, PiMcpOverrideEntry> = {};
	for (const [serverId, rawEntry] of Object.entries((value.servers as Record<string, unknown> | undefined) ?? {})) {
		if (!isRecord(rawEntry) || typeof rawEntry.enabled !== 'boolean') return undefined;
		servers[serverId] = rawEntry as PiMcpOverrideEntry;
	}

	return {
		...value,
		schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
		servers,
		...(Array.isArray(value.managedServers) ? {managedServers: [...value.managedServers] as string[]} : {})
	};
}

export function readPiMcpAdapterOverride(): PiMcpOverrideRead {
	const result = readJsonFileStrict<unknown>(piMcpAdapterOverridesPath());
	if (result.status === 'missing') return {ok: true, document: EMPTY_OVERRIDE};
	if (result.status === 'invalid') return {ok: false, reason: 'override-read-failed', detail: result.error};
	const document = validateOverrideDocument(result.value);
	return document ? {ok: true, document} : {ok: false, reason: 'override-read-failed', detail: 'override JSON schema 无效'};
}

function validatePiMcpConfig(value: unknown): PiMcpConfigDocument | undefined {
	if (!isRecord(value)) return undefined;

	const rawServers = value.mcpServers ?? value['mcp-servers'] ?? {};
	if (!isRecord(rawServers)) return undefined;

	const mcpServers: Record<string, Record<string, unknown>> = {};
	for (const [serverId, rawEntry] of Object.entries(rawServers)) {
		if (!isRecord(rawEntry)) return undefined;
		mcpServers[serverId] = rawEntry;
	}

	const document = {...value};
	delete document['mcp-servers'];
	document.mcpServers = mcpServers;
	return document as PiMcpConfigDocument;
}

export function readPiMcpConfig(): PiMcpConfigRead {
	const result = readJsonFileStrict<unknown>(piMcpConfigPath());
	if (result.status === 'missing') return {ok: true, document: {mcpServers: {}}};
	if (result.status === 'invalid') return {ok: false, reason: 'config-read-failed', detail: result.error};
	const document = validatePiMcpConfig(result.value);
	return document ? {ok: true, document} : {ok: false, reason: 'config-read-failed', detail: 'Pi MCP config JSON schema 无效'};
}

/** 共享 MCP 全量删除时清理指定 server 的 Pi-owned override 记录。 */
export function removePiMcpOverrideRecord(serverId: string): {Success: boolean; ServerId: string; Status: string} {
	const current = readPiMcpAdapterOverride();
	if (!current.ok) {
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${current.detail}`};
	}

	const managed = current.document.managedServers?.includes(serverId) || Object.hasOwn(current.document.servers, serverId);
	if (!managed) {
		return {Success: true, ServerId: serverId, Status: 'Removed'};
	}

	const native = readPiMcpConfig();
	if (!native.ok) {
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${native.detail}`};
	}

	const servers = {...current.document.servers};
	delete servers[serverId];
	const nextOverride = withManagedServer({...current.document, servers}, serverId, true);
	const nextNative = nativeDocumentWithoutServer(native.document, serverId);
	const result = writePiMcpDocuments(
		existsSync(piMcpConfigPath()),
		native.document,
		existsSync(piMcpAdapterOverridesPath()),
		current.document,
		nextNative,
		nextOverride
	);
	return result.Success
		? {Success: true, ServerId: serverId, Status: 'Removed'}
		: {Success: false, ServerId: serverId, Status: result.Status};
}

function adapterMarkerExists(): boolean {
	const agentDir = piAgentDir();
	const markerPaths = [
		join(agentDir, 'extensions', PI_MCP_ADAPTER_ID),
		join(agentDir, 'extensions', `${PI_MCP_ADAPTER_ID}.js`),
		join(agentDir, 'packages', PI_MCP_ADAPTER_ID),
		join(agentDir, 'packages', `${PI_MCP_ADAPTER_ID}.js`)
	];
	if (markerPaths.some(existsSync)) return true;

	const settings = readJsonFile<Record<string, unknown>>(join(agentDir, 'settings.json'), {});
	for (const key of ['extensions', 'packages']) {
		const value = settings[key];
		if (Array.isArray(value) && value.some(item => packageName(item) === PI_MCP_ADAPTER_ID)) return true;
		if (isRecord(value) && Object.keys(value).some(item => item === PI_MCP_ADAPTER_ID)) return true;
	}

	return false;
}

/** 同步 projection 的保守事实：未完成异步 `pi list` 检测时，宁可显示 unsupported。 */
export function readLocalPiMcpAdapterFact(): PiMcpAdapterFact {
	const override = readPiMcpAdapterOverride();
	if (!override.ok) {
		return {
			piInstalled: existsSync(piAgentDir()),
			adapterInstalled: false,
			overrideReadable: false,
			configReadable: false,
			supported: false,
			reason: 'override-read-failed',
			detail: override.detail
		};
	}

	const piInstalled = existsSync(piAgentDir());
	if (!piInstalled)
		return {
			piInstalled: false,
			adapterInstalled: false,
			overrideReadable: true,
			configReadable: true,
			supported: false,
			reason: 'pi-not-installed'
		};
	const config = readPiMcpConfig();
	if (!config.ok)
		return {
			piInstalled: true,
			adapterInstalled: false,
			overrideReadable: true,
			configReadable: false,
			supported: false,
			reason: 'config-read-failed',
			detail: config.detail
		};
	if (!adapterMarkerExists())
		return {
			piInstalled: true,
			adapterInstalled: false,
			overrideReadable: true,
			configReadable: true,
			supported: false,
			reason: 'adapter-not-installed'
		};
	return {piInstalled: true, adapterInstalled: true, overrideReadable: true, configReadable: true, supported: true};
}

export function currentPiMcpAdapterFact(): PiMcpAdapterFact {
	return detectedFact ?? readLocalPiMcpAdapterFact();
}

function piDefinitionExpressible(definition: McpServerDefinition | null): boolean {
	if (!definition) return false;
	if (definition.McpType === 'stdio') return typeof definition.Command === 'string' && definition.Command.trim().length > 0;
	if (definition.McpType === 'http') return typeof definition.Url === 'string' || typeof definition.UrlTemplate === 'string';
	return typeof definition.Command === 'string' || typeof definition.Url === 'string' || typeof definition.UrlTemplate === 'string';
}

export function isPiMcpDefinitionExpressible(definition: McpServerDefinition | null, config: Record<string, unknown> | null): boolean {
	if (piDefinitionExpressible(definition)) return true;
	if (!config) return false;
	return typeof config.command === 'string' || typeof config.url === 'string' || typeof config.httpUrl === 'string';
}

export function piMcpUnsupportedReason(
	fact: PiMcpAdapterFact,
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null
): PiMcpUnsupportedReason | undefined {
	if (!fact.piInstalled) return 'pi-not-installed';
	if (!fact.adapterInstalled) return 'adapter-not-installed';
	if (!fact.overrideReadable) return 'override-read-failed';
	if (!fact.configReadable) return 'config-read-failed';
	if (!isPiMcpDefinitionExpressible(definition, config)) return 'definition-not-expressible';
	return undefined;
}

function unsupportedDetail(reason: PiMcpUnsupportedReason): string {
	return {
		'pi-not-installed': 'Pi Agent CLI 未安装',
		'adapter-not-installed': 'pi-mcp-adapter 未安装',
		'definition-not-expressible': '该 MCP 定义缺少 Pi adapter 可表达的 command/url',
		'override-read-failed': 'Pi adapter override 无法读取',
		'config-read-failed': 'Pi MCP 标准配置无法读取',
		'adapter-detection-failed': 'Pi runtime/package 状态读取失败'
	}[reason];
}

export function piMcpDisplayReason(reason: PiMcpUnsupportedReason): string {
	return unsupportedDetail(reason);
}

async function detectPiCli(exec: typeof execCommand): Promise<boolean> {
	const definition = TOOL_DEFINITIONS.find(item => item.id === 'PiCli');
	if (!definition) return false;
	return (await detectTool(definition, exec)).installed;
}

export async function detectPiMcpAdapter(exec: typeof execCommand = execCommand): Promise<PiMcpAdapterFact> {
	try {
		const piInstalled = await detectPiCli(exec);
		if (!piInstalled) {
			return rememberDetectedFact({
				piInstalled: false,
				adapterInstalled: false,
				overrideReadable: true,
				configReadable: true,
				supported: false,
				reason: 'pi-not-installed'
			});
		}

		const result: ExecResult = await exec('pi', ['list', '--no-approve'], {timeout: 15000});
		if (result.code !== 0) {
			return rememberDetectedFact({
				piInstalled: true,
				adapterInstalled: false,
				overrideReadable: false,
				configReadable: true,
				supported: false,
				reason: 'adapter-detection-failed',
				detail: result.stderr || result.stdout
			});
		}

		const override = readPiMcpAdapterOverride();
		if (!override.ok) {
			return rememberDetectedFact({
				piInstalled: true,
				adapterInstalled: false,
				overrideReadable: false,
				configReadable: false,
				supported: false,
				reason: 'override-read-failed',
				detail: override.detail
			});
		}

		const adapterInstalled = hasPiMcpAdapterPackage(result.stdout);
		const config = readPiMcpConfig();
		if (!config.ok) {
			return rememberDetectedFact({
				piInstalled: true,
				adapterInstalled,
				overrideReadable: true,
				configReadable: false,
				supported: false,
				reason: 'config-read-failed',
				detail: config.detail
			});
		}
		return rememberDetectedFact({
			piInstalled: true,
			adapterInstalled,
			overrideReadable: true,
			configReadable: true,
			supported: adapterInstalled,
			...(adapterInstalled ? {} : {reason: 'adapter-not-installed' as const})
		});
	} catch (error) {
		return rememberDetectedFact({
			piInstalled: false,
			adapterInstalled: false,
			overrideReadable: false,
			configReadable: false,
			supported: false,
			reason: 'adapter-detection-failed',
			detail: error instanceof Error ? error.message : String(error)
		});
	}
}

export function resetPiMcpAdapterFact(): void {
	detectedFact = undefined;
}

const PI_NATIVE_MANAGED_KEYS = new Set([
	'args',
	'auth',
	'bearerToken',
	'bearerTokenEnv',
	'bearerTokenStore',
	'command',
	'cwd',
	'disabled',
	'env',
	'headers',
	'http_headers',
	'httpUrl',
	'idleTimeout',
	'lifecycle',
	'oauth',
	'requestHeadersCommand',
	'requestTimeoutMs',
	'socket',
	'type',
	'url'
]);

function stringRecord(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	const result: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (item !== undefined && item !== null) result[key] = String(item);
	}
	return result;
}

function buildPiMcpServerEntry(projection: PiMcpServerProjection): Record<string, unknown> {
	const {definition, config, credentials = {}} = projection;
	const entry: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(config)) {
		if (value === undefined || key === 'type' || key === 'enabled' || key === 'disabled' || key === 'removed' || key === 'http_headers')
			continue;
		if (key === 'args' && Array.isArray(value)) {
			entry.args = value.filter((item): item is string => typeof item === 'string');
			continue;
		}
		if (key === 'env' || key === 'headers') continue;
		entry[key] = value;
	}

	if (typeof entry.command !== 'string' && typeof definition?.Command === 'string') {
		entry.command = definition.Command;
	}
	if (!Array.isArray(entry.args) && Array.isArray(definition?.Args)) {
		entry.args = definition.Args.map(String);
	}
	if (typeof entry.url !== 'string') {
		if (typeof config.httpUrl === 'string') {
			entry.url = config.httpUrl;
		} else if (typeof definition?.Url === 'string') {
			entry.url = definition.Url;
		} else if (typeof definition?.UrlTemplate === 'string') {
			let templateUrl = definition.UrlTemplate;
			for (const [name, value] of Object.entries(credentials)) {
				templateUrl = templateUrl.split(`{${name}}`).join(encodeURIComponent(value));
			}
			if (!/\{[A-Za-z0-9_]+\}/.test(templateUrl)) entry.url = templateUrl;
		}
	}

	const env = stringRecord(config.env);
	const headers = {...stringRecord(config.http_headers), ...stringRecord(config.headers)};
	const headerNames = new Set((definition?.OptionalHeaders ?? []).map(header => header.HeaderName).filter(Boolean));
	const isHttp = typeof entry.url === 'string' || definition?.McpType === 'http';
	const isUrlEmbedded = definition?.CredentialType === 'url-embedded';
	const isArgsCredential = definition?.CredentialType === 'args-multi' || definition?.CredentialType === 'args-token';

	for (const [name, value] of Object.entries(credentials)) {
		if (value === '') continue;
		if (headerNames.has(name) || Object.hasOwn(headers, name) || (isHttp && !isUrlEmbedded && !isArgsCredential)) {
			headers[name] = value;
		} else if (!isArgsCredential && (!isHttp || typeof entry.command === 'string')) {
			env[name] = value;
		}
	}

	if (Object.keys(env).length > 0) entry.env = env;
	if (Object.keys(headers).length > 0) entry.headers = headers;
	if (projection.enabled === false) entry.disabled = true;
	return entry;
}

function mergePiMcpServerEntry(existing: Record<string, unknown> | undefined, projection: PiMcpServerProjection): Record<string, unknown> {
	const previous = isRecord(existing) ? {...existing} : {};
	const next = buildPiMcpServerEntry(projection);
	for (const key of PI_NATIVE_MANAGED_KEYS) {
		if (!Object.hasOwn(next, key)) delete previous[key];
	}
	return {...previous, ...next};
}

function restorePiMcpFile(filePath: string, existed: boolean, document: Record<string, unknown>): void {
	if (!existed) {
		try {
			unlinkSync(filePath);
		} catch {}
		return;
	}
	writeJsonAtomic(filePath, document, {mode: SECRET_FILE_MODE});
}

function writePiMcpDocuments(
	previousNativeExisted: boolean,
	previousNative: PiMcpConfigDocument,
	previousOverrideExisted: boolean,
	previousOverride: PiMcpOverrideDocument,
	nextNative: PiMcpConfigDocument,
	nextOverride: PiMcpOverrideDocument
): PiMcpConfigSyncResult {
	const nativeChanged = JSON.stringify(previousNative) !== JSON.stringify(nextNative);
	const overrideChanged = JSON.stringify(previousOverride) !== JSON.stringify(nextOverride);
	if (!nativeChanged && !overrideChanged) return {Success: true, Status: 'Unchanged'};

	try {
		if (nativeChanged) writeJsonAtomic(piMcpConfigPath(), nextNative, {mode: SECRET_FILE_MODE});
		if (overrideChanged) writeJsonAtomic(piMcpAdapterOverridesPath(), nextOverride, {mode: SECRET_FILE_MODE});

		const nativePostflight = readPiMcpConfig();
		const overridePostflight = readPiMcpAdapterOverride();
		if (!nativePostflight.ok || JSON.stringify(nativePostflight.document) !== JSON.stringify(nextNative)) {
			throw new Error('Pi MCP 标准配置 postflight 校验失败');
		}
		if (!overridePostflight.ok || JSON.stringify(overridePostflight.document) !== JSON.stringify(nextOverride)) {
			throw new Error('Pi MCP ownership sidecar postflight 校验失败');
		}
		return {Success: true, Status: 'Synced'};
	} catch (error) {
		try {
			if (nativeChanged) restorePiMcpFile(piMcpConfigPath(), previousNativeExisted, previousNative);
			if (overrideChanged) restorePiMcpFile(piMcpAdapterOverridesPath(), previousOverrideExisted, previousOverride);
		} catch {}
		return {Success: false, Status: `WriteFailed: ${error instanceof Error ? error.message : String(error)}`};
	}
}

function withManagedServer(document: PiMcpOverrideDocument, serverId: string, remove = false): PiMcpOverrideDocument {
	const managed = new Set((document.managedServers ?? []).filter(item => typeof item === 'string'));
	if (remove) managed.delete(serverId);
	else managed.add(serverId);
	const next = {...document};
	if (managed.size > 0) next.managedServers = [...managed];
	else delete next.managedServers;
	return next;
}

function nativeDocumentWithServer(document: PiMcpConfigDocument, serverId: string, projection: PiMcpServerProjection): PiMcpConfigDocument {
	return {
		...document,
		mcpServers: {...document.mcpServers, [serverId]: mergePiMcpServerEntry(document.mcpServers[serverId], projection)}
	};
}

function nativeDocumentWithoutServer(document: PiMcpConfigDocument, serverId: string): PiMcpConfigDocument {
	const mcpServers = {...document.mcpServers};
	delete mcpServers[serverId];
	return {...document, mcpServers};
}

/** 将 CCQ 共享定义同步到 pi-mcp-adapter 实际读取的标准全局配置。 */
export function syncPiMcpConfig(projections: readonly PiMcpServerProjection[]): PiMcpConfigSyncResult {
	const currentOverride = readPiMcpAdapterOverride();
	if (!currentOverride.ok) return {Success: false, Status: `Unsupported: ${currentOverride.detail}`};

	const currentNative = readPiMcpConfig();
	if (!currentNative.ok) return {Success: false, Status: `Unsupported: ${currentNative.detail}`};

	const projectedIds = new Set(projections.map(projection => projection.serverId));
	const managed = new Set((currentOverride.document.managedServers ?? []).filter(item => typeof item === 'string'));
	const mcpServers = {...currentNative.document.mcpServers};

	for (const projection of projections) {
		managed.add(projection.serverId);
		mcpServers[projection.serverId] = mergePiMcpServerEntry(mcpServers[projection.serverId], projection);
	}

	for (const serverId of [...managed]) {
		if (projectedIds.has(serverId)) continue;
		delete mcpServers[serverId];
		managed.delete(serverId);
	}

	const nextNative: PiMcpConfigDocument = {...currentNative.document, mcpServers};
	const nextOverride = {...currentOverride.document};
	if (managed.size > 0) nextOverride.managedServers = [...managed];
	else delete nextOverride.managedServers;

	return writePiMcpDocuments(
		existsSync(piMcpConfigPath()),
		currentNative.document,
		existsSync(piMcpAdapterOverridesPath()),
		currentOverride.document,
		nextNative,
		nextOverride
	);
}

export type PiMcpMutationResult =
	| {readonly Success: true; readonly ServerId: string; readonly Status: 'Active' | 'Disabled'}
	| {readonly Success: false; readonly ServerId: string; readonly Status: string};

export function writePiMcpOverride(
	serverId: string,
	enabled: boolean,
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null,
	credentials: Readonly<Record<string, string>> = {}
): PiMcpMutationResult {
	const fact = currentPiMcpAdapterFact();
	const reason = piMcpUnsupportedReason(fact, definition, config);
	if (reason) {
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${unsupportedDetail(reason)}`};
	}

	const current = readPiMcpAdapterOverride();
	if (!current.ok) return {Success: false, ServerId: serverId, Status: `Unsupported: ${current.detail}`};
	const native = readPiMcpConfig();
	if (!native.ok) return {Success: false, ServerId: serverId, Status: `Unsupported: ${native.detail}`};

	const servers = {...current.document.servers};
	servers[serverId] = {...(servers[serverId] ?? {}), enabled};
	const nextOverride = withManagedServer({...current.document, servers}, serverId);
	const nextNative = nativeDocumentWithServer(native.document, serverId, {
		serverId,
		definition,
		config: config ?? {},
		credentials,
		enabled
	});
	const result = writePiMcpDocuments(
		existsSync(piMcpConfigPath()),
		native.document,
		existsSync(piMcpAdapterOverridesPath()),
		current.document,
		nextNative,
		nextOverride
	);
	return result.Success
		? {Success: true, ServerId: serverId, Status: enabled ? 'Active' : 'Disabled'}
		: {Success: false, ServerId: serverId, Status: result.Status};
}

export function removePiMcpOverride(
	serverId: string,
	definition: McpServerDefinition | null,
	config: Record<string, unknown> | null,
	credentials: Readonly<Record<string, string>> = {}
): PiMcpMutationResult {
	const fact = currentPiMcpAdapterFact();
	if (!fact.piInstalled) return {Success: false, ServerId: serverId, Status: `Unsupported: ${unsupportedDetail('pi-not-installed')}`};
	if (!fact.adapterInstalled)
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${unsupportedDetail('adapter-not-installed')}`};
	if (!fact.overrideReadable)
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${unsupportedDetail('override-read-failed')}`};
	if (!fact.configReadable)
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${unsupportedDetail('config-read-failed')}`};
	if (!isPiMcpDefinitionExpressible(definition, config) && piMcpOverrideEnabled(serverId) === undefined) {
		return {Success: false, ServerId: serverId, Status: `Unsupported: ${unsupportedDetail('definition-not-expressible')}`};
	}

	const current = readPiMcpAdapterOverride();
	if (!current.ok) return {Success: false, ServerId: serverId, Status: `Unsupported: ${current.detail}`};
	const native = readPiMcpConfig();
	if (!native.ok) return {Success: false, ServerId: serverId, Status: `Unsupported: ${native.detail}`};

	const servers = {...current.document.servers};
	servers[serverId] = {...(servers[serverId] ?? {}), enabled: false, removed: true};
	const nextOverride = withManagedServer({...current.document, servers}, serverId);
	const nextNative = nativeDocumentWithServer(native.document, serverId, {
		serverId,
		definition,
		config: config ?? {},
		credentials,
		enabled: false
	});
	const result = writePiMcpDocuments(
		existsSync(piMcpConfigPath()),
		native.document,
		existsSync(piMcpAdapterOverridesPath()),
		current.document,
		nextNative,
		nextOverride
	);
	return result.Success
		? {Success: true, ServerId: serverId, Status: 'Disabled'}
		: {Success: false, ServerId: serverId, Status: result.Status};
}

export function piMcpOverrideEnabled(serverId: string): boolean | undefined {
	const result = readPiMcpAdapterOverride();
	return result.ok ? result.document.servers[serverId]?.enabled : undefined;
}
