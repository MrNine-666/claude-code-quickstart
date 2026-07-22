import {busyActionTitle, toast, type BusyOverlayState} from '../../components/index.js';
import {abortable, throwIfAborted, type ProgressCallback} from '../../core/exec.js';
import {projectSharedSkills, searchSkillIdentity, skillSourcesEquivalent} from '../../core/skills.js';
import {targetTopologyOfDraft, topologyOfInspection, type SkillStorageInspection} from '../../core/skills-storage.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../hooks/use-task-cancellation.js';
import {AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {
	pendingInstallResults,
	selectedInstalled,
	uninstallTargets,
	type InstallDraft,
	type SkillsViewMode,
	type SkillsViewState
} from '../../state/skills-view-state.js';
import type {
	InstalledSkill,
	SearchSkillResult,
	SkillSharedRow,
	SkillTopology,
	SkillsAdoptionResult,
	SkillsBatchExecution,
	SkillsViewDispatch,
	SkillsViewServices
} from './skills-view-types.js';

export function projectSkillsAction(skills: readonly InstalledSkill[]): readonly SkillSharedRow[] {
	return projectSharedSkills(skills);
}

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

export function runInstallToTargetsAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<InstalledSkill[]>,
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

			const installed = projectSharedSkills(refreshed.result ?? []);
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

function confirmedInstallKeys(
	results: readonly SearchSkillResult[],
	previous: readonly SkillSharedRow[],
	installed: readonly SkillSharedRow[],
	execution: SkillsBatchExecution,
	targets: readonly AgentContext[]
): readonly string[] {
	const previousByName = new Map(previous.map(skill => [skill.name, skill]));
	const installedByName = new Map(installed.map(skill => [skill.name, skill]));
	const replacementByKey = new Map(execution.replacements.map(item => [item.key, item]));
	return results.flatMap(result => {
		const identity = searchSkillIdentity(result);
		if (!identity) return [];
		const current = installedByName.get(identity.skillName);
		if (!current) return [];
		const previousSkill = previousByName.get(identity.skillName);
		const isReplacement = Boolean(previousSkill?.source && !skillSourcesEquivalent(previousSkill.source, identity.source));
		if (!isReplacement) return [identity.key];
		const replacement = replacementByKey.get(identity.key);
		const targetReady = targets.includes('cc')
			? current.codexAvailable && current.claudeInjected
			: current.codexAvailable && !current.claudeInjected;
		return replacement?.success && targetReady && Boolean(current.source && skillSourcesEquivalent(current.source, identity.source))
			? [identity.key]
			: [];
	});
}

export function runTopologyTransitionAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	const current = selectedInstalled(view);
	const target = targetTopologyOfDraft(view.installDraft);
	if (!current || target === 'empty') {
		dispatch({type: 'action-failed', error: '当前 Skill 或目标拓扑无效'});
		return;
	}
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'confirm'});
	void (async () => {
		try {
			const result = await services.transitionTopology(current, target, progressSink(dispatch), signal);
			throwIfAborted(signal);
			await finishTopologyLifecycle(result, cache, dispatch, current.name, target, signal);
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
	cache: DetectionCache<InstalledSkill[]>,
	dispatch: SkillsViewDispatch,
	name: string,
	target: SkillTopology,
	signal: AbortSignal
): Promise<void> {
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
			...(result.outcome === 'complete' ? {expected: {name, target}} : {})
		},
		signal
	);
}

async function reconcileManagedLifecycle(
	cache: DetectionCache<InstalledSkill[]>,
	dispatch: SkillsViewDispatch,
	feedback: {
		readonly message?: string;
		readonly warning?: boolean;
		readonly error?: string;
		readonly expected?: {readonly name: string; readonly target: SkillTopology};
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
	const installed = projectSharedSkills(refreshed.result ?? []);
	if (feedback.expected) {
		const current = installed.find(skill => skill.name === feedback.expected!.name);
		if (!current?.storage || topologyOfInspection(current.storage) !== feedback.expected.target) {
			dispatch({type: 'action-failed', error: '最终共享检测未确认目标拓扑'});
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
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	const names = uninstallTargets(view);
	if (names.length === 0) {
		dispatch({type: 'action-failed', error: '没有选中要卸载的 skill'});
		return;
	}
	const name = names[0]!;
	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.uninstallAllAgents(name, progressSink(dispatch), signal)
		.then(result => {
			if (signal.aborted) return;
			if (result.success) {
				toast.success(`已从所有 Agent 卸载 ${name}`);
				dispatch({type: 'action-uninstall-done', names});
				cache.refresh();
			} else {
				dispatch({type: 'action-failed', error: result.error ?? '卸载失败'});
			}
		})
		.catch(error => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `卸载失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
}

export function runUpdateIfReadyAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	if (view.installed.length === 0) return;
	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.updateBothSides(progressSink(dispatch), signal)
		.then(result => {
			if (signal.aborted) return;
			if (result.success) {
				toast.success(result.noChange ? 'skill 已是最新版本' : '已更新 skill');
				dispatch({type: 'action-done'});
			} else dispatch({type: 'action-failed', error: result.error ?? '更新失败'});
		})
		.catch((error: unknown) => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `更新失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
}

export function runUpdateOneIfReadyAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: SkillsViewDispatch,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	const current = selectedInstalled(view);
	if (!current?.source) return;
	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.updateOne(current.name, progressSink(dispatch), signal)
		.then(result => {
			if (signal.aborted) return;
			if (result.success) {
				toast.success(result.noChange ? `选中的 ${current.name} 已是最新版本` : `已更新选中的 ${current.name}`);
				dispatch({type: 'action-done'});
			} else dispatch({type: 'action-failed', error: result.error ?? `更新 ${current.name} 失败`});
		})
		.catch((error: unknown) => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `更新 ${current.name} 失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
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

export function topologyOfStorage(storage: SkillStorageInspection | undefined): SkillTopology | undefined {
	return storage ? topologyOfInspection(storage) : undefined;
}

export function targetTopologyOfInstallDraft(draft: InstallDraft): SkillTopology | 'empty' {
	return targetTopologyOfDraft(draft);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
