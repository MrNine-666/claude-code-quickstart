import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, realpathSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

import {collectPortableTreeEntries, excludedTransferAuthFile, excludedTransferAuthSymlink} from './config-transfer-sections.js';
import {
	createPortableTreeValidationState,
	type PortableTreeEntry,
	parsePortableTreeEntries,
	type TransferResult,
	transferFail,
	transferOk
} from './config-transfer.js';
import {resolveHome} from './paths.js';
import {
	classifySkillLockEntry,
	findSkillLockKeys,
	readSkillLock,
	resolveSkillLockPath,
	type SkillLockEntry,
	type SkillLockPatch,
	type SkillLockSnapshot
} from './skills-lock-metadata.js';
import {
	cleanupSkillSnapshot,
	createSkillSnapshot,
	isSafeSkillName,
	type SkillAgentTargets,
	type SkillStorageOptions,
	validateSkillMetadataText
} from './skills-storage.js';

// Skills 导入导出 seam：离线采集单个 Skills 根的实际内容。
//
// `ccq:skills` 对应 `~/.agents/skills`（Codex / Pi 共用 canonical），`cc:skills` 对应 `~/.claude/skills`；
// 两个分类各自独立快照，互不删除对方一侧。内容源先经 createSkillSnapshot 验证（SKILL.md frontmatter、
// 内部链接不逃逸、清单一致），根 projection symlink 先 realpath 解析到实体目录再快照。
// 包内路径统一为 root `agents` + `<name>/<相对路径>`，物化落点由 section `root` 决定，
// 导入由 services/config-transfer-skills-service.ts 离线直接恢复内容与拓扑，并按名称补丁官方 lock（不调用 skills add）。
// schema 2 起每个条目显式携带 tracking：官方 global lock v3 匹配条目原样导出，或 null（只恢复内容）。
// shortcut: shared Skill 两个分类都选时内容在包内存两份；包体积成为问题时再做跨分类去重。

export const SKILLS_ROOTS = ['agents', 'claude'] as const;
export type SkillsRoot = (typeof SKILLS_ROOTS)[number];

export const SKILLS_SECTION_SCHEMA = 2;

/** 官方 global lock v3 条目原样（含未知 v3 字段），已通过 classifySkillLockEntry 安全校验。 */
export type SkillTracking = {readonly kind: 'global-lock-v3'; readonly entry: SkillLockEntry};

export type ExportedSkill = {
	readonly id: string;
	readonly name: string;
	readonly files: readonly PortableTreeEntry[];
	/** null = 无可迁移来源，只恢复内容。 */
	readonly tracking: SkillTracking | null;
};

export type SkillsSection = {
	/** 缺省 = 旧 v1 当前 root 格式（legacy content-only）：不含来源，也不得继承目标机同名来源。 */
	readonly schema?: typeof SKILLS_SECTION_SCHEMA;
	readonly root: SkillsRoot;
	readonly skills: readonly ExportedSkill[];
};

export type SkillImportState = 'add' | 'replace' | 'unchanged' | 'blocked';

export type SkillImportPlanItem = {
	readonly id: string;
	readonly name: string;
	readonly state: SkillImportState;
	/** 需要重写内容时的物化目标拓扑；内容一致、只有来源变化时省略。 */
	readonly targets?: SkillAgentTargets;
	/** 官方 lock 按名称补丁；省略 = 来源记录已一致。 */
	readonly lock?: SkillLockPatch;
	readonly reason?: string;
};

export type SkillsImportPlan = {
	readonly items: readonly SkillImportPlanItem[];
	/** 规划时读取的 lock 原文/缺失事实；写入前据此复核外部修改。不进入 UI 计划。 */
	readonly lock: SkillLockSnapshot;
	readonly warnings: readonly string[];
};

export type SkillsImportPlanOptions = SkillStorageOptions & {
	/** 官方 lock 路径；transfer 编排解析一次后在 preview/snapshot/apply/postflight 复用。 */
	readonly lockPath?: string;
	/** 同批将执行的另一个 Skills 分类原始数据；同名来源提案不一致时阻断。 */
	readonly peer?: unknown;
};

export type SkillsSnapshotOptions = SkillStorageOptions & {
	readonly root: SkillsRoot;
	/** 官方 lock 路径；省略时按 home/XDG_STATE_HOME 解析一次。 */
	readonly lockPath?: string;
};

const ROOT_LABELS: Readonly<Record<SkillsRoot, string>> = {agents: 'Codex / Pi', claude: 'Claude Code'};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skillsRootDir(homeDir: string, root: SkillsRoot): string {
	return root === 'agents' ? join(homeDir, '.agents', 'skills') : join(homeDir, '.claude', 'skills');
}

function manifestDigest(manifest: readonly string[]): string {
	return createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 8);
}

/** 与 contentManifest 一致的文件/链接条目（去掉 `<name>/` 前缀，目录条目不参与跨端内容比较）。 */
function bundleManifestEntries(name: string, files: readonly PortableTreeEntry[]): readonly string[] {
	const prefix = `${name}/`;
	const entries = files.map(entry => {
		const path = entry.path.slice(prefix.length);
		return entry.kind === 'file'
			? `f:${path}:${createHash('sha256').update(Buffer.from(entry.contentBase64, 'base64')).digest('hex')}`
			: `l:${path}:${entry.target}`;
	});
	return entries.sort();
}

function localFileManifest(manifest: readonly string[]): readonly string[] {
	return manifest.filter(entry => entry.startsWith('f:') || entry.startsWith('l:')).sort();
}

type CollectedSkill = Omit<ExportedSkill, 'tracking'> & {readonly otherRootConflict: boolean};

function sameLockSnapshot(a: SkillLockSnapshot, b: SkillLockSnapshot): boolean {
	return (a.state === 'valid' ? a.text : null) === (b.state === 'valid' ? b.text : null);
}

/** 按名称匹配官方 lock 条目；歧义、本机路径、凭据或不支持的来源只导出内容并给出脱敏 warning。 */
function trackingOf(
	skill: CollectedSkill,
	lock: SkillLockSnapshot,
	claims: ReadonlyMap<string, number>,
	label: string
): {readonly tracking: SkillTracking | null; readonly warning?: string} {
	const contentOnly = (why: string) => ({tracking: null, warning: `${label} Skill ${why}，仅导出内容：${skill.name}`});
	const keys = lock.state === 'valid' ? findSkillLockKeys(lock.lock, skill.name) : [];
	if (keys.length === 0) {
		return contentOnly('无官方来源记录');
	}

	if (keys.length > 1 || (claims.get(keys[0]!) ?? 0) > 1) {
		return contentOnly('的官方来源记录存在同名歧义');
	}

	// 官方 lock 按名称记录；另一侧同名 Skill 内容不同时无法证明条目属于哪一侧。
	if (skill.otherRootConflict) {
		return contentOnly('与另一侧同名 Skill 内容不同，无法确定官方来源归属');
	}

	const classified = classifySkillLockEntry(lock.state === 'valid' ? lock.lock.skills[keys[0]!] : undefined);
	if (classified.kind === 'content-only') {
		const why = {
			local: '来源为本机路径或内部快照，无法跨机器恢复更新来源',
			credential: '来源含疑似凭据，已省略来源',
			unsupported: '来源类型或字段不受支持'
		}[classified.reason];
		return contentOnly(why);
	}

	const tracking: SkillTracking = {kind: 'global-lock-v3', entry: classified.entry};
	return classified.missingUpdateFields
		? {tracking, warning: `${label} Skill 来源缺少更新基线，恢复后可能无法官方更新：${skill.name}`}
		: {tracking};
}

/** 离线采集一个 Skills 根的全局 Skill 实际内容与可迁移官方来源（不依赖 `npx skills list` 或网络）。 */
export async function snapshotSkillsSection(options: SkillsSnapshotOptions): Promise<TransferResult<SkillsSection>> {
	const homeDir = options.homeDir ?? resolveHome();
	const dir = skillsRootDir(homeDir, options.root);
	const otherDir = skillsRootDir(homeDir, options.root === 'agents' ? 'claude' : 'agents');
	const label = ROOT_LABELS[options.root];
	const warnings: string[] = [];
	const collectedSkills: CollectedSkill[] = [];
	if (!existsSync(dir)) {
		return transferOk({schema: SKILLS_SECTION_SCHEMA, root: options.root, skills: []});
	}

	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return transferOk({schema: SKILLS_SECTION_SCHEMA, root: options.root, skills: []}, [`${label} Skill 目录无法读取`]);
	}

	// 损坏/不支持的 lock 阻断导出，绝不当作“无来源”静默降级。
	const lockPath = options.lockPath ?? resolveSkillLockPath({homeDir});
	const lockBefore = readSkillLock(lockPath);
	if (!lockBefore.ok) {
		return transferFail('validation', lockBefore.error);
	}

	for (const name of names) {
		if (!isSafeSkillName(name)) {
			continue;
		}

		const fullPath = join(dir, name);
		let fact: ReturnType<typeof lstatSync>;
		try {
			fact = lstatSync(fullPath);
		} catch {
			continue;
		}

		if (!fact.isDirectory() && !fact.isSymbolicLink()) {
			continue;
		}

		// 根 projection symlink 不是内容：解析到实体目录后再验证/快照。
		let realPath: string;
		try {
			realPath = realpathSync(fullPath);
		} catch {
			warnings.push(`${label} Skill 链接已断开：${name}`);
			continue;
		}

		let snapshot: Awaited<ReturnType<typeof createSkillSnapshot>>;
		try {
			snapshot = await createSkillSnapshot(realPath, name, options);
		} catch {
			warnings.push(`${label} 已跳过无效 Skill：${name}`);
			continue;
		}

		try {
			const collected = collectPortableTreeEntries({
				root: 'agents',
				baseDir: snapshot.root,
				files: [],
				dirs: [name],
				exclude: excludedTransferAuthFile
			});
			if (!collected.ok) {
				warnings.push(`${label} Skill 内容无法采集：${name}`);
				continue;
			}

			warnings.push(...collected.data.warnings);
			const other = await readLocalSkillFact(join(otherDir, name), name, options);
			const otherRootConflict =
				other.state === 'invalid' ||
				(other.state === 'valid' &&
					other.realPath !== realPath &&
					JSON.stringify(other.manifest) !== JSON.stringify(localFileManifest(snapshot.manifest)));
			collectedSkills.push({
				id: `${name}#${manifestDigest(snapshot.manifest)}`,
				name,
				files: collected.data.entries,
				otherRootConflict
			});
		} finally {
			await cleanupSkillSnapshot(snapshot);
		}
	}

	// 采集期间 lock 变化会混装两个时刻的来源：明确失败，让用户重试。
	const lockAfter = readSkillLock(lockPath);
	if (!lockAfter.ok || !sameLockSnapshot(lockBefore.data, lockAfter.data)) {
		return transferFail('conflict', '官方 Skills 来源记录在导出期间发生变化，请重试');
	}

	// 两个目录名 sanitize 后命中同一 lock key 时双方都不认领。
	const claims = new Map<string, number>();
	const lock = lockBefore.data;
	for (const skill of collectedSkills) {
		for (const key of lock.state === 'valid' ? findSkillLockKeys(lock.lock, skill.name) : []) {
			claims.set(key, (claims.get(key) ?? 0) + 1);
		}
	}

	const skills = collectedSkills.map(skill => {
		const resolved = trackingOf(skill, lock, claims, label);
		if (resolved.warning) warnings.push(resolved.warning);
		return {id: skill.id, name: skill.name, files: skill.files, tracking: resolved.tracking};
	});
	return transferOk({schema: SKILLS_SECTION_SCHEMA, root: options.root, skills}, warnings);
}

/** 旧版（按 Agent 合并、无 `root`）Skills 分类的统一提示。 */
export const LEGACY_SKILLS_SECTION_MESSAGE = '旧版 Skills 分类不再支持，已跳过';

/** 校验包中的 Skills 分类（导入边界；不信任包内容）。 */
export function parseSkillsSection(value: unknown): TransferResult<SkillsSection> {
	if (isRecord(value) && !Object.hasOwn(value, 'root')) {
		return transferFail('validation', LEGACY_SKILLS_SECTION_MESSAGE);
	}

	if (!isRecord(value) || !(SKILLS_ROOTS as readonly unknown[]).includes(value.root) || !Array.isArray(value.skills)) {
		return transferFail('validation', 'Skills 分类内容无效');
	}

	// schema 缺省仅表示旧 v1 当前 root 格式；存在时必须是已知版本且每个条目显式带 tracking。
	const tracked = Object.hasOwn(value, 'schema');
	if (tracked && value.schema !== SKILLS_SECTION_SCHEMA) {
		return transferFail('validation', 'Skills 分类版本不受支持');
	}

	const state = createPortableTreeValidationState();
	const skills: ExportedSkill[] = [];
	const ids = new Set<string>();
	const names = new Set<string>();

	for (const raw of value.skills) {
		if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') {
			return transferFail('validation', 'Skills 分类包含无效条目');
		}

		if (typeof raw.name !== 'string' || !isSafeSkillName(raw.name)) {
			return transferFail('validation', 'Skills 分类包含不安全名称');
		}

		if (ids.has(raw.id) || names.has(raw.name)) {
			return transferFail('validation', 'Skills 分类包含重复条目');
		}

		const parsed = parsePortableTreeEntries(raw.files, state);
		if (!parsed.ok) {
			return parsed;
		}

		const prefix = `${raw.name}/`;
		for (const entry of parsed.data) {
			if (
				entry.root !== 'agents' ||
				!entry.path.startsWith(prefix) ||
				entry.path.length === prefix.length ||
				excludedTransferAuthFile(entry.path) ||
				excludedTransferAuthSymlink(entry)
			) {
				return transferFail('validation', 'Skills 分类包含不受支持的路径');
			}
		}

		// 内容边界校验（不信任包内容）：SKILL.md 存在且 frontmatter name/description 有效。
		const skillFile = parsed.data.find(entry => entry.kind === 'file' && entry.path === `${prefix}SKILL.md`);
		if (skillFile?.kind !== 'file') {
			return transferFail('validation', `Skills 分类缺少 SKILL.md：${raw.name}`);
		}

		const metadataError = validateSkillMetadataText(Buffer.from(skillFile.contentBase64, 'base64').toString('utf8'), raw.name);
		if (metadataError) {
			return transferFail('validation', `Skill 内容无效：${raw.name}`);
		}

		const tracking = tracked ? parseSkillTracking(raw) : transferOk(null);
		if (!tracking.ok) {
			return transferFail('validation', `Skill 来源跟踪无效或不安全：${raw.name}`);
		}

		ids.add(raw.id);
		names.add(raw.name);
		skills.push({id: raw.id, name: raw.name, files: parsed.data, tracking: tracking.data});
	}

	const root = value.root as SkillsRoot;
	return transferOk(tracked ? {schema: SKILLS_SECTION_SCHEMA, root, skills} : {root, skills});
}

/** 包内 tracking 与导出共用同一安全边界：只接受 null 或仍可迁移的 global-lock-v3 条目。 */
function parseSkillTracking(raw: Record<string, unknown>): TransferResult<SkillTracking | null> {
	if (!Object.hasOwn(raw, 'tracking')) {
		return transferFail('validation', 'Skills 分类条目缺少来源跟踪');
	}

	const tracking = raw.tracking;
	if (tracking === null) {
		return transferOk(null);
	}

	if (!isRecord(tracking) || tracking.kind !== 'global-lock-v3' || Object.keys(tracking).some(key => key !== 'kind' && key !== 'entry')) {
		return transferFail('validation', 'Skills 来源跟踪类型不受支持');
	}

	const classified = classifySkillLockEntry(tracking.entry);
	return classified.kind === 'transferable'
		? transferOk({kind: 'global-lock-v3', entry: classified.entry})
		: transferFail('validation', 'Skills 来源跟踪条目不安全');
}

type LocalSkillFact =
	| {readonly state: 'missing'}
	| {readonly state: 'valid'; readonly realPath: string; readonly manifest: readonly string[]}
	| {readonly state: 'invalid'};

async function readLocalSkillFact(path: string, name: string, options: SkillStorageOptions): Promise<LocalSkillFact> {
	let fact: ReturnType<typeof lstatSync>;
	try {
		fact = lstatSync(path);
	} catch {
		return {state: 'missing'};
	}

	if (!fact.isDirectory() && !fact.isSymbolicLink()) {
		return {state: 'invalid'};
	}

	let realPath: string;
	try {
		realPath = realpathSync(path);
	} catch {
		return {state: 'invalid'};
	}

	let snapshot: Awaited<ReturnType<typeof createSkillSnapshot>>;
	try {
		snapshot = await createSkillSnapshot(realPath, name, options);
	} catch {
		return {state: 'invalid'};
	}

	try {
		return {state: 'valid', realPath, manifest: localFileManifest(snapshot.manifest)};
	} finally {
		await cleanupSkillSnapshot(snapshot);
	}
}

/** 事务快照按路径复制：Skills 根或 lock 父目录若是链接/junction，写入会落到回滚范围外；无法确认也视为链接。 */
function anyLinked(paths: readonly string[]): boolean {
	return paths.some(path => {
		try {
			return lstatSync(path).isSymbolicLink();
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== 'ENOENT';
		}
	});
}

/**
 * 导入预览：只读取本机事实，零写盘，不返回任何内容或凭据。
 * unchanged = 本侧内容一致且官方 lock 中该名称的来源记录与包一致（tracking:null/旧包 = 不应有记录）。
 * 另一侧不存在 -> 仅本侧；另一侧已链接到同一 canonical 或内容与包相同 -> shared；
 * 另一侧内容不同 -> 仅本侧独立恢复，绝不删除或覆盖另一侧；但若需改写按名称共享的来源记录，且另一侧
 * 不在同批 peer 中（其来源不由本包决定）-> blocked。
 */
export async function planSkillsImport(data: unknown, options: SkillsImportPlanOptions = {}): Promise<TransferResult<SkillsImportPlan>> {
	const parsed = parseSkillsSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const homeDir = options.homeDir ?? resolveHome();
	const root = parsed.data.root;
	const otherRoot: SkillsRoot = root === 'agents' ? 'claude' : 'agents';
	const label = ROOT_LABELS[root];
	const lockPath = options.lockPath ?? resolveSkillLockPath({homeDir});
	if (anyLinked([skillsRootDir(homeDir, 'agents'), skillsRootDir(homeDir, 'claude'), dirname(lockPath)])) {
		return transferFail('conflict', 'Skills 目录或官方来源记录目录是链接，无法保证导入可回滚');
	}

	const lockRead = readSkillLock(lockPath);
	if (!lockRead.ok) {
		return transferFail('validation', lockRead.error);
	}

	const lock = lockRead.data;
	const peerSection = options.peer === undefined ? undefined : parseSkillsSection(options.peer);
	const peer = new Map(
		peerSection?.ok && peerSection.data.root !== root ? peerSection.data.skills.map(skill => [skill.name, skill.tracking]) : []
	);
	const items: SkillImportPlanItem[] = [];

	for (const skill of parsed.data.skills) {
		const base = {id: skill.id, name: skill.name};
		// 官方 lock 以名称为 key：sanitize 别名或两个分类提案不同都无法表达，拒绝猜测。
		const keys = lock.state === 'valid' ? findSkillLockKeys(lock.lock, skill.name) : [];
		if (keys.some(key => key !== skill.name)) {
			items.push({...base, state: 'blocked', reason: `官方 Skills 来源记录存在同名歧义：${skill.name}`});
			continue;
		}

		if (peer.has(skill.name) && !isDeepStrictEqual(peer.get(skill.name), skill.tracking)) {
			items.push({...base, state: 'blocked', reason: `两个 Skills 分类中同名 Skill 的来源记录不一致：${skill.name}`});
			continue;
		}

		const current = lock.state === 'valid' && keys.length > 0 ? lock.lock.skills[skill.name] : undefined;
		const desired = skill.tracking?.entry;
		const lockPatch = isDeepStrictEqual(current, desired) ? undefined : {name: skill.name, entry: desired ?? null};
		const manifest = JSON.stringify(bundleManifestEntries(skill.name, skill.files));
		const local = await readLocalSkillFact(join(skillsRootDir(homeDir, root), skill.name), skill.name, options);
		if (local.state === 'invalid') {
			items.push({...base, state: 'blocked', reason: '本机同名 Skill 损坏或无法验证'});
			continue;
		}

		const contentSame = local.state === 'valid' && JSON.stringify(local.manifest) === manifest;
		if (contentSame && !lockPatch) {
			items.push({...base, state: 'unchanged'});
			continue;
		}

		const other = await readLocalSkillFact(join(skillsRootDir(homeDir, otherRoot), skill.name), skill.name, options);
		if (other.state === 'invalid') {
			items.push({...base, state: 'blocked', reason: `${ROOT_LABELS[otherRoot]} 中同名 Skill 损坏或无法验证：${skill.name}`});
			continue;
		}

		// `.claude` 投影指向本侧 canonical 时随 canonical 一起更新，不算冲突。
		const linked = other.state === 'valid' && local.state === 'valid' && other.realPath === local.realPath;
		const shared = other.state === 'valid' && ((root === 'agents' && linked) || JSON.stringify(other.manifest) === manifest);
		// 离线恢复只写本侧目录，内容不同的另一侧原样保留；仍会波及它的是拆散本侧共享投影与名称级 lock 补丁。
		if (other.state === 'valid' && !shared && (linked || (lockPatch && !peer.has(skill.name)))) {
			items.push({...base, state: 'blocked', reason: `${ROOT_LABELS[otherRoot]} 中已有不同内容的同名 Skill：${skill.name}`});
			continue;
		}

		items.push({
			...base,
			state: local.state === 'missing' ? 'add' : 'replace',
			...(contentSame ? {} : {targets: shared ? {cc: true, cx: true} : {cc: root === 'claude', cx: root === 'agents'}}),
			...(lockPatch ? {lock: lockPatch} : {})
		});
	}

	return transferOk({items, lock, warnings: importWarnings(parsed.data, items, label)});
}

/** 只为将要变化的条目提示：内容离线恢复、来源无法恢复或缺少更新基线（postflight 全部 unchanged 时不重复）。 */
function importWarnings(section: SkillsSection, items: readonly SkillImportPlanItem[], label: string): readonly string[] {
	const tracking = new Map(section.skills.map(skill => [skill.name, skill.tracking]));
	const changed = items.filter(item => item.state === 'add' || item.state === 'replace');
	const warnings: string[] = [];
	if (changed.some(item => item.targets)) {
		warnings.push(`${label} Skills 将离线恢复包内完整内容，不联网安装或更新；后续官方更新可能覆盖本地修改`);
	}

	const unknown = changed.filter(item => tracking.get(item.name) === null).map(item => item.name);
	if (unknown.length > 0) {
		warnings.push(
			section.schema === undefined
				? `${label} Skills 来自旧版导出包，不含来源记录，恢复后为未知来源：${unknown.join('、')}`
				: `${label} Skill 无可迁移来源，恢复后为未知来源：${unknown.join('、')}`
		);
	}

	const noBaseline = changed.filter(item => {
		const entry = tracking.get(item.name)?.entry;
		const classified = entry ? classifySkillLockEntry(entry) : undefined;
		return classified?.kind === 'transferable' && classified.missingUpdateFields;
	});
	if (noBaseline.length > 0) {
		warnings.push(`${label} Skill 来源缺少更新基线，恢复后可能无法官方更新：${noBaseline.map(item => item.name).join('、')}`);
	}

	return warnings;
}
