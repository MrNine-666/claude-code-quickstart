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
	type SkillStorageOptions,
	validateSkillMetadataText
} from './skills-storage.js';

// Skills 导入导出 seam（Phase 2 Part B）：离线采集全局 Skill 实际内容 + 目标拓扑。
//
// 内容源先经现有 createSkillSnapshot 验证（SKILL.md frontmatter、内部链接不逃逸、清单一致），
// 根 projection symlink 不作为内容导出：先 realpath 解析到实体目录再快照，包内只记录目标拓扑。
// 相同内容跨目标只打包一次；同名但内容不同的 Skill 只保留先出现的目标并给出 warning
// （ponytail: 同名异构仅保留一份，需要真正 per-target 异构时再拆分 bundle schema）。
// 包内路径统一为 root `agents` + `<name>/<相对路径>`：导入按 Skill 名映射到各 Agent 目标，
// 具体拓扑物化由 services/skills-adoption.ts 的现有 lifecycle 负责。

export const SKILL_TRANSFER_TARGETS = ['cc', 'cx', 'pi'] as const;
export type SkillTransferTarget = (typeof SKILL_TRANSFER_TARGETS)[number];

export type ExportedSkill = {
	readonly id: string;
	readonly name: string;
	readonly targets: readonly SkillTransferTarget[];
	readonly files: readonly PortableTreeEntry[];
};

export type SkillsSection = {readonly skills: readonly ExportedSkill[]};

export type SkillImportState = 'add' | 'replace' | 'unchanged' | 'blocked';

export type SkillImportPlanItem = {
	readonly id: string;
	readonly name: string;
	readonly targets: readonly SkillTransferTarget[];
	readonly state: SkillImportState;
	readonly reason?: string;
};

export type SkillsImportPlan = {readonly items: readonly SkillImportPlanItem[]};

export type SkillsSnapshotOptions = SkillStorageOptions & {readonly targets: readonly SkillTransferTarget[]};

type MutableSkill = {
	id: string;
	name: string;
	targets: SkillTransferTarget[];
	files: readonly PortableTreeEntry[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSkillTransferTarget(value: unknown): value is SkillTransferTarget {
	return typeof value === 'string' && (SKILL_TRANSFER_TARGETS as readonly string[]).includes(value);
}

function skillRoots(homeDir: string): Readonly<Record<SkillTransferTarget, string>> {
	return {
		cc: join(homeDir, '.claude', 'skills'),
		cx: join(homeDir, '.agents', 'skills'),
		pi: join(homeDir, '.pi', 'agent', 'skills')
	};
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

/** 离线采集所选目标的全局 Skill 实际内容（不依赖 `npx skills list` 或网络）。 */
export async function snapshotSkillsSection(options: SkillsSnapshotOptions): Promise<TransferResult<SkillsSection>> {
	const homeDir = options.homeDir ?? resolveHome();
	const roots = skillRoots(homeDir);
	const warnings: string[] = [];
	const skills: MutableSkill[] = [];
	const byKey = new Map<string, MutableSkill>();
	const byName = new Map<string, MutableSkill>();

	for (const target of options.targets) {
		const root = roots[target];
		if (!existsSync(root)) {
			continue;
		}

		let names: string[];
		try {
			names = readdirSync(root).sort();
		} catch {
			warnings.push(`Skill 目录无法读取：${target}`);
			continue;
		}

		for (const name of names) {
			if (!isSafeSkillName(name)) {
				continue;
			}

			const fullPath = join(root, name);
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
				warnings.push(`Skill 链接已断开：${name}`);
				continue;
			}

			let snapshot: Awaited<ReturnType<typeof createSkillSnapshot>>;
			try {
				snapshot = await createSkillSnapshot(realPath, name, options);
			} catch {
				warnings.push(`已跳过无效 Skill：${name}`);
				continue;
			}

			try {
				const digest = manifestDigest(snapshot.manifest);
				const key = `${name}\u0000${digest}`;
				const existing = byKey.get(key);
				if (existing) {
					if (!existing.targets.includes(target)) {
						existing.targets.push(target);
					}

					continue;
				}

				if (byName.has(name)) {
					warnings.push(`同名但内容不同的 Skill 已跳过：${name}`);
					continue;
				}

				const collected = collectPortableTreeEntries({
					root: 'agents',
					baseDir: snapshot.root,
					files: [],
					dirs: [name],
					exclude: excludedTransferAuthFile
				});
				if (!collected.ok) {
					warnings.push(`Skill 内容无法采集：${name}`);
					continue;
				}

				warnings.push(...collected.data.warnings);
				const skill: MutableSkill = {id: `${name}#${digest}`, name, targets: [target], files: collected.data.entries};
				byKey.set(key, skill);
				byName.set(name, skill);
				skills.push(skill);
			} finally {
				await cleanupSkillSnapshot(snapshot);
			}
		}
	}

	return transferOk({skills: skills.map(skill => ({...skill, targets: [...skill.targets]}))}, warnings);
}

/** 校验包中的 Skills 分类（导入边界；不信任包内容）。 */
export function parseSkillsSection(value: unknown): TransferResult<SkillsSection> {
	if (!isRecord(value) || !Array.isArray(value.skills)) {
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

		if (!Array.isArray(raw.targets) || raw.targets.length === 0) {
			return transferFail('validation', 'Skills 分类缺少目标');
		}

		const targets: SkillTransferTarget[] = [];
		for (const target of raw.targets) {
			if (!isSkillTransferTarget(target) || targets.includes(target)) {
				return transferFail('validation', 'Skills 分类包含无效目标');
			}

			targets.push(target);
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
		skills.push({id: raw.id, name: raw.name, targets, files: parsed.data});
	}

	return transferOk({skills});
}

type LocalSkillFact =
	| {readonly state: 'missing'}
	| {readonly state: 'valid'; readonly manifest: readonly string[]}
	| {readonly state: 'invalid'};

async function readLocalSkillFact(name: string, homeDir: string, options: SkillStorageOptions): Promise<LocalSkillFact> {
	const roots = skillRoots(homeDir);
	for (const target of ['cx', 'cc', 'pi'] as const) {
		const path = join(roots[target], name);
		let fact: ReturnType<typeof lstatSync>;
		try {
			fact = lstatSync(path);
		} catch {
			continue;
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
			return {state: 'valid', manifest: snapshot.manifest};
		} finally {
			await cleanupSkillSnapshot(snapshot);
		}
	}

	return {state: 'missing'};
}

function targetMaterialized(roots: Readonly<Record<SkillTransferTarget, string>>, target: SkillTransferTarget, name: string): boolean {
	try {
		const fact = lstatSync(join(roots[target], name));
		// Pi 目标在受管拓扑中必须是 symlink（real dir 属于 Pi native，需要重建投影）。
		return target === 'pi' ? fact.isSymbolicLink() : fact.isDirectory() || fact.isSymbolicLink();
	} catch {
		return false;
	}
}

/** 导入预览：只读取本机事实，零写盘，不返回任何内容或凭据。 */
export async function planSkillsImport(data: unknown, options: SkillStorageOptions = {}): Promise<TransferResult<SkillsImportPlan>> {
	const parsed = parseSkillsSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const homeDir = options.homeDir ?? resolveHome();
	const roots = skillRoots(homeDir);
	const items: SkillImportPlanItem[] = [];

	for (const skill of parsed.data.skills) {
		const local = await readLocalSkillFact(skill.name, homeDir, options);
		if (local.state === 'invalid') {
			items.push({id: skill.id, name: skill.name, targets: skill.targets, state: 'blocked', reason: '本机同名 Skill 损坏或无法验证'});
			continue;
		}

		if (local.state === 'missing') {
			items.push({id: skill.id, name: skill.name, targets: skill.targets, state: 'add'});
			continue;
		}

		const contentMatches =
			JSON.stringify(bundleManifestEntries(skill.name, skill.files)) === JSON.stringify(localFileManifest(local.manifest));
		const topologyMatches = skill.targets.every(target => targetMaterialized(roots, target, skill.name));
		items.push({
			id: skill.id,
			name: skill.name,
			targets: skill.targets,
			state: contentMatches && topologyMatches ? 'unchanged' : 'replace'
		});
	}

	return transferOk({items});
}
