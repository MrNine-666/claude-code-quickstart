import {lstatSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

import {atomicWrite} from './fs-utils.js';
import {resolveHome} from './paths.js';

// 配置导入导出专用的官方 Skills 全局 lock（skills@1.7.2 `src/skill-lock.ts`，version 3）适配器。
// 只服务 transfer：严格读取、按名称匹配可迁移条目、按名称补丁与原子保存。
// Skills 已安装 detection 仍只消费 `skills list -g --json`，不得改用本模块。

export const SKILL_LOCK_VERSION = 3;
export const SKILL_LOCK_FILE = '.skill-lock.json';

export type SkillLockPathOptions = {
	readonly homeDir?: string;
	/** 省略时读取 `process.env.XDG_STATE_HOME`；测试显式注入隔离值。 */
	readonly xdgStateHome?: string;
};

/** 与官方一致：XDG_STATE_HOME 存在时为 `<XDG>/skills/.skill-lock.json`，否则 `<home>/.agents/.skill-lock.json`。 */
export function resolveSkillLockPath(options: SkillLockPathOptions = {}): string {
	const xdg = options.xdgStateHome ?? process.env.XDG_STATE_HOME;
	return xdg ? join(xdg, 'skills', SKILL_LOCK_FILE) : join(options.homeDir ?? resolveHome(), '.agents', SKILL_LOCK_FILE);
}

export type SkillLockEntry = Readonly<Record<string, unknown>>;

export type SkillLockDocument = Readonly<Record<string, unknown>> & {
	readonly version: typeof SKILL_LOCK_VERSION;
	readonly skills: Readonly<Record<string, unknown>>;
};

/** `text` 是读取时的原始文本，供写前复核外部修改；missing 是合法空状态。 */
export type SkillLockSnapshot =
	| {readonly state: 'missing'}
	| {readonly state: 'valid'; readonly text: string; readonly lock: SkillLockDocument};

export type SkillLockResult<T> = {readonly ok: true; readonly data: T} | {readonly ok: false; readonly error: string};

const LOCK_LABEL = '官方 Skills 来源记录（.skill-lock.json）';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
	return error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
}

/** 严格解析：无效 JSON/顶层结构/未知版本都是错误，绝不当作空 lock（官方 readSkillLock 会静默回退）。 */
export function parseSkillLockText(text: string): SkillLockResult<SkillLockDocument> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return {ok: false, error: `${LOCK_LABEL}损坏：不是有效 JSON`};
	}

	if (!isRecord(parsed) || typeof parsed.version !== 'number') {
		return {ok: false, error: `${LOCK_LABEL}结构无效`};
	}

	if (parsed.version !== SKILL_LOCK_VERSION) {
		return {ok: false, error: `${LOCK_LABEL}版本不受支持：${parsed.version}`};
	}

	if (!isRecord(parsed.skills)) {
		return {ok: false, error: `${LOCK_LABEL}结构无效`};
	}

	return {ok: true, data: parsed as SkillLockDocument};
}

/** 读取 lock 原文；链接或非普通文件拒绝（避免跟随写到未纳入回滚的位置）。错误不含绝对路径。 */
export function readSkillLock(lockPath: string): SkillLockResult<SkillLockSnapshot> {
	try {
		if (!lstatSync(lockPath).isFile()) {
			return {ok: false, error: `${LOCK_LABEL}不是普通文件`};
		}
	} catch (error) {
		if (errorCode(error) === 'ENOENT') {
			return {ok: true, data: {state: 'missing'}};
		}

		return {ok: false, error: `${LOCK_LABEL}无法读取`};
	}

	let text: string;
	try {
		text = readFileSync(lockPath, 'utf8');
	} catch {
		return {ok: false, error: `${LOCK_LABEL}无法读取`};
	}

	const parsed = parseSkillLockText(text);
	return parsed.ok ? {ok: true, data: {state: 'valid', text, lock: parsed.data}} : parsed;
}

/** skills CLI `sanitizeName`：目录名由它派生，list 也按它回退查 lock。 */
export function sanitizeSkillLockName(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9._]+/g, '-')
		.replace(/^[.-]+|[.-]+$/g, '');
	return sanitized.substring(0, 255) || 'unnamed-skill';
}

/** 与 name 精确相等或 sanitize 后相等的全部 lock key；多于一个即身份歧义，调用方不得猜测。 */
export function findSkillLockKeys(lock: SkillLockDocument, name: string): readonly string[] {
	const sanitized = sanitizeSkillLockName(name);
	return Object.keys(lock.skills).filter(key => key === name || sanitizeSkillLockName(key) === sanitized);
}

// ── 可迁移来源校验 ──────────────────────────────────────────────────────────

/** 已适配可迁移的远程来源类型；local 与未知类型只导出内容。 */
const TRANSFERABLE_SOURCE_TYPES: ReadonlySet<string> = new Set(['github', 'gitlab', 'git', 'well-known']);

// 常见令牌前缀与带凭据语义的查询参数；命中即按凭据处理，绝不输出原值。
const TOKEN_PATTERN =
	/(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,})/;
const CREDENTIAL_QUERY_KEY =
	/^(?:.*[-_])?(?:token|access[-_]?token|private[-_]?token|key|api[-_]?key|secret|password|passwd|auth|authorization|sig|signature|credential|credentials)$/i;
const CONTROL_PATTERN = /[\x00-\x1f\x7f]/;
const LOCAL_SOURCE_PATTERN = /^(?:file:|\.{1,2}(?:[\\/]|$)|[\\/]|~|[A-Za-z]:[\\/])/;
const CCQ_STAGE_PATTERN = /ccq-skill-stage-[A-Za-z0-9]{6}/;

/** 字符串是否疑似携带认证凭据：URL userinfo 密码、https 用户名、凭据型查询参数或已知令牌前缀。 */
export function looksLikeCredential(value: string): boolean {
	if (TOKEN_PATTERN.test(value) || /\bbearer\s+\S/i.test(value)) {
		return true;
	}

	for (const match of value.matchAll(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g)) {
		let url: URL;
		try {
			url = new URL(match[0]);
		} catch {
			continue;
		}

		// SSH 用户名（如 git@host）不是密码；其它协议的 userinfo 视为凭据。
		if (url.password || (url.username && url.protocol !== 'ssh:')) {
			return true;
		}

		for (const key of url.searchParams.keys()) {
			if (CREDENTIAL_QUERY_KEY.test(key)) {
				return true;
			}
		}
	}

	return false;
}

function anyStringLooksLikeCredential(value: unknown, depth = 0): boolean {
	if (typeof value === 'string') {
		return looksLikeCredential(value);
	}

	if (depth > 16 || typeof value !== 'object' || value === null) {
		return false;
	}

	return Object.entries(value).some(([key, item]) => looksLikeCredential(key) || anyStringLooksLikeCredential(item, depth + 1));
}

function isSafeToken(value: string): boolean {
	return value.length > 0 && value.length <= 2048 && !CONTROL_PATTERN.test(value) && !/\s/.test(value) && !value.startsWith('-');
}

function isLocalSource(value: string): boolean {
	return LOCAL_SOURCE_PATTERN.test(value) || CCQ_STAGE_PATTERN.test(value);
}

/** https / ssh URL 或 scp 形式 `user@host:path`；不得含密码、端口歧义以外的危险协议或选项注入。 */
function isSafeRemoteUrl(value: string, allowSsh: boolean): boolean {
	if (!isSafeToken(value)) {
		return false;
	}

	if (allowSsh && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/.test(value)) {
		return !value.slice(value.indexOf(':') + 1).startsWith('-');
	}

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}

	return (url.protocol === 'https:' || (allowSsh && url.protocol === 'ssh:')) && !url.password && url.hostname !== '';
}

function isSafeRelativePath(value: string): boolean {
	return (
		isSafeToken(value) &&
		!value.includes('\\') &&
		!/^(?:\/|~|[A-Za-z]:)/.test(value) &&
		!value.includes('://') &&
		!value.split('/').some(segment => segment === '' || segment === '..' || segment === '.')
	);
}

function isSafeRef(value: string): boolean {
	return isSafeToken(value) && /^[A-Za-z0-9._/+@-]+$/.test(value) && !value.includes('..') && !value.includes('@{');
}

export type SkillLockEntryClassification =
	| {readonly kind: 'transferable'; readonly entry: SkillLockEntry; readonly missingUpdateFields: boolean}
	| {readonly kind: 'content-only'; readonly reason: 'local' | 'credential' | 'unsupported'};

const OPTIONAL_STRING_FIELDS = ['sourceUrl', 'ref', 'skillPath', 'sourceBaseUrl'] as const;

/**
 * 判定 lock 条目能否作为可迁移来源原样导出：条目整体保留（含未知 v3 字段），
 * 只校验已知来源字段与全部字符串中的疑似凭据。导出与导入共用同一边界。
 */
export function classifySkillLockEntry(entry: unknown): SkillLockEntryClassification {
	if (!isRecord(entry)) {
		return {kind: 'content-only', reason: 'unsupported'};
	}

	if (anyStringLooksLikeCredential(entry)) {
		return {kind: 'content-only', reason: 'credential'};
	}

	const {source, sourceType} = entry;
	if (typeof source !== 'string' || typeof sourceType !== 'string') {
		return {kind: 'content-only', reason: 'unsupported'};
	}

	if (sourceType === 'local' || isLocalSource(source) || (typeof entry.sourceUrl === 'string' && isLocalSource(entry.sourceUrl))) {
		return {kind: 'content-only', reason: 'local'};
	}

	if (
		!TRANSFERABLE_SOURCE_TYPES.has(sourceType) ||
		!isSafeToken(source) ||
		OPTIONAL_STRING_FIELDS.some(field => entry[field] !== undefined && typeof entry[field] !== 'string') ||
		(typeof entry.sourceUrl === 'string' && !isSafeRemoteUrl(entry.sourceUrl, true)) ||
		(typeof entry.sourceBaseUrl === 'string' && !isSafeRemoteUrl(entry.sourceBaseUrl, false)) ||
		(typeof entry.skillPath === 'string' && !isSafeRelativePath(entry.skillPath)) ||
		(typeof entry.ref === 'string' && !isSafeRef(entry.ref))
	) {
		return {kind: 'content-only', reason: 'unsupported'};
	}

	const hash = entry.skillFolderHash;
	return {kind: 'transferable', entry, missingUpdateFields: typeof hash !== 'string' || hash === ''};
}

// ── 按名称补丁与原子保存 ────────────────────────────────────────────────────

/** entry 为 null 表示删除该名称的条目（清理陈旧来源）。 */
export type SkillLockPatch = {readonly name: string; readonly entry: SkillLockEntry | null};

/**
 * 只替换/删除补丁中的精确名称；顶层未知字段、偏好与无关条目原样保留（含 key 顺序）。
 * 无实际变化返回 null；目标缺失且只有删除时不创建空 lock。
 */
export function patchSkillLock(snapshot: SkillLockSnapshot, patches: readonly SkillLockPatch[]): SkillLockDocument | null {
	const base: SkillLockDocument = snapshot.state === 'valid' ? snapshot.lock : {version: SKILL_LOCK_VERSION, skills: {}};
	const skills: Record<string, unknown> = {...base.skills};
	let changed = false;
	for (const patch of patches) {
		if (patch.entry === null) {
			if (Object.hasOwn(skills, patch.name)) {
				delete skills[patch.name];
				changed = true;
			}
		} else if (!Object.hasOwn(skills, patch.name) || JSON.stringify(skills[patch.name]) !== JSON.stringify(patch.entry)) {
			skills[patch.name] = patch.entry;
			changed = true;
		}
	}

	return changed ? {...base, skills} : null;
}

/**
 * 写前重读复核：当前文件必须仍等于 `expected`（原文或缺失），否则视为外部修改并拒绝覆盖。
 * 与官方一致使用 2 空格 JSON；既有文件权限由 atomicWrite 保留。
 */
export function saveSkillLock(lockPath: string, expected: SkillLockSnapshot, next: SkillLockDocument): SkillLockResult<void> {
	const current = readSkillLock(lockPath);
	if (!current.ok) {
		return current;
	}

	const currentText = current.data.state === 'valid' ? current.data.text : null;
	if (currentText !== (expected.state === 'valid' ? expected.text : null)) {
		return {ok: false, error: `${LOCK_LABEL}在导入期间被外部修改，已停止写入`};
	}

	try {
		atomicWrite(lockPath, JSON.stringify(next, null, 2));
	} catch {
		return {ok: false, error: `${LOCK_LABEL}写入失败`};
	}

	return {ok: true, data: undefined};
}
