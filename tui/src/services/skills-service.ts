import {searchSkills, type InstalledSkill, type SearchSkillResult, type SkillsSearchOutcome} from '../core/skills.js';
import {
	installSkill,
	uninstallSkills,
	updateSkills,
	type InstallSkillInput,
	type SkillsActionResult
} from '../core/skills-actions.js';
import type {ProgressCallback} from '../core/exec.js';

// Skills service：TUI 视图唯一入口。搜索数据源固定为 skills find，不回退 catalogue（design D11）。

export function searchSkillCatalogue(query: string): Promise<SkillsSearchOutcome> {
	return searchSkills(query);
}

export function installSearchResult(result: SearchSkillResult, onProgress?: ProgressCallback): Promise<SkillsActionResult> {
	const input: InstallSkillInput = {source: result.source || result.name, displayName: result.name};
	return installSkill(input, onProgress);
}

export function updateAllSkills(onProgress?: ProgressCallback): Promise<SkillsActionResult> {
	return updateSkills([], onProgress);
}

export function uninstallSelected(skillNames: readonly string[], onProgress?: ProgressCallback): Promise<SkillsActionResult> {
	return uninstallSkills(skillNames, onProgress);
}

export type {InstalledSkill, SearchSkillResult, SkillsSearchOutcome, SkillsActionResult};
