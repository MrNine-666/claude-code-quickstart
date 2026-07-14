import type {AgentContext} from '../state/manage-state.js';
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
	agentContext: AgentContext | readonly AgentContext[] = 'cc',
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

/**
 * 需求③：批量安装某 repo 下多个选中子 skill（单次多 --skill）。
 * 含 cc 时按「谁用归谁」补齐为 `[cc, cx]` 双 agent 触发 symlink（与 installResultToTargets 同策略）；仅 cx 单 agent 直落本体。
 */
export function installMultipleSkillsForView(
	input: {source: string; skillNames: readonly string[]; displayName?: string},
	onProgress?: ProgressCallback,
	agentContext: AgentContext = 'cc'
): Promise<SkillsActionResult> {
	const callAgents: readonly AgentContext[] = agentContext === 'cc' ? ['cc', 'cx'] : ['cx'];
	return installMultipleSkills(input, onProgress, callAgents);
}

export function updateAllSkills(onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsActionResult> {
	return updateSkills([], onProgress, exec);
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
 * 多目标安装（Section 17.2）：一次调用同传全部选中侧的 `--agent` 以触发 symlink。
 *
 * 含 cc 时按「谁用归谁」补齐为 `[cc, cx]` 双 agent 单次调用——skills CLI 单一 skillsDir 会强制 copy，
 * 双 agent 令 uniqueDirs.size==2 且不传 --copy → 本体落 `~/.agents/skills`，`~/.claude/skills` 建软链指向本体；
 * 仅 cx 时单 agent 直落本体（universal，无 copy 问题）。UI 中 cx 草稿恒 true，含 cc 必然也含 cx，语义自洽。
 *
 * 双 agent 单次调用是原子的，无法 per-side 上报：一次失败则该次所有目标标失败（per-side 失败隔离退化）。
 * 返回值仍按 target 逐条映射同一结果，保持 UI `failed` 聚合兼容。
 */
export async function installResultToTargets(
	result: SearchSkillResult,
	targets: readonly AgentContext[],
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn
): Promise<readonly SkillsSideResult[]> {
	if (targets.length === 0) {
		return [];
	}

	// 含 cc → 双 agent 触发 symlink；仅 cx → 单 agent 直落本体。
	const callAgents: readonly AgentContext[] = targets.includes('cc') ? ['cc', 'cx'] : ['cx'];
	const callResult = await installSearchResult(result, onProgress, callAgents, exec);

	// 单次原子调用结果映射回每个选中 target，保持 per-side 聚合结构。
	return targets.map(agentContext => ({agentContext, result: callResult}));
}

/**
 * 切换 Claude Code 安装态（Section 17.3）：install → 一次传 `[cc, cx]` 双 agent（建本体 + symlink，
 * 本体 overwrite 不影响 cx 直读）；卸载 → `remove --agent claude-code` 单侧撤销（删 symlink，本体若 codex 仍用由 CLI 保留）。
 * 全走官方 CLI，不自删文件。
 */
export function toggleClaudeInstall(
	skill: SkillSharedRow,
	install: boolean,
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn
): Promise<SkillsActionResult> {
	if (install) {
		if (!skill.source) {
			return Promise.resolve({
				success: false,
				error: `无法恢复 ${skill.name} 的 Claude Code 安装：全局 skills lock 缺少来源，请重新搜索安装`
			});
		}

		const source = skill.ref && !skill.source.includes('#') ? `${skill.source}#${skill.ref}` : skill.source;
		return installSkill(
			{source, displayName: skill.name, skillName: skill.skillName ?? skill.name},
			onProgress,
			['cc', 'cx'],
			exec
		);
	}

	return uninstallSkills([skill.name], onProgress, 'cc', exec);
}

/**
 * 更新共享本体与所有注入侧（Section 17.4）：单次 `skills update -g -y`，由上游 lock 恢复所有 agent。
 */
export async function updateAllSkillsBothSides(onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsActionResult> {
	return updateSkills([], onProgress, exec);
}

/**
 * 全量卸载（Section 17.4）：单条 `skills remove <name> -g --yes`（**省略 `--agent`**）从所有 Agent 删 symlink + 本体，
 * 非挨个 agent。CLI 1.5.16 的 remove 不接受 `--agent '*'`（报 Invalid agents: * 并 exit 1），省略即默认全 agent + 无人再用则清本体。
 * 物理删除由 CLI 负责，ccq 绝不自删文件。
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
