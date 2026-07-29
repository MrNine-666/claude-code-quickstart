import {createHash} from 'node:crypto';
import {cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, readlink, unlink} from 'node:fs/promises';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveHome} from './paths.js';
import type {SkillDeletionTarget} from './skills-installed.js';

export type SkillStorageKind =
	| 'shared-symlink'
	| 'shared-copy'
	| 'claude-only'
	| 'canonical-only'
	| 'invalid-link'
	| 'conflict'
	| 'invalid'
	| 'missing';

export type SkillStorageOptions = {
	readonly homeDir?: string;
	readonly tempDir?: string;
};

export type SkillTopology = 'claude-only' | 'codex-only' | 'shared';
export type SkillTopologyDraft = {readonly cc: boolean; readonly cx: boolean};

export type SkillStorageInspection = {
	readonly name: string;
	readonly kind: SkillStorageKind;
	readonly claudePath: string;
	readonly canonicalPath: string;
	readonly claudeValid: boolean;
	readonly canonicalValid: boolean;
	readonly error?: string;
};

export function topologyOfInspection(inspection: SkillStorageInspection): SkillTopology | undefined {
	switch (inspection.kind) {
		case 'claude-only':
			return 'claude-only';
		case 'canonical-only':
			return 'codex-only';
		case 'shared-symlink':
			return 'shared';
		default:
			return undefined;
	}
}

export function targetTopologyOfDraft(draft: SkillTopologyDraft): SkillTopology | 'empty' {
	if (draft.cc && draft.cx) {
		return 'shared';
	}
	if (draft.cc) {
		return 'claude-only';
	}
	if (draft.cx) {
		return 'codex-only';
	}
	return 'empty';
}

export type SkillSnapshot = {
	readonly root: string;
	readonly skillPath: string;
	readonly manifest: readonly string[];
};

type DirectoryValidation = {
	readonly valid: boolean;
	readonly manifest?: readonly string[];
	readonly error?: string;
};

type PathFact = Awaited<ReturnType<typeof lstat>> | undefined;

const SAFE_SKILL_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isSafeSkillName(name: string): boolean {
	return SAFE_SKILL_NAME.test(name) && name !== '.' && name !== '..';
}

export function skillStoragePaths(name: string, options: SkillStorageOptions = {}): {claudePath: string; canonicalPath: string} {
	const homeDir = options.homeDir ?? resolveHome();
	return {
		claudePath: join(homeDir, '.claude', 'skills', name),
		canonicalPath: join(homeDir, '.agents', 'skills', name)
	};
}

async function lstatIfPresent(path: string): Promise<PathFact> {
	try {
		return await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return undefined;
		}

		throw error;
	}
}

function containedBy(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function frontmatterField(frontmatter: string, field: string): string | undefined {
	const match = frontmatter.match(new RegExp(`^${field}\\s*:\\s*(.+)$`, 'mi'));
	const value = match?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
	return value || undefined;
}

async function validateSkillMetadata(skillPath: string, expectedName: string): Promise<string | undefined> {
	const metadataPath = join(skillPath, 'SKILL.md');
	const metadataFact = await lstatIfPresent(metadataPath);
	if (!metadataFact?.isFile()) {
		return 'SKILL.md 缺失或不是普通文件';
	}

	const text = await readFile(metadataPath, 'utf8');
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) {
		return 'SKILL.md 缺少有效 frontmatter';
	}

	const declaredName = frontmatterField(match[1] ?? '', 'name');
	const description = frontmatterField(match[1] ?? '', 'description');
	if (!declaredName || declaredName !== expectedName) {
		return `SKILL.md name 必须为 ${expectedName}`;
	}

	return description ? undefined : 'SKILL.md description 不能为空';
}

async function validateSkillTree(skillPath: string): Promise<string | undefined> {
	const resolvedRoot = await realpath(skillPath);
	const queue = [skillPath];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const entry of await readdir(current, {withFileTypes: true})) {
			const entryPath = join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(entryPath);
				continue;
			}

			if (entry.isSymbolicLink()) {
				try {
					const target = await realpath(entryPath);
					if (!containedBy(resolvedRoot, target)) {
						return `内部链接逃逸 Skill 根目录：${relative(skillPath, entryPath)}`;
					}
				} catch {
					return `内部链接已断开：${relative(skillPath, entryPath)}`;
				}
				continue;
			}

			if (!entry.isFile()) {
				return `包含不支持的文件类型：${relative(skillPath, entryPath)}`;
			}
		}
	}

	return undefined;
}

async function contentManifest(skillPath: string): Promise<readonly string[]> {
	const entries: string[] = [];
	const queue = [skillPath];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const entry of await readdir(current, {withFileTypes: true})) {
			const entryPath = join(current, entry.name);
			const itemPath = relative(skillPath, entryPath).replaceAll('\\', '/');
			if (entry.isDirectory()) {
				entries.push(`d:${itemPath}`);
				queue.push(entryPath);
			} else if (entry.isSymbolicLink()) {
				entries.push(`l:${itemPath}:${await readlink(entryPath)}`);
			} else {
				const digest = createHash('sha256').update(await readFile(entryPath)).digest('hex');
				entries.push(`f:${itemPath}:${digest}`);
			}
		}
	}

	return entries.sort();
}

export function skillManifestsEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** 事务专用完整清单；普通列表检测不调用，避免对每个 Skill 重复 hash 全树。 */
export async function readSkillManifest(skillPath: string, expectedName: string): Promise<readonly string[]> {
	const validation = await validateSkillDirectory(skillPath, expectedName, true);
	if (!validation.valid || !validation.manifest) {
		throw new Error(`无法读取 Skill manifest：${validation.error ?? '目录无效'}`);
	}

	return validation.manifest;
}

async function validateSkillDirectory(
	skillPath: string,
	expectedName: string,
	includeManifest = false
): Promise<DirectoryValidation> {
	const rootFact = await lstatIfPresent(skillPath);
	if (!rootFact?.isDirectory() || rootFact.isSymbolicLink()) {
		return {valid: false, error: 'Skill 路径不是实体目录'};
	}

	const metadataError = await validateSkillMetadata(skillPath, expectedName);
	if (metadataError) {
		return {valid: false, error: metadataError};
	}

	const treeError = await validateSkillTree(skillPath);
	if (treeError) {
		return {valid: false, error: treeError};
	}

	return includeManifest
		? {valid: true, manifest: await contentManifest(skillPath)}
		: {valid: true};
}

function inspection(
	name: string,
	kind: SkillStorageKind,
	paths: ReturnType<typeof skillStoragePaths>,
	claudeValid: boolean,
	canonicalValid: boolean,
	error?: string
): SkillStorageInspection {
	return {name, kind, ...paths, claudeValid, canonicalValid, ...(error ? {error} : {})};
}

async function inspectClaudeLink(
	name: string,
	paths: ReturnType<typeof skillStoragePaths>,
	canonicalFact: PathFact
): Promise<SkillStorageInspection> {
	if (!canonicalFact?.isDirectory() || canonicalFact.isSymbolicLink()) {
		return inspection(name, 'invalid-link', paths, false, false, 'Claude Code 链接缺少有效 canonical 目标');
	}

	const canonical = await validateSkillDirectory(paths.canonicalPath, name);
	try {
		const [claudeTarget, canonicalTarget] = await Promise.all([realpath(paths.claudePath), realpath(paths.canonicalPath)]);
		if (claudeTarget !== canonicalTarget) {
			return inspection(name, 'invalid-link', paths, false, canonical.valid, 'Claude Code 链接未指向同名 canonical');
		}
	} catch {
		return inspection(name, 'invalid-link', paths, false, canonical.valid, 'Claude Code 链接已断开');
	}

	return canonical.valid
		? inspection(name, 'shared-symlink', paths, true, true)
		: inspection(name, 'invalid-link', paths, false, false, canonical.error);
}

async function inspectRealDirectories(
	name: string,
	paths: ReturnType<typeof skillStoragePaths>,
	claudeFact: PathFact,
	canonicalFact: PathFact
): Promise<SkillStorageInspection> {
	const compareContents = Boolean(claudeFact?.isDirectory() && canonicalFact?.isDirectory());
	const claude = claudeFact?.isDirectory() ? await validateSkillDirectory(paths.claudePath, name, compareContents) : undefined;
	const canonical = canonicalFact?.isDirectory() ? await validateSkillDirectory(paths.canonicalPath, name, compareContents) : undefined;
	if ((claude && !claude.valid) || (canonical && !canonical.valid)) {
		return inspection(name, 'invalid', paths, Boolean(claude?.valid), Boolean(canonical?.valid), claude?.error ?? canonical?.error);
	}

	if (claude && !canonical) {
		return inspection(name, 'claude-only', paths, true, false);
	}

	if (canonical && !claude) {
		return inspection(name, 'canonical-only', paths, false, true);
	}

	if (claude && canonical) {
		const equal = JSON.stringify(claude.manifest) === JSON.stringify(canonical.manifest);
		return inspection(name, equal ? 'shared-copy' : 'conflict', paths, true, true, equal ? undefined : '两侧实体目录内容不一致');
	}

	return inspection(name, 'missing', paths, false, false);
}

export async function inspectSkillStorage(name: string, options: SkillStorageOptions = {}): Promise<SkillStorageInspection> {
	const paths = skillStoragePaths(isSafeSkillName(name) ? name : '__invalid__', options);
	if (!isSafeSkillName(name)) {
		return inspection(name, 'invalid', paths, false, false, 'Skill 名称不能安全映射到安装目录');
	}

	try {
		return await inspectSafeSkillStorage(name, paths);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return inspection(name, 'invalid', paths, false, false, `无法检查 Skill 存储：${message}`);
	}
}

async function inspectSafeSkillStorage(
	name: string,
	paths: ReturnType<typeof skillStoragePaths>
): Promise<SkillStorageInspection> {
	const [claudeFact, canonicalFact] = await Promise.all([lstatIfPresent(paths.claudePath), lstatIfPresent(paths.canonicalPath)]);
	if (claudeFact?.isSymbolicLink()) {
		return inspectClaudeLink(name, paths, canonicalFact);
	}

	if (canonicalFact?.isSymbolicLink()) {
		return inspection(name, 'invalid', paths, Boolean(claudeFact?.isDirectory()), false, 'canonical 不能是符号链接');
	}

	if ((claudeFact && !claudeFact.isDirectory()) || (canonicalFact && !canonicalFact.isDirectory())) {
		return inspection(name, 'invalid', paths, false, false, 'Skill 路径存在但不是目录');
	}

	return inspectRealDirectories(name, paths, claudeFact, canonicalFact);
}

export function hasRecoverableSkillContent(value: SkillStorageInspection): boolean {
	return value.claudeValid || value.canonicalValid;
}

export function preferredSkillContentPath(value: SkillStorageInspection): string | undefined {
	return value.canonicalValid ? value.canonicalPath : value.claudeValid ? value.claudePath : undefined;
}

export async function createSkillSnapshot(
	sourcePath: string,
	name: string,
	options: SkillStorageOptions = {}
): Promise<SkillSnapshot> {
	if (!isSafeSkillName(name)) {
		throw new Error('Skill 名称不能安全映射到快照目录');
	}

	const source = await validateSkillDirectory(sourcePath, name, true);
	if (!source.valid) {
		throw new Error(`无法创建 Skill 快照：${source.error ?? '源目录无效'}`);
	}

	const parent = resolve(options.tempDir ?? tmpdir());
	const paths = skillStoragePaths(name, options);
	for (const target of [paths.claudePath, paths.canonicalPath]) {
		const resolvedTarget = resolve(target);
		if (containedBy(resolvedTarget, parent) || containedBy(parent, resolvedTarget)) {
			throw new Error('Skill 快照目录不得与 Claude/Codex 安装树重叠');
		}
	}

	await mkdir(parent, {recursive: true});
	const root = await mkdtemp(join(parent, 'ccq-skill-stage-'));
	const skillPath = join(root, name);
	try {
		await cp(sourcePath, skillPath, {recursive: true, errorOnExist: true, force: false});
		const staged = await validateSkillDirectory(skillPath, name, true);
		if (!staged.valid || !staged.manifest || !source.manifest || !skillManifestsEqual(staged.manifest, source.manifest)) {
			throw new Error(staged.error ?? '快照内容校验不一致');
		}

		return {root, skillPath, manifest: staged.manifest};
	} catch (error) {
		await rm(root, {recursive: true, force: true});
		throw error;
	}
}

export async function cleanupSkillSnapshot(snapshot: SkillSnapshot): Promise<void> {
	await rm(snapshot.root, {recursive: true, force: true});
}

/**
 * 删除已通过 `verifySkillDeletionTarget` 验证的精确目标（design §8.3 / §10）。
 * symlink 只删链接本身（Node `rm` 默认不跟随符号链接），directory 才递归删该精确目录。
 * 调用方必须先经 `verifySkillDeletionTarget` 证明目标安全；本函数不再二次猜测路径，
 * 也不再读取 `.skill-lock.json` 或枚举目录。`force: false` 确保目标必须存在，避免静默吞错。
 */
export async function removeSkillTarget(target: SkillDeletionTarget): Promise<void> {
	if (target.kind === 'symlink') {
		// 符号链接只删链接条目本身：用 unlink 而非 rm。Node/Bun 的 rm 在部分平台对
		// 目录符号链接会误判（如 Windows EFAULT），unlink 语义明确、永不跟随目标。
		await unlink(target.path);
		return;
	}

	await rm(target.path, {recursive: true, force: false});
}
