import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {materializePortableTreeEntries} from '../core/config-transfer-sections.js';
import {type SectionMergeReport, type TransferResult, transferFail, transferOk} from '../core/config-transfer.js';
import {
	type ExportedSkill,
	planSkillsImport,
	parseSkillsSection,
	type SkillImportPlanItem,
	type SkillTransferTarget
} from '../core/config-transfer-skills.js';
import type {ProgressCallback} from '../core/exec.js';
import type {SkillsExecFn} from '../core/skills-actions.js';
import {cleanupSkillSnapshot, createSkillSnapshot, type SkillSnapshot, type SkillStorageOptions} from '../core/skills-storage.js';
import {materializeSkillTargetsFromSnapshot} from './skills-adoption.js';

// Skills 导入分类事务 seam（Phase 2 Part B）：把 bundle 内容写入临时 staging，
// 再经现有 Skills lifecycle 物化目标拓扑。包中未出现的本机 Skill 永不触碰/删除。
// Phase 3 负责分类级快照/回滚；本模块只做内容验证、物化与脱敏报告。

export type SkillMaterializeResult = {readonly ok: boolean; readonly error?: string};

export type SkillMaterializeFn = (input: {
	readonly name: string;
	readonly snapshot: SkillSnapshot;
	readonly targets: readonly SkillTransferTarget[];
}) => Promise<SkillMaterializeResult>;

export type ImportSkillsOptions = SkillStorageOptions & {
	readonly dryRun?: boolean;
	readonly onProgress?: ProgressCallback;
	readonly exec?: SkillsExecFn;
	/** 测试注入 seam；默认走 services/skills-adoption 的官方 CLI lifecycle。 */
	readonly materialize?: SkillMaterializeFn;
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

function defaultMaterialize(options: ImportSkillsOptions): SkillMaterializeFn {
	return async ({name, snapshot, targets}) => {
		const result = await materializeSkillTargetsFromSnapshot(
			name,
			snapshot,
			{cc: targets.includes('cc'), cx: targets.includes('cx'), pi: targets.includes('pi')},
			options.onProgress,
			options.exec,
			options
		);
		return {ok: result.success, ...(result.error ? {error: result.error} : {})};
	};
}

async function materializeSkill(
	skill: ExportedSkill,
	materialize: SkillMaterializeFn,
	options: ImportSkillsOptions
): Promise<TransferResult<void>> {
	const stagingParent = options.tempDir ?? tmpdir();
	mkdirSync(stagingParent, {recursive: true});
	const staging = mkdtempSync(join(stagingParent, 'ccq-skill-import-'));
	let snapshot: SkillSnapshot | undefined;
	try {
		const staged = materializePortableTreeEntries(staging, skill.files, false);
		if (!staged.ok) {
			return transferFail(staged.kind, `Skill 内容写入失败：${skill.name}`);
		}

		snapshot = await createSkillSnapshot(join(staging, skill.name), skill.name, {
			homeDir: options.homeDir,
			tempDir: options.tempDir
		});
		const result = await materialize({name: skill.name, snapshot, targets: skill.targets});
		if (!result.ok) {
			// 失败时保留 lifecycle 快照供 Phase 3 回滚诊断。
			return transferFail('io', `Skill 导入失败：${skill.name}`);
		}

		await cleanupSkillSnapshot(snapshot);
		return transferOk(undefined);
	} catch {
		return transferFail('io', `Skill 导入失败：${skill.name}`);
	} finally {
		rmSync(staging, {recursive: true, force: true});
	}
}

/**
 * 合并导入 Skills 分类：只新增/覆盖包内 Skill，恢复 bundle 记录的目标拓扑。
 * `dryRun` 只返回 add/replace/unchanged/blocked 计数，零写盘。
 */
export async function importSkillsSection(data: unknown, options: ImportSkillsOptions = {}): Promise<TransferResult<SectionMergeReport>> {
	const parsed = parseSkillsSection(data);
	if (!parsed.ok) {
		return parsed;
	}

	const plan = await planSkillsImport(parsed.data, options);
	if (!plan.ok) {
		return plan;
	}

	const blocked = plan.data.items.filter(item => item.state === 'blocked');
	if (blocked.length > 0) {
		return transferFail('conflict', `本机同名 Skill 损坏，已停止导入：${blocked.map(item => item.name).join('、')}`);
	}

	const report = summarizePlan(plan.data.items);
	if (options.dryRun) {
		return transferOk(report, parsed.warnings);
	}

	const byId = new Map(parsed.data.skills.map(skill => [skill.id, skill]));
	const materialize = options.materialize ?? defaultMaterialize(options);
	const warnings = [...parsed.warnings];

	for (const item of plan.data.items) {
		if (item.state === 'unchanged') {
			continue;
		}

		const skill = byId.get(item.id);
		if (!skill) {
			continue;
		}

		const result = await materializeSkill(skill, materialize, options);
		if (!result.ok) {
			return result;
		}
	}

	return transferOk(report, warnings);
}
