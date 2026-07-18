import type {AgentContext} from '../state/manage-state.js';
import {
	getInstalledSkills,
	inspectInstalledSkillStorage,
	listRepoSkills,
	projectSharedSkills,
	readGlobalSkillLockMetadata,
	searchSkillIdentity,
	searchSkills,
	skillNameFromSearchResult,
	skillSourcesEquivalent,
	type InstalledSkill,
	type RepoSkill,
	type RepoSkillsOutcome,
	type SearchSkillResult,
	type SkillSharedRow,
	type SkillsSearchOutcome
} from '../core/skills.js';
import {
	cleanupSkillSnapshot,
	createSkillSnapshot,
	inspectSkillStorage,
	preferredSkillContentPath,
	type SkillSnapshot,
	type SkillStorageOptions
} from '../core/skills-storage.js';
import {
	installMultipleSkills,
	installSkill,
	createSkillsChildEnv,
	runSkillsRemove,
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
	exec?: SkillsExecFn,
	storageOptions: SkillStorageOptions = {}
): Promise<SkillsActionResult> {
	const source = result.source || result.name;
	const callAgents = Array.isArray(agentContext) ? agentContext : [agentContext as AgentContext];
	const input: InstallSkillInput = {
		source,
		displayName: result.name,
		skillName: skillNameFromSearchResult(result, source),
		copy: callAgents.length === 1,
		env: createSkillsChildEnv(storageOptions.homeDir, callAgents.includes('cx'))
	};
	return installSkill(input, onProgress, callAgents, exec);
}

export {skillNameFromSearchResult};

export type SkillsInstallPlanBatch = {
	readonly source: string;
	readonly skillNames: readonly string[];
};

export type SkillsInstallBatch = SkillsInstallPlanBatch & {
	readonly result: SkillsActionResult;
};

export type SkillsReplacementExecution = {
	readonly key: string;
	readonly skillName: string;
	readonly oldSource: string;
	readonly newSource: string;
	readonly success: boolean;
	readonly error?: string;
	readonly recoveryPath?: string;
	/** 最终共享 detection 确认前保留；仅由 cleanupConfirmedReplacementSnapshots 消费。 */
	readonly cleanupSnapshot?: SkillSnapshot;
};

export type SkillsBatchExecution = {
	readonly batches: readonly SkillsInstallBatch[];
	readonly replacements: readonly SkillsReplacementExecution[];
};

export type SkillsInstallExecutionOptions = {
	readonly installed?: readonly SkillSharedRow[];
	readonly storage?: SkillStorageOptions;
	readonly readLockMetadata?: typeof readGlobalSkillLockMetadata;
};

type PreparedReplacement = {
	readonly identity: NonNullable<ReturnType<typeof searchSkillIdentity>>;
	readonly installed: SkillSharedRow & {readonly source: string};
	readonly snapshot: SkillSnapshot;
};

/**
 * 把扁平跨来源选择转换为内部 source 批次。保持首次出现顺序，同 source 去重；
 * 不同 source 的同名 Skill 会争用全局安装身份，必须在任何 spawn 前拒绝。
 */
export function planSkillInstallBatches(results: readonly SearchSkillResult[]): readonly SkillsInstallPlanBatch[] {
	const batches = new Map<string, {readonly skillNames: string[]; readonly seen: Set<string>}>();
	const sourceBySkillName = new Map<string, string>();

	for (const result of results) {
		const identity = searchSkillIdentity(result);
		if (!identity) {
			throw new Error(`无法识别 Skill 来源：${result.name}`);
		}

		const existingSource = sourceBySkillName.get(identity.skillName);
		if (existingSource && existingSource !== identity.source) {
			throw new Error(`同名 Skill ${identity.skillName} 来自多个来源，无法同时安装`);
		}

		sourceBySkillName.set(identity.skillName, identity.source);
		const batch = batches.get(identity.source) ?? {skillNames: [], seen: new Set<string>()};
		if (!batch.seen.has(identity.skillName)) {
			batch.skillNames.push(identity.skillName);
			batch.seen.add(identity.skillName);
		}

		batches.set(identity.source, batch);
	}

	return [...batches.entries()].map(([source, batch]) => ({source, skillNames: batch.skillNames}));
}

function installAgentsForTargets(targets: readonly AgentContext[]): readonly AgentContext[] {
	if (targets.length === 0) {
		throw new Error('未选择安装目标');
	}

	return targets.includes('cc') ? ['cc', 'cx'] : ['cx'];
}

/**
 * 执行一次用户可见的跨来源批量安装。内部按 source 顺序调用现有一源多 Skill 原语，
 * 每个 source 的失败只记录结果，不阻断后续批次。
 */
export async function installSearchResultsToTargets(
	results: readonly SearchSkillResult[],
	targets: readonly AgentContext[],
	onProgress?: ProgressCallback,
	exec?: SkillsExecFn,
	options: SkillsInstallExecutionOptions = {}
): Promise<SkillsBatchExecution> {
	if (results.length === 0) {
		throw new Error('未选择要安装的 Skill');
	}

	const installedByName = new Map((options.installed ?? []).map(skill => [skill.name, skill]));
	if (options.installed) {
		await validateInstallCandidates(results, installedByName, options.storage);
	}

	const plan = planSkillInstallBatches(results);
	const callAgents = installAgentsForTargets(targets);
	const batches: SkillsInstallBatch[] = [];
	const replacements: SkillsReplacementExecution[] = [];

	for (const batch of plan) {
		let prepared: readonly PreparedReplacement[] = [];
		try {
			prepared = await prepareReplacements(batch, results, installedByName, options.storage);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			batches.push({...batch, result: {success: false, error: message}});
			continue;
		}

		const result = await installMultipleSkills(
			{
				source: batch.source,
				skillNames: batch.skillNames,
				displayName: `${batch.source}（${batch.skillNames.length} 个 Skill）`,
				copy: callAgents.length === 1,
				env: createSkillsChildEnv(options.storage?.homeDir, callAgents.includes('cx'))
			},
			onProgress,
			callAgents,
			exec
		);
		const replacementResults = await finishReplacements(
			prepared,
			result,
			targets,
			onProgress,
			exec,
			options
		);
		replacements.push(...replacementResults);
		const replacementFailure = replacementResults.find(item => !item.success);
		batches.push({
			...batch,
			result: replacementFailure
				? {success: false, error: replacementFailure.error ?? '同名来源替换对账失败'}
				: result
		});
	}

	return {batches, replacements};
}

async function validateInstallCandidates(
	results: readonly SearchSkillResult[],
	installedByName: ReadonlyMap<string, SkillSharedRow>,
	storageOptions: SkillStorageOptions = {}
): Promise<void> {
	for (const result of results) {
		const identity = searchSkillIdentity(result);
		if (!identity || installedByName.has(identity.skillName)) {
			continue;
		}

		const storage = await inspectSkillStorage(identity.skillName, storageOptions);
		if (storage.kind !== 'missing') {
			throw new Error(`${identity.skillName} 的安装目录已存在但未被检测识别，拒绝自动覆盖`);
		}
	}
}

async function prepareReplacements(
	batch: SkillsInstallPlanBatch,
	results: readonly SearchSkillResult[],
	installedByName: ReadonlyMap<string, SkillSharedRow>,
	storageOptions: SkillStorageOptions = {}
): Promise<readonly PreparedReplacement[]> {
	const prepared: PreparedReplacement[] = [];
	try {
		for (const result of results) {
			const identity = searchSkillIdentity(result);
			if (!identity || identity.source !== batch.source || !batch.skillNames.includes(identity.skillName)) {
				continue;
			}

			const installed = installedByName.get(identity.skillName);
			if (!installed) {
				continue;
			}

			if (!installed.source || skillSourcesEquivalent(installed.source, identity.source)) {
				throw new Error(`${identity.skillName} 已安装且来源无法证明为不同，拒绝覆盖`);
			}

			const inspection = await inspectSkillStorage(identity.skillName, storageOptions);
			const sourcePath = preferredSkillContentPath(inspection);
			if (!sourcePath) {
				throw new Error(`${identity.skillName} 没有可恢复的旧内容，拒绝来源替换`);
			}

			prepared.push({
				identity,
				installed: {...installed, source: installed.source},
				snapshot: await createSkillSnapshot(sourcePath, identity.skillName, storageOptions)
			});
		}
		return prepared;
	} catch (error) {
		await Promise.all(prepared.map(item => cleanupSkillSnapshot(item.snapshot)));
		throw error;
	}
}

async function finishReplacements(
	prepared: readonly PreparedReplacement[],
	action: SkillsActionResult,
	targets: readonly AgentContext[],
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillsInstallExecutionOptions
): Promise<readonly SkillsReplacementExecution[]> {
	if (prepared.length === 0) {
		return [];
	}

	if (!action.success) {
		return prepared.map(item => replacementFailure(item, action.error ?? '新来源安装失败'));
	}

	const results: SkillsReplacementExecution[] = [];
	for (const item of prepared) {
		results.push(await verifyAndFinishReplacement(item, targets, onProgress, exec, options));
	}

	return results;
}

async function verifyAndFinishReplacement(
	prepared: PreparedReplacement,
	targets: readonly AgentContext[],
	onProgress: ProgressCallback | undefined,
	exec: SkillsExecFn | undefined,
	options: SkillsInstallExecutionOptions
): Promise<SkillsReplacementExecution> {
	const storageOptions = options.storage ?? {};
	const readLock = options.readLockMetadata ?? readGlobalSkillLockMetadata;
	const postflight = await inspectSkillStorage(prepared.identity.skillName, storageOptions);
	const selectedProjectionReady = targets.includes('cc')
		? postflight.kind === 'shared-symlink' || postflight.kind === 'shared-copy'
		: postflight.canonicalValid;
	const lock = await readLock(storageOptions.homeDir);
	const newLockSource = lock.get(prepared.identity.skillName)?.source;
	if (!selectedProjectionReady || !newLockSource || !skillSourcesEquivalent(newLockSource, prepared.identity.source)) {
		return replacementFailure(prepared, postflight.error ?? 'canonical、所选 Agent 或 lock source 对账失败');
	}

	if (!targets.includes('cc') && prepared.installed.claudeInjected) {
		const cleanup = await runSkillsRemove({
			skillNames: [prepared.identity.skillName],
			agents: ['cc'],
			env: createSkillsChildEnv(storageOptions.homeDir, true)
		}, onProgress, exec);
		if (!cleanup.success) {
			return replacementFailure(prepared, cleanup.error ?? '未能清理未选择的 Claude Code 旧投影');
		}

		const finalStorage = await inspectSkillStorage(prepared.identity.skillName, storageOptions);
		const finalLock = await readLock(storageOptions.homeDir);
		const finalLockSource = finalLock.get(prepared.identity.skillName)?.source;
		if (
			finalStorage.kind !== 'canonical-only'
			|| !finalLockSource
			|| !skillSourcesEquivalent(finalLockSource, prepared.identity.source)
		) {
			return replacementFailure(prepared, finalStorage.error ?? '清理旧投影后 canonical 或 lock source 对账失败');
		}
	}

	return replacementSuccess(prepared);
}

/** 共享 detection 已确认的来源替换才提交事务并清理旧内容快照。 */
export async function cleanupConfirmedReplacementSnapshots(
	replacements: readonly SkillsReplacementExecution[],
	confirmedKeys: readonly string[]
): Promise<void> {
	const confirmed = new Set(confirmedKeys);
	await Promise.all(replacements.flatMap(item => (
		item.success && item.cleanupSnapshot && confirmed.has(item.key)
			? [cleanupSkillSnapshot(item.cleanupSnapshot)]
			: []
	)));
}

function replacementSuccess(prepared: PreparedReplacement): SkillsReplacementExecution {
	return {
		key: prepared.identity.key,
		skillName: prepared.identity.skillName,
		oldSource: prepared.installed.source,
		newSource: prepared.identity.source,
		success: true,
		recoveryPath: prepared.snapshot.skillPath,
		cleanupSnapshot: prepared.snapshot
	};
}

function replacementFailure(prepared: PreparedReplacement, error: string): SkillsReplacementExecution {
	return {
		key: prepared.identity.key,
		skillName: prepared.identity.skillName,
		oldSource: prepared.installed.source,
		newSource: prepared.identity.source,
		success: false,
		error,
		recoveryPath: prepared.snapshot.skillPath
	};
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
	return installMultipleSkills({
		...input,
		copy: callAgents.length === 1,
		env: createSkillsChildEnv(undefined, callAgents.includes('cx'))
	}, onProgress, callAgents);
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
	const callAgents = installAgentsForTargets(targets);
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
 * 更新单个 skill（列表页 U）：`skills update <name> -g -y`，由上游 lock 只重装该 skill 的所有注入侧。
 * 与全量更新同走 updateSkills（无 --agent），仅名单从空改为单条，语义自洽。
 */
export async function updateSingleSkill(name: string, onProgress?: ProgressCallback, exec?: SkillsExecFn): Promise<SkillsActionResult> {
	if (!name) {
		return {success: false, error: '未选择要更新的 Skill'};
	}

	return updateSkills([name], onProgress, exec);
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
export async function loadSharedSkillStatus(exec?: SkillsExecFn, storageOptions: SkillStorageOptions = {}): Promise<readonly SkillSharedRow[]> {
	const installed = exec ? await getInstalledSkills(exec) : await getInstalledSkills();
	return projectSharedSkills(await inspectInstalledSkillStorage(installed, storageOptions));
}

export type {InstalledSkill, RepoSkill, RepoSkillsOutcome, SearchSkillResult, SkillSharedRow, SkillsSearchOutcome, SkillsActionResult};
