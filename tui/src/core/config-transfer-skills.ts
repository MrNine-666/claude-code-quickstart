import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, realpathSync} from 'node:fs';
import {join} from 'node:path';

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
// 具体拓扑由 services/skills-adoption.ts 的现有 lifecycle 负责。
// shortcut: shared Skill 两个分类都选时内容在包内存两份；包体积成为问题时再做跨分类去重。

export const SKILLS_ROOTS = ['agents', 'claude'] as const;
export type SkillsRoot = (typeof SKILLS_ROOTS)[number];

export type ExportedSkill = {
	readonly id: string;
	readonly name: string;
	readonly files: readonly PortableTreeEntry[];
};

export type SkillsSection = {readonly root: SkillsRoot; readonly skills: readonly ExportedSkill[]};

export type SkillImportState = 'add' | 'replace' | 'unchanged' | 'blocked';

export type SkillImportPlanItem = {
	readonly id: string;
	readonly name: string;
	readonly state: SkillImportState;
	/** add/replace 的物化目标拓扑。 */
	readonly targets?: SkillAgentTargets;
	readonly reason?: string;
};

export type SkillsImportPlan = {readonly items: readonly SkillImportPlanItem[]};

export type SkillsSnapshotOptions = SkillStorageOptions & {readonly root: SkillsRoot};

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

/** 离线采集一个 Skills 根的全局 Skill 实际内容（不依赖 `npx skills list` 或网络）。 */
export async function snapshotSkillsSection(options: SkillsSnapshotOptions): Promise<TransferResult<SkillsSection>> {
	const dir = skillsRootDir(options.homeDir ?? resolveHome(), options.root);
	const label = ROOT_LABELS[options.root];
	const warnings: string[] = [];
	const skills: ExportedSkill[] = [];
	if (!existsSync(dir)) {
		return transferOk({root: options.root, skills});
	}

	let names: string[];
	try {
		names = readdirSync(dir).sort();
	} catch {
		return transferOk({root: options.root, skills}, [`${label} Skill 目录无法读取`]);
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
			skills.push({id: `${name}#${manifestDigest(snapshot.manifest)}`, name, files: collected.data.entries});
		} finally {
			await cleanupSkillSnapshot(snapshot);
		}
	}

	return transferOk({root: options.root, skills}, warnings);
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

		ids.add(raw.id);
		names.add(raw.name);
		skills.push({id: raw.id, name: raw.name, files: parsed.data});
	}

	return transferOk({root: value.root as SkillsRoot, skills});
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

/**
 * 导入预览：只读取本机事实，零写盘，不返回任何内容或凭据。
 * 本侧内容一致即 unchanged；另一侧不存在 -> 仅本侧；另一侧已链接到同一 canonical 或内容与包相同 -> shared；
 * 另一侧内容不同 -> blocked（绝不删除或静默覆盖另一侧）。
 */
export async function planSkillsImport(data: unknown, options: SkillStorageOptions = {}): Promise<TransferResult<SkillsImportPlan>> {
	const parsed = parseSkillsSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const homeDir = options.homeDir ?? resolveHome();
	const root = parsed.data.root;
	const otherRoot: SkillsRoot = root === 'agents' ? 'claude' : 'agents';
	const items: SkillImportPlanItem[] = [];

	for (const skill of parsed.data.skills) {
		const base = {id: skill.id, name: skill.name};
		const manifest = JSON.stringify(bundleManifestEntries(skill.name, skill.files));
		const local = await readLocalSkillFact(join(skillsRootDir(homeDir, root), skill.name), skill.name, options);
		if (local.state === 'invalid') {
			items.push({...base, state: 'blocked', reason: '本机同名 Skill 损坏或无法验证'});
			continue;
		}

		if (local.state === 'valid' && JSON.stringify(local.manifest) === manifest) {
			items.push({...base, state: 'unchanged'});
			continue;
		}

		const other = await readLocalSkillFact(join(skillsRootDir(homeDir, otherRoot), skill.name), skill.name, options);
		if (other.state === 'invalid') {
			items.push({...base, state: 'blocked', reason: `${ROOT_LABELS[otherRoot]} 中同名 Skill 损坏或无法验证：${skill.name}`});
			continue;
		}

		// `.claude` 投影指向本侧 canonical 时随 canonical 一起更新，不算冲突。
		const linked = root === 'agents' && other.state === 'valid' && local.state === 'valid' && other.realPath === local.realPath;
		const shared = other.state === 'valid' && (linked || JSON.stringify(other.manifest) === manifest);
		if (other.state === 'valid' && !shared) {
			items.push({...base, state: 'blocked', reason: `${ROOT_LABELS[otherRoot]} 中已有不同内容的同名 Skill：${skill.name}`});
			continue;
		}

		items.push({
			...base,
			state: local.state === 'missing' ? 'add' : 'replace',
			targets: shared ? {cc: true, cx: true} : {cc: root === 'claude', cx: root === 'agents'}
		});
	}

	return transferOk({items});
}
