import {join} from 'node:path';
import type {AgentContext} from '../state/manage-state.js';
import {execCommand, removeAnsiSequences, type ExecResult} from './exec.js';
import {resolveHome} from './paths.js';
import {inspectSkillStorage, type SkillStorageInspection, type SkillStorageOptions} from './skills-storage.js';

// 外部命令执行缝：默认走 execCommand，测试可注入桩以避免真实 spawn（design D11/D13）。
export type ExecFn = (command: string, args: readonly string[], options?: {timeout?: number}) => Promise<ExecResult>;

// Skills core：已安装检测 + skills find 搜索 + parser（design D11）。
// 搜索数据源固定为 `npx --yes skills find <query>`，命令不可用/不可解析时报错，不回退 catalogue。

export type SkillsCliAgent = 'claude-code' | 'codex';

export function skillsAgentOf(agentContext: AgentContext): SkillsCliAgent {
	switch (agentContext) {
		case 'cc':
			return 'claude-code';
		case 'cx':
			return 'codex';
	}
}

// skills list --json 的 agents 字段用 displayName 标识 skill 所在 agent 目录。
// 共享投影只关心 Claude Code / Codex 两侧；其它 universal agent（Cline/Cursor 等）displayName 忽略。
export const SKILL_AGENT_DISPLAY_TO_CONTEXT: Readonly<Record<string, AgentContext>> = {
	'Claude Code': 'cc',
	Codex: 'cx'
};

/** 某 skill 是否在给定 agent 上（按 agents displayName 判定）。纯函数，供投影与门禁复用。 */
export function skillInstalledOn(skill: InstalledSkill, agentContext: AgentContext): boolean {
	return skill.agents.some(display => SKILL_AGENT_DISPLAY_TO_CONTEXT[display] === agentContext);
}

function normalizeAgentAndExec(agentOrExec: AgentContext | ExecFn | undefined, exec: ExecFn | undefined): {agentContext: AgentContext; exec: ExecFn} {
	return typeof agentOrExec === 'function'
		? {agentContext: 'cc', exec: agentOrExec}
		: {agentContext: agentOrExec ?? 'cc', exec: exec ?? execCommand};
}

const LIST_TIMEOUT_MS = 120000;
const SEARCH_TIMEOUT_MS = 120000;
const GLOBAL_SKILL_LOCK_VERSION = 3;

export type SkillInstallMetadata = {
	readonly source?: string;
	readonly ref?: string;
	readonly skillName: string;
};

export type InstalledSkill = {
	readonly name: string;
	readonly path: string;
	readonly scope: string;
	readonly agents: readonly string[];
	readonly source?: string;
	readonly ref?: string;
	readonly skillName?: string;
	readonly storage?: SkillStorageInspection;
};

export type SearchSkillResult = {
	readonly name: string;
	readonly source: string;
	readonly description: string;
	readonly installCount?: number;
	readonly url?: string;
};

export type SearchSkillIdentity = {
	readonly key: string;
	readonly source: string;
	readonly skillName: string;
};

function githubRepoSlug(source: string): string | undefined {
	let candidate = source.trim();
	if (!candidate) {
		return undefined;
	}

	try {
		const url = new URL(candidate);
		if (url.hostname.toLowerCase() !== 'github.com') {
			return undefined;
		}

		candidate = url.pathname;
	} catch {
		const sshMatch = candidate.match(/^git@github\.com:(.+)$/i);
		candidate = sshMatch?.[1] ?? candidate.replace(/^github:/i, '').replace(/^github\.com\//i, '');
	}

	const parts = candidate.replace(/^\/+|\/+$/g, '').split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return undefined;
	}

	const repo = parts[1].replace(/\.git$/i, '');
	return repo ? `${parts[0].toLowerCase()}/${repo.toLowerCase()}` : undefined;
}

/** GitHub repo URL、SSH source 与 `owner/repo` 简写视为同一 Skills 来源。 */
export function skillSourcesEquivalent(left: string, right: string): boolean {
	const normalizedLeft = left.trim();
	const normalizedRight = right.trim();
	if (!normalizedLeft || !normalizedRight) {
		return false;
	}

	if (normalizedLeft === normalizedRight) {
		return true;
	}

	const leftSlug = githubRepoSlug(normalizedLeft);
	const rightSlug = githubRepoSlug(normalizedRight);
	return Boolean(leftSlug && rightSlug && leftSlug === rightSlug);
}

/** 从搜索结果中提取 source 下的子 Skill 名；非 `source@skill` 形态返回 undefined。 */
export function skillNameFromSearchResult(result: SearchSkillResult, source: string): string | undefined {
	const prefix = `${source}@`;
	if (!source || !result.name.startsWith(prefix)) {
		return undefined;
	}

	const skillName = result.name.slice(prefix.length).trim();
	return skillName || undefined;
}

/**
 * 搜索结果的唯一身份。全局安装目录按 skillName 占位，但 UI 选择必须同时区分 source，
 * 因此 key 使用可逆的 tuple JSON，避免分隔符碰撞。
 */
export function searchSkillIdentity(result: SearchSkillResult): SearchSkillIdentity | undefined {
	const source = (result.source || repoOfName(result.name)).trim();
	const skillName = skillNameFromSearchResult(result, source);
	if (!source || !skillName) {
		return undefined;
	}

	return {
		key: JSON.stringify([source, skillName]),
		source,
		skillName
	};
}

export type SkillsSearchOutcome =
	| {readonly ok: true; readonly results: readonly SearchSkillResult[]}
	| {readonly ok: false; readonly error: string; readonly rawSummary?: string};

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Best-effort 读取 skills CLI v3 全局 lock；缺失、旧版或损坏时返回空 Map。 */
export async function readGlobalSkillLockMetadata(homeDir = resolveHome()): Promise<ReadonlyMap<string, SkillInstallMetadata>> {
	const metadata = new Map<string, SkillInstallMetadata>();
	try {
		const parsed = JSON.parse(await Bun.file(join(homeDir, '.agents', '.skill-lock.json')).text()) as unknown;
		if (!isRecord(parsed) || parsed.version !== GLOBAL_SKILL_LOCK_VERSION || !isRecord(parsed.skills)) {
			return metadata;
		}

		for (const [skillName, rawEntry] of Object.entries(parsed.skills)) {
			if (!isRecord(rawEntry)) {
				continue;
			}

			// v3 的 sourceUrl 是可直接重新 add 的原始来源；缺失时回退规范化 source shorthand。
			const sourceUrl = typeof rawEntry.sourceUrl === 'string' ? rawEntry.sourceUrl.trim() : '';
			const source = sourceUrl || (typeof rawEntry.source === 'string' ? rawEntry.source.trim() : '');
			const ref = typeof rawEntry.ref === 'string' ? rawEntry.ref.trim() : '';
			metadata.set(skillName, {
				...(source ? {source} : {}),
				...(ref ? {ref} : {}),
				skillName
			});
		}
	} catch {
		// Lock 是增强元数据，不得让缺失或损坏阻断已安装列表检测。
	}

	return metadata;
}

/**
 * 获取已安装的 Skills（`npx skills list -g [--agent <侧>] --json`）。
 *
 * 双模式（shared-resource-injection-ui Section 16.1）：
 * - **显式传 AgentContext（'cc'/'cx'）**：带 `--agent <侧>` 单侧过滤（旧主路径，供 agent-aware 检测复用）。
 * - **无参 / 仅传 exec / undefined agent**：**不带 `--agent`** 全量扫所有 agent 目录，一次调用即得每条 skill 的
 *   `agents` 字段（含 Claude Code / Codex displayName），供 `projectSharedSkills` 派生双侧态。
 *   实测：`--agent` 在 `--json` 模式下过滤语义不可靠，不带才是全量扫目录的正解。
 *
 * 返回 Promise，支持后台并发执行（design D13）。
 */
export async function getInstalledSkills(agentOrExec?: AgentContext | ExecFn, execArg?: ExecFn): Promise<InstalledSkill[]> {
	// 区分「显式单侧」与「全量扫」：仅当首参为 AgentContext 字符串才带 --agent。
	const explicitAgent = typeof agentOrExec === 'string' ? agentOrExec : undefined;
	const exec = typeof agentOrExec === 'function' ? agentOrExec : execArg ?? execCommand;
	const args = ['--yes', 'skills', 'list', '-g'];
	if (explicitAgent) {
		args.push('--agent', skillsAgentOf(explicitAgent));
	}

	args.push('--json');

	const {code, stdout, stderr} = await exec('npx', args, {timeout: LIST_TIMEOUT_MS});
	if (code !== 0) {
		const detail = removeAnsiSequences(stderr || stdout).trim().slice(0, 300);
		throw new Error(`Skills 列表检测失败 (ExitCode: ${code})${detail ? `: ${detail}` : ''}`);
	}

	const output = stdout.trim();
	if (!output) {
		throw new Error('Skills 列表检测失败：命令未返回 JSON');
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new Error('Skills 列表检测失败：命令返回了无效 JSON');
	}

	if (!Array.isArray(parsed)) {
		throw new Error('Skills 列表检测失败：JSON 顶层不是数组');
	}

	const lockMetadata = await readGlobalSkillLockMetadata();
	const records: InstalledSkill[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) {
			continue;
		}

		const skillName = typeof item.name === 'string' ? item.name : '';
		if (!skillName) {
			continue;
		}

		const metadata = lockMetadata.get(skillName);
		records.push({
			name: skillName,
			path: typeof item.path === 'string' ? item.path : '',
			scope: typeof item.scope === 'string' ? item.scope : '',
			agents: Array.isArray(item.agents) ? item.agents.filter((agent): agent is string => typeof agent === 'string') : [],
			...(metadata?.source ? {source: metadata.source} : {}),
			...(metadata?.ref ? {ref: metadata.ref} : {}),
			...(metadata ? {skillName: metadata.skillName} : {})
		});
	}

	return records;
}

// ── 共享本体 + 注入投影（shared-resource-injection-ui Section 16.3） ─────────────

/**
 * 共享投影行：一 skill name 一行，双侧态从单次 `skills list -g --json` 的 agents 字段派生。
 * - sharedInstalled：canonical 共享本体存在（agents 含 Codex；codex=universal 直读本体）。
 * - claudeInjected：Claude Code symlink 存在（agents 含 Claude Code）。
 * - codexAvailable：恒等于 sharedInstalled（codex 直读本体，无独立开关）。
 */
export type SkillSharedRow = {
	readonly name: string;
	readonly path: string;
	readonly scope: string;
	readonly source?: string;
	readonly ref?: string;
	readonly skillName?: string;
	readonly sharedInstalled: boolean;
	readonly claudeInjected: boolean;
	readonly codexAvailable: boolean;
	readonly agents: readonly string[];
	readonly otherAgents: readonly string[];
	readonly storage?: SkillStorageInspection;
};

/**
 * 把不带 `--agent` 的 `getInstalledSkills()` 结果投影为一行一 skill 的双侧共享行。
 * codexAvailable === sharedInstalled（codex 直读本体）；非 Claude Code/Codex displayName 忽略。
 */
export function projectSharedSkills(installed: readonly InstalledSkill[]): readonly SkillSharedRow[] {
	return installed.map(skill => {
		// 官方 skills 在隔离 HOME 的真实双 Agent add 后，list --json 可能只列 Claude Code，
		// 即使 canonical 已存在且 Codex 已可直读。因此有物理检查时以路径事实为准；旧调用无 storage 时兼容 agents 投影。
		const sharedInstalled = skill.storage ? skill.storage.canonicalValid : skillInstalledOn(skill, 'cx');
		const claudeInjected = skill.storage ? skill.storage.claudeValid : skillInstalledOn(skill, 'cc');
		const otherAgents = skill.agents.filter(agent => SKILL_AGENT_DISPLAY_TO_CONTEXT[agent] === undefined);
		return {
			name: skill.name,
			path: skill.path,
			scope: skill.scope,
			...(skill.source ? {source: skill.source} : {}),
			...(skill.ref ? {ref: skill.ref} : {}),
			...(skill.skillName ? {skillName: skill.skillName} : {}),
			...(skill.storage ? {storage: skill.storage} : {}),
			sharedInstalled,
			claudeInjected,
			codexAvailable: sharedInstalled,
			agents: skill.agents,
			otherAgents
		};
	});
}

/** 为一次 CLI 列表结果追加只读文件系统事实；不新增 CLI 调用，也不修改任何 Skill。 */
export async function inspectInstalledSkillStorage(
	installed: readonly InstalledSkill[],
	options: SkillStorageOptions = {}
): Promise<InstalledSkill[]> {
	return Promise.all(installed.map(async skill => ({
		...skill,
		storage: await inspectSkillStorage(skill.name, options)
	})));
}

// ── 搜索（skills find） ─────────────────────────────────────────────────────

const COMMAND_UNAVAILABLE = /command not found|not recognized|no such file|enoent|unknown command|usage:/i;

/**
 * 解析 `skills find` 输出。优先尝试 JSON（数组或 {results:[...]}）；
 * 回退到逐行表格解析（`name  source  description` 形式）。
 * 返回 null 表示无法解析（区别于"成功但无结果"的空数组）。
 */
export function parseSkillsFindOutput(rawStdout: string, rawStderr = ''): SearchSkillResult[] | null {
	const cleaned = removeAnsiSequences(rawStdout).trim();

	if (cleaned) {
		const fromJson = tryParseJsonResults(cleaned);
		if (fromJson) {
			return fromJson;
		}
	}

	const combined = removeAnsiSequences(`${rawStdout}\n${rawStderr}`);
	if (COMMAND_UNAVAILABLE.test(combined) && !cleaned) {
		return null;
	}

	const fromTable = parseTableResults(cleaned);
	if (fromTable) {
		return fromTable;
	}

	// 有输出但无法解析为结果：返回空数组（成功无结果），完全无输出返回 null。
	return cleaned ? [] : null;
}

function tryParseJsonResults(text: string): SearchSkillResult[] | null {
	if (!text.startsWith('[') && !text.startsWith('{')) {
		return null;
	}

	try {
		const parsed = JSON.parse(text) as unknown;
		const items = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as {results?: unknown[]}).results)
				? (parsed as {results: unknown[]}).results
				: null;
		if (!items) {
			return null;
		}

		return items
			.map(normalizeSearchItem)
			.filter((item): item is SearchSkillResult => item !== null);
	} catch {
		return null;
	}
}

function normalizeSearchItem(raw: unknown): SearchSkillResult | null {
	if (!raw || typeof raw !== 'object') {
		return null;
	}

	const item = raw as Record<string, unknown>;
	const name = typeof item.name === 'string' ? item.name.trim() : '';
	if (!name) {
		return null;
	}

	const source = typeof item.source === 'string' ? item.source : typeof item.repo === 'string' ? item.repo : '';
	const description =
		typeof item.description === 'string' ? item.description : typeof item.desc === 'string' ? item.desc : '';
	const installCount = typeof item.installCount === 'number' ? item.installCount : undefined;
	const url = typeof item.url === 'string' ? item.url : undefined;

	return {name, source, description, installCount, url};
}

// skills find 实际输出为「块状多行」格式：每个 skill 占两行——
// `<owner/repo@skill> <count> installs` 紧跟 `└ https://skills.sh/...`，块间空行分隔。
// 注意：name 与 count 之间为**单空格**（非 2+ 空格/制表符），不可用 `\s{2,}` 分列，
// 否则整行无法分列、name 含空格不匹配校验被跳过，URL 续行反被误判为 name（只解析出一条）。
// 旧版表格格式 `name  source  description`（单行多列，2+ 空格分列）作为兼容分支保留。
function parseTableResults(text: string): SearchSkillResult[] | null {
	if (!text) {
		return null;
	}

	type Acc = {name: string; source: string; description: string; installCount?: number; url?: string};
	const results: Acc[] = [];

	// 真实块状格式 name 行：<name> <count> installs（name=owner/repo@skill，count 形如 9.6K/8K/1234）。
	// name 与 count 间单空格，count 与 installs 间单空格；用锚定结尾的正则精确提取，避免吞掉多空格旧格式。
	const blockLine = /^([A-Za-z0-9@][A-Za-z0-9@:_./-]{0,99})\s+([\d.]+\s*[kmbKMB]?)\s+installs\s*$/;

	for (const rawLine of text.split(/\r?\n/)) {
		// 去掉边框/续行前缀（│ | └ 及尾部空格）。
		const line = rawLine.replace(/^[│|└]\s*/, '').trim();
		if (!line || /^install with/i.test(line)) {
			continue;
		}

		// URL 续行：始终跳过（results 为空时无处回填，也绝不能当 name）。
		if (/^https?:\/\//i.test(line)) {
			if (results.length > 0) {
				const last = results[results.length - 1]!;
				if (!last.url) {
					last.url = line;
				}
			}

			continue;
		}

		// 真实块状格式：<name> <count> installs
		const blockMatch = line.match(blockLine);
		if (blockMatch) {
			const name = blockMatch[1]!;
			results.push({
				name,
				source: name.includes('@') ? (name.split('@')[0] ?? '') : '',
				description: '',
				installCount: parseInstallCount(blockMatch[2]!)
			});
			continue;
		}

		// 兼容旧表格格式：name  source  description（2+ 空格/制表符分列）。
		const columns = line.split(/\t|\s{2,}/).map(c => c.trim()).filter(Boolean);
		if (columns.length < 2) {
			continue;
		}

		const name = columns[0]!;
		if (!/^[A-Za-z0-9@][A-Za-z0-9@:_./-]{0,99}$/.test(name)) {
			continue;
		}

		const second = columns[1] ?? '';
		if (/installs/i.test(second)) {
			// 旧格式变种：name  <count> installs
			results.push({
				name,
				source: name.includes('@') ? (name.split('@')[0] ?? '') : '',
				description: '',
				installCount: parseInstallCount(second)
			});
		} else {
			// 旧表格格式：name  source  description
			results.push({
				name,
				source: second,
				description: columns.slice(2).join(' ')
			});
		}
	}

	return results.length > 0 ? results : null;
}

/** 解析 "491.5K installs" 形态的安装数；无法解析返回 undefined。 */
function parseInstallCount(text: string): number | undefined {
	const match = text.match(/([\d.]+)\s*([kmb]?)/i);
	if (!match) {
		return undefined;
	}

	const value = Number.parseFloat(match[1]!);
	if (Number.isNaN(value)) {
		return undefined;
	}

	const unit = match[2]!.toLowerCase();
	const multiplier = unit === 'k' ? 1e3 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1;
	return Math.round(value * multiplier);
}

/**
 * 搜索 Skills（`npx --yes skills find <query>`）。空查询不触发 CLI（design D11）。
 * 命令不可用 / 输出不可解析时返回 ok:false，不回退 catalogue。
 */
export async function searchSkills(query: string, exec: ExecFn = execCommand): Promise<SkillsSearchOutcome> {
	const trimmed = (query || '').trim();
	if (!trimmed) {
		return {ok: false, error: '请输入搜索关键词'};
	}

	try {
		const {code, stdout, stderr} = await exec('npx', ['--yes', 'skills', 'find', trimmed], {
			timeout: SEARCH_TIMEOUT_MS
		});

		const results = parseSkillsFindOutput(stdout, stderr);
		if (results === null) {
			return {
				ok: false,
				error: code === 0 ? 'skills find 输出无法解析' : 'skills find 命令不可用或执行失败',
				rawSummary: removeAnsiSequences(stderr || stdout).slice(0, 500)
			};
		}

		return {ok: true, results};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

// ── 按 repo 分组（父级列表）+ skills add <repo> --list（子级全量） ──────────
// 需求③两级选择：find 结果按 owner/repo 去重为「父 repo 列表」；
// 选中父 repo 后用 `skills add <repo> --list` 拉取该 repo 全部子 skill（对齐 npx skills add 交互）。

export type RepoGroup = {
	readonly repo: string; // owner/repo
	readonly hitCount: number; // 该 repo 命中搜索词的 skill 数
	readonly totalInstalls?: number; // 命中 skill 安装数求和（可选，用于父级热度展示）
};

export type RepoSkill = {
	readonly name: string;
	readonly description?: string;
};

export type RepoSkillsOutcome =
	| {readonly ok: true; readonly skills: readonly RepoSkill[]}
	| {readonly ok: false; readonly error: string; readonly rawSummary?: string};

const LIST_REPO_TIMEOUT_MS = 120000;

/** 从 `owner/repo@skill` 形态的 name 取 repo（@ 前）；无 @ 返回空串。 */
function repoOfName(name: string): string {
	const at = name.indexOf('@');
	return at < 0 ? '' : name.slice(0, at);
}

function mergeInstalls(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined && b === undefined) {
		return undefined;
	}

	return (a ?? 0) + (b ?? 0);
}

/**
 * 把 skills find 结果按 owner/repo 去重，得到父级 repo 列表。
 * repo 取 source（find 解析时已拆出），fallback 从 name 的 @ 前缀解析；两者皆空则跳过。
 */
export function groupByRepo(results: readonly SearchSkillResult[]): readonly RepoGroup[] {
	const map = new Map<string, RepoGroup>();
	for (const r of results) {
		const repo = r.source || repoOfName(r.name);
		if (!repo) {
			continue;
		}

		const existing = map.get(repo);
		if (existing) {
			map.set(repo, {
				repo,
				hitCount: existing.hitCount + 1,
				totalInstalls: mergeInstalls(existing.totalInstalls, r.installCount)
			});
		} else {
			map.set(repo, {repo, hitCount: 1, totalInstalls: r.installCount});
		}
	}

	return [...map.values()];
}

/**
 * 解析 `skills add <repo> --list` 输出（Available Skills 块状格式）。
 * 实测格式：每块 `│    <name>`（单个连字符 token，无空格）+ `│` + `│      <desc>`（含空格自然语言），块间 `│` 分隔。
 * 解析规则：去掉行首边框/空白后，单个 token（`^[A-Za-z0-9][A-Za-z0-9._-]*$`）= skill name；
 * 含空格文本 = 追加到当前 skill 的 description。
 * 返回 null 表示无法解析（命令不可用 / repo 不存在），区别于空数组（成功无 skill）。
 */
export function parseSkillsListOutput(rawStdout: string, rawStderr = ''): RepoSkill[] | null {
	const cleaned = removeAnsiSequences(rawStdout).trim();
	const combined = removeAnsiSequences(`${rawStdout}\n${rawStderr}`);

	const startIdx = cleaned.indexOf('Available Skills');
	if (startIdx < 0) {
		// 无 Available Skills 标题：命令不可用 / repo 不存在 / 仓库无 skill
		if (COMMAND_UNAVAILABLE.test(combined) || /not found|404|no such|empty|no skills/i.test(combined)) {
			return null;
		}

		return cleaned ? [] : null;
	}

	const tailMarker = cleaned.indexOf('Use --skill', startIdx);
	const region = tailMarker > startIdx ? cleaned.slice(startIdx, tailMarker) : cleaned.slice(startIdx);

	const skills: RepoSkill[] = [];
	let current: {name: string; description: string} | null = null;

	for (const rawLine of region.split(/\r?\n/)) {
		// 去掉行首边框符号（│ │ └ ● ◇ ○ ◓ ◒ ◑ ◐ 等装饰）与空白
		const line = rawLine.replace(/^[│|└●◇○◓◒◑◐\s]+/, '').trim();
		if (!line || line === 'Available Skills') {
			continue;
		}

		// 单个 token = skill name（skill 名无空格，含字母/数字/._-）
		if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(line)) {
			if (current) {
				skills.push(current);
			}

			current = {name: line, description: ''};
			continue;
		}

		// 含空格文本 = description（追加到当前 skill，多行拼接）
		if (current) {
			current.description = current.description ? `${current.description} ${line}` : line;
		}
	}

	if (current) {
		skills.push(current);
	}

	return skills;
}

/**
 * 列出某 repo 下全部 skill（`npx --yes skills add <owner/repo> --list`）。
 * 需求③：选中父 repo 后调用，拉取该 repo 全部子 skill（--list 只列不装）。
 * 输出无法解析 / 命令不可用时返回 ok:false。
 */
export async function listRepoSkills(repo: string, agentOrExec?: AgentContext | ExecFn, execArg?: ExecFn): Promise<RepoSkillsOutcome> {
	const trimmed = (repo || '').trim();
	if (!trimmed) {
		return {ok: false, error: '无效的 repo'};
	}

	const {agentContext, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	try {
		const {code, stdout, stderr} = await exec('npx', ['--yes', 'skills', 'add', trimmed, '--list', '--agent', skillsAgentOf(agentContext)], {
			timeout: LIST_REPO_TIMEOUT_MS
		});

		const skills = parseSkillsListOutput(stdout, stderr);
		if (skills === null) {
			return {
				ok: false,
				error: code === 0 ? 'skills add --list 输出无法解析' : 'skills add --list 命令不可用或执行失败',
				rawSummary: removeAnsiSequences(stderr || stdout).slice(0, 500)
			};
		}

		return {ok: true, skills};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
