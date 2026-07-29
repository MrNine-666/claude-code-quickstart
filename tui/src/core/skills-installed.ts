import {lstat, realpath} from 'node:fs/promises';
import {isAbsolute, join, normalize, resolve, sep} from 'node:path';
import {execCommand, removeAnsiSequences, type ExecResult} from './exec.js';
import type {AgentContext} from '../state/manage-state.js';
import type {SkillTopology} from './skills-storage.js';

// 已安装 Skills 领域边界（task 07-28-skills-multi-source-topology design Section 3-6）。
// 唯一事实源是一次成功的 `npx skills list -g --json`：本模块只解释 CLI 已返回的数据，
// 不枚举 .claude/.agents/.codex 目录、不读取 .skill-lock.json、不比较 Skill 内容。
// path 只用于识别存储根以及执行经用户确认的迁移/删除，不参与来源身份或 Agent 可用侧。

export type ExecFn = (command: string, args: readonly string[], options?: {timeout?: number}) => Promise<ExecResult>;

const LIST_TIMEOUT_MS = 120000;

/** 受支持的存储根。`other` 表示 CLI 报告了受管拓扑之外的位置。 */
export type SkillsStorageRoot = 'claude' | 'agents' | 'codex' | 'other';

/** `skills list -g --json` 的单条记录，严格解析后的协议投影。 */
export type SkillsCliListRecord = {
	readonly name: string;
	readonly path: string;
	readonly scope: string;
	readonly agents: readonly string[];
	readonly source?: string;
	readonly sourceUrl?: string;
};

/**
 * 来源身份。`source` 与 `sourceUrl` 始终分开保留用于展示；
 * `identity` 是归一化后的逻辑分组键，`installSource` 是可直接重新 add 的操作来源。
 */
export type SkillProvenance =
	| {
			readonly kind: 'known';
			readonly identity: string;
			readonly source?: string;
			readonly sourceUrl?: string;
			readonly installSource: string;
	  }
	| {readonly kind: 'unknown'};

/** 一条 CLI 记录对应的物理投影。root 仅由 path 分类，不影响身份。 */
export type SkillProjection = {
	readonly path: string;
	readonly root: SkillsStorageRoot;
	readonly scope: string;
	readonly agents: readonly string[];
	/** 该 projection 对应的原始 CLI 来源字段，仅供诊断；逻辑身份仍由 Item provenance 决定。 */
	readonly source?: string;
	readonly sourceUrl?: string;
};

/** 能力矩阵：只由 provenance 派生，不受存储目录或平台影响（design Section 6）。 */
export type SkillInstanceCapabilities = {
	readonly update: boolean;
	readonly manageAgents: boolean;
	readonly migrate: boolean;
	readonly delete: true;
};

/** 逻辑实例：列表、reducer、Modal 快照与写操作共用的唯一身份。 */
export type InstalledSkillItem = {
	readonly id: string;
	readonly name: string;
	readonly provenance: SkillProvenance;
	readonly agents: readonly string[];
	readonly projections: readonly SkillProjection[];
	readonly capabilities: SkillInstanceCapabilities;
};

export type SkillsListParseResult =
	| {readonly ok: true; readonly records: readonly SkillsCliListRecord[]}
	| {readonly ok: false; readonly error: string};

// ── 来源归一化（design Section 4.2） ─────────────────────────────────────────

function githubRepoSlug(candidateSource: string): string | undefined {
	let candidate = candidateSource.trim();
	if (!candidate) {
		return undefined;
	}

	// `github:owner/repo` 与 `git@github.com:owner/repo` 都能被 new URL() 当作合法
	// scheme 解析（hostname 为空），必须在 URL 分支之前剥掉，否则永远归一失败。
	const shorthandMatch = candidate.match(/^github:(?:\/\/)?(.+)$/i);
	const sshMatch = candidate.match(/^(?:ssh:\/\/)?git@github\.com[:/](.+)$/i);
	if (shorthandMatch?.[1]) {
		candidate = shorthandMatch[1];
	} else if (sshMatch?.[1]) {
		candidate = sshMatch[1];
	} else {
		try {
			const url = new URL(candidate);
			if (url.hostname.toLowerCase() !== 'github.com') {
				return undefined;
			}

			candidate = url.pathname;
		} catch {
			candidate = candidate.replace(/^github\.com\//i, '');
		}
	}

	const parts = candidate.replace(/^\/+|\/+$/g, '').split('/');
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return undefined;
	}

	const repo = parts[1].replace(/\.git$/i, '');
	return repo ? `${parts[0].toLowerCase()}/${repo.toLowerCase()}` : undefined;
}

/**
 * 归一化来源身份。GitHub HTTPS / SSH / `github:` / `owner/repo` 简写归一为
 * `github:<owner/repo>`；其它来源保留 trim 后原值并加类型前缀。
 * 空白输入返回 undefined（调用方据此判定未知来源）。
 */
export function normalizeSkillSourceIdentity(rawSource: string | undefined): string | undefined {
	const trimmed = (rawSource ?? '').trim();
	if (!trimmed) {
		return undefined;
	}

	const slug = githubRepoSlug(trimmed);
	return slug ? `github:${slug}` : `raw:${trimmed}`;
}

/** GitHub repo URL、SSH source 与 `owner/repo` 简写视为同一来源。归一化身份的唯一比较入口。 */
export function skillSourcesEquivalent(left: string, right: string): boolean {
	const leftIdentity = normalizeSkillSourceIdentity(left);
	const rightIdentity = normalizeSkillSourceIdentity(right);
	return Boolean(leftIdentity && rightIdentity && leftIdentity === rightIdentity);
}

// ── 存储根分类（design Section 3；只看 path，不触碰文件系统） ────────────────

const STORAGE_ROOT_SEGMENTS: readonly (readonly [SkillsStorageRoot, readonly string[]])[] = [
	['claude', ['.claude', 'skills']],
	['agents', ['.agents', 'skills']],
	['codex', ['.codex', 'skills']]
];

/**
 * 按 JSON `path` 归类存储根。纯字符串判定，不做 stat/realpath，
 * 因此不会因权限或链接状态改变列表事实。
 */
export function classifySkillsStorageRoot(rawPath: string): SkillsStorageRoot {
	const normalized = (rawPath || '').trim().replace(/\\/g, '/');
	if (!normalized) {
		return 'other';
	}

	const segments = normalized.split('/').filter(Boolean);
	for (const [root, marker] of STORAGE_ROOT_SEGMENTS) {
		for (let index = 0; index + marker.length <= segments.length; index += 1) {
			if (marker.every((part, offset) => segments[index + offset] === part)) {
				return root;
			}
		}
	}

	return 'other';
}

/** 规范化 path 用于精确去重与 unknown 分组；不解析链接，只做词法归一。 */
function normalizePathKey(rawPath: string): string {
	const trimmed = (rawPath || '').trim();
	if (!trimmed) {
		return '';
	}

	const lexical = normalize(trimmed).replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? lexical.toLowerCase() : lexical;
}

// ── 严格解析（design Section 4.1） ──────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown): {readonly ok: true; readonly value?: string} | {readonly ok: false} {
	if (value === undefined || value === null) {
		return {ok: true};
	}

	if (typeof value !== 'string') {
		return {ok: false};
	}

	const trimmed = value.trim();
	return trimmed ? {ok: true, value: trimmed} : {ok: true};
}

/**
 * 从 `unknown` 严格解析 list JSON。任一记录不满足 schema 时整体失败并带上记录索引，
 * 绝不静默跳过坏记录（R1）。
 */
export function parseSkillsListJson(parsed: unknown): SkillsListParseResult {
	if (!Array.isArray(parsed)) {
		return {ok: false, error: 'Skills 列表检测失败：JSON 顶层不是数组'};
	}

	const records: SkillsCliListRecord[] = [];
	for (const [index, item] of parsed.entries()) {
		if (!isRecord(item)) {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录不是对象`};
		}

		if (typeof item.name !== 'string' || !item.name.trim()) {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录的 name 无效`};
		}

		if (typeof item.path !== 'string') {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录的 path 无效`};
		}

		if (typeof item.scope !== 'string') {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录的 scope 无效`};
		}

		if (!Array.isArray(item.agents) || item.agents.some(agent => typeof agent !== 'string')) {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录的 agents 无效`};
		}

		const source = optionalString(item.source);
		if (!source.ok) {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录的 source 无效`};
		}

		const sourceUrl = optionalString(item.sourceUrl);
		if (!sourceUrl.ok) {
			return {ok: false, error: `Skills 列表检测失败：第 ${index} 条记录的 sourceUrl 无效`};
		}

		records.push({
			name: item.name.trim(),
			path: item.path,
			scope: item.scope,
			agents: item.agents as readonly string[],
			...(source.value ? {source: source.value} : {}),
			...(sourceUrl.value ? {sourceUrl: sourceUrl.value} : {})
		});
	}

	return {ok: true, records};
}

// ── 逻辑实例分组（design Section 5） ────────────────────────────────────────

function provenanceOf(record: SkillsCliListRecord): SkillProvenance {
	// sourceUrl 优先作为操作来源；两个字段都缺失才是未知来源。
	const installSource = record.sourceUrl ?? record.source;
	const identity = normalizeSkillSourceIdentity(installSource);
	if (!identity || !installSource) {
		return {kind: 'unknown'};
	}

	return {
		kind: 'known',
		identity,
		...(record.source ? {source: record.source} : {}),
		...(record.sourceUrl ? {sourceUrl: record.sourceUrl} : {}),
		installSource
	};
}

function capabilitiesOf(provenance: SkillProvenance): SkillInstanceCapabilities {
	const known = provenance.kind === 'known';
	return {update: known, manageAgents: known, migrate: known, delete: true};
}

/**
 * 逻辑实例身份。known 用 `(name, normalizedSourceIdentity)`；unknown 没有可证明的
 * 跨路径合并键，必须带上精确路径隔离（R2）。reducer 快照与 React key 复用此函数，
 * 调用方不自行拼装 key 结构。
 *
 * 接受已分组的 Item（reducer / view 侧）或原始记录加 provenance（分组内部）。
 * unknown 的路径取第一条投影：分组键保证同一 unknown Item 只有一条精确路径。
 */
export function installedSkillItemId(item: InstalledSkillItem): string;
export function installedSkillItemId(record: SkillsCliListRecord, provenance: SkillProvenance): string;
export function installedSkillItemId(source: InstalledSkillItem | SkillsCliListRecord, provenanceArg?: SkillProvenance): string {
	const provenance = provenanceArg ?? (source as InstalledSkillItem).provenance;
	if (provenance.kind === 'known') {
		return JSON.stringify(['known', source.name, provenance.identity]);
	}

	const path = provenanceArg ? (source as SkillsCliListRecord).path : ((source as InstalledSkillItem).projections[0]?.path ?? '');
	return JSON.stringify(['unknown', source.name, normalizePathKey(path)]);
}

function dedupeStable(values: readonly string[]): readonly string[] {
	const seen = new Set<string>();
	const output: string[] = [];
	for (const value of values) {
		if (!seen.has(value)) {
			seen.add(value);
			output.push(value);
		}
	}

	return output;
}

/**
 * 把 CLI 记录分组为逻辑实例。同名同来源合并（不比较内容），
 * 同名不同来源拆成相邻 Item，unknown 按精确路径隔离。
 */
export function groupInstalledSkillItems(records: readonly SkillsCliListRecord[]): readonly InstalledSkillItem[] {
	type Draft = {
		readonly key: string;
		readonly name: string;
		readonly provenance: SkillProvenance;
		readonly agents: string[];
		readonly projections: SkillProjection[];
		readonly pathKeys: Set<string>;
		readonly order: number;
	};

	const drafts = new Map<string, Draft>();
	for (const [order, record] of records.entries()) {
		const provenance = provenanceOf(record);
		const key = installedSkillItemId(record, provenance);
		const pathKey = normalizePathKey(record.path);
		const existing = drafts.get(key);
		const draft = existing ?? {
			key,
			name: record.name,
			provenance,
			agents: [],
			projections: [],
			pathKeys: new Set<string>(),
			order
		};

		// 精确重复路径视为同一条物理记录，去重但仍并入 agents。
		if (!draft.pathKeys.has(pathKey)) {
			draft.pathKeys.add(pathKey);
			draft.projections.push({
				path: record.path,
				root: classifySkillsStorageRoot(record.path),
				scope: record.scope,
				agents: record.agents,
				...(record.source ? {source: record.source} : {}),
				...(record.sourceUrl ? {sourceUrl: record.sourceUrl} : {})
			});
		}

		draft.agents.push(...record.agents);
		if (!existing) {
			drafts.set(key, draft);
		}
	}

	return [...drafts.values()]
		.sort((left, right) => left.name.localeCompare(right.name) || left.key.localeCompare(right.key))
		.map(draft => ({
			id: draft.key,
			name: draft.name,
			provenance: draft.provenance,
			agents: dedupeStable(draft.agents),
			projections: draft.projections,
			capabilities: capabilitiesOf(draft.provenance)
		}));
}

/**
 * `(root, name)` 所有权索引。CLI 若让不同 Item 声明同一物理目标，
 * 该目标标记为歧义，任何覆盖/迁移/定向删除必须在预检阶段拒绝（design Section 5.3）。
 */
export type SkillsOwnershipIndex = ReadonlyMap<string, {readonly itemId: string; readonly ambiguous: boolean}>;

export function ownershipKey(root: SkillsStorageRoot, name: string): string {
	return JSON.stringify([root, name]);
}

export function buildSkillsOwnershipIndex(items: readonly InstalledSkillItem[]): SkillsOwnershipIndex {
	const index = new Map<string, {itemId: string; ambiguous: boolean}>();
	for (const item of items) {
		for (const projection of item.projections) {
			const key = ownershipKey(projection.root, item.name);
			const existing = index.get(key);
			if (!existing) {
				index.set(key, {itemId: item.id, ambiguous: false});
			} else if (existing.itemId !== item.id) {
				existing.ambiguous = true;
			}
		}
	}

	return index;
}

/**
 * 为定向删除补齐 CLI `agents` 能无歧义证明的标准投影路径。
 * Claude Code 只对应 `.claude`；Codex 的物理根必须由当前 JSON path 已明确为
 * `.agents` 或 `.codex` 后才能推导，绝不只凭 badge 猜测二者之一。
 */
export function skillDeletionCandidatePaths(item: InstalledSkillItem, homeDir: string): readonly string[] {
	const roots = storageRootsOf(item);
	const candidates = item.projections.map(projection => projection.path);
	if (itemAvailableOn(item, 'cc')) {
		candidates.push(join(homeDir, '.claude', 'skills', item.name));
	}
	if (itemAvailableOn(item, 'cx')) {
		if (roots.includes('agents')) candidates.push(join(homeDir, '.agents', 'skills', item.name));
		if (roots.includes('codex')) candidates.push(join(homeDir, '.codex', 'skills', item.name));
	}

	const seen = new Set<string>();
	return candidates.filter(candidate => {
		const key = normalizePathKey(candidate);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * 删除预检使用的所有权索引必须包含可证明的标准 Agent 投影；否则一个 Item 的
 * `.claude` badge 与另一来源声明的 `.claude` path 不会形成歧义，可能误删后者。
 */
export function buildSkillsDeletionOwnershipIndex(items: readonly InstalledSkillItem[], homeDir: string): SkillsOwnershipIndex {
	const expanded = items.map(item => ({
		...item,
		projections: skillDeletionCandidatePaths(item, homeDir).map(path => ({
			path,
			root: classifySkillsStorageRoot(path),
			scope: 'global',
			agents: item.agents
		}))
	}));
	return buildSkillsOwnershipIndex(expanded);
}

// ── Agent 投影（只由 agents 派生，R1/R2） ───────────────────────────────────

export const SKILL_AGENT_DISPLAY_TO_CONTEXT: Readonly<Record<string, AgentContext>> = {
	'Claude Code': 'cc',
	Codex: 'cx'
};

/** 某逻辑实例是否在给定 Agent 上可用。只读 `agents`，不看 path、不查磁盘。 */
export function itemAvailableOn(item: InstalledSkillItem, agentContext: AgentContext): boolean {
	return item.agents.some(display => SKILL_AGENT_DISPLAY_TO_CONTEXT[display] === agentContext);
}

/** 非 Claude Code / Codex 的其它 universal agent displayName。 */
export function otherAgentsOf(item: InstalledSkillItem): readonly string[] {
	return item.agents.filter(agent => SKILL_AGENT_DISPLAY_TO_CONTEXT[agent] === undefined);
}

/** 该实例占用的存储根集合，按 projections 去重后保持 CLI 顺序。 */
export function storageRootsOf(item: InstalledSkillItem): readonly SkillsStorageRoot[] {
	return dedupeStable(item.projections.map(projection => projection.root)) as readonly SkillsStorageRoot[];
}

/**
 * Item 当前可用侧映射到 C/X/B 拓扑；两侧都无时返回 undefined（design §8.4）。
 * 只读 `agents`，不看 path 或磁盘——拓扑身份由 CLI 报告的可用侧决定，
 * 迁移事务据此规划目标，不由 physical inspection 推导。
 */
export function currentTopologyOfItem(item: InstalledSkillItem): SkillTopology | undefined {
	const cc = itemAvailableOn(item, 'cc');
	const cx = itemAvailableOn(item, 'cx');
	if (cc && cx) return 'shared';
	if (cc) return 'claude-only';
	if (cx) return 'codex-only';
	return undefined;
}

/**
 * `.codex` 实例即使目标侧与当前一致也必须迁移到受管拓扑，不是 no-op（design §8.4 / R6）。
 * `.codex` 不是受管 canonical（`.agents` 才是），故任一受管目标都需要把本体收编。
 * 仅依据 JSON path 分类，不扫描用户目录。
 */
export function needsManagedMigration(item: InstalledSkillItem, target: SkillTopology): boolean {
	if (!storageRootsOf(item).includes('codex')) return false;
	return target === 'claude-only' || target === 'codex-only' || target === 'shared';
}

// ── 检测入口（design Section 4.1 / 9） ─────────────────────────────────────

/**
 * 一次完整的已安装检测：执行一次不带 `--agent` 的 `skills list -g --json`，
 * 严格解析后分组为逻辑实例。失败一律抛错，不回退文件系统扫描。
 */
export async function detectInstalledSkillItems(exec: ExecFn = execCommand): Promise<readonly InstalledSkillItem[]> {
	const {code, stdout, stderr} = await exec('npx', ['--yes', 'skills', 'list', '-g', '--json'], {
		timeout: LIST_TIMEOUT_MS
	});

	if (code !== 0) {
		const detail = removeAnsiSequences(stderr || stdout)
			.trim()
			.slice(0, 300);
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

	const result = parseSkillsListJson(parsed);
	if (!result.ok) {
		throw new Error(result.error);
	}

	return groupInstalledSkillItems(result.records);
}

// ── 定向删除路径安全验证（design Section 8.3） ──────────────────────────────

const SAFE_SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isSafeSkillName(name: string): boolean {
	return SAFE_SKILL_NAME.test(name) && name !== '.' && name !== '..';
}

export type SkillPathVerdict =
	| {readonly ok: true; readonly root: SkillsStorageRoot; readonly path: string}
	| {readonly ok: false; readonly reason: string};

/**
 * 校验一个候选删除路径是否可证明安全：必须是受支持根下的直接 `<name>`，
 * basename 与 Item 名称一致，无穿越，且不是根或父目录。纯词法校验，
 * 文件系统层面的 lstat / 链接判定由 storage 层在执行前补充。
 */
export function verifySkillDeletionPath(candidatePath: string, name: string, supportedRoots: readonly string[]): SkillPathVerdict {
	if (!isSafeSkillName(name)) {
		return {ok: false, reason: `Skill 名称不安全：${name}`};
	}

	const trimmed = (candidatePath || '').trim();
	if (!trimmed || !isAbsolute(trimmed)) {
		return {ok: false, reason: 'Skill 路径必须是绝对路径'};
	}

	const target = resolve(trimmed);
	for (const rawRoot of supportedRoots) {
		const root = resolve(rawRoot);
		if (target === root) {
			return {ok: false, reason: '拒绝删除 Skills 根目录'};
		}

		// 只接受根下的直接 <name>：join 后必须与目标完全一致。
		if (join(root, name) === target) {
			return {ok: true, root: classifySkillsStorageRoot(target), path: target};
		}
	}

	return {ok: false, reason: `路径不在受支持的 Skills 根下：${target}`};
}

// ── 删除目标文件系统层验证（design Section 8.3） ──────────────────────────────

export type SkillDeletionTargetKind = 'directory' | 'symlink';

/** 已通过安全验证的删除目标。symlink 只允许 unlink 链接本身，directory 才允许递归删该精确目录。 */
export type SkillDeletionTarget = {
	readonly path: string;
	readonly root: SkillsStorageRoot;
	readonly kind: SkillDeletionTargetKind;
	/** symlink 解析后的目标绝对路径（仅 kind === 'symlink'），供 planner 判定是否需要后续 canonical 处理。 */
	readonly symlinkTarget?: string;
};

export type SkillDeletionVerdict =
	| {readonly ok: true; readonly target: SkillDeletionTarget}
	| {readonly ok: false; readonly reason: string};

/**
 * 删除目标的文件系统层安全验证。先复用词法 `verifySkillDeletionPath`（名称/basename/穿越/根），
 * 再用 lstat 区分实体目录与符号链接：
 * - 实体目录：放行 `directory`，调用方只对该精确目录递归删除；
 * - 符号链接：`realpath` 解析目标，必须仍是受支持根下的同名投影，否则视为逃逸拒绝跟随；
 *   放行 `symlink`，调用方只 `unlink` 链接本身，永不递归进入目标。
 * 所有权索引标记歧义（同一 `(root, name)` 被多个 Item 声明）时整体拒绝，避免误删同名异源。
 *
 * Windows junction/reparse point 的 lstat 语义属已知平台边界：Node 把能识别的 reparse point
 * 报告为 symbolic link。运行时以官方 CLI smoke 为准，不在此猜测未识别 reparse 类型。
 */
export async function verifySkillDeletionTarget(
	candidatePath: string,
	name: string,
	supportedRoots: readonly string[],
	ownershipIndex?: SkillsOwnershipIndex,
	expectedItemId?: string
): Promise<SkillDeletionVerdict> {
	const lexical = verifySkillDeletionPath(candidatePath, name, supportedRoots);
	if (!lexical.ok) {
		return {ok: false, reason: lexical.reason};
	}

	if (ownershipIndex) {
		const owned = ownershipIndex.get(ownershipKey(lexical.root, name));
		if (owned?.ambiguous) {
			return {ok: false, reason: `${name} 在 ${lexical.root} 根被多个来源声明，无法证明定向删除安全`};
		}
		if (expectedItemId && owned && owned.itemId !== expectedItemId) {
			return {ok: false, reason: `${name} 在 ${lexical.root} 根属于其它来源，拒绝定向删除`};
		}
	}

	let fact: Awaited<ReturnType<typeof lstat>>;
	try {
		fact = await lstat(lexical.path);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') {
			return {ok: false, reason: `${lexical.path} 不存在，可能已被删除`};
		}

		const detail = error instanceof Error ? error.message : String(error);
		return {ok: false, reason: `无法检查删除目标：${detail}`};
	}

	if (fact.isSymbolicLink()) {
		let target: string;
		try {
			target = await realpath(lexical.path);
		} catch {
			return {ok: false, reason: `${lexical.path} 符号链接已断开，拒绝删除`};
		}

		// realpath 会展开短名与符号链（Windows 8.3、macOS /tmp→/private/tmp、挂载点），
		// supportedRoots 若仍用词法 resolve 会与 target 物理路径不一致，把合法 canonical 投影
		// 误判为逃逸。等价 realpath 规范化两端后再比较；root 尚不存在时回退 resolve（词法），
		// 既兼容尚未物化的目标根，又不放松「目标必须是受支持根下同名投影」的安全约束。
		const normalizedRoots = await Promise.all(
			supportedRoots.map(async rawRoot => {
				try {
					return await realpath(rawRoot);
				} catch {
					return resolve(rawRoot);
				}
			})
		);
		const targetLexical = verifySkillDeletionPath(target, name, normalizedRoots);
		if (!targetLexical.ok || targetLexical.root === 'other') {
			return {ok: false, reason: `${lexical.path} 的链接目标不在受支持 Skills 根下，拒绝跟随删除`};
		}
		if (ownershipIndex && expectedItemId) {
			const targetOwner = ownershipIndex.get(ownershipKey(targetLexical.root, name));
			if (targetOwner?.ambiguous || (targetOwner && targetOwner.itemId !== expectedItemId)) {
				return {ok: false, reason: `${lexical.path} 的链接目标属于其它来源，拒绝定向删除`};
			}
		}

		return {ok: true, target: {path: lexical.path, root: lexical.root, kind: 'symlink', symlinkTarget: target}};
	}

	if (!fact.isDirectory()) {
		return {ok: false, reason: `${lexical.path} 不是目录，拒绝删除`};
	}

	return {ok: true, target: {path: lexical.path, root: lexical.root, kind: 'directory'}};
}

/** 受管与兼容存储根的绝对路径，供删除/迁移预检使用。 */
export function supportedSkillsRoots(homeDir: string): readonly string[] {
	return [join(homeDir, '.claude', 'skills'), join(homeDir, '.agents', 'skills'), join(homeDir, '.codex', 'skills')];
}

/**
 * 官方 `skills remove <name>` 是否能在当前列表中证明只命中当前逻辑实例（design §8.3）。
 * 官方 remove 是名称级选择器：只要存在同名异源（不同 id）Item，就无法证明隔离，
 * 必须改用当前 Item 投影的定向删除。
 */
export function officialRemovalIsolated(item: InstalledSkillItem, allItems: readonly InstalledSkillItem[]): boolean {
	return !allItems.some(other => other.name === item.name && other.id !== item.id);
}

export {sep as pathSeparator};
