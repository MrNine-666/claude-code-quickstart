import {existsSync, readFileSync} from 'node:fs';
import type {AgentContext} from '../state/manage-state.js';
import {readJsonFile, writeJsonAtomic} from './fs-utils.js';
import {claudeJsonPath, codexConfigPath, settingsPath} from './paths.js';
import {atomicWrite as writeTomlAtomic, deletePath, getPath, parse as parseToml, setPath, type TomlDocument} from './toml-edit.js';
import {loadMcpContract, type McpServerDefinition} from './mcp-contract.js';
import {toCodexMcpConfig} from './mcp-codex-schema.js';
import {
	definitionHash,
	loadVault,
	saveVault,
	withVaultLock,
	type McpVault,
	type McpVaultServerEntry
} from './mcp-vault.js';

export type McpServerStatus = 'Custom' | 'Active' | 'Disabled' | 'Missing' | 'Unknown';

export type McpStatusRow = {
	readonly Id: string;
	readonly Name: string;
	readonly Status: McpServerStatus;
	readonly McpType: string;
	readonly Category: string;
	readonly HasCredentials: boolean;
};

export type McpActionResult = {Success: boolean; ServerId: string; Status: string};

const STATUS_PRIORITY: Record<McpServerStatus, number> = {
	Custom: 0,
	Active: 1,
	Disabled: 2,
	Missing: 3,
	Unknown: 4
};

export type ClaudeJson = {
	mcpServers?: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
};

function readClaudeJson(): ClaudeJson {
	return readJsonFile<ClaudeJson>(claudeJsonPath(), {});
}

function readSettings(): Record<string, unknown> {
	return readJsonFile<Record<string, unknown>>(settingsPath(), {});
}

function readCodexConfigToml(): TomlDocument {
	const path = codexConfigPath();
	if (!existsSync(path)) {
		return {};
	}

	return parseToml(readFileSync(path, 'utf8'));
}

function readCodexMcpServers(): Record<string, Record<string, unknown>> {
	const servers = getPath(readCodexConfigToml(), ['mcp_servers']);
	return servers && typeof servers === 'object' && !Array.isArray(servers)
		? (servers as Record<string, Record<string, unknown>>)
		: {};
}

function writeCodexMcpServer(serverId: string, config: Record<string, unknown>): void {
	// Codex 只识别其 schema 支持的字段（去 type、剔除 Claude 专有字段）；HTTP 靠 url 判定，stdio 靠 command。
	writeTomlAtomic(codexConfigPath(), setPath(readCodexConfigToml(), ['mcp_servers', serverId], toCodexMcpConfig(config)));
}

function deleteCodexMcpServer(serverId: string): void {
	writeTomlAtomic(codexConfigPath(), deletePath(readCodexConfigToml(), ['mcp_servers', serverId]));
}

function isCodexServerDisabled(config: Record<string, unknown> | undefined): boolean {
	return config?.enabled === false;
}

function credentialsFromConfig(config: Record<string, unknown>): Record<string, string> {
	const env = config.env;
	return env && typeof env === 'object' && !Array.isArray(env) ? {...(env as Record<string, string>)} : {};
}

function definitionHashFor(serverId: string, contractServers: Record<string, McpServerDefinition>): string {
	const definition = contractServers[serverId];
	return definition ? definitionHash(definition) : '';
}

function backupRuntimeMcpToVault(
	meta: McpVault,
	serverId: string,
	config: Record<string, unknown>,
	contractServers: Record<string, McpServerDefinition>,
	permissions: string[] = []
): void {
	backupMcpToVault(meta, serverId, config, credentialsFromConfig(config), permissions, definitionHashFor(serverId, contractServers));
}

function syncRuntimeMcpToVault(agentContext: AgentContext): void {
	withVaultLock(() => {
		const runtimeServers = agentContext === 'cx' ? readCodexMcpServers() : (readClaudeJson().mcpServers ?? {});
		const contractServers = loadMcpContract().servers;
		const meta = loadVault();
		let vaultChanged = false;

		for (const [serverId, config] of Object.entries(runtimeServers)) {
			if (!config || typeof config !== 'object' || Array.isArray(config)) {
				continue;
			}

			backupRuntimeMcpToVault(meta, serverId, config, contractServers);
			vaultChanged = true;
		}

		if (agentContext === 'cx') {
			for (const [serverId, entry] of Object.entries(meta.servers ?? {})) {
				if (Object.prototype.hasOwnProperty.call(runtimeServers, serverId) || !entry?.config) {
					continue;
				}

				writeCodexMcpServer(serverId, {...entry.config, enabled: false});
			}
		}

		if (vaultChanged) {
			saveVault(meta);
		}
	});
}

function normalizeCredentials(entry: McpVaultServerEntry | undefined): Record<string, string> {
	if (!entry?.credentials) {
		return {};
	}

	// vault 中两种存法：{values:{...}}（新）或直接 {...}（旧 / syncCredentials 场景）
	const values = (entry.credentials as {values?: Record<string, string>}).values;
	if (values) {
		return {...values};
	}

	if (typeof entry.credentials === 'object') {
		return {...(entry.credentials as Record<string, string>)};
	}

	return {};
}

/** 计算所有 MCP Server 状态（Custom/Active/Disabled/Missing/Unknown，按优先级排序）。 */
export function computeStatus(agentContext: AgentContext = 'cc'): McpStatusRow[] {
	syncRuntimeMcpToVault(agentContext);
	const runtimeServers = agentContext === 'cx' ? readCodexMcpServers() : (readClaudeJson().mcpServers ?? {});
	const vault = loadVault();
	const metaServers = vault.servers ?? {};
	const contract = loadMcpContract();
	const contractServers = contract.servers;

	const allIds = new Set<string>([
		...Object.keys(runtimeServers),
		...Object.keys(metaServers)
	]);

	const results: McpStatusRow[] = [];
	for (const id of allIds) {
		const runtimeConfig = runtimeServers[id];
		const inRuntimeConfig = Object.prototype.hasOwnProperty.call(runtimeServers, id);
		const metaEntry = metaServers[id];
		const isDisabled = agentContext === 'cx' && isCodexServerDisabled(runtimeConfig);

		let status: McpServerStatus;
		if (isDisabled) {
			status = 'Disabled';
		} else if (inRuntimeConfig) {
			status = 'Active';
		} else if (agentContext === 'cc' && metaEntry?.config) {
			status = 'Disabled';
		} else {
			status = 'Unknown';
		}

		let name = id;
		let mcpType = '';
		let category = '';
		let hasCredentials = false;

		const def = contractServers[id];
		if (def) {
			name = def.Name || id;
			mcpType = def.McpType || '';
			category = def.Category || '';
			hasCredentials = Boolean(def.CredentialType && def.CredentialType !== 'none');
		} else if (metaEntry) {
			hasCredentials = Boolean(metaEntry.credentials);
		}

		results.push({Id: id, Name: name, Status: status, McpType: mcpType, Category: category, HasCredentials: hasCredentials});
	}

	results.sort((a, b) => {
		const aPriority = STATUS_PRIORITY[a.Status] ?? 99;
		const bPriority = STATUS_PRIORITY[b.Status] ?? 99;
		if (aPriority !== bPriority) {
			return aPriority - bPriority;
		}

		return a.Name.localeCompare(b.Name);
	});

	return results;
}

// ── 详情 ─────────────────────────────────────────────────────────────────

export type McpServerDetail = {
	readonly id: string;
	readonly status: McpServerStatus;
	readonly definition: McpServerDefinition | null;
	readonly config: Record<string, unknown> | null;
	readonly vaultEntry: McpVaultServerEntry | null;
	readonly permissions: readonly string[];
	readonly isEnvFile: boolean;
};

/** 收集单个 MCP Server 的详情（契约定义 + 当前 config + vault + permission）。 */
export function getServerDetail(serverId: string, agentContext: AgentContext = 'cc'): McpServerDetail {
	const contract = loadMcpContract();
	const definition = contract.servers[serverId] ?? null;
	const runtimeServers = agentContext === 'cx' ? readCodexMcpServers() : (readClaudeJson().mcpServers ?? {});
	const vault = loadVault();
	const vaultEntry = vault.servers?.[serverId] ?? null;
	// config 优先取当前 Agent 运行时配置；若已禁用/删除且 vault 有备份，则用于编辑回显。
	const config = runtimeServers[serverId] ?? vaultEntry?.config ?? null;

	const settings = readSettings();
	const allow = agentContext === 'cc' ? ((settings.permissions as {allow?: string[]} | undefined)?.allow ?? []) : [];
	const mcpPerm = `mcp__${serverId}`;
	const permissions = allow.filter(p => p === mcpPerm);

	const statusRow = computeStatus(agentContext).find(row => row.Id === serverId);

	return {
		id: serverId,
		status: statusRow?.Status ?? 'Unknown',
		definition,
		config,
		vaultEntry,
		permissions,
		isEnvFile: definition?.CredentialType === 'env-file'
	};
}

// ── 凭据同步 ─────────────────────────────────────────────────────────────

export type SyncCredentialsResult = {Success: boolean; SyncedCount: number; Details: string[]};

/** 凭据同步：.claude.json ↔ vault 双向补缺（内置 MCP 才回填 .claude.json）。 */
export function syncCredentials(): SyncCredentialsResult {
	const result: SyncCredentialsResult = {Success: true, SyncedCount: 0, Details: []};

	try {
		if (!existsSync(claudeJsonPath())) {
			return result;
		}

		const cj = readClaudeJson();
		if (!cj.mcpServers) {
			return result;
		}

		const contract = loadMcpContract();
		const contractServers = contract.servers;

		withVaultLock(() => {
			const meta = loadVault();
			let vaultChanged = false;
			let cjChanged = false;

			for (const id of Object.keys(cj.mcpServers!)) {
				const config = cj.mcpServers![id];
				if (!config || typeof config !== 'object') {
					continue;
				}

				const env = config.env as Record<string, string> | undefined;
				const cjHasEnv = Boolean(env && Object.keys(env).length > 0);
				const vaultEntry = meta.servers[id];
				const vaultValues = (vaultEntry?.credentials as {values?: Record<string, string>} | undefined)?.values;
				const vaultHasValues = Boolean(vaultValues && Object.keys(vaultValues).length > 0);

				// 场景 A: .claude.json 有 env, vault 无 → 备份到 vault
				if (cjHasEnv && !vaultHasValues) {
					if (!meta.servers[id]) {
						meta.servers[id] = {};
					}

					meta.servers[id]!.credentials = {values: env};
					meta.servers[id]!.updatedAt = new Date().toISOString();
					vaultChanged = true;
					result.SyncedCount++;
					result.Details.push(`vault-backup::${id}`);
				}

				// 场景 B: vault 有 credentials, .claude.json env 缺失 → 恢复（仅限内置 MCP）
				if (!cjHasEnv && vaultHasValues && Object.prototype.hasOwnProperty.call(contractServers, id)) {
					config.env = vaultValues;
					cjChanged = true;
					result.SyncedCount++;
					result.Details.push(`claude-restore::${id}`);
				}
			}

			if (vaultChanged) {
				saveVault(meta);
			}

			if (cjChanged) {
				writeJsonAtomic(claudeJsonPath(), cj);
			}
		});
	} catch {
		result.Success = false;
	}

	return result;
}

// ── 变更层（disable / enable / remove） ─────────────────────────────────────

function backupMcpToVault(meta: McpVault, serverId: string, config: Record<string, unknown>, credentials: Record<string, string>, permissions: string[], definitionHashValue: string): void {
	meta.servers[serverId] = {
		credentials: Object.keys(credentials).length > 0 ? {values: credentials} : undefined,
		config,
		permissions,
		definitionHash: definitionHashValue,
		updatedAt: new Date().toISOString()
	};
}

function readSettingsForWrite(): {settings: Record<string, unknown>; allow: string[]} {
	const settings = readSettings();
	if (!settings.permissions) {
		settings.permissions = {};
	}

	const perms = settings.permissions as {allow?: string[]};
	if (!perms.allow) {
		perms.allow = [];
	}

	return {settings, allow: perms.allow};
}

/** 禁用 MCP Server（Claude：备份到 vault → 移除 .claude.json + permission；Codex：写 enabled=false）。 */
export function disableServer(serverId: string, agentContext: AgentContext = 'cc'): McpActionResult {
	syncRuntimeMcpToVault(agentContext);
	return agentContext === 'cx' ? disableCodexServer(serverId) : disableClaudeServer(serverId);
}

function disableCodexServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const servers = readCodexMcpServers();
		const existingConfig = servers[serverId];
		if (!existingConfig) {
			return {Success: false, ServerId: serverId, Status: 'NotFound'};
		}

		const disabledConfig = {...existingConfig, enabled: false};
		const meta = loadVault();
		backupRuntimeMcpToVault(meta, serverId, disabledConfig, loadMcpContract().servers);
		saveVault(meta);

		writeCodexMcpServer(serverId, disabledConfig);
		return {Success: true, ServerId: serverId, Status: 'Disabled'};
	});
}

function disableClaudeServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const claudeJson = readClaudeJson();
		if (!claudeJson.mcpServers) {
			claudeJson.mcpServers = {};
		}

		if (!claudeJson.mcpServers[serverId]) {
			return {Success: false, ServerId: serverId, Status: 'NotFound'};
		}

		const existingConfig = claudeJson.mcpServers[serverId]!;
		const meta = loadVault();
		const credentials = (existingConfig.env as Record<string, string>) ?? {};

		const contract = loadMcpContract();
		const defHash = contract.servers[serverId] ? definitionHash(contract.servers[serverId]!) : '';

		// 从 settings.json permissions 移除匹配项
		const settings = readSettings();
		const removedPermissions: string[] = [];
		const perms = settings.permissions as {allow?: string[]} | undefined;
		if (perms?.allow) {
			const mcpPerm = `mcp__${serverId}`;
			if (perms.allow.includes(mcpPerm)) {
				removedPermissions.push(mcpPerm);
			}

			perms.allow = perms.allow.filter(p => p !== mcpPerm);
			writeJsonAtomic(settingsPath(), settings);
		}

		// 先写 vault 再删 .claude.json，确保数据不丢失。vault 只作备份，不记录 active/disabled 状态。
		backupMcpToVault(meta, serverId, existingConfig, credentials, removedPermissions, defHash);
		saveVault(meta);

		delete claudeJson.mcpServers[serverId];
		writeJsonAtomic(claudeJsonPath(), claudeJson);

		return {Success: true, ServerId: serverId, Status: 'Disabled'};
	});
}

/** 启用 MCP Server（Claude：从 vault 恢复 config + permission；Codex：写/恢复 [mcp_servers.<id>]）。 */
export function enableServer(serverId: string, agentContext: AgentContext = 'cc'): McpActionResult {
	syncRuntimeMcpToVault(agentContext);
	return agentContext === 'cx' ? enableCodexServer(serverId) : enableClaudeServer(serverId);
}

function enableCodexServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const existingConfig = readCodexMcpServers()[serverId];
		const meta = loadVault();
		const contractServers = loadMcpContract().servers;
		if (existingConfig) {
			const {enabled: _enabled, ...nextConfig} = existingConfig;
			void _enabled;
			backupRuntimeMcpToVault(meta, serverId, nextConfig, contractServers);
			saveVault(meta);
			writeCodexMcpServer(serverId, nextConfig);
			return {Success: true, ServerId: serverId, Status: 'Active'};
		}

		const vaultEntry = meta.servers[serverId];
		const serverConfig = vaultEntry?.config ?? null;
		if (!serverConfig) {
			return {Success: false, ServerId: serverId, Status: 'Error'};
		}

		const {enabled: _enabled, ...nextConfig} = serverConfig;
		void _enabled;
		backupRuntimeMcpToVault(meta, serverId, nextConfig, contractServers);
		saveVault(meta);
		writeCodexMcpServer(serverId, nextConfig);
		return {Success: true, ServerId: serverId, Status: 'Active'};
	});
}

function enableClaudeServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const meta = loadVault();
		const vaultEntry = meta.servers[serverId];
		if (readClaudeJson().mcpServers?.[serverId]) {
			return {Success: true, ServerId: serverId, Status: 'Active'};
		}

		if (!vaultEntry?.config) {
			return {Success: false, ServerId: serverId, Status: 'Error'};
		}

		const credentials = normalizeCredentials(vaultEntry);
		let serverConfig = vaultEntry.config ?? null;
		if (serverConfig && Object.keys(credentials).length > 0) {
			if (!serverConfig.env) {
				serverConfig.env = {};
			}

			Object.assign(serverConfig.env as Record<string, string>, credentials);
		}

		if (!serverConfig) {
			return {Success: false, ServerId: serverId, Status: 'Error'};
		}

		const claudeJson = readClaudeJson();
		if (!claudeJson.mcpServers) {
			claudeJson.mcpServers = {};
		}

		claudeJson.mcpServers[serverId] = serverConfig;
		writeJsonAtomic(claudeJsonPath(), claudeJson);

		// 恢复 permissions
		const {settings, allow} = readSettingsForWrite();
		const vaultPerms = vaultEntry.permissions ?? [];
		let permChanged = false;
		if (vaultPerms.length > 0) {
			for (const perm of vaultPerms) {
				if (!allow.includes(perm)) {
					allow.push(perm);
					permChanged = true;
				}
			}
		} else {
			const mcpPerm = `mcp__${serverId}`;
			if (!allow.includes(mcpPerm)) {
				allow.push(mcpPerm);
				permChanged = true;
			}
		}

		if (permChanged) {
			writeJsonAtomic(settingsPath(), settings);
		}

		// 更新 vault 备份元数据；清理历史 disabled 字段，vault 不再作为状态源。
		delete meta.servers[serverId]!.disabled;
		const contract = loadMcpContract();
		if (contract.servers[serverId]) {
			meta.servers[serverId]!.definitionHash = definitionHash(contract.servers[serverId]!);
		}

		meta.servers[serverId]!.updatedAt = new Date().toISOString();
		saveVault(meta);

		return {Success: true, ServerId: serverId, Status: 'Active'};
	});
}

/** 删除 MCP Server（confirmed=false 返回 NeedConfirmation，由调用方确认）。 */
export function removeServer(serverId: string, confirmed = false, agentContext: AgentContext = 'cc'): McpActionResult {
	if (!confirmed) {
		return {Success: false, ServerId: serverId, Status: 'NeedConfirmation'};
	}

	syncRuntimeMcpToVault(agentContext);
	return agentContext === 'cx' ? removeCodexServer(serverId) : removeClaudeServer(serverId);
}

function removeCodexServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		deleteCodexMcpServer(serverId);

		const meta = loadVault();
		if (meta.servers[serverId]) {
			delete meta.servers[serverId];
		}

		saveVault(meta);
		return {Success: true, ServerId: serverId, Status: 'Removed'};
	});
}

function removeClaudeServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const claudeJson = readClaudeJson();
		if (claudeJson.mcpServers?.[serverId]) {
			delete claudeJson.mcpServers[serverId];
		}

		const settings = readSettings();
		const perms = settings.permissions as {allow?: string[]} | undefined;
		if (perms?.allow) {
			const mcpPerm = `mcp__${serverId}`;
			perms.allow = perms.allow.filter(p => p !== mcpPerm);
			writeJsonAtomic(settingsPath(), settings);
		}

		writeJsonAtomic(claudeJsonPath(), claudeJson);

		const meta = loadVault();
		if (meta.servers[serverId]) {
			delete meta.servers[serverId];
		}

		saveVault(meta);

		return {Success: true, ServerId: serverId, Status: 'Removed'};
	});
}

// ── 落盘层（新增 / 编辑保存） ───────────────────────────────────────────────

/**
 * 持久化一个 MCP Server 的最终配置（对齐 Windows Install-McpServer 的 5b–5d 写入）：
 * 1. Claude Code 写 `.claude.json.mcpServers[serverId]`，Codex 写 `config.toml` `[mcp_servers.<id>]`；
 * 2. Claude Code 补 `settings.json.permissions.allow` 的 `mcp__<id>`，Codex 不写 Claude permissions；
 * 3. vault 只备份 credentials/config/definitionHash，不记录 active/disabled 状态。
 * 锁内串行执行，确保 vault 与运行时配置一致。
 */
export function persistMcpServer(
	serverId: string,
	config: Record<string, unknown>,
	credentials: Record<string, string>,
	definitionHashValue: string,
	agentContext: AgentContext = 'cc'
): McpActionResult {
	return agentContext === 'cx'
		? persistCodexMcpServer(serverId, config, credentials, definitionHashValue)
		: persistClaudeMcpServer(serverId, config, credentials, definitionHashValue);
}

function persistCodexMcpServer(
	serverId: string,
	config: Record<string, unknown>,
	credentials: Record<string, string>,
	definitionHashValue: string
): McpActionResult {
	return withVaultLock(() => {
		const {enabled: _enabled, ...nextConfig} = config;
		void _enabled;
		writeCodexMcpServer(serverId, nextConfig);

		const meta = loadVault();
		backupMcpToVault(meta, serverId, nextConfig, credentials, [], definitionHashValue);
		saveVault(meta);

		return {Success: true, ServerId: serverId, Status: 'Active'};
	});
}

function persistClaudeMcpServer(
	serverId: string,
	config: Record<string, unknown>,
	credentials: Record<string, string>,
	definitionHashValue: string
): McpActionResult {
	return withVaultLock(() => {
		const claudeJson = readClaudeJson();
		if (!claudeJson.mcpServers) {
			claudeJson.mcpServers = {};
		}

		claudeJson.mcpServers[serverId] = config;
		writeJsonAtomic(claudeJsonPath(), claudeJson);

		const {settings, allow} = readSettingsForWrite();
		const mcpPerm = `mcp__${serverId}`;
		if (!allow.includes(mcpPerm)) {
			allow.push(mcpPerm);
			writeJsonAtomic(settingsPath(), settings);
		}

		const meta = loadVault();
		backupMcpToVault(meta, serverId, config, credentials, [], definitionHashValue);
		saveVault(meta);

		return {Success: true, ServerId: serverId, Status: 'Active'};
	});
}

