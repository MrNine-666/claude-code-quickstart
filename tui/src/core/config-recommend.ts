import {existsSync, readFileSync} from 'node:fs';
import {resolveContractsDir} from './contracts.js';
import {join} from 'node:path';
import {atomicWrite} from './fs-utils.js';
import {settingsPath} from './paths.js';

// 配置文件菜单 core：推荐 settings.json 配置加载（含 description 介绍）+ fill-missing 导入。
// fill-missing 语义与 contracts/scripts/claude-config-drift.js 的 applySettings(install) 对齐：
//   - env / 顶层默认值仅补缺失（不覆盖已有值），permissions.allow 去重追加
//   - DoNotManageTopLevelKeys / DoNotManageEnvKeys 全程跳过（保护供应商/模型/用户配置）
// 安全策略对齐 installer Install-ClaudeConfig：现有 settings.json 解析失败时拒绝写入，避免覆盖用户配置。
// Update 检测已收缩（HC-FU-08 不再检测 ClaudeConfig），导入不写指纹种子。

type JsonObject = Record<string, unknown>;

type ConfigContract = {
	readonly Ownership?: {
		readonly DoNotManageTopLevelKeys?: readonly string[];
		readonly DoNotManageEnvKeys?: readonly string[];
	};
	readonly TopLevelDefaults?: Record<string, unknown>;
	readonly ClaudeConfigEnvDefaults?: Record<string, string>;
	readonly ClaudeConfigBasePermissions?: readonly string[];
	readonly Descriptions?: {
		readonly TopLevelDefaults?: Record<string, string>;
		readonly ClaudeConfigEnvDefaults?: Record<string, string>;
		readonly ClaudeConfigBasePermissions?: string;
	};
};

export type ConfigEntry = {readonly key: string; readonly value: string; readonly description: string};

export type ConfigRecommendation = {
	readonly available: boolean;
	readonly topLevel: readonly ConfigEntry[];
	readonly env: readonly ConfigEntry[];
	readonly permissions: {readonly items: readonly string[]; readonly description: string};
};

export type ImportResult =
	| {readonly ok: true; readonly updatedItems: readonly string[]; readonly changed: number}
	| {readonly ok: false; readonly error: string};

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 推荐配置展示值统一转字符串（对象转紧凑 JSON，布尔/数字转字面量）。 */
function displayValue(value: unknown): string {
	if (typeof value === 'string') {
		return value;
	}

	if (isObject(value) || Array.isArray(value)) {
		return JSON.stringify(value);
	}

	return String(value);
}

/** 读取 claude-config.json 契约；不可用时返回 null（视图据此提示契约缺失）。 */
export function loadConfigContract(): ConfigContract | null {
	const path = join(resolveContractsDir(), 'claude-config.json');
	if (!existsSync(path)) {
		return null;
	}

	try {
		return JSON.parse(readFileSync(path, 'utf8')) as ConfigContract;
	} catch {
		return null;
	}
}

/** 加载推荐配置（供视图预览：顶层 / env / permissions 三组，附 description 介绍）。 */
export function loadRecommendation(): ConfigRecommendation {
	const contract = loadConfigContract();
	if (!contract) {
		return {available: false, topLevel: [], env: [], permissions: {items: [], description: ''}};
	}

	const descriptions = contract.Descriptions ?? {};
	const topLevelDesc = descriptions.TopLevelDefaults ?? {};
	const envDesc = descriptions.ClaudeConfigEnvDefaults ?? {};

	const topLevel: ConfigEntry[] = Object.entries(contract.TopLevelDefaults ?? {}).map(([key, value]) => ({
		key,
		value: displayValue(value),
		description: topLevelDesc[key] ?? ''
	}));

	const env: ConfigEntry[] = Object.entries(contract.ClaudeConfigEnvDefaults ?? {}).map(([key, value]) => ({
		key,
		value: displayValue(value),
		description: envDesc[key] ?? ''
	}));

	return {
		available: true,
		topLevel,
		env,
		permissions: {
			items: [...(contract.ClaudeConfigBasePermissions ?? [])],
			description: descriptions.ClaudeConfigBasePermissions ?? ''
		}
	};
}

/** 当前用户级 settings.json 路径（~/.claude/settings.json）。 */
export function settingsFilePath(): string {
	return settingsPath();
}

/** 读取当前 settings.json（不存在或读取失败返回 null）。 */
export function readInstalledSettings(): JsonObject | null {
	const path = settingsFilePath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** 组装推荐配置 JSON 文本（供复制到剪贴板，仅含 ClaudeConfig 管辖字段）。 */
export function assembleRecommendationJson(): string | null {
	const contract = loadConfigContract();
	if (!contract) {
		return null;
	}

	const recommended: JsonObject = {...(contract.TopLevelDefaults ?? {})};
	recommended['env'] = {...(contract.ClaudeConfigEnvDefaults ?? {})};
	recommended['permissions'] = {allow: [...(contract.ClaudeConfigBasePermissions ?? [])]};
	return JSON.stringify(recommended, null, 2);
}

/**
 * 按 fill-missing 语义将推荐配置合并进 settings（对齐 drift.js install 模式）。
 * 纯函数：接收 settings 副本，返回新对象与变更项，便于幂等/保护测试断言。
 */
export function applyFillMissing(contract: ConfigContract, source: JsonObject): {settings: JsonObject; updatedItems: string[]} {
	const settings: JsonObject = {...source};
	const updatedItems: string[] = [];
	const doNotManageEnv = new Set(contract.Ownership?.DoNotManageEnvKeys ?? []);
	const doNotManageTopLevel = new Set(contract.Ownership?.DoNotManageTopLevelKeys ?? []);

	// 1. env 节：仅补缺失（缺失 / null / 空白），跳过禁区键
	const env: JsonObject = isObject(settings['env']) ? {...(settings['env'] as JsonObject)} : {};
	if (!isObject(settings['env'])) {
		updatedItems.push('config::env::section-added');
	}

	for (const [key, value] of Object.entries(contract.ClaudeConfigEnvDefaults ?? {})) {
		if (doNotManageEnv.has(key)) {
			continue;
		}

		const current = env[key];
		if (current === undefined || current === null || String(current).trim() === '') {
			env[key] = String(value);
			updatedItems.push(`config::env.${key}::added`);
		}
	}

	settings['env'] = env;

	// 2. 顶层默认值：仅补缺失，跳过禁区键；attribution 仅当非对象时填充
	for (const [key, value] of Object.entries(contract.TopLevelDefaults ?? {})) {
		if (doNotManageTopLevel.has(key)) {
			continue;
		}

		if (key === 'attribution') {
			if (!isObject(settings['attribution'])) {
				settings['attribution'] = value;
				updatedItems.push('config::attribution::added');
			}

			continue;
		}

		const current = settings[key];
		const missing = current === undefined || current === null || (typeof current === 'string' && current.trim() === '');
		if (missing) {
			settings[key] = value;
			updatedItems.push(`config::${key}::added`);
		}
	}

	// 3. permissions.allow：去重保留用户已有项，追加缺失的基础权限
	const permissions: JsonObject = isObject(settings['permissions']) ? {...(settings['permissions'] as JsonObject)} : {};
	if (!isObject(settings['permissions'])) {
		updatedItems.push('config::permissions::section-added');
	}

	const allow: string[] = [];
	const existingAllow = Array.isArray(permissions['allow']) ? (permissions['allow'] as unknown[]) : [];
	for (const perm of existingAllow) {
		if (typeof perm === 'string' && perm.trim() !== '' && !allow.includes(perm)) {
			allow.push(perm);
		}
	}

	for (const perm of contract.ClaudeConfigBasePermissions ?? []) {
		if (!allow.includes(perm)) {
			allow.push(perm);
			updatedItems.push(`config::permissions.allow.${perm}::added`);
		}
	}

	permissions['allow'] = allow;
	if (!Array.isArray(permissions['deny'])) {
		permissions['deny'] = [];
	}

	settings['permissions'] = permissions;

	return {settings, updatedItems};
}

/**
 * fill-missing 导入推荐配置到 settings.json（原子写入）。
 * 现有 settings.json 解析失败时拒绝写入（避免覆盖用户配置，对齐 Install-ClaudeConfig）。
 * 不写指纹种子（HC-FU-08 范围调整）。
 */
export function importFillMissing(): ImportResult {
	const contract = loadConfigContract();
	if (!contract) {
		return {ok: false, error: '推荐配置契约不可用（contracts/claude-config.json 缺失）'};
	}

	const path = settingsFilePath();
	let source: JsonObject = {};
	if (existsSync(path)) {
		try {
			const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
			source = isObject(parsed) ? parsed : {};
		} catch (error) {
			return {ok: false, error: `无法解析现有 settings.json，已停止以避免覆盖用户配置：${error instanceof Error ? error.message : String(error)}`};
		}
	}

	const {settings, updatedItems} = applyFillMissing(contract, source);

	try {
		atomicWrite(path, JSON.stringify(settings, null, 2));
		return {ok: true, updatedItems, changed: updatedItems.length};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
