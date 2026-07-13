import {AGENT_CONTEXT_ORDER, type AgentContext} from '../state/manage-state.js';
import {
	getInstalledSkills,
	listRepoSkills,
	projectSharedSkills,
	searchSkills,
	type InstalledSkill,
	type RepoSkill,
	type RepoSkillsOutcome,
	type SearchSkillResult,
	type SkillSharedRow,
	type SkillsSearchOutcome
} from '../core/skills.js';
import {
	installMultipleSkills,
	installSkill,
	uninstallSkills,
	updateSkills,
	type InstallSkillInput,
	type SkillsActionResult,
	type SkillsExecFn
} from '../core/skills-actions.js';
import type {ProgressCallback} from '../core/exec.js';

// Skills service：TUI 视图唯一入口。搜索数据源固定为 skills find，不回退 catalogue（design D11）。
// 纯 service 函数，不依赖 view 层类型（createSkillsViewServices 装配在 views/skills-view-services.ts）。

export function searchSkillCatalogue(query: string): Promise<SkillsSearchOutcome> {
	return searchSkills(query);
}

export function installSearchResult(
	result: SearchSkillResult,
	onProgress?: ProgressCallback,
	agentContext: AgentContext = 'cc',
	exec?: SkillsExecFn
): Promise<SkillsActionResult> {
	const source = result.source || result.name;
	const input: InstallSkillInput = {
		source,
		displayName: result.name,
		skillName: skillNameFromSearchResult(result, source)
	};
	return installSkill(input, onProgress, agentContext, exec);
}

export function skillNameFromSearchResult(result: SearchSkillResult, source: string): string | undefined {
	const prefix = `${source}@`;
	if (!source || !result.name.startsWith(prefix)) {
		return undefined;
	}

	const skillName = result.name.slice(prefix.length).trim();
	return skillName || undefined;
}

/** 需求③：列出某 repo 全部子 skill（skills add <repo> --list，--list 只列不装）。 */
export function listRepoSkillsForView(repo: string, agentContext: AgentContext = 'cc'): Promise<RepoSkillsOutcome> {
	return listRepoSkills(repo, agentContext);
}

/** 需求③：批量安装某 repo 下多个选中子 skill（单次多 --skill）。 */
export function installMultipleSkillsForView(
	input: {source: string; skillNames: readonly string[]; displayName?: string},
	onProgress?: ProgressCallback,
	agentContext: AgentContext = 'cc'
): Promise<SkillsActionResult> {
	return installMultipleSkills(input, onProgress, agentContext);
}

export function updateAllSkills(onProgress?: ProgressCallback, agentContext: AgentContext = 'cc', exec?: SkillsExecFn): Promise<SkillsActionResult> {
	return updateSkills([], onProgress, agentContext, exec);
}

export function uninstallSelected(
	skillNames: readonly string[],
	onProgress?: ProgressCallback,
	agentContext: AgentContext = 'cc',
	exec?: SkillsExecFn
): Promise<SkillsActionResult> {
	return uninstallSkills(skillNames, onProgress, agentContext, exec);
}

// ── 共享本体 + 双侧注入（shared-resource-injection-ui Section 17） ────────────────

/** 单侧安装结果（installResultToTargets 逐侧聚合用）。 */
export type SkillsSideResult = {readonly agentContext: AgentContext; readonly result: SkillsActionResult};

/**
 * 多目标安装（Section 17.2）：按选中侧逐侧调 installSearchResult。
 * cc → `add --agent claude-code`（本体 + symlink）；cx → `add --agent codex`（仅本体）。
 * 任一侧失败返回该侧错误但不中断其余侧（per-side 结果聚合）。
 */
export async function installResultToTargets(
	result: SearchSkillResult,
	targets: readonly AgentContext[],
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn
): Promise<readonly SkillsSideResult[]> {
	const sides: SkillsSideResult[] = [];
	for (const agentContext of targets) {
		const sideResult = await installSearchResult(result, onProgress, agentContext, exec);
		sides.push({agentContext, result: sideResult});
	}

	return sides;
}

/**
 * 切换 Claude Code 安装态（Section 17.3）：install → `add --agent claude-code`（建本体 + symlink）；
 * 卸载 → `remove --agent claude-code`（删 symlink，本体若 codex 仍用由 CLI 保留）。全走官方 CLI，不自删文件。
 */
export function toggleClaudeInstall(
	name: string,
	install: boolean,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn
): Promise<SkillsActionResult> {
	if (install) {
		return installSkill({source: name, displayName: name}, onProgress, 'cc', exec);
	}

	return uninstallSkills([name], onProgress, 'cc', exec);
}

/**
 * 更新两侧（Section 17.4）：cc/cx 各调一次 updateSkills（`update --agent <侧>`），串行汇总。
 * 任一侧失败即返回该侧错误；两侧皆 noChange 才报 noChange。
 */
export async function updateAllSkillsBothSides(onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsActionResult> {
	let allNoChange = true;
	for (const agentContext of AGENT_CONTEXT_ORDER) {
		const result = await updateSkills([], onProgress, agentContext, exec);
		if (!result.success) {
			return result;
		}

		if (!result.noChange) {
			allNoChange = false;
		}
	}

	return {success: true, noChange: allNoChange};
}

/**
 * 全量卸载（Section 17.4）：单条 `skills remove <name> -g --agent '*' --yes` 从所有 Agent 删 symlink + 本体，
 * 非挨个 agent。物理删除由 CLI 负责，ccq 绝不自删文件。
 */
export function uninstallSkillAllAgents(name: string, onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsActionResult> {
	return uninstallSkills([name], onProgress, '*', exec);
}

/**
 * 双侧共享列表（Section 17.5）：跑一次无 `--agent` 的 getInstalledSkills → projectSharedSkills。
 * 每次实时读，不缓存；供视图 refresh 复用。exec 缝仅供测试注入。
 */
export async function loadSharedSkillStatus(exec?: SkillsExecFn): Promise<readonly SkillSharedRow[]> {
	const installed = exec ? await getInstalledSkills(exec) : await getInstalledSkills();
	return projectSharedSkills(installed);
}

export type {InstalledSkill, RepoSkill, RepoSkillsOutcome, SearchSkillResult, SkillSharedRow, SkillsSearchOutcome, SkillsActionResult};
