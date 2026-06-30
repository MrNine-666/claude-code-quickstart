import {existsSync, readFileSync} from 'node:fs';
import {loadContract} from './contracts.js';
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
	try {
		return loadContract<ConfigContract>('claude-config.json');
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

/** 读取当前 settings.json 原始文本（不存在或读取失败返回 null；对称 readInstalledClaudeMd，供 view 态只读展示与 edit 载入保真）。 */
export function readInstalledSettingsText(): string | null {
	const path = settingsFilePath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		return readFileSync(path, 'utf8');
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
 * 组装带注释的推荐配置文本（JSONC 风格，供推荐边栏对照展示）。
 * 每个配置项的 description 以 `// 注释` 独立行标注于项上方（IDE 风格）；
 * permissions 的整体 description 标在 allow 上方。
 * 单一数据源：注释来自契约 Descriptions，与值同处一份契约，零重复维护。
 */
export function assembleRecommendationAnnotated(): string | null {
	const contract = loadConfigContract();
	if (!contract) {
		return null;
	}

	const descriptions = contract.Descriptions ?? {};
	const topLevelDesc = descriptions.TopLevelDefaults ?? {};
	const envDesc = descriptions.ClaudeConfigEnvDefaults ?? {};
	const permDesc = descriptions.ClaudeConfigBasePermissions ?? '';

	const members: string[] = [];

	// 顶层默认值（每项 description 标注于上方）
	for (const [key, value] of Object.entries(contract.TopLevelDefaults ?? {})) {
		members.push(annotateMember(key, value, topLevelDesc[key], '  '));
	}

	// env 节（内部项缩进 4 空格，每项 description 标注于上方）
	const envMembers = Object.entries(contract.ClaudeConfigEnvDefaults ?? {})
		.map(([k, v]) => annotateMember(k, v, envDesc[k], '    '));
	if (envMembers.length > 0) {
		members.push(`  "env": {\n${envMembers.join(',\n')}\n  }`);
	}

	// permissions 节（整体 description 标在 allow 上方）
	const perms = [...(contract.ClaudeConfigBasePermissions ?? [])];
	if (perms.length > 0) {
		const lines: string[] = ['  "permissions": {'];
		if (permDesc) {
			lines.push(`    // ${permDesc}`);
		}
		lines.push('    "allow": [');
		lines.push(perms.map(p => `      "${p}"`).join(',\n'));
		lines.push('    ]');
		lines.push('  }');
		members.push(lines.join('\n'));
	}

	if (members.length === 0) {
		return '{}';
	}

	return `{\n${members.join(',\n')}\n}`;
}

/**
 * 生成单个带注释的成员块：可选 // 注释行 + "key": value（多行值正确缩进）。
 * indent 为 key 所在行的缩进；多行值（对象/数组）内部统一再缩进一级，保持合法 JSON 缩进。
 */
function annotateMember(key: string, value: unknown, description: string | undefined, indent: string): string {
	// JSON.stringify(…, 2) 本身已含 2 空格内部缩进，换行后只补 indent 即可（再 +2 会叠加错位）。
	const valueJson = JSON.stringify(value, null, 2);
	const valueIndented = valueJson.includes('\n')
		? valueJson.replace(/\n/g, `\n${indent}`)
		: valueJson;
	const comment = description ? `${indent}// ${description}\n` : '';
	return `${comment}${indent}"${key}": ${valueIndented}`;
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
 * 对编辑缓冲中的 JSON 文本执行 fill-missing 合并（仅补缺失，保留用户已有配置）。
 * 供推荐边栏 Ctrl+O 灌缓冲：合并结果写回编辑器文本，可 Ctrl+Z 撤销，不直接落盘。
 * 文本非法 JSON 时返回错误（不抛）；非对象（数组/原始值）视为空配置从零补全。
 */
export function applyFillMissingToText(jsonText: string):
	| {readonly ok: true; readonly text: string; readonly changed: number}
	| {readonly ok: false; readonly error: string} {
	const contract = loadConfigContract();
	if (!contract) {
		return {ok: false, error: '推荐配置契约不可用（contracts/claude-config.json 缺失）'};
	}

	let source: JsonObject = {};
	try {
		const parsed = JSON.parse(jsonText) as unknown;
		if (isObject(parsed)) {
			source = parsed;
		}
	} catch (error) {
		return {ok: false, error: `当前编辑内容不是合法 JSON：${error instanceof Error ? error.message : String(error)}`};
	}

	const {settings, updatedItems} = applyFillMissing(contract, source);
	return {ok: true, text: JSON.stringify(settings, null, 2), changed: updatedItems.length};
}

/**
 * 从 settings 文本剥离供应商 env 字段（DoNotManageEnvKeys），供配置文件页 view/edit 展示。
 * 不暴露 token/base_url/model 等供应商字段（归供应商页管，HC-12 字段所有权）。
 * 文本非 JSON 对象时返回 {ok:false}，调用方可回退展示原文。
 */
export function stripProviderEnvFromText(jsonText: string):
	| {readonly ok: true; readonly text: string}
	| {readonly ok: false; readonly error: string} {
	let parsed: JsonObject;
	try {
		const obj = JSON.parse(jsonText) as unknown;
		if (!isObject(obj)) {
			return {ok: false, error: 'settings.json 不是 JSON 对象'};
		}
		parsed = obj;
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}

	const forbidden = new Set(loadConfigContract()?.Ownership?.DoNotManageEnvKeys ?? []);
	const env = parsed['env'];
	if (!isObject(env) || forbidden.size === 0) {
		return {ok: true, text: JSON.stringify(parsed, null, 2)};
	}

	const cleaned: JsonObject = {};
	for (const [key, value] of Object.entries(env as JsonObject)) {
		if (!forbidden.has(key)) {
			cleaned[key] = value;
		}
	}
	return {ok: true, text: JSON.stringify({...parsed, env: cleaned}, null, 2)};
}

/**
 * 保存合并：edited 是用户编辑（不含供应商 env），从 original 恢复供应商 env 字段后整体返回。
 * 配置文件页不展示/不编辑供应商 env（token/base_url/model 等），保存时自动从原文件原样保留，绝不丢失。
 * original 缺失或解析失败时按 edited 写入（首次新建场景）。
 */
export function mergeProviderEnvOnSave(editedText: string, originalText: string | null):
	| {readonly ok: true; readonly text: string}
	| {readonly ok: false; readonly error: string} {
	let edited: JsonObject;
	try {
		const obj = JSON.parse(editedText) as unknown;
		if (!isObject(obj)) {
			return {ok: false, error: '编辑内容不是 JSON 对象'};
		}
		edited = obj;
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}

	const forbidden = new Set(loadConfigContract()?.Ownership?.DoNotManageEnvKeys ?? []);
	if (forbidden.size === 0 || !originalText) {
		return {ok: true, text: JSON.stringify(edited, null, 2)};
	}

	try {
		const original = JSON.parse(originalText) as unknown;
		if (!isObject(original) || !isObject(original['env'])) {
			return {ok: true, text: JSON.stringify(edited, null, 2)};
		}
		const providerEntries = Object.fromEntries(
			Object.entries(original['env'] as JsonObject).filter(([k]) => forbidden.has(k))
		);
		if (Object.keys(providerEntries).length === 0) {
			return {ok: true, text: JSON.stringify(edited, null, 2)};
		}
		const editedEnv: JsonObject = isObject(edited['env']) ? {...(edited['env'] as JsonObject)} : {};
		// 供应商字段从原文件恢复（用户编辑器看不到这些键，不会主动编辑）；其余 env 字段尊重用户编辑。
		return {ok: true, text: JSON.stringify({...edited, env: {...editedEnv, ...providerEntries}}, null, 2)};
	} catch {
		// original 解析失败：忽略，按 edited 写入（不阻塞保存）。
		return {ok: true, text: JSON.stringify(edited, null, 2)};
	}
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
