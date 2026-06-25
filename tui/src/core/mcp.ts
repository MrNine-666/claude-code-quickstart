import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {readJsonFile, writeJsonAtomic} from './fs-utils.js';
import {claudeJsonPath, settingsPath, rulesDir} from './paths.js';
import {loadMcpContract, type McpContract, type McpServerDefinition} from './mcp-contract.js';
import {
	definitionHash,
	loadVault,
	newEmptyVault,
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
export function computeStatus(): McpStatusRow[] {
	const claudeJson = readClaudeJson();
	const claudeServers = claudeJson.mcpServers ?? {};
	const vault = loadVault();
	const metaServers = vault.servers ?? {};
	const contract = loadMcpContract();
	const contractServers = contract.servers;

	const allIds = new Set<string>([
		...Object.keys(claudeServers),
		...Object.keys(contractServers),
		...Object.keys(metaServers)
	]);

	const results: McpStatusRow[] = [];
	for (const id of allIds) {
		const inClaudeJson = Object.prototype.hasOwnProperty.call(claudeServers, id);
		const inContract = Object.prototype.hasOwnProperty.call(contractServers, id);
		const metaEntry = metaServers[id];
		const isDisabled = metaEntry?.disabled === true;

		let status: McpServerStatus;
		if (inClaudeJson && !inContract) {
			status = 'Custom';
		} else if (isDisabled) {
			status = 'Disabled';
		} else if (inClaudeJson && inContract) {
			status = 'Active';
		} else if (inContract && !inClaudeJson && !isDisabled) {
			status = 'Missing';
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
export function getServerDetail(serverId: string): McpServerDetail {
	const contract = loadMcpContract();
	const definition = contract.servers[serverId] ?? null;
	const claudeJson = readClaudeJson();
	const config = claudeJson.mcpServers?.[serverId] ?? null;
	const vault = loadVault();
	const vaultEntry = vault.servers?.[serverId] ?? null;

	const settings = readSettings();
	const allow = (settings.permissions as {allow?: string[]} | undefined)?.allow ?? [];
	const mcpPerm = `mcp__${serverId}`;
	const permissions = allow.filter(p => p === mcpPerm);

	const statusRow = computeStatus().find(row => row.Id === serverId);

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

/** 禁用 MCP Server（备份到 vault → 移除 .claude.json + permission）。 */
export function disableServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const claudeJson = readClaudeJson();
		if (!claudeJson.mcpServers) {
			claudeJson.mcpServers = {};
		}

		if (!claudeJson.mcpServers[serverId]) {
			const meta = loadVault();
			if (meta.servers[serverId]?.disabled) {
				return {Success: true, ServerId: serverId, Status: 'Disabled'};
			}

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

		// 先写 vault 再删 .claude.json，确保数据不丢失
		meta.servers[serverId] = {
			disabled: true,
			credentials: {values: credentials},
			config: existingConfig,
			permissions: removedPermissions,
			definitionHash: defHash,
			updatedAt: new Date().toISOString()
		};
		saveVault(meta);

		delete claudeJson.mcpServers[serverId];
		writeJsonAtomic(claudeJsonPath(), claudeJson);

		return {Success: true, ServerId: serverId, Status: 'Disabled'};
	});
}

/** 启用 MCP Server（从 vault 恢复 config + permission）。 */
export function enableServer(serverId: string): McpActionResult {
	return withVaultLock(() => {
		const meta = loadVault();
		const vaultEntry = meta.servers[serverId];
		if (!vaultEntry?.disabled) {
			return {Success: true, ServerId: serverId, Status: 'Active'};
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

		// 更新 vault
		meta.servers[serverId]!.disabled = false;
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
export function removeServer(serverId: string, confirmed = false): McpActionResult {
	if (!confirmed) {
		return {Success: false, ServerId: serverId, Status: 'NeedConfirmation'};
	}

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
 * 1. `.claude.json.mcpServers[serverId]` 合并写入；
 * 2. `settings.json.permissions.allow` 补 `mcp__<id>`（已存在则不重复写）；
 * 3. vault 记录 disabled:false + credentials.values + definitionHash + updatedAt。
 * 锁内串行执行，确保 vault 与 .claude.json / settings.json 一致。
 */
export function persistMcpServer(
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
		const entry: McpVaultServerEntry = {
			disabled: false,
			definitionHash: definitionHashValue,
			updatedAt: new Date().toISOString()
		};
		if (Object.keys(credentials).length > 0) {
			entry.credentials = {values: credentials};
		}

		meta.servers[serverId] = entry;
		saveVault(meta);

		return {Success: true, ServerId: serverId, Status: 'Active'};
	});
}

