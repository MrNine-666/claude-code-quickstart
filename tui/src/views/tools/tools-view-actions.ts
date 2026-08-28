import {busyActionTitle, toast, type BusyAction, type BusyOverlayState, type StatusDotKind} from '../../components/index.js';
import type {ProgressCallback} from '../../core/exec.js';
import {openUrl} from '../../core/open-url.js';
import {
	groupComponentsByToolGroup,
	isInjectableComponent,
	projectSharedToolComponents,
	uninstallImpactNotice
} from '../../core/tools-manage.js';
import type {DetectionCache} from '../../hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../hooks/use-task-cancellation.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../../state/manage-state.js';
import {
	cursorComponent,
	initialInjectDraft,
	isAnyBusy,
	itemStatusOf,
	latestActiveProgressTask,
	resolveToolsPrimaryAction,
	updatableComponents,
	type ComponentItemStatus,
	type ComponentPatch,
	type ToolsViewState
} from '../../state/tools-view-state.js';
import {semverCompare} from '../../core/semver.js';
import type {
	AgentInjectSnapshot,
	ComponentId,
	ComponentInstallOutcome,
	ComponentUninstallOutcome,
	InjectChangesResult,
	ManagedComponent,
	SharedManagedComponent,
	ToolsViewDispatch,
	ToolsViewServices
} from './tools-view-types.js';

export function projectToolsComponentsAction(components: readonly ManagedComponent[]): readonly SharedManagedComponent[] {
	return projectSharedToolComponents(components);
}

export function groupToolsForHome(components: readonly ManagedComponent[]) {
	return groupComponentsByToolGroup(components);
}

export function isToolsInjectable(id: ComponentId): boolean {
	return isInjectableComponent(id);
}

export function toolsUninstallImpactNotice(id: ComponentId, fullUninstall: boolean): string {
	return uninstallImpactNotice(id, {fullUninstall});
}

export function openCurrentDocsAction(view: ToolsViewState): void {
	const component = cursorComponent(view);
	if (!component) return;
	if (!component.docsUrl) {
		toast.info(`${component.name} 无文档链接`);
		return;
	}
	void openUrl(component.docsUrl).then(result => {
		if (result.ok) toast.success(`已打开 ${component.name} 文档`);
		else toast.error(result.error);
	});
}

export function runPrimaryAction(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view);
	if (!component || itemStatusOf(view, component.id) !== 'idle') return;

	switch (resolveToolsPrimaryAction(component)) {
		case 'manage':
			dispatch({type: 'open-inject-target', draft: initialInjectDraft(component as SharedManagedComponent)});
			return;
		case 'install':
			installOne(component, services, dispatch, cache, taskCancellation);
			return;
		case 'update':
			updateOne(component, services, dispatch, cache, taskCancellation);
			return;
		case 'repair':
			updateOne(component, services, dispatch, cache, taskCancellation);
			return;
		case 'blocked':
			toast.error(component.lifecycle?.diagnostic ?? `${component.name} 当前不可操作`);
			return;
		case 'latest':
			toast.success(`${component.name} 已是最新`);
	}
}

export function updateInjectableCurrent(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view);
	if (!component || !isInjectableComponent(component.id)) return;
	updateCurrent(view, services, dispatch, cache, taskCancellation);
}

function updateCurrent(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view);
	if (!component || itemStatusOf(view, component.id) !== 'idle') return;
	if (component.hasUpdate === true) {
		updateOne(component, services, dispatch, cache, taskCancellation);
		return;
	}
	if (!component.installed) toast.info(`${component.name} 未安装`);
	else toast.success(`${component.name} 已是最新`);
}

export function applyInjectDraft(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view) as SharedManagedComponent | undefined;
	const draft = view.injectDraft;
	if (!component || !isInjectableComponent(component.id) || !draft) {
		dispatch({type: 'cancel'});
		return;
	}

	const changes = AGENT_CONTEXT_ORDER.map(ctx => ({
		ctx,
		desired: draft[ctx],
		actual: Boolean(component.injectByAgent?.[ctx]?.integrated)
	})).filter(item => item.desired !== item.actual);
	if (changes.length === 0) {
		toast.info('未改变任何开关');
		dispatch({type: 'cancel'});
		return;
	}

	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'item-start', id: component.id, action: injectChangesAction(changes)});
	void runInjectChanges(component, changes, services, dispatch, signal)
		.then(result => {
			if (signal.aborted) return;
			dispatch({type: 'item-patched', id: component.id, patch: result.patch});
			if (result.error) {
				dispatch({type: 'item-failed', id: component.id, error: result.error});
				toast.warning(`${component.name} 操作部分完成，请检查详情`);
			} else {
				toast.success(`${component.name} 设置已更新`);
			}
			cache.refresh();
		})
		.catch((error: unknown) => {
			if (signal.aborted) return;
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
			cache.refresh();
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh({forceRefresh: true});
		});
}

export function injectChangesAction(changes: readonly {readonly desired: boolean}[]): 'install' | 'uninstall' {
	return changes.every(change => !change.desired) ? 'uninstall' : 'install';
}

function injectChangesPatch(
	component: SharedManagedComponent,
	injectByAgent: Readonly<Record<AgentContext, AgentInjectSnapshot>>,
	codeGraphVersion: string
): ComponentPatch {
	if (component.id !== 'CodeGraph') return {injectByAgent};
	const anyIntegrated = Object.values(injectByAgent).some(snapshot => snapshot.integrated);
	const cliInstalled = component.sharedInstalled || anyIntegrated;
	return {
		injectByAgent,
		installed: cliInstalled,
		sharedInstalled: cliInstalled,
		currentVersion: cliInstalled ? codeGraphVersion : '',
		sharedVersion: cliInstalled ? codeGraphVersion : '',
		...(cliInstalled ? {} : {latestVersion: '', hasUpdate: null})
	};
}

export async function runInjectChanges(
	component: SharedManagedComponent,
	changes: readonly {readonly ctx: AgentContext; readonly desired: boolean}[],
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	signal?: AbortSignal
): Promise<InjectChangesResult> {
	let nextInject = {...(component.injectByAgent ?? {})} as Record<AgentContext, AgentInjectSnapshot>;
	let codeGraphVersion = component.sharedVersion || component.currentVersion;

	for (const {ctx, desired} of changes) {
		const label = AGENT_CONTEXT_LABELS[ctx];
		let outcome: ComponentInstallOutcome | ComponentUninstallOutcome;
		try {
			outcome = desired
				? await services.injectComponent(component.id, ctx, progressSink(dispatch, component.id), signal)
				: await services.ejectComponent(component.id, ctx, progressSink(dispatch, component.id), signal);
		} catch (error) {
			return {patch: injectChangesPatch(component, nextInject, codeGraphVersion), error: errorMessage(error)};
		}
		if (!outcome.success) {
			return {
				patch: injectChangesPatch(component, nextInject, codeGraphVersion),
				error: outcome.error ?? `${component.name} · ${label} 操作失败`
			};
		}
		const installedVersion = desired && 'version' in outcome ? outcome.version : undefined;
		const version = component.id === 'CcgWorkflow' ? installedVersion : undefined;
		nextInject = {...nextInject, [ctx]: {context: ctx, integrated: desired, ...(version ? {version} : {})}};
		if (desired && component.id === 'CodeGraph') codeGraphVersion = installedVersion || codeGraphVersion;
	}

	return {patch: injectChangesPatch(component, nextInject, codeGraphVersion)};
}

function progressSink(dispatch: ToolsViewDispatch, fallbackId: string): ProgressCallback {
	return event => {
		if (event.instruction) {
			dispatch({type: 'progress', id: event.componentId ?? fallbackId, message: event.instruction, level: event.level});
		}
	};
}

function installOne(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'item-start', id: component.id, action: 'install'});
	void services
		.installComponent(component.id, progressSink(dispatch, component.id), undefined, signal)
		.then(outcome => {
			if (signal.aborted) return;
			if (outcome.success) {
				toast.success(`${component.name} 安装成功`);
				dispatch({
					type: 'item-patched',
					id: component.id,
					patch: successfulInstallPatch(component, outcome.version, outcome.lifecycle)
				});
			} else {
				dispatch({
					type: 'item-failed',
					id: component.id,
					error: outcome.error ?? `${component.name} 安装失败`,
					...(outcome.lifecycle ? {patch: dshLifecyclePatch(component, outcome.lifecycle)} : {})
				});
			}
			cache.refresh();
		})
		.catch((error: unknown) => {
			if (signal.aborted) return;
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
			cache.refresh();
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh({forceRefresh: true});
		});
}

export function successfulInstallPatch(
	component: ManagedComponent,
	installedVersion?: string,
	lifecycle?: ManagedComponent['lifecycle']
): ComponentPatch {
	const currentVersion = installedVersion ?? component.currentVersion;
	return {
		installed: true,
		hasUpdate: false,
		currentVersion,
		statusHint: lifecycle?.prereleaseWarning,
		lifecycle,
		sharedInstalled: true,
		sharedVersion: currentVersion
	};
}

function updateOne(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'item-start', id: component.id, action: 'update'});
	void services
		.updateComponents([component], progressSink(dispatch, component.id), undefined, signal)
		.then(result => {
			if (signal.aborted) return;
			const failed = result.updatedItems.some(item => item.startsWith(`failed::${component.id}`));
			if (failed) {
				dispatch({
					type: 'item-failed',
					id: component.id,
					error: `${component.name} 更新失败: ${updateFailureMessage(result.updatedItems, component.id, '未返回失败详情')}`,
					...(result.dshLifecycle ? {patch: dshLifecyclePatch(component, result.dshLifecycle)} : {})
				});
			} else {
				toast.success(`${component.name} 已更新`);
				dispatch({type: 'item-patched', id: component.id, patch: successfulUpdatePatch(component, result.dshLifecycle)});
			}
			cache.refresh();
		})
		.catch((error: unknown) => {
			if (signal.aborted) return;
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
			cache.refresh();
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh({forceRefresh: true});
		});
}

/** Preserve the operation-layer diagnostic encoded in an applyUpdates failure record. */
export function updateFailureMessage(updatedItems: readonly string[], id: string, fallback: string): string {
	const prefix = `failed::${id}::`;
	const record = updatedItems.find(item => item.startsWith(prefix));
	const detail = record?.slice(prefix.length).trim();
	return detail || fallback;
}

export function successfulUpdatePatch(component: ManagedComponent, lifecycle?: ManagedComponent['lifecycle']): ComponentPatch {
	const shared = component as SharedManagedComponent;
	const nextLifecycle = component.id === 'DeepSeekHarness' ? lifecycle : undefined;
	const currentVersion =
		nextLifecycle?.packageVersion || nextLifecycle?.commandVersion || component.latestVersion || component.currentVersion;
	const patch: ComponentPatch = {
		installed: true,
		hasUpdate: false,
		currentVersion,
		statusHint: nextLifecycle?.prereleaseWarning,
		lifecycle: nextLifecycle
	};
	if (shared.id === 'CcgWorkflow' && shared.injectByAgent) {
		return {
			...patch,
			injectByAgent: Object.fromEntries(
				AGENT_CONTEXT_ORDER.map(context => {
					const snapshot = shared.injectByAgent?.[context] ?? {context, integrated: false};
					return [context, snapshot.integrated ? {...snapshot, version: currentVersion} : snapshot];
				})
			) as Readonly<Record<AgentContext, AgentInjectSnapshot>>
		};
	}
	return {...patch, sharedInstalled: true, sharedVersion: currentVersion};
}

/** 将 DSH 操作失败的最终 lifecycle 投影回卡片，避免错误文本掩盖 postflight 事实。 */
export function dshLifecyclePatch(component: ManagedComponent, lifecycle: NonNullable<ManagedComponent['lifecycle']>): ComponentPatch {
	const currentVersion = lifecycle.packageVersion || lifecycle.commandVersion;
	const repairable = lifecycle.repairRequired;
	const detail = lifecycle.state === 'managed' || lifecycle.state === 'not-installed' ? '' : lifecycle.diagnostic;
	const statusHint = [detail, lifecycle.prereleaseWarning].filter(Boolean).join(' ') || undefined;
	return {
		installed: lifecycle.state === 'managed' || repairable,
		currentVersion,
		latestVersion: component.latestVersion,
		hasUpdate: lifecycle.state === 'managed' ? component.hasUpdate : repairable ? true : null,
		statusHint,
		lifecycle,
		sharedInstalled: lifecycle.state === 'managed' || repairable,
		sharedVersion: currentVersion
	};
}

export function settleBatchUpdateComponents(
	components: readonly ManagedComponent[],
	targets: readonly ManagedComponent[],
	failedIds: ReadonlySet<string>,
	dshLifecycle?: ManagedComponent['lifecycle']
): readonly ManagedComponent[] {
	const successfulTargets = new Map(
		targets.filter(component => !failedIds.has(component.id)).map(component => [component.id, component] as const)
	);
	return components.map(component => {
		const target = successfulTargets.get(component.id);
		if (!target && component.id === 'DeepSeekHarness' && failedIds.has(component.id) && dshLifecycle) {
			return {...component, ...dshLifecyclePatch(component, dshLifecycle)} as ManagedComponent;
		}
		return target
			? ({
					...component,
					...successfulUpdatePatch(target, target.id === 'DeepSeekHarness' ? dshLifecycle : undefined)
				} as ManagedComponent)
			: component;
	});
}

export function updateAll(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const targets = updatableComponents(view);
	if (targets.length === 0) {
		toast.info('没有可更新的组件');
		return;
	}
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'batch-start', action: 'update', ids: targets.map(item => item.id)});
	void services
		.updateComponents(targets, progressSink(dispatch, targets[0]?.id ?? 'batch-update'), undefined, signal)
		.then(result => {
			if (signal.aborted) return;
			const failedItems = result.updatedItems.filter(item => item.startsWith('failed::'));
			const failedIds = new Set<string>(failedItems.map(item => item.split('::')[1]).filter((id): id is string => Boolean(id)));
			const components = settleBatchUpdateComponents(view.components, targets, failedIds, result.dshLifecycle);
			const updatedCount = targets.length - failedIds.size;
			const failureDetails = [...failedIds].map(id => `${id}: ${updateFailureMessage(failedItems, id, '未返回失败详情')}`);
			const summary =
				failedIds.size === 0
					? `已更新 ${targets.length} 个组件`
					: `${updatedCount}/${targets.length} 成功，失败: ${failureDetails.join('；')}`;
			if (failedIds.size === 0) {
				toast.success(summary);
				dispatch({type: 'batch-done', components});
			} else {
				dispatch({type: 'batch-failed', error: summary, components});
			}
			cache.refresh();
		})
		.catch((error: unknown) => {
			if (signal.aborted) return;
			dispatch({type: 'batch-failed', error: errorMessage(error)});
			cache.refresh();
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh({forceRefresh: true});
		});
}

export function runUninstall(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: ToolsViewDispatch,
	cache: DetectionCache<ManagedComponent[]>,
	fullUninstall: boolean,
	taskCancellation: TaskCancellation
): void {
	const signal = taskCancellation.start();
	if (!signal) return;
	dispatch({type: 'confirm-uninstall'});
	void services
		.uninstallComponent(component.id, progressSink(dispatch, component.id), {fullUninstall, signal})
		.then(outcome => {
			if (signal.aborted) return;
			if (outcome.success) {
				toast.success(`${component.name} 已卸载`);
				if (outcome.warning) toast.warning(outcome.warning);
				dispatch({
					type: 'item-patched',
					id: component.id,
					patch: uninstallSuccessPatch(component, fullUninstall, outcome.lifecycle, outcome.warning)
				});
			} else {
				const message = outcome.manualHint
					? `${outcome.error ?? '卸载失败'}\n${outcome.manualHint}`
					: (outcome.error ?? `${component.name} 卸载失败`);
				dispatch({
					type: 'item-failed',
					id: component.id,
					error: message,
					...(outcome.lifecycle ? {patch: dshLifecyclePatch(component, outcome.lifecycle)} : {})
				});
			}
			cache.refresh();
		})
		.catch((error: unknown) => {
			if (signal.aborted) return;
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
			cache.refresh();
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh({forceRefresh: true});
		});
}

export function uninstallSuccessPatch(
	component: ManagedComponent,
	fullUninstall: boolean,
	lifecycle?: ManagedComponent['lifecycle'],
	warning?: string
): ComponentPatch {
	const isDsh = component.id === 'DeepSeekHarness';
	const patch: ComponentPatch = {
		installed: isDsh && lifecycle ? lifecycle.state === 'managed' || lifecycle.repairRequired : false,
		hasUpdate: null,
		currentVersion: '',
		latestVersion: '',
		statusHint: isDsh && lifecycle?.state === 'external' ? (warning ?? lifecycle.diagnostic) : isDsh ? warning : undefined,
		lifecycle: isDsh ? lifecycle : undefined,
		sharedInstalled: false,
		sharedVersion: ''
	};
	if (!fullUninstall || !isInjectableComponent(component.id)) return patch;
	return {
		...patch,
		injectByAgent: {
			cc: {context: 'cc', integrated: false},
			cx: {context: 'cx', integrated: false}
		}
	};
}

export function createToolsBusyOverlayState(view: ToolsViewState, onCancel: () => void): BusyOverlayState | null {
	if (!isAnyBusy(view)) return null;
	const action = currentToolsBusyAction(view);
	const currentTask = latestActiveProgressTask(view);
	return {
		title: action ? busyActionTitle(action, '工具') : '正在执行工具操作',
		message: currentTask ? `${currentTask.name} · ${currentTask.message}` : undefined,
		onCancel
	};
}

function currentToolsBusyAction(view: ToolsViewState): BusyAction | undefined {
	if (view.busyAction) return view.busyAction;
	const statuses = Object.values(view.itemStatus);
	if (statuses.includes('uninstalling')) return 'uninstall';
	if (statuses.includes('updating')) return 'update';
	if (statuses.includes('installing')) return 'install';
	return undefined;
}

export function toolStatusDot(component: SharedManagedComponent, status: ComponentItemStatus): {kind: StatusDotKind; label: string} {
	if (status === 'installing') return {kind: 'installing', label: '安装中'};
	if (status === 'updating') return {kind: 'updating', label: '更新中'};
	if (status === 'uninstalling') return {kind: 'uninstalling', label: '卸载中'};
	if (component.id === 'DeepSeekHarness' && component.lifecycle) return dshStatusDot(component);
	if (component.sharingKind === 'shared-cli-per-agent-inject') return injectSharedDot(component);
	if (!component.installed) return {kind: 'notInstalled', label: '未安装'};
	if (component.hasUpdate === true) {
		return {kind: 'updatable', label: `${component.currentVersion || '-'} → ${component.latestVersion || '-'}`};
	}
	if (component.hasUpdate === false) return {kind: 'latest', label: component.currentVersion || '最新'};
	return {kind: 'latest', label: `${component.currentVersion || '已安装'} · 无法检测更新`};
}

function dshStatusDot(component: SharedManagedComponent): {kind: StatusDotKind; label: string} {
	const lifecycle = component.lifecycle;
	if (!lifecycle) return {kind: 'unknown', label: '状态未知'};

	switch (lifecycle.state) {
		case 'not-installed':
			return {kind: 'notInstalled', label: '未安装'};
		case 'managed':
			if (component.hasUpdate === true) {
				return {kind: 'updatable', label: `${component.currentVersion || '-'} → ${component.latestVersion || '-'}`};
			}
			return {
				kind: 'latest',
				label: component.currentVersion || '最新'
			};
		case 'broken':
			return {kind: 'failed', label: '需修复'};
		case 'version-mismatch':
			return {kind: 'failed', label: '版本不一致'};
		case 'external':
			return {kind: 'failed', label: '外部 dsh'};
		case 'path-conflict':
			return {kind: 'failed', label: 'PATH 冲突'};
		case 'npm-unavailable':
			return {kind: 'failed', label: 'npm 不可用'};
		case 'verification-unknown':
			return {kind: 'failed', label: '需验证'};
	}
}

function injectSharedDot(component: SharedManagedComponent): {kind: StatusDotKind; label: string} {
	const anyInjected = component.injectByAgent ? Object.values(component.injectByAgent).some(snapshot => snapshot.integrated) : false;
	if (component.id === 'CodeGraph') {
		if (!component.sharedInstalled) {
			return anyInjected ? {kind: 'failed', label: 'CLI 不可用'} : {kind: 'notInstalled', label: '未安装'};
		}
		if (component.hasUpdate === true) {
			return {kind: 'updatable', label: `${component.currentVersion || '-'} → ${component.latestVersion || '-'}`};
		}
		return {kind: 'latest', label: component.currentVersion || 'CLI 已装'};
	}
	if (!anyInjected) return {kind: 'notInstalled', label: '未安装'};
	const olderVersion = olderInjectedVersion(component);
	if (component.hasUpdate === true) {
		return {
			kind: 'updatable',
			label: olderVersion ? `${olderVersion} → ${component.latestVersion || '-'}` : `→ ${component.latestVersion || '-'}`
		};
	}
	return {kind: 'latest', label: olderVersion || '已安装'};
}

function olderInjectedVersion(component: SharedManagedComponent): string {
	const versions = AGENT_CONTEXT_ORDER.map(ctx => component.injectByAgent?.[ctx])
		.filter((snapshot): snapshot is AgentInjectSnapshot => Boolean(snapshot?.integrated && snapshot.version))
		.map(snapshot => snapshot.version as string);
	if (versions.length === 0) return '';
	return versions.reduce((older, current) => (semverCompare(current, older) < 0 ? current : older));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
