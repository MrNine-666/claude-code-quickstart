import {busyActionTitle, toast, type BusyOverlayState} from '../../components/index.js';
import {abortable, throwIfAborted, type ProgressCallback} from '../../core/exec.js';
import {isSafeHttpUrl, openUrl} from '../../core/open-url.js';
import {searchSkillIdentity} from '../../core/skills.js';
import {
	itemAvailableOn,
	normalizeSkillSourceIdentity,
	otherAgentsOf,
	skillSourcesEquivalent,
	storageRootsOf,
	type SkillsStorageRoot
} from '../../core/skills-installed.js';
import {targetTopologyOfDraft} from '../../core/skills-storage.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../hooks/use-task-cancellation.js';
import {AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {
	currentTopologyOfItem,
	pendingBatchInstances,
	pendingInstallResults,
	pendingInstance,
	selectedOrCurrentInstalled,
	selectedInstalled,
	uninstallTargets,
	type InstallDraft,
	type SkillsViewMode,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import type {
	InstalledSkillItem,
	SkillsDetection,
	SearchSkillResult,
	SkillTopology,
	SkillsAdoptionResult,
	SkillsBatchExecution,
	SkillsViewDispatch,
	SkillsViewServices
} from './skills-view-types.js';

export function createSkillsBusyOverlayState(view: SkillsViewState, onCancel: () => void): BusyOverlayState | null {
	if (!view.busyAction) return null;
	return {
		title: view.batchStage === 'reconciling' ? '正在同步 Skills 状态' : busyActionTitle(view.busyAction, ' Skill'),
		message: view.progress.at(-1),
		onCancel
	};
}

function progressSink(dispatch: SkillsViewDispatch): ProgressCallback {
	return event => {
		if (event.instruction) dispatch({type: 'progress', message: event.instruction});
	};
}

export function runSearchAction(query: string, services: SkillsViewServices, dispatch: SkillsViewDispatch): void {
	void services.searchSkills(query).then(outcome => {
		if (outcome.ok) {
			dispatch({type: 'search-done', results: outcome.results});
			if (outcome.results.length === 0) toast.info('没有匹配的 Skill');
		} else {
			dispatch({type: 'search-failed', error: outcome.error, rawSummary: outcome.rawSummary});
		}
	});
}

export function openCurrentSkillSourceAction(view: SkillsViewState): void {
	const current = selectedInstalled(view);
	const url = current && current.provenance.kind === 'known' ? current.provenance.sourceUrl : undefined;
	if (!current || !url || !isSafeHttpUrl(url)) {
		toast.info('无来源链接');
		return;
	}
	const skillName = current.name;

	void openUrl(url).then(result => {
		if (result.ok) toast.success(`已打开 ${skillName} 来源`);
		else toast.error(result.error);
	});
}

export function runInstallToTargetsAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<SkillsDetection>,
	taskCancellation: TaskCancellation
): void {
	const skills = pendingInstallResults(view);
	if (skills.length === 0) {
		dispatch({type: 'cancel'});
		toast.info('没有可安装的 Skill');
		return;
	}
	const targets = AGENT_CONTEXT_ORDER.filter(ctx => view.installDraft[ctx]);
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'confirm'});
	void (async () => {
		try {
			const execution = await services.installBatchToTargets(skills, targets, progressSink(dispatch), view.installed, signal);
			throwIfAborted(signal);
			dispatch({type: 'install-execution-done'});
			const refreshed = await abortable(cache.refreshAndWait(), signal);
			throwIfAborted(signal);
			if (refreshed?.status !== 'success') {
				const failedSources = execution.batches
					.filter(batch => !batch.result.success)
					.map(batch => `${batch.source}: ${batch.result.error ?? '安装失败'}`);
				const recoverySnapshots = execution.replacements
					.filter(item => item.recoveryPath)
					.map(item => `${item.skillName} 恢复快照：${item.recoveryPath}`);
				const detail = [refreshed?.error ?? '安装状态检测未完成', ...failedSources, ...recoverySnapshots].join('\n');
				dispatch({type: 'install-reconcile-failed', error: detail});
				return;
			}

			const installed = refreshed.result ?? [];
			const confirmedKeys = confirmedInstallKeys(skills, view.installed, installed, execution, targets);
			await services.finalizeReplacementSnapshots(execution.replacements, confirmedKeys);
			throwIfAborted(signal);
			const confirmed = new Set(confirmedKeys);
			const replacementErrors = execution.replacements.flatMap(item => {
				if (!item.success) {
					return [
						`${item.skillName}: ${item.error ?? '来源替换失败'}${item.recoveryPath ? `（恢复快照：${item.recoveryPath}）` : ''}`
					];
				}
				return confirmed.has(item.key)
					? []
					: [`${item.skillName}: 最终检测未确认来源替换${item.recoveryPath ? `（恢复快照：${item.recoveryPath}）` : ''}`];
			});
			dispatch({
				type: 'install-reconciled',
				installed,
				confirmedKeys,
				...(replacementErrors.length > 0 ? {error: replacementErrors.join('\n')} : {})
			});
			const missingCount = skills.length - confirmedKeys.length;
			if (missingCount === 0) toast.success(`已确认安装 ${confirmedKeys.length} 个 Skill`);
			else toast.info(`安装结果：已确认 ${confirmedKeys.length}，仍未安装 ${missingCount}`);
		} catch (error) {
			if (!signal.aborted) dispatch({type: 'action-failed', error: errorMessage(error)});
		} finally {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		}
	})();
}

/**
 * 安装确认（R4）：只有刷新后的 Item 同时匹配 `(name, sourceIdentity)` 与目标 Agent
 * 投影才算成功。仅按名称存在即判定成功会把同名另一来源误报为本次安装结果。
 */
function confirmedInstallKeys(
	results: readonly SearchSkillResult[],
	previous: readonly InstalledSkillItem[],
	installed: readonly InstalledSkillItem[],
	execution: SkillsBatchExecution,
	targets: readonly AgentContext[]
): readonly string[] {
	const replacementByKey = new Map(execution.replacements.map(item => [item.key, item]));
	const findBySource = (items: readonly InstalledSkillItem[], name: string, source: string): InstalledSkillItem | undefined =>
		items.find(
			item =>
				item.name === name &&
				item.provenance.kind === 'known' &&
				skillSourcesEquivalent(item.provenance.installSource, source)
		);

	return results.flatMap(result => {
		const identity = searchSkillIdentity(result);
		if (!identity) return [];
		const current = findBySource(installed, identity.skillName, identity.source);
		if (!current) return [];

		// 目标 Agent 侧必须全部出现在刷新后的 agents 并集里。
		const targetReady = targets.every(target => itemAvailableOn(current, target));
		if (!targetReady) return [];

		// 覆盖安装（同名异源）额外要求 replacement 事务成功。
		const replacedSameName = previous.some(
			item =>
				item.name === identity.skillName &&
				(item.provenance.kind !== 'known' || !skillSourcesEquivalent(item.provenance.installSource, identity.source))
		);
		if (!replacedSameName) return [identity.key];
		const replacement = replacementByKey.get(identity.key);
		return replacement === undefined || replacement.success ? [identity.key] : [];
	});
}

export function runTopologyTransitionAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<SkillsDetection>,
	taskCancellation: TaskCancellation
): void {
	// 确认后只认已快照的逻辑实例，避免刷新排序把迁移打到同名另一来源（R2/R6）。
	const current = pendingInstance(view) ?? selectedInstalled(view);
	const target = targetTopologyOfDraft(view.installDraft);
	if (!current || target === 'empty') {
		dispatch({type: 'action-failed', error: '当前 Skill 或目标拓扑无效'});
		return;
	}
	if (!current.capabilities.migrate) {
		dispatch({type: 'action-failed', error: '未知来源的 Skill 无法迁移或切换 Agent'});
		return;
	}
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'confirm'});
	void (async () => {
		try {
			const result = await services.transitionTopology(current, target, progressSink(dispatch), signal);
			throwIfAborted(signal);
			await finishTopologyLifecycle(result, cache, dispatch, current, target, signal);
		} catch (error) {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `拓扑切换失败：${errorMessage(error)}`});
		} finally {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		}
	})();
}

async function finishTopologyLifecycle(
	result: SkillsAdoptionResult,
	cache: DetectionCache<SkillsDetection>,
	dispatch: SkillsViewDispatch,
	item: InstalledSkillItem,
	target: SkillTopology,
	signal: AbortSignal
): Promise<void> {
	const name = item.name;
	const recovery = result.recoveryPath ? `\n恢复快照：${result.recoveryPath}` : '';
	const error = result.success ? undefined : `${result.error ?? '拓扑切换失败'}${recovery}`;
	if (!result.mutated) {
		dispatch({type: 'action-failed', error: error ?? '未执行任何变更'});
		return;
	}
	await reconcileManagedLifecycle(
		cache,
		dispatch,
		{
			message:
				result.outcome === 'complete'
					? `${name} 已切换为${topologyLabel(target)}`
					: result.outcome === 'partial'
						? `${name} 内容可用，但共享投影尚未完成`
						: result.outcome === 'restored'
							? `${name} 切换失败，已恢复原拓扑`
							: undefined,
			warning: result.outcome === 'partial' || result.outcome === 'restored',
			error,
			...(result.outcome === 'complete' ? {expected: {instanceId: item.id, target}} : {})
		},
		signal
	);
}

async function reconcileManagedLifecycle(
	cache: DetectionCache<SkillsDetection>,
	dispatch: SkillsViewDispatch,
	feedback: {
		readonly message?: string;
		readonly warning?: boolean;
		readonly error?: string;
		readonly expected?: {readonly instanceId: string; readonly target: SkillTopology};
	},
	signal: AbortSignal
): Promise<void> {
	const refreshed = await abortable(cache.refreshAndWait(), signal);
	throwIfAborted(signal);
	if (refreshed?.status !== 'success') {
		const detectionError = refreshed?.error ?? '安装状态检测未完成';
		dispatch({type: 'action-failed', error: feedback.error ? `${feedback.error}\n状态复检失败：${detectionError}` : detectionError});
		return;
	}
	const installed = refreshed.result ?? [];
	if (feedback.expected) {
		// 复检按操作前快照的实例 id 定位，避免同名另一来源被当作本次迁移结果（R6）。
		const current = installed.find((item: InstalledSkillItem) => item.id === feedback.expected!.instanceId);
		if (!current || currentTopologyOfItem(current) !== feedback.expected.target) {
			dispatch({type: 'action-failed', error: '最终检测未确认目标拓扑'});
			return;
		}
	}
	dispatch({type: 'lifecycle-reconciled', installed, ...(feedback.error ? {error: feedback.error} : {})});
	if (feedback.message) {
		if (feedback.warning) toast.info(feedback.message);
		else toast.success(feedback.message);
	}
}

export function runConfirmedUninstallAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<SkillsDetection>,
	taskCancellation: TaskCancellation
): void {
	// 删除目标取自确认时的实例快照，不再按 cursor 或 name 重查（R7）。
	const targets = uninstallTargets(view);
	if (targets.length === 0) {
		dispatch({type: 'action-failed', error: '没有选中要卸载的 skill'});
		return;
	}
	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.uninstallInstances(targets, view.installed, progressSink(dispatch), signal)
		.then(async outcome => {
			if (signal.aborted) return;
			if (!outcome.mutated) {
				dispatch({type: 'action-failed', error: outcome.error ?? '卸载失败'});
				return;
			}

			// 不做名称级乐观过滤：最终状态只由完整复检的 JSON 投影决定（R1/R7）。
			const refreshed = await abortable(cache.refreshAndWait(), signal);
			throwIfAborted(signal);
			if (refreshed?.status !== 'success') {
				const detectionError = refreshed?.error ?? '卸载后状态复检未完成';
				dispatch({
					type: 'action-failed',
					error: outcome.error ? `${outcome.error}\n状态复检失败：${detectionError}` : detectionError
				});
				return;
			}

			const error = outcome.outcome === 'complete' ? undefined : outcome.error ?? '卸载未完全完成';
			dispatch({type: 'uninstall-reconciled', installed: refreshed.result ?? [], ...(error ? {error} : {})});
			const completeCount = outcome.items.filter(item => item.result.outcome === 'complete').length;
			if (outcome.outcome === 'complete') toast.success(`已卸载 ${completeCount} 个 Skill`);
			else toast.info(`${completeCount}/${targets.length} 个 Skill 卸载完成，已按最新检测结果刷新`);
		})
		.catch(error => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `卸载失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
}

export function runUpdateSelectedIfReadyAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<SkillsDetection>,
	taskCancellation: TaskCancellation
): void {
	const targets = pendingBatchInstances(view).length > 0 ? pendingBatchInstances(view) : selectedOrCurrentInstalled(view);
	if (!targets.some(item => item.capabilities.update)) return;
	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.updateInstances(targets, progressSink(dispatch), signal)
		.then(result => reconcileUpdateLifecycle(
			result,
			cache,
			dispatch,
			signal,
			result.noChange
				? `${result.updatedNames.length} 个名称已是最新版本`
				: `已更新 ${result.updatedNames.length} 个名称${result.skippedInstanceIds.length > 0 ? `，跳过 ${result.skippedInstanceIds.length} 个未知来源` : ''}`
		))
		.catch((error: unknown) => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `更新失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
}

async function reconcileUpdateLifecycle(
	result: {readonly success: boolean; readonly error?: string; readonly noChange?: boolean},
	cache: DetectionCache<SkillsDetection>,
	dispatch: SkillsViewDispatch,
	signal: AbortSignal,
	successMessage: string
): Promise<void> {
	if (signal.aborted) return;
	const refreshed = await abortable(cache.refreshAndWait(), signal);
	throwIfAborted(signal);
	if (refreshed?.status !== 'success') {
		const detectionError = refreshed?.error ?? '更新后状态复检未完成';
		dispatch({type: 'action-failed', error: result.error ? `${result.error}\n状态复检失败：${detectionError}` : detectionError});
		return;
	}

	if (result.success) {
		dispatch({type: 'lifecycle-reconciled', installed: refreshed.result ?? []});
		toast.success(successMessage);
		return;
	}

	dispatch({type: 'lifecycle-reconciled', installed: refreshed.result ?? [], error: result.error ?? '更新失败'});
}

export function skillsPageOf(mode: SkillsViewMode, busyReturnMode?: 'list' | 'install'): 'list' | 'install' {
	if (mode === 'install' || mode === 'select-install-target' || mode === 'confirm-source-replacement') return 'install';
	if (mode === 'busy') return busyReturnMode ?? 'list';
	return 'list';
}

export function topologyLabel(topology: SkillTopology | undefined): string {
	return topology === 'claude-only'
		? '仅 Claude Code'
		: topology === 'codex-only'
			? '仅 Codex'
			: topology === 'shared'
				? '双侧共享'
				: '部分完成';
}

/** 存储根展示名。只用于展示 JSON `path` 的归类结果，不参与身份或能力判定。 */
export function storageRootLabel(root: SkillsStorageRoot): string {
	switch (root) {
		case 'claude':
			return '.claude/skills';
		case 'agents':
			return '.agents/skills';
		case 'codex':
			return '.codex/skills';
		default:
			return '其它位置';
	}
}

/**
 * 来源展示（R2）。`source` 与 `sourceUrl` 是两个独立展示字段，两者都缺失时显示
 * `未知来源`；不猜测、不从 lock 或目录反推。
 */
/** 来源展示：`source` 与 `sourceUrl` 都缺失时显示 `未知来源`（R2）。 */
export function provenanceLabel(item: InstalledSkillItem | undefined): string {
	if (item?.provenance.kind !== 'known') {
		return '未知来源';
	}

	const {source, sourceUrl} = item.provenance;
	return [source, sourceUrl].filter(Boolean).join('  ') || '未知来源';
}

export function targetTopologyOfInstallDraft(draft: InstallDraft): SkillTopology | 'empty' {
	return targetTopologyOfDraft(draft);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
