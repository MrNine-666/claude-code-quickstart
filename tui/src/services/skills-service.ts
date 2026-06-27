import {
	listRepoSkills,
	searchSkills,
	type InstalledSkill,
	type RepoSkill,
	type RepoSkillsOutcome,
	type SearchSkillResult,
	type SkillsSearchOutcome
} from '../core/skills.js';
import {
	installMultipleSkills,
	installSkill,
	uninstallSkills,
	updateSkills,
	type InstallSkillInput,
	type SkillsActionResult
} from '../core/skills-actions.js';
import type {ProgressCallback} from '../core/exec.js';

// Skills service：TUI 视图唯一入口。搜索数据源固定为 skills find，不回退 catalogue（design D11）。
// 纯 service 函数，不依赖 view 层类型（createSkillsViewServices 装配在 views/skills-view-services.ts）。

export function searchSkillCatalogue(query: string): Promise<SkillsSearchOutcome> {
	return searchSkills(query);
}

export function installSearchResult(result: SearchSkillResult, onProgress?: ProgressCallback): Promise<SkillsActionResult> {
	const input: InstallSkillInput = {source: result.source || result.name, displayName: result.name};
	return installSkill(input, onProgress);
}

/** 需求③：列出某 repo 全部子 skill（skills add <repo> --list，--list 只列不装）。 */
export function listRepoSkillsForView(repo: string): Promise<RepoSkillsOutcome> {
	return listRepoSkills(repo);
}

/** 需求③：批量安装某 repo 下多个选中子 skill（单次多 --skill）。 */
export function installMultipleSkillsForView(
	input: {source: string; skillNames: readonly string[]; displayName?: string},
	onProgress?: ProgressCallback
): Promise<SkillsActionResult> {
	return installMultipleSkills(input, onProgress);
}

export function updateAllSkills(onProgress?: ProgressCallback): Promise<SkillsActionResult> {
	return updateSkills([], onProgress);
}

export function uninstallSelected(skillNames: readonly string[], onProgress?: ProgressCallback): Promise<SkillsActionResult> {
	return uninstallSkills(skillNames, onProgress);
}

export type {InstalledSkill, RepoSkill, RepoSkillsOutcome, SearchSkillResult, SkillsSearchOutcome, SkillsActionResult};
