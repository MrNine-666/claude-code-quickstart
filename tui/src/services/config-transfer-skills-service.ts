import {lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';

import {materializePortableTreeEntries} from '../core/config-transfer-sections.js';
import {type SectionMergeReport, type TransferResult, transferFail, transferOk} from '../core/config-transfer.js';
import {
	type ExportedSkill,
	planSkillsImport,
	parseSkillsSection,
	type SkillImportPlanItem,
	type SkillsImportPlanOptions
} from '../core/config-transfer-skills.js';
import {patchSkillLock, resolveSkillLockPath, saveSkillLock} from '../core/skills-lock-metadata.js';
import {readSkillManifest, type SkillAgentTargets, skillStoragePaths} from '../core/skills-storage.js';

// Skills 导入分类事务 seam：完全离线，只使用包内内容，绝不调用 skills add/update 或联网。
// 包内 Skill 先写入系统 temp staging 并验证，再精确替换 `<root>/<name>`（不残留包中已删除的旧文件）：
// Codex / Pi = `.agents` 实体，Claude-only = `.claude` 实体，shared = `.agents` 实体 + `.claude` 投影。
// 来源按名称补丁官方 lock。包中未出现的本机 Skill 与 lock 条目永不触碰；分类快照/回滚由 config-transfer-plan 负责。

export type ImportSkillsOptions = SkillsImportPlanOptions & {
	readonly dryRun?: boolean;
	/** 每个 Skill 与 lock 写入前检查；abort 后不再开始新的写入，由分类事务恢复已写部分。 */
	readonly signal?: AbortSignal;
	/** 测试注入 seam：创建 `.claude` -> `.agents` 共享投影；默认 symlink（Windows 为 junction）。 */
	readonly createProjection?: (target: string, path: string) => void;
};

function summarizePlan(items: readonly SkillImportPlanItem[]): SectionMergeReport {
	const added: string[] = [];
	const replaced: string[] = [];
	const unchanged: string[] = [];
	const skipped: string[] = [];
	for (const item of items) {
		if (item.state === 'add') {
			added.push(item.id);
		} else if (item.state === 'replace') {
			replaced.push(item.id);
		} else if (item.state === 'unchanged') {
			unchanged.push(item.id);
		} else {
			skipped.push(item.id);
		}
	}

	return {added, replaced, unchanged, skipped, warnings: []};
}

function defaultProjection(target: string, path: string): void {
	// 目标机自建链接，不搬运源机器绝对链接；Windows junction 无需管理员权限但要求绝对路径。
	if (process.platform === 'win32') symlinkSync(target, path, 'junction');
	else symlinkSync(relative(dirname(path), target), path, 'dir');
}

/** 删除精确的 `<root>/<name>`：链接/junction 只解除链接本身，绝不跟随。 */
function removeExact(path: string): void {
	let fact: ReturnType<typeof lstatSync>;
	try {
		fact = lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}

	if (fact.isSymbolicLink()) unlinkSync(path);
	else rmSync(path, {recursive: true, force: false});
}

function sameRealPath(left: string, right: string): boolean {
	try {
		return realpathSync(left) === realpathSync(right);
	} catch {
		return false;
	}
}

function overlaps(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

/** 先在 staging 验证包内 Skill（SKILL.md、内部链接不逃逸），再精确替换目标并按需建立共享投影。 */
async function restoreSkill(skill: ExportedSkill, targets: SkillAgentTargets, options: ImportSkillsOptions): Promise<TransferResult<void>> {
	const {claudePath, canonicalPath} = skillStoragePaths(skill.name, options);
	const stagingParent = options.tempDir ?? tmpdir();
	if ([claudePath, canonicalPath].some(path => overlaps(path, stagingParent) || overlaps(stagingParent, path))) {
		return transferFail('validation', 'Skill 导入临时目录不得与 Claude/Codex 安装树重叠');
	}

	mkdirSync(stagingParent, {recursive: true});
	const staging = mkdtempSync(join(stagingParent, 'ccq-skill-import-'));
	try {
		const staged = materializePortableTreeEntries(staging, skill.files, false);
		if (!staged.ok) {
			return transferFail(staged.kind, `Skill 内容写入失败：${skill.name}`);
		}

		await readSkillManifest(join(staging, skill.name), skill.name);
	} catch {
		return transferFail('validation', `Skill 内容无效：${skill.name}`);
	} finally {
		rmSync(staging, {recursive: true, force: true});
	}

	const entity = targets.cx ? canonicalPath : claudePath;
	try {
		removeExact(entity);
		mkdirSync(dirname(entity), {recursive: true});
		const written = materializePortableTreeEntries(dirname(entity), skill.files, false);
		if (!written.ok) {
			return transferFail(written.kind, `Skill 内容写入失败：${skill.name}`);
		}
	} catch {
		return transferFail('io', `Skill 内容写入失败：${skill.name}`);
	}

	if (targets.cc && targets.cx && !sameRealPath(claudePath, canonicalPath)) {
		try {
			removeExact(claudePath);
			mkdirSync(dirname(claudePath), {recursive: true});
			(options.createProjection ?? defaultProjection)(canonicalPath, claudePath);
			// postflight 只看本侧内容与 lock，投影拓扑在此确认，避免 `.claude` 侧被删后误报 shared。
			if (!sameRealPath(claudePath, canonicalPath)) throw new Error('projection not created');
		} catch {
			// 不静默留下两份实体：由分类事务回滚并如实报告。
			return transferFail('io', `Skill 共享投影创建失败（系统可能不允许创建链接）：${skill.name}`);
		}
	}

	return transferOk(undefined);
}

/**
 * 合并导入 Skills 分类：只新增/覆盖包内 Skill 与其官方来源记录，另一侧只保留或建立共享，绝不删除包外内容。
 * `dryRun` 只返回 add/replace/unchanged/blocked 计数，零写盘。
 */
export async function importSkillsSection(data: unknown, options: ImportSkillsOptions = {}): Promise<TransferResult<SectionMergeReport>> {
	const parsed = parseSkillsSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const lockPath = options.lockPath ?? resolveSkillLockPath({homeDir: options.homeDir});
	const plan = await planSkillsImport(parsed.data, {...options, lockPath});
	if (!plan.ok) {
		return plan;
	}

	const blocked = plan.data.items.filter(item => item.state === 'blocked');
	if (blocked.length > 0) {
		return transferFail('conflict', `本机同名 Skill 冲突或损坏，已停止导入：${blocked.map(item => item.name).join('、')}`);
	}

	const report = summarizePlan(plan.data.items);
	const warnings = [...parsed.warnings, ...plan.data.warnings];
	if (options.dryRun) {
		return transferOk(report, warnings);
	}

	const byId = new Map(parsed.data.skills.map(skill => [skill.id, skill]));
	for (const item of plan.data.items) {
		const skill = byId.get(item.id);
		if (!skill || !item.targets) {
			continue;
		}

		if (options.signal?.aborted) {
			return transferFail('cancelled', '操作已取消');
		}

		const result = await restoreSkill(skill, item.targets, options);
		if (!result.ok) {
			return result;
		}
	}

	// 来源补丁与内容同属本分类事务：写前重读 lock，外部修改即停止并由事务恢复内容。
	const next = patchSkillLock(
		plan.data.lock,
		plan.data.items.flatMap(item => (item.lock ? [item.lock] : []))
	);
	if (next) {
		if (options.signal?.aborted) {
			return transferFail('cancelled', '操作已取消');
		}

		const saved = saveSkillLock(lockPath, plan.data.lock, next);
		if (!saved.ok) {
			return transferFail('conflict', saved.error);
		}
	}

	return transferOk(report, warnings);
}
