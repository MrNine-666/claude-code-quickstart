import {existsSync, mkdirSync, readdirSync, renameSync, unlinkSync} from 'node:fs';
import {basename, join} from 'node:path';
import {createHash} from 'node:crypto';
import {atomicWrite, readJsonFile, withProfileLock, writeJsonAtomic} from './fs-utils.js';
import {providersDir, settingsPath, claudeJsonPath} from './paths.js';
import {
	escapeRegex,
	isNullOrWhiteSpace,
	maskApiKey,
	normalizeBaseUrl,
	testProviderAuthTokenMatch,
	testProviderBaseUrlMatch,
	testProviderKey
} from './text-utils.js';
import {
	getManagedModelEnvFromLegacyAliases,
	loadProviderContract,
	type ProviderRuntimeConfig
} from './provider-contract.js';

// ── 类型 ────────────────────────────────────────────────────────────────────

// 新格式：单层 { env } 即官方 settings-compatible；modelEnv/modelMapping 仅为旧格式迁移识别保留。
export type ProviderProfile = {
	env?: Record<string, string>;
	modelEnv?: Record<string, string>;
	modelMapping?: Record<string, string>;
	[key: string]: unknown;
};

export type ProviderListItem = {
	readonly key: string;
	readonly baseUrl: string;
	readonly hasManagedModelConfig: boolean;
	readonly authToken: string;
	readonly profilePath: string;
};

export type ProviderDisplayProfile = {
	readonly key: string;
	readonly baseUrl: string;
	readonly authToken: string;
	readonly profilePath: string;
	readonly isActive: boolean;
	readonly maskedApiKey: string;
};

export type ProviderDisplayData = {
	readonly profiles: readonly ProviderDisplayProfile[];
	readonly activeKey: string;
	readonly hasProviders: boolean;
};

export type AddProviderOptions = {
	readonly builtinKey?: string;
	readonly name?: string;
	readonly profileKey?: string; // 用户指定文件名（§2.7），未填时回退派生
	readonly baseUrl?: string;
	readonly apiKey?: string;
	readonly modelEnv?: Record<string, string>;
	// 用户经表单底部 JSON 直填的完整 env（5 必填字段外的供应商特定键）。
	// 传入时以此为真源与模板预填 env 合并；未传入时回退模板 ExtraEnv + ModelEnv。
	readonly env?: Record<string, string>;
	readonly activate?: boolean;
	readonly conflictStrategy?: 'increment' | 'overwrite' | 'error';
};

export type AddProviderResult = {
	success: boolean;
	key: string;
	name: string;
	baseUrl: string;
	activated: boolean;
	error?: string;
	activateError?: string;
};

export type EditProviderUpdates = {
	readonly apiKey?: string;
	readonly baseUrl?: string;
	readonly name?: string;
	readonly profileKey?: string; // 用户改写文件名（§2.7），触发重命名
	readonly modelEnv?: Record<string, string> | null;
	// 用户经表单底部 JSON 直填的完整 env（5 必填字段外的键）。
	// 全量替换语义：传入时 textarea 为真源，profile.env 的非必填键整体被该值替换；
	// token/baseUrl/受管模型键由专用路径写入，不受此字段影响。
	readonly env?: Record<string, string> | null;
};

// 旧格式 → settings-compatible 迁移结果（HC-FU-05/06）。
export type MigrationEntry = {
	readonly key: string;
	readonly status: 'migrated' | 'skipped' | 'failed';
	readonly reason?: string; // failed 时填，脱敏，不含 token
};

export type MigrationResult = {
	readonly migrated: readonly string[];
	readonly skipped: readonly string[];
	readonly failed: readonly MigrationEntry[];
	readonly total: number;
};

// ── 数据层辅助 ─────────────────────────────────────────────────────────────

function cfg(): ProviderRuntimeConfig {
	return loadProviderContract();
}

function readSettings(): Record<string, unknown> {
	return readJsonFile<Record<string, unknown>>(settingsPath(), {}) || {};
}

function writeSettingsAtomic(settings: Record<string, unknown>): void {
	writeJsonAtomic(settingsPath(), settings);
}

/**
 * §2.7 决策 2：首次新增供应商时检测 ~/.claude.json 的 hasCompletedOnboarding，
 * 无则写入 true，跳过 Claude Code 官方首次引导。
 */
function ensureOnboardingMarked(): void {
	const path = claudeJsonPath();
	const data = readJsonFile<Record<string, unknown>>(path, {}) || {};
	if (data.hasCompletedOnboarding === true) {
		return;
	}

	data.hasCompletedOnboarding = true;
	try {
		writeJsonAtomic(path, data);
	} catch {
		/* 写入失败不阻塞供应商新增 */
	}
}

function settingsEnv(settings: Record<string, unknown>): Record<string, string> {
	return (settings.env as Record<string, string>) ?? {};
}

function stringFingerprint(text: string): string {
	return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/** 生成自定义供应商 Key：优先名称，回退 URL（host + 可选路径哈希）。 */
export function newCustomProviderKey(name: string | undefined, baseUrl: string): string {
	if (!isNullOrWhiteSpace(name)) {
		const sanitized = String(name)
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, '-')
			.replace(/-{2,}/g, '-')
			.replace(/^-|-$/g, '');
		if (sanitized) {
			return `custom-${sanitized}`;
		}
	}

	try {
		const uri = new URL(String(baseUrl).trim().replace(/\/+$/, ''));
		const hostPart = uri.hostname.toLowerCase().replace(/\./g, '-');
		if (uri.pathname && uri.pathname !== '/') {
			const pathHash = stringFingerprint(uri.pathname).substring(0, 4);
			return `custom-${hostPart}-${pathHash}`;
		}

		return `custom-${hostPart}`;
	} catch {
		return 'custom-manual';
	}
}

/** 计算下一个可用递增 key（如 zhipu → zhipu-2 → zhipu-3）。 */
function getNextAvailableKey(baseKey: string, dir: string): string {
	if (!existsSync(dir)) {
		return `${baseKey}-2`;
	}

	let files: string[] = [];
	try {
		files = readdirSync(dir).filter(f => f.endsWith('.json'));
	} catch {
		return `${baseKey}-2`;
	}

	if (files.length === 0) {
		return `${baseKey}-2`;
	}

	const pattern = new RegExp(`^${escapeRegex(baseKey)}(?:-(\\d+))?$`);
	let maxNum = 1;
	for (const f of files) {
		const m = basename(f, '.json').match(pattern);
		if (!m) {
			continue;
		}

		if (m[1]) {
			const n = Number.parseInt(m[1], 10);
			if (!Number.isNaN(n) && n > maxNum) {
				maxNum = n;
			}
		}
	}

	return `${baseKey}-${maxNum + 1}`;
}

function findBuiltinProviderProfiles(builtinKey: string, profiles: readonly ProviderListItem[]): ProviderListItem[] {
	if (profiles.length === 0) {
		return [];
	}

	const pattern = new RegExp(`^${escapeRegex(builtinKey)}-\\d+$`);
	return profiles.filter(p => p.key === builtinKey || pattern.test(p.key));
}

// ── 受管 env 层 ─────────────────────────────────────────────────────────────

// 读取优先级 modelEnv → legacy(modelMapping) → env 对新旧格式均正确，禁止反转（design §1.2 CRITICAL）。
export function getManagedModelEnv(profile: ProviderProfile | null): Record<string, string> {
	const result: Record<string, string> = {};
	if (!profile) {
		return result;
	}

	const config = cfg();

	if (profile.modelEnv) {
		for (const key of config.managedModelEnvKeys) {
			if (!isNullOrWhiteSpace(profile.modelEnv[key])) {
				result[key] = String(profile.modelEnv[key]);
			}
		}

		if (Object.keys(result).length > 0) {
			return result;
		}
	}

	const legacy = profile[config.legacyModelKey] as Record<string, string> | undefined;
	if (legacy) {
		return getManagedModelEnvFromLegacyAliases(legacy);
	}

	if (profile.env) {
		for (const key of config.managedModelEnvKeys) {
			if (!isNullOrWhiteSpace(profile.env[key])) {
				result[key] = String(profile.env[key]);
			}
		}
	}

	return result;
}

/** 将受管模型键写入 profile.env 并清理旧版顶层字段（modelMapping + modelEnv），产出 settings-compatible 格式。 */
function setManagedModelEnv(profile: ProviderProfile, modelEnv: Record<string, string> | null | undefined): void {
	const config = cfg();
	delete profile[config.legacyModelKey];
	delete profile.modelEnv;
	if (!profile.env) {
		profile.env = {};
	}

	for (const key of config.managedModelEnvKeys) {
		delete profile.env[key];
	}

	if (!modelEnv) {
		return;
	}

	for (const key of config.managedModelEnvKeys) {
		if (!isNullOrWhiteSpace(modelEnv[key])) {
			profile.env[key] = String(modelEnv[key]);
		}
	}
}

/**
 * 将用户直填的 env 整体合并进 profile.env（5 必填字段外的供应商特定键）。
 * 跳过 token/baseUrl/受管模型键以免与专用写入路径冲突；空 key/value 丢弃。
 * profile.env 中由模板预填但用户 env 未携带的键保留（不主动清理），由 edit 全量替换路径负责删除。
 */
function mergeEnvIntoProfile(profile: ProviderProfile, env: Record<string, string> | null | undefined): void {
	if (!profile.env) {
		profile.env = {};
	}

	if (!env) {
		return;
	}

	const reserved = new Set<string>(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...cfg().managedModelEnvKeys]);
	for (const [k, v] of Object.entries(env)) {
		if (isNullOrWhiteSpace(k) || isNullOrWhiteSpace(v) || reserved.has(k)) {
			continue;
		}

		profile.env[k] = String(v);
	}
}

/** 生成人类可读的模型配置摘要。 */
export function getManagedModelSummary(profile: ProviderProfile | null): string {
	const modelEnv = getManagedModelEnv(profile);
	if (Object.keys(modelEnv).length === 0) {
		return '未配置';
	}

	const labels = cfg().modelEnvLabels;
	const orderedKeys = [
		'ANTHROPIC_DEFAULT_HAIKU_MODEL',
		'ANTHROPIC_DEFAULT_OPUS_MODEL',
		'ANTHROPIC_DEFAULT_SONNET_MODEL'
	];
	const parts: string[] = [];
	for (const key of orderedKeys) {
		if (modelEnv[key]) {
			parts.push(`${labels[key] ?? key}=${modelEnv[key]}`);
		}
	}

	return parts.join(', ');
}

// ── 数据层（Profile 扫描 / 活跃身份匹配 / 展示数据） ─────────────────────────

/**
 * §2.8.1：收集当前 settings.env 中属于「某个 provider profile 受管」的键集合。
 * 即所有已存在 provider profile 的 env 键的并集——切换供应商时这些键都应被清理后重写，
 * 避免残留旧供应商配置；非 provider 来源的 env（ClaudeConfig 等）不在并集中而自动保留。
 */
function collectPreviousProviderManagedKeys(): Set<string> {
	const keys = new Set<string>();
	for (const p of getProviderList()) {
		const profilePath = p.profilePath;
		let profile: ProviderProfile | null = null;
		try {
			profile = readJsonFile<ProviderProfile | null>(profilePath, null);
		} catch {
			continue;
		}

		if (profile?.env) {
			for (const k of Object.keys(profile.env)) {
				keys.add(k);
			}
		}
	}

	return keys;
}

/** 扫描 ~/.claude/providers/*.json，返回 Profile 摘要数组。 */
export function getProviderList(): ProviderListItem[] {
	const dir = providersDir();
	if (!existsSync(dir)) {
		return [];
	}

	let files: string[] = [];
	try {
		files = readdirSync(dir).filter(f => f.endsWith('.json'));
	} catch {
		return [];
	}

	const results: ProviderListItem[] = [];
	for (const f of files) {
		try {
			const profilePath = join(dir, f);
			const profile = readJsonFile<ProviderProfile | null>(profilePath, null);
			if (!profile?.env?.ANTHROPIC_AUTH_TOKEN) {
				continue;
			}

			results.push({
				key: basename(f, '.json'),
				baseUrl: profile.env?.ANTHROPIC_BASE_URL ?? '',
				hasManagedModelConfig: Object.keys(getManagedModelEnv(profile)).length > 0,
				authToken: profile.env?.ANTHROPIC_AUTH_TOKEN ?? '',
				profilePath
			});
		} catch {
			/* 跳过损坏的 Profile 文件 */
		}
	}

	return results;
}

/** 从 Profile 列表解析当前活跃供应商（BaseUrl + Token 精确身份匹配）。 */
function resolveActiveProfile(
	profiles: readonly ProviderListItem[],
	baseUrl: string,
	authToken: string
): ProviderListItem | null {
	if (profiles.length === 0 || isNullOrWhiteSpace(baseUrl)) {
		return null;
	}

	const baseMatches = profiles.filter(p => testProviderBaseUrlMatch(baseUrl, p.baseUrl));
	if (baseMatches.length === 0) {
		return null;
	}

	const tokenMatches = baseMatches.filter(p => testProviderAuthTokenMatch(authToken, p.authToken));
	if (tokenMatches.length > 0) {
		return tokenMatches[0]!;
	}

	// 兼容旧 Profile / 手工半配置：仅当缺少可比较 Token 时退回历史 BaseUrl 匹配
	const profilesWithToken = baseMatches.filter(p => !isNullOrWhiteSpace(p.authToken));
	if (isNullOrWhiteSpace(authToken) || profilesWithToken.length === 0) {
		return baseMatches[0]!;
	}

	return null;
}

/** 识别当前活跃供应商。 */
export function getActiveProvider(): {key: string; baseUrl: string; profilePath: string} | null {
	const env = settingsEnv(readSettings());
	const baseUrl = env.ANTHROPIC_BASE_URL || '';
	const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
	if (isNullOrWhiteSpace(baseUrl)) {
		return null;
	}

	const active = resolveActiveProfile(getProviderList(), baseUrl, authToken);
	if (!active) {
		return null;
	}

	return {key: active.key, baseUrl: active.baseUrl, profilePath: active.profilePath};
}

/** 聚合供应商展示数据（合并 Profiles + ActiveKey）。 */
export function getDisplayData(): ProviderDisplayData {
	const profiles = getProviderList();
	const env = settingsEnv(readSettings());
	const baseUrl = env.ANTHROPIC_BASE_URL || '';
	const authToken = env.ANTHROPIC_AUTH_TOKEN || '';
	const active = resolveActiveProfile(profiles, baseUrl, authToken);
	const activeKey = active ? active.key : '';

	const displayProfiles: ProviderDisplayProfile[] = profiles.map(p => ({
		key: p.key,
		baseUrl: p.baseUrl,
		authToken: p.authToken,
		profilePath: p.profilePath,
		isActive: Boolean(activeKey) && p.key === activeKey,
		maskedApiKey: maskApiKey(p.authToken)
	}));

	return {
		profiles: displayProfiles,
		activeKey,
		hasProviders: displayProfiles.length > 0
	};
}

// ── 变更层（switch / add / edit / delete） ──────────────────────────────────
// 公开函数用 withProfileLock 包裹；内部 *Unlocked 避免重入死锁（对齐旧 provider-manager.js）。

/** 切换活跃供应商（读 Profile → 合并 settings.json，严格字段所有权，HC-SETTINGS-OWNERSHIP）。 */
function switchProviderUnlocked(key: string): {success: boolean; providerName: string} {
	const profiles = getProviderList();
	if (profiles.length === 0) {
		throw new Error('未找到供应商 Profile，请先添加供应商');
	}

	if (!testProviderKey(key)) {
		throw new Error(`非法 Provider Key: ${key}`);
	}

	const profilePath = join(providersDir(), `${key}.json`);
	if (!existsSync(profilePath)) {
		throw new Error(`供应商 Profile 不存在: ${key}`);
	}

	const profile = readJsonFile<ProviderProfile | null>(profilePath, null);
	if (!profile) {
		throw new Error(`供应商 Profile 读取失败: ${key}`);
	}

	const settings = readSettings();
	if (!settings.env) {
		settings.env = {};
	}

	const env = settings.env as Record<string, string>;
	const config = cfg();

	// §2.8.1：设置默认前，先识别并清理上一活跃供应商写入 settings.env 的受管键，
	// 避免切换后残留旧供应商 env；非 provider 来源的 env（如 ClaudeConfig 写入的
	// CLAUDE_AUTOCOMPACT_PCT_OVERRIDE）因不出现在任何 provider.env 中而自动保留。
	const previousManagedKeys = collectPreviousProviderManagedKeys();
	for (const k of previousManagedKeys) {
		delete env[k];
	}

	// 1. AUTH_TOKEN + BASE_URL（仅来自 profile.env）
	if (profile.env) {
		const authToken = profile.env.ANTHROPIC_AUTH_TOKEN;
		const baseUrl = profile.env.ANTHROPIC_BASE_URL;

		if (typeof authToken === 'string' && !isNullOrWhiteSpace(authToken)) {
			env.ANTHROPIC_AUTH_TOKEN = authToken;
		}

		if (typeof baseUrl === 'string' && !isNullOrWhiteSpace(baseUrl)) {
			env.ANTHROPIC_BASE_URL = baseUrl;
		}
	}

	// 2. 清理旧版顶层别名映射字段
	delete settings[config.legacyModelKey];

	// 3. 写入当前 Profile 的模型配置（受管模型键）
	for (const [k, v] of Object.entries(getManagedModelEnv(profile))) {
		env[k] = v;
	}

	// 4. 写入 profile.env 全量除 token/baseUrl 外的所有键（供应商携带的 env 字段），
	//    模型键已由步骤 3 覆盖。
	if (profile.env) {
		for (const [k, v] of Object.entries(profile.env)) {
			if (k === 'ANTHROPIC_AUTH_TOKEN' || k === 'ANTHROPIC_BASE_URL') {
				continue;
			}

			env[k] = v;
		}
	}

	// ★ 绝不触碰：model / language / permissions / hooks / statusLine / mcpServers
	writeSettingsAtomic(settings);

	const providerName = key;
	return {success: true, providerName};
}

/** 添加供应商（非交互核心）。 */
function addProviderUnlocked(opts: AddProviderOptions): AddProviderResult {
	const config = cfg();
	const result: AddProviderResult = {success: false, key: '', name: '', baseUrl: '', activated: false};

	if (!opts || isNullOrWhiteSpace(opts.apiKey)) {
		result.error = 'API Key 不能为空';
		return result;
	}

	let selectedKey: string;
	let providerName: string;
	let providerBaseUrl: string;
	let template: ProviderProfile | null = null;
	const builtin = opts.builtinKey ? config.builtinProviders[opts.builtinKey] : undefined;

	if (opts.builtinKey && builtin && opts.builtinKey !== 'custom') {
		// 内置供应商
		template = builtin as ProviderProfile;
		// §2.7：profileKey 优先覆盖内置默认 key（内置预填可由用户改写）
		selectedKey = !isNullOrWhiteSpace(opts.profileKey) ? String(opts.profileKey).trim() : opts.builtinKey;
		if (!testProviderKey(selectedKey)) {
			result.error = '文件名非法，请使用字母/数字/. _ -';
			return result;
		}

		providerName = opts.name || builtin.name;
		if (!isNullOrWhiteSpace(opts.baseUrl)) {
			if (!/^https?:\/\//.test(String(opts.baseUrl))) {
				result.error = 'Base URL 必须以 http:// 或 https:// 开头';
				return result;
			}

			providerBaseUrl = normalizeBaseUrl(opts.baseUrl);
		} else {
			providerBaseUrl = builtin.baseUrl;
		}

		const strategy = opts.conflictStrategy || 'increment';
		const exists = existsSync(join(providersDir(), `${selectedKey}.json`));
		const hasBuiltinCopies = findBuiltinProviderProfiles(selectedKey, getProviderList()).length > 0;
		if (exists || hasBuiltinCopies) {
			if (strategy === 'error') {
				result.error = `供应商 ${selectedKey} 已存在`;
				return result;
			}

			if (strategy === 'increment') {
				selectedKey = getNextAvailableKey(selectedKey, providersDir());
				const numMatch = selectedKey.match(/-(\d+)$/);
				const num = numMatch ? Number.parseInt(numMatch[1]!, 10) : 2;
				providerName = opts.name || `${builtin.name} (${num})`;
			}
		}
	} else {
		// 自定义供应商
		if (isNullOrWhiteSpace(opts.baseUrl)) {
			result.error = 'Base URL 不能为空';
			return result;
		}

		if (!/^https?:\/\//.test(String(opts.baseUrl))) {
			result.error = 'Base URL 必须以 http:// 或 https:// 开头';
			return result;
		}

		providerBaseUrl = normalizeBaseUrl(opts.baseUrl);
		providerName = opts.name || '自定义供应商';
		// §2.7：profileKey 优先，未填时回退 newCustomProviderKey 派生
		selectedKey = !isNullOrWhiteSpace(opts.profileKey)
			? String(opts.profileKey).trim()
			: newCustomProviderKey(opts.name, providerBaseUrl);
		if (!testProviderKey(selectedKey)) {
			result.error = '文件名非法，请使用字母/数字/. _ -';
			return result;
		}

		if (existsSync(join(providersDir(), `${selectedKey}.json`)) && opts.conflictStrategy === 'error') {
			result.error = `供应商 ${selectedKey} 已存在`;
			return result;
		}
	}

	// 构建 Profile（单层 env，无 _meta，settings-compatible）
	const profile: ProviderProfile = {
		env: {
			ANTHROPIC_AUTH_TOKEN: String(opts.apiKey),
			ANTHROPIC_BASE_URL: providerBaseUrl
		}
	};

	const templateModelEnv = template?.modelEnv as Record<string, string> | undefined;
	if (opts.modelEnv !== undefined) {
		setManagedModelEnv(profile, opts.modelEnv);
	} else if (templateModelEnv) {
		setManagedModelEnv(profile, templateModelEnv);
	}

	// 用户经 JSON 直填 env 为真源时以其为优先；未传入时回退模板 ExtraEnv。
	const templateExtraEnv = template?.extraEnv as Record<string, string> | undefined;
	const mergedEnv: Record<string, string> = opts.env !== undefined
		? {...opts.env}
		: {...(templateExtraEnv ?? {})};

	if (Object.keys(mergedEnv).length > 0) {
		mergeEnvIntoProfile(profile, mergedEnv);
	}

	if (!existsSync(providersDir())) {
		mkdirSync(providersDir(), {recursive: true});
	}

	writeJsonAtomic(join(providersDir(), `${selectedKey}.json`), profile);

	// §2.7 决策 2：首次新增供应商写入 onboarding 标记（跳过官方首次引导）
	ensureOnboardingMarked();

	result.success = true;
	result.key = selectedKey;
	result.name = providerName;
	result.baseUrl = providerBaseUrl;

	if (opts.activate) {
		try {
			switchProviderUnlocked(selectedKey);
			result.activated = true;
		} catch (error) {
			result.activateError = error instanceof Error ? error.message : String(error);
		}
	}

	return result;
}

/** 修改供应商配置（非交互核心）。 */
function editProviderUnlocked(key: string, updates: EditProviderUpdates): {success: boolean; key: string; renamed: boolean} {
	if (!testProviderKey(key)) {
		throw new Error(`非法 Provider Key: ${key}`);
	}

	const profilePath = join(providersDir(), `${key}.json`);
	if (!existsSync(profilePath)) {
		throw new Error(`供应商 Profile 不存在: ${key}`);
	}

	const profile = readJsonFile<ProviderProfile | null>(profilePath, null);
	if (!profile) {
		throw new Error(`供应商 Profile 读取失败: ${key}`);
	}

	if (!profile.env) {
		profile.env = {};
	}

	const envData = profile.env;

	// 写入前判断是否活跃（写入后 BaseUrl 可能已变，无法再匹配旧 URL）
	const activeBefore = getActiveProvider();
	const wasActive = Boolean(activeBefore && activeBefore.key === key);

	let pendingNewKey: string | null = null;

	if (updates.apiKey !== undefined) {
		if (isNullOrWhiteSpace(updates.apiKey)) {
			throw new Error('API Key 不能为空');
		}

		envData.ANTHROPIC_AUTH_TOKEN = String(updates.apiKey);
	}

	if (updates.baseUrl !== undefined) {
		if (isNullOrWhiteSpace(updates.baseUrl) || !/^https?:\/\//.test(String(updates.baseUrl))) {
			throw new Error('Base URL 无效');
		}

		const newUrl = normalizeBaseUrl(updates.baseUrl);
		envData.ANTHROPIC_BASE_URL = newUrl;
	}

	// §2.7：profileKey 优先触发重命名；否则 custom 供应商从 name 重新派生（兜底）。
	if (updates.profileKey !== undefined) {
		const candidateKey = String(updates.profileKey).trim();
		if (!testProviderKey(candidateKey)) {
			throw new Error('文件名非法，请使用字母/数字/. _ -');
		}

		if (candidateKey !== key) {
			const candidatePath = join(providersDir(), `${candidateKey}.json`);
			if (existsSync(candidatePath)) {
				throw new Error(`文件名 ${candidateKey} 已存在`);
			}

			pendingNewKey = candidateKey;
		}
	} else if (updates.name !== undefined && /^custom-/.test(key)) {
		const candidateKey = newCustomProviderKey(updates.name, envData.ANTHROPIC_BASE_URL ?? '');
		if (testProviderKey(candidateKey) && candidateKey !== key) {
			const candidatePath = join(providersDir(), `${candidateKey}.json`);
			if (!existsSync(candidatePath)) {
				pendingNewKey = candidateKey;
			}
		}
	}

	if (updates.modelEnv !== undefined) {
		setManagedModelEnv(profile, updates.modelEnv);
	}

	// 全量替换 env：textarea 为真源，先清除 profile.env 中非 token/baseUrl/模型键的旧键，再写入新值。
	// token/baseUrl/受管模型键由上方专用路径写入，不受此字段影响。
	if (updates.env !== undefined) {
		const reserved = new Set<string>(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', ...cfg().managedModelEnvKeys]);
		for (const k of Object.keys(envData)) {
			if (!reserved.has(k)) {
				delete envData[k];
			}
		}

		mergeEnvIntoProfile(profile, updates.env);
	}

	const effectiveKey = pendingNewKey || key;

	// 原子写入（重命名场景：写新文件 + 删旧文件）
	if (pendingNewKey) {
		writeJsonAtomic(join(providersDir(), `${pendingNewKey}.json`), profile);
		try {
			unlinkSync(profilePath);
		} catch {
			/* 旧文件清理失败不阻塞 */
		}
	} else {
		writeJsonAtomic(profilePath, profile);
	}

	// 活跃供应商自动同步 settings.json
	if (wasActive) {
		switchProviderUnlocked(effectiveKey);
	}

	return {success: true, key: effectiveKey, renamed: pendingNewKey !== null};
}

/** 删除供应商 Profile（force=true 允许删除活跃供应商并清理 settings 引用）。 */
function deleteProviderUnlocked(key: string, opts?: {force?: boolean}): {success: boolean; key: string; clearedSettings: boolean} {
	const options = opts ?? {};
	if (!testProviderKey(key)) {
		throw new Error(`非法 Provider Key: ${key}`);
	}

	const profilePath = join(providersDir(), `${key}.json`);
	if (!existsSync(profilePath)) {
		throw new Error(`供应商 Profile 不存在: ${key}`);
	}

	const active = getActiveProvider();
	const isActive = Boolean(active && active.key === key);

	if (isActive && !options.force) {
		throw new Error(`无法删除当前活跃的供应商: ${active!.key}，请先切换到其他供应商后再删除`);
	}

	// §2.8.1：删除前读出 profile.env 键集合，活跃供应商删除时据此精确清理 settings.env。
	let managedKeys: readonly string[] = [];
	let profile: ProviderProfile | null = null;
	try {
		profile = readJsonFile<ProviderProfile | null>(profilePath, null);
	} catch {
		/* 读取失败按无键处理 */
	}

	if (profile?.env) {
		managedKeys = Object.keys(profile.env);
	}

	unlinkSync(profilePath);

	if (isActive) {
		const config = cfg();
		const settings = readSettings();
		const env = settings.env as Record<string, string> | undefined;
		if (env) {
			for (const k of managedKeys) {
				delete env[k];
			}
		}

		delete settings[config.legacyModelKey];
		writeSettingsAtomic(settings);
	}

	return {success: true, key, clearedSettings: isActive};
}

// 公开版本：用 withProfileLock 包裹
export function switchProvider(key: string): {success: boolean; providerName: string} {
	return withProfileLock(() => switchProviderUnlocked(key));
}

export function addProvider(opts: AddProviderOptions): AddProviderResult {
	return withProfileLock(() => addProviderUnlocked(opts));
}

export function editProvider(key: string, updates: EditProviderUpdates): {success: boolean; key: string; renamed: boolean} {
	return withProfileLock(() => editProviderUnlocked(key, updates));
}

export function deleteProvider(key: string, opts?: {force?: boolean}): {success: boolean; key: string; clearedSettings: boolean} {
	return withProfileLock(() => deleteProviderUnlocked(key, opts));
}

// ── 迁移器（HC-FU-05/06，design §2.3） ─────────────────────────────────────────

/**
 * 旧格式 Profile 迁移器（无锁内部实现）。
 * 判定「需迁移」：含顶层 _meta、modelEnv、modelMapping 或 extraEnv 之一。
 * 新格式：单层 { env: {...} }，无顶层 _meta/modelEnv/modelMapping/extraEnv。
 * 事务：写临时文件 → 校验 → 原子替换 → 删旧（失败保留旧文件）。
 * 全量迁移：旧 env 全部键 + 顶层 modelEnv/modelMapping 模型键 + 顶层 extraEnv 全部键（§2.3.4）。
 */
function migrateLegacyProfilesUnlocked(): MigrationResult {
	const dir = providersDir();
	if (!existsSync(dir)) {
		return {migrated: [], skipped: [], failed: [], total: 0};
	}

	let files: string[] = [];
	try {
		files = readdirSync(dir).filter(f => f.endsWith('.json'));
	} catch {
		return {migrated: [], skipped: [], failed: [], total: 0};
	}

	const migrated: string[] = [];
	const skipped: string[] = [];
	const failed: MigrationEntry[] = [];

	for (const f of files) {
		const key = basename(f, '.json');
		const profilePath = join(dir, f);

		try {
			const profile = readJsonFile<ProviderProfile | null>(profilePath, null);
			if (!profile) {
				skipped.push(key);
				continue;
			}

			// 判定需迁移：含顶层 _meta / modelEnv / modelMapping / extraEnv 之一
			const hasMeta = '_meta' in profile && profile._meta;
			const hasModelEnv = 'modelEnv' in profile && profile.modelEnv;
			const hasModelMapping = 'modelMapping' in profile && profile.modelMapping;
			const hasExtraEnv = 'extraEnv' in profile && profile.extraEnv;

			if (!hasMeta && !hasModelEnv && !hasModelMapping && !hasExtraEnv) {
				skipped.push(key);
				continue;
			}

			// 构造新 profile（单层 env，无顶层 _meta/modelEnv/modelMapping/extraEnv）
			const newProfile: ProviderProfile = {env: {}};

			// 1. 旧 env 全部键原样迁移
			if (profile.env && typeof profile.env === 'object') {
				for (const [k, v] of Object.entries(profile.env)) {
					newProfile.env![k] = String(v);
				}
			}

			// 2. 顶层 modelEnv 模型键迁移到 env
			if (hasModelEnv && typeof profile.modelEnv === 'object') {
				for (const [k, v] of Object.entries(profile.modelEnv as Record<string, unknown>)) {
					if (!isNullOrWhiteSpace(String(v))) {
						newProfile.env![k] = String(v);
					}
				}
			}

			// 3. 顶层 modelMapping（legacy）转换后迁移到 env
			if (hasModelMapping && typeof profile.modelMapping === 'object') {
				const converted = getManagedModelEnvFromLegacyAliases(profile.modelMapping as Record<string, string>);
				for (const [k, v] of Object.entries(converted)) {
					newProfile.env![k] = v;
				}
			}

			// 4. 顶层 extraEnv 全量迁移到 env（§2.3.4 全量，同名 env 优先）
			if (hasExtraEnv && typeof profile.extraEnv === 'object') {
				for (const [k, v] of Object.entries(profile.extraEnv as Record<string, unknown>)) {
					if (!(k in newProfile.env!)) {
						newProfile.env![k] = String(v);
					}
				}
			}

			// 5. 校验必填字段
			if (!newProfile.env!.ANTHROPIC_AUTH_TOKEN || !newProfile.env!.ANTHROPIC_BASE_URL) {
				failed.push({key, status: 'failed', reason: '缺少必填字段'});
				continue;
			}

			// 6. 写临时文件
			const tmpPath = `${profilePath}.tmp-${process.pid}`;
			try {
				writeJsonAtomic(tmpPath, newProfile);
			} catch (error) {
				failed.push({key, status: 'failed', reason: '写入临时文件失败'});
				continue;
			}

			// 7. 校验临时文件可读
			let validated: ProviderProfile | null = null;
			try {
				validated = readJsonFile<ProviderProfile | null>(tmpPath, null);
			} catch {
				try {
					unlinkSync(tmpPath);
				} catch {}

				failed.push({key, status: 'failed', reason: '校验失败'});
				continue;
			}

			if (!validated?.env?.ANTHROPIC_AUTH_TOKEN || !validated.env.ANTHROPIC_BASE_URL) {
				try {
					unlinkSync(tmpPath);
				} catch {}

				failed.push({key, status: 'failed', reason: '校验内容不完整'});
				continue;
			}

			// 8. 原子替换
			try {
				renameSync(tmpPath, profilePath);
			} catch (error) {
				try {
					unlinkSync(tmpPath);
				} catch {}

				failed.push({key, status: 'failed', reason: '替换失败'});
				continue;
			}

			migrated.push(key);
		} catch (error) {
			// 脱敏：reason 不含 token/auth 值（SC-FU-02）
			const reason = error instanceof Error ? error.message.replace(/sk-[a-zA-Z0-9_-]+/g, '<token>') : '迁移异常';
			failed.push({key, status: 'failed', reason});
		}
	}

	return {
		migrated,
		skipped,
		failed,
		total: files.length
	};
}

/**
 * 旧格式 Profile 迁移器（公开版本，包锁）。
 * 进入 Provider 管理时执行 preflight（§2.4 时序保证）。
 */
export function migrateLegacyProfiles(): MigrationResult {
	return withProfileLock(() => migrateLegacyProfilesUnlocked());
}
