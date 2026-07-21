import React, {useCallback, useEffect, useMemo, useReducer, useRef} from 'react';
import {TextAttributes, type ScrollBoxRenderable} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {
	Card,
	ErrorPanel,
	ListEmptyState,
	ListLoadingState,
	Modal,
	StatusDot,
	ThemedScrollbox,
	ViewHeader,
	busyActionTitle,
	toast,
	type BusyAction,
	type BusyOverlayState,
	type StatusDotKind
} from '../components/index.js';
import {colors} from '../theme/index.js';
import type {ProgressCallback} from '../core/exec.js';
import type {DetectionState} from '../services/async-detection.js';
import type {DetectionCache} from '../hooks/use-detection-cache.js';
import type {DetectionRunner, DetectionRunOptions, DetectionStateSink} from '../services/detection-runner.js';
import type {
	AgentInjectSnapshot,
	ComponentId,
	ComponentInstallOutcome,
	ComponentUninstallOutcome,
	ManagedComponent,
	SharedManagedComponent
} from '../core/tools-manage.js';
import type {ApplyUpdatesResult} from '../core/update.js';
import {
	createInitialToolsViewState,
	cursorComponent,
	isAnyBusy,
	itemStatusOf,
	reduceToolsViewState,
	resolveToolsPrimaryAction,
	updatableComponents,
	latestActiveProgressTask,
	injectTargetContext,
	initialInjectDraft,
	CARD_WIDTH,
	computeColumns,
	type ComponentPatch,
	type ComponentItemStatus,
	type ToolsViewAction,
	type ToolsViewState
} from '../state/tools-view-state.js';
import {
	groupComponentsByToolGroup,
	isInjectableComponent,
	projectSharedToolComponents,
	uninstallImpactNotice
} from '../core/tools-manage.js';
import {openUrl} from '../core/open-url.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../state/manage-state.js';
import {semverCompare} from '../core/semver.js';
import {useTaskCancellation, type TaskCancellation} from '../hooks/use-task-cancellation.js';

type Dispatch = React.Dispatch<ToolsViewAction>;

export type InjectChangesResult = {
	readonly patch: ComponentPatch;
	readonly error?: string;
};

// 工具管理视图（Phase 4，OpenTUI 适配）：合并工具安装 + 检查更新为全生命周期菜单。
// grid 卡片范式：flexWrap 布局 + StatusDot 彩色圆点 + 上下左右 2D 导航。
// 卡片主操作：普通项 Enter 按状态安装/更新，inject 项 Enter 管理开关；d 强确认卸载。
// 检测缓存提升到 App 层：切走再切回不重跑；r 键刷新。
// OpenTUI 适配：useKeyboard 替代 useInput，<box>/<text> 小写元素，<input> 替代 ink-text-input。

/** 卸载调用选项：Enter 单侧 eject 传 agentContext；d 全量卸载传 fullUninstall。 */
export type UninstallOptions = {
	readonly agentContext?: AgentContext;
	readonly fullUninstall?: boolean;
	readonly signal?: AbortSignal;
};

export type ToolsViewServices = {
	readonly detectComponents: () => Promise<readonly ManagedComponent[]>;
	readonly installComponent: (
		id: ComponentId,
		onProgress?: ProgressCallback,
		agentContext?: AgentContext,
		signal?: AbortSignal
	) => Promise<ComponentInstallOutcome>;
	readonly installMultiple: (
		ids: readonly ComponentId[],
		onProgress?: ProgressCallback,
		agentContext?: AgentContext,
		signal?: AbortSignal
	) => Promise<readonly ComponentInstallOutcome[]>;
	readonly updateComponents: (
		components: readonly ManagedComponent[],
		onProgress?: ProgressCallback,
		agentContext?: AgentContext,
		signal?: AbortSignal
	) => Promise<ApplyUpdatesResult>;
	readonly uninstallComponent: (
		id: ComponentId,
		onProgress?: ProgressCallback,
		options?: UninstallOptions
	) => Promise<ComponentUninstallOutcome>;
	// 单侧 inject/eject：显式传目标 Agent，禁止依赖 Header agentContext（design D5/4.2）。
	readonly injectComponent: (
		id: ComponentId,
		target: AgentContext,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<ComponentInstallOutcome>;
	readonly ejectComponent: (
		id: ComponentId,
		target: AgentContext,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<ComponentUninstallOutcome>;
	readonly createDetectionRunner: (onChange: DetectionStateSink<ManagedComponent[]>) => DetectionRunner<ManagedComponent[]>;
	readonly runDetection: (runner: DetectionRunner<ManagedComponent[]>) => Promise<unknown>;
	readonly refreshDetection?: (runner: DetectionRunner<ManagedComponent[]>, options?: DetectionRunOptions) => Promise<unknown>;
};

export type ToolsViewProps = {
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly active?: boolean;
	readonly contentWidth?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav?: () => void;
};

export function ToolsView({
	services: rawServices,
	cache,
	active = true,
	contentWidth,
	onSubModeChange,
	onBusyStateChange,
	onExitToNav
}: ToolsViewProps) {
	const [view, dispatch] = useReducer(reduceToolsViewState, undefined, createInitialToolsViewState);
	const detection = cache.state;
	const taskCancellation = useTaskCancellation();
	const cancelBusyTask = useCallback(() => {
		if (!taskCancellation.cancel()) {
			return;
		}

		dispatch({type: 'cancel-busy'});
		toast.info('已取消任务，正在刷新状态');
		cache.refresh({forceRefresh: true});
	}, [cache, taskCancellation]);

	// D5/4.6：inject/eject/uninstall 路径显式传目标，禁止把 Header agentContext useMemo 绑死到生命周期动作。
	// rawServices 直接透传；单侧 inject/eject 由 select-inject-target 显式解析目标，非 inject 的 install/update
	// 无 per-agent 语义（全局工具），agentContext 交由 core 默认处理。
	const services = rawServices;

	// 网格列数随终端内容区宽度自适应（卡宽固定），导航上下键 delta 跟随列数，避免视觉/语义错位。
	const columns = useMemo(() => computeColumns(contentWidth ?? 52), [contentWidth]);

	// 共享投影：不按 Header agentContext 过滤列表（design D2）。7 组件全集常显，
	// inject 类附双侧 injectByAgent 快照，对侧状态互不塌缩；refresh 后经同一投影重投影。
	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({type: 'components-loaded', components: projectSharedToolComponents(detection.result ?? [])});
		}

		if (detection.status === 'error') {
			dispatch({type: 'detection-error', error: detection.error ?? '检测失败'});
		}
	}, [detection.status, detection.result, detection.error]);

	// 检测失败时弹 toast（长停留，保留「按 r 重试」指引；仅在 status 变 error 时触发一次）。
	useEffect(() => {
		if (detection.status === 'error') {
			toast.error('检测失败，可按 r 重试', 6000);
		}
	}, [detection.status]);

	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const cursorCard = view.components[view.cursor];
	const activeCardId = cursorCard ? toolCardId(cursorCard, view.cursor) : null;
	const busyOverlayState = useMemo(() => createToolsBusyOverlayState(view, cancelBusyTask), [view, cancelBusyTask]);

	// 上报当前子模式给 App footer：inject 类光标下 grid → grid-inject（footer 展示「选择注入目标」）。
	const cursorInjectable = cursorCard ? isInjectableComponent(cursorCard.id) : false;
	useEffect(() => {
		if (!active) {
			return;
		}
		const subMode =
			view.mode === 'busy'
				? 'busy'
				: view.mode === 'confirm-uninstall'
					? 'confirm-uninstall'
					: view.mode === 'select-inject-target'
						? 'select-inject-target'
						: cursorInjectable
							? 'grid-inject'
							: 'grid';
		onSubModeChange?.(subMode);
	}, [active, view.mode, cursorInjectable, onSubModeChange]);

	useEffect(() => {
		onBusyStateChange?.(busyOverlayState);
	}, [busyOverlayState, onBusyStateChange]);

	useEffect(() => () => onBusyStateChange?.(null), [onBusyStateChange]);

	useEffect(() => {
		if (!scrollRef.current || !activeCardId) {
			return;
		}

		scrollRef.current.scrollChildIntoView(activeCardId);
	}, [activeCardId]);

	// 键盘输入处理
	useKeyboard(keyEvent => {
		if (!active) return;

		// OpenTUI 回调收到 KeyEvent 对象，取 .name 得到键名字符串。
		const key = keyEvent.name;

		// grid 模式 Esc 退回左侧导航；←/→ 留给网格内光标移动（横向布局下选中相邻工具）。
		if (view.mode === 'grid' && key === 'escape' && onExitToNav) {
			onExitToNav();
			return;
		}

		// grid 模式：光标停在所属分组首项时，← 退回左侧导航（各分组 grid 相对独立，行首边界快捷返回，与 Esc 等效）。
		if (
			view.mode === 'grid' &&
			(key === 'left' || key === 'arrowleft') &&
			view.cursor === (cursorGroupBounds(view)?.start ?? 0) &&
			onExitToNav
		) {
			onExitToNav();
			return;
		}

		if (view.mode === 'confirm-uninstall') {
			// 卸载确认模式由 UninstallConfirm 内部处理
			return;
		}

		if (view.mode === 'select-inject-target') {
			handleInjectTargetKey(key, view, services, dispatch, cache, taskCancellation);
			return;
		}

		if (view.mode === 'busy') {
			return; // 执行中禁用操作
		}

		handleGridKey(key, view, services, dispatch, cache, columns, taskCancellation);
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="工具管理" subtitle="管理常用 CLI 工具的安装、更新与卸载" />
			{renderDetectionNotice(detection.status)}
			{/* 检测中时隐藏网格，仅显示加载态；检测完成后才显示分组网格或空状态 */}
			{detection.status !== 'loading' && detection.status !== 'idle'
				? renderGrid(view, scrollRef, active && view.mode === 'grid')
				: null}
			{view.errorText ? <ErrorPanel message={view.errorText} /> : null}
			{view.mode === 'confirm-uninstall' ? (
				<UninstallConfirm
					view={view}
					dispatch={dispatch}
					services={services}
					cache={cache}
					taskCancellation={taskCancellation}
					active={active}
				/>
			) : null}
			{view.mode === 'select-inject-target' ? <InjectTargetModal view={view} /> : null}
		</box>
	);
}

// ── grid 模式按键分发 ─────────────────────────────────────────────────────────

// Tools 隐藏 Header（Task 2.3）：顶行 ↑ 停在首项（no-op），不再退回 header。
function handleGridKey(
	key: string,
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	columns: number,
	taskCancellation: TaskCancellation
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		const nextCursor = visualVerticalCursor(view, columns, -1);
		if (nextCursor !== null) {
			dispatch({type: 'nav', delta: nextCursor - view.cursor});
		}
		// 顶行 ↑：停在首项（Tools 无 Header，不退回）。
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		const nextCursor = visualVerticalCursor(view, columns, 1);
		if (nextCursor !== null) {
			dispatch({type: 'nav', delta: nextCursor - view.cursor});
		}
		return;
	}

	// 左右键在所属分组内移动，不跨组：分组首项 ← 由 useKeyboard 拦截返回菜单，分组末项 → 停住。
	const bounds = cursorGroupBounds(view);

	if (k === 'left' || k === 'arrowleft') {
		if (!bounds || view.cursor > bounds.start) {
			dispatch({type: 'nav', delta: -1});
		}
		return;
	}

	if (k === 'right' || k === 'arrowright') {
		if (!bounds || view.cursor < bounds.end) {
			dispatch({type: 'nav', delta: 1});
		}
		return;
	}

	// Enter：普通项按实时状态安装/更新，inject 类始终打开管理开关 Modal。
	if (k === 'enter' || k === 'return') {
		runPrimaryAction(view, services, dispatch, cache, taskCancellation);
		return;
	}

	// u：仅 inject 类保留单项更新，普通项已由 Enter 按状态处理。
	if (k === 'u') {
		updateInjectableCurrent(view, services, dispatch, cache, taskCancellation);
		return;
	}

	if (k === 'a') {
		updateAll(view, services, dispatch, cache, taskCancellation);
		return;
	}

	if (k === 'd') {
		dispatch({type: 'request-uninstall'});
		return;
	}

	if (k === 'r' && !isAnyBusy(view)) {
		cache.refresh({forceRefresh: true});
		return;
	}

	// o：在系统默认浏览器打开当前项的官方文档 / GitHub（OSC-8 点击的键盘兜底入口）。
	if (k === 'o') {
		openCurrentDocs(view);
	}
}

// ── o：打开当前项文档链接（跨平台默认浏览器） ──────────────────────────────────

function openCurrentDocs(view: ToolsViewState): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	if (!component.docsUrl) {
		toast.info(`${component.name} 无文档链接`);
		return;
	}

	void openUrl(component.docsUrl).then(result => {
		if (result.ok) {
			toast.success(`已打开 ${component.name} 文档`);
		} else {
			toast.error(result.error);
		}
	});
}

// ── 开关管理 Modal（select-inject-target）：↑/↓ 选侧，Space 切草稿，Enter 统一应用，Esc 取消 ──

function handleInjectTargetKey(
	key: string,
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		dispatch({type: 'inject-target-nav', delta: -1});
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		dispatch({type: 'inject-target-nav', delta: 1});
		return;
	}

	if (k === 'space' || key === ' ') {
		dispatch({type: 'inject-target-toggle'});
		return;
	}

	if (k === 'escape') {
		dispatch({type: 'cancel'});
		return;
	}

	if (k === 'enter' || k === 'return') {
		applyInjectDraft(view, services, dispatch, cache, taskCancellation);
	}
}

// ── Enter：按组件能力与实时状态解析唯一主操作 ───────────────────────────────────

function runPrimaryAction(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	if (itemStatusOf(view, component.id) !== 'idle') {
		return;
	}

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
		case 'latest':
			toast.success(`${component.name} 已是最新`);
	}
}

// ── u：仅管理型工具保留单项更新 ───────────────────────────────────────────────

function updateInjectableCurrent(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view);
	if (!component || !isInjectableComponent(component.id)) {
		return;
	}

	updateCurrent(view, services, dispatch, cache, taskCancellation);
}

// ── 更新当前项（无更新则提示已是最新） ────────────────────────────────────────

function updateCurrent(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	if (itemStatusOf(view, component.id) !== 'idle') {
		return;
	}

	if (component.hasUpdate === true) {
		updateOne(component, services, dispatch, cache, taskCancellation);
		return;
	}

	if (!component.installed) {
		toast.info(`${component.name} 未安装`);
		return;
	}

	toast.success(`${component.name} 已是最新`);
}

// ── Enter 应用开关草稿：对比草稿与实际态，对每个变化侧顺序执行 inject/eject ──────────

function applyInjectDraft(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	taskCancellation: TaskCancellation
): void {
	const component = cursorComponent(view) as SharedManagedComponent | undefined;
	const draft = view.injectDraft;
	if (!component || !isInjectableComponent(component.id) || !draft) {
		dispatch({type: 'cancel'});
		return;
	}

	// 计算与实际态有差异的侧（草稿 true=开启注入，false=关闭）。
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
			// 无论全部成功还是部分失败，均刷新真实双侧状态。
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
	if (component.id !== 'CodeGraph') {
		return {injectByAgent};
	}

	// 逐 Agent 开关永不删除共享 codegraph CLI：安装任一侧会确保 CLI 就位，纯关闭（含关掉最后一侧）
	// 均保留 CLI —— 移除 CLI 仅由整体卸载路径负责。因此乐观 patch 不得在关掉最后一侧时清空 CLI 状态，
	// 否则会与磁盘真实态（CLI 仍在）冲突并造成一次错误闪烁。
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

// 顺序执行各侧开/关；失败时返回已完成侧的 patch，调用方据此对齐部分成功的磁盘状态。
export async function runInjectChanges(
	component: SharedManagedComponent,
	changes: readonly {readonly ctx: AgentContext; readonly desired: boolean}[],
	services: ToolsViewServices,
	dispatch: Dispatch,
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
		if (desired && component.id === 'CodeGraph') {
			codeGraphVersion = installedVersion || codeGraphVersion;
		}
	}

	return {patch: injectChangesPatch(component, nextInject, codeGraphVersion)};
}

// ── 安装（单项 / 批量，失败隔离） ─────────────────────────────────────────────

function progressSink(dispatch: Dispatch, fallbackId: string): ProgressCallback {
	return event => {
		if (event.instruction) {
			dispatch({type: 'progress', id: event.componentId ?? fallbackId, message: event.instruction, level: event.level});
		}
	};
}

function installOne(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: Dispatch,
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
				dispatch({type: 'item-patched', id: component.id, patch: successfulInstallPatch(component, outcome.version)});
				// 同步 App 层检测缓存，避免切换 Agent 后旧 detection.result 覆盖局部 patch。
				cache.refresh();
			} else {
				dispatch({type: 'item-failed', id: component.id, error: outcome.error ?? `${component.name} 安装失败`});
				cache.refresh();
			}
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

export function successfulInstallPatch(component: ManagedComponent, installedVersion?: string): ComponentPatch {
	const currentVersion = installedVersion ?? component.currentVersion;
	return {
		installed: true,
		hasUpdate: false,
		currentVersion,
		statusHint: undefined,
		sharedInstalled: true,
		sharedVersion: currentVersion
	};
}

// ── 更新（单项 / 一键） ───────────────────────────────────────────────────────

function updateOne(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: Dispatch,
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
				dispatch({type: 'item-failed', id: component.id, error: `${component.name} 更新失败`});
				cache.refresh();
				return;
			}

			toast.success(`${component.name} 已更新`);
			dispatch({type: 'item-patched', id: component.id, patch: successfulUpdatePatch(component)});
			// 同步 App 层检测缓存，避免切换 Agent 后旧 detection.result 覆盖局部 patch。
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

export function successfulUpdatePatch(component: ManagedComponent): ComponentPatch {
	const shared = component as SharedManagedComponent;
	const currentVersion = component.latestVersion || component.currentVersion;
	const patch: ComponentPatch = {
		installed: true,
		hasUpdate: false,
		currentVersion,
		statusHint: undefined
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

export function settleBatchUpdateComponents(
	components: readonly ManagedComponent[],
	targets: readonly ManagedComponent[],
	failedIds: ReadonlySet<string>
): readonly ManagedComponent[] {
	const successfulTargets = new Map(
		targets.filter(component => !failedIds.has(component.id)).map(component => [component.id, component] as const)
	);

	return components.map(component => {
		const target = successfulTargets.get(component.id);
		return target ? ({...component, ...successfulUpdatePatch(target)} as ManagedComponent) : component;
	});
}

function updateAll(
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
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
			const failedIds = new Set<string>(
				result.updatedItems
					.filter(item => item.startsWith('failed::'))
					.map(item => item.split('::')[1])
					.filter((id): id is string => Boolean(id))
			);
			const components = settleBatchUpdateComponents(view.components, targets, failedIds);
			const updatedCount = targets.length - failedIds.size;
			const summary =
				failedIds.size === 0
					? `已更新 ${targets.length} 个组件`
					: `${updatedCount}/${targets.length} 成功，失败: ${[...failedIds].join(', ')}`;
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

// ── 卸载确认 ─────────────────────────────────────────────────────────────────

function UninstallConfirm({
	view,
	dispatch,
	services,
	cache,
	taskCancellation,
	active
}: {
	readonly view: ToolsViewState;
	readonly dispatch: Dispatch;
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly taskCancellation: TaskCancellation;
	readonly active: boolean;
}) {
	const target = view.components.find(item => item.id === view.uninstallTarget);
	// d = 全量卸载（design D5）：inject 类解除两侧注入 + 共享 CLI/包；非 inject 走既有全局卸载。
	const fullUninstall = target ? isInjectableComponent(target.id) : false;

	useKeyboard(keyEvent => {
		if (!active || !target) return;

		const key = keyEvent.name;

		if (key === 'escape') {
			dispatch({type: 'cancel'});
			return;
		}

		if (key === 'enter' || key === 'return') {
			runUninstall(target, services, dispatch, cache, fullUninstall, taskCancellation);
		}
	});

	if (!target) {
		return null;
	}

	return (
		<Modal active title={`卸载确认：${target.name}`} hint="Enter 确认  Esc 取消" tone="danger" width={INJECT_MODAL_WIDTH}>
			<box flexDirection="column">
				{/* inject 类：全量卸载文案（CLI + 全部注入）；非 inject：既有全局卸载文案（按组件 id 区分，不依赖 Header 上下文）。 */}
				<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{uninstallImpactNotice(target.id, {fullUninstall})}
				</text>
			</box>
		</Modal>
	);
}

function runUninstall(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: Dispatch,
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
				dispatch({type: 'item-patched', id: component.id, patch: uninstallSuccessPatch(component, fullUninstall)});
				// 同步 App 层检测缓存，refresh 后经共享投影重投影双侧，禁止单上下文塌缩。
				cache.refresh();
			} else {
				const message = outcome.manualHint
					? `${outcome.error ?? '卸载失败'}\n${outcome.manualHint}`
					: (outcome.error ?? `${component.name} 卸载失败`);
				dispatch({type: 'item-failed', id: component.id, error: message});
				cache.refresh();
			}
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

export function uninstallSuccessPatch(component: ManagedComponent, fullUninstall: boolean): ComponentPatch {
	const patch: ComponentPatch = {
		installed: false,
		hasUpdate: null,
		currentVersion: '',
		latestVersion: '',
		statusHint: undefined,
		sharedInstalled: false,
		sharedVersion: ''
	};
	if (!fullUninstall || !isInjectableComponent(component.id)) {
		return patch;
	}

	return {
		...patch,
		injectByAgent: {
			cc: {context: 'cc', integrated: false},
			cx: {context: 'cx', integrated: false}
		}
	};
}

// ── 开关管理 Modal：↑/↓ 选 Claude Code / Codex，空格切换草稿开/关，Enter 统一应用，Esc 取消 ──

function InjectTargetModal({view}: {readonly view: ToolsViewState}) {
	const shared = cursorComponent(view) as SharedManagedComponent | undefined;
	const selected = injectTargetContext(view);
	const draft = view.injectDraft;

	return (
		<Modal
			active
			title={`管理开关：${shared?.name ?? ''}`}
			hint="↑/↓ 选择  空格 切换装/卸  Enter 应用  Esc 取消"
			width={INJECT_MODAL_WIDTH}
		>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map(ctx => {
					const enabled = Boolean(draft?.[ctx]);
					const focused = ctx === selected;
					// 每侧实际版本（已注入且版本可读时展示）：CcgWorkflow cc/cx 可不同版本，Modal 逐侧精确呈现。
					const version = shared?.injectByAgent?.[ctx]?.version;
					const stateLabel = enabled ? (version ? `● 已安装 ${version}` : '● 已安装') : '○ 卸载';
					return (
						<box key={ctx} flexDirection="row">
							<text
								fg={focused ? colors.primary : colors.muted}
								attributes={focused ? TextAttributes.BOLD : 0}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexGrow={1}
							>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]} `}
							</text>
							<text
								fg={enabled ? colors.success : colors.muted}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexShrink={0}
							>
								{stateLabel}
							</text>
						</box>
					);
				})}
			</box>
		</Modal>
	);
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

function renderDetectionNotice(status: DetectionState<ManagedComponent[]>['status']): React.ReactNode {
	if (status === 'loading' || status === 'idle') {
		return <ListLoadingState message="检测中..." />;
	}

	return null;
}

function toolCardId(component: ManagedComponent, index: number): string {
	return `tools-grid-item-${index}-${component.id}`;
}

type GridRow = readonly number[];

/**
 * 当前光标所属分组在扁平 view.components 中的首/末索引。
 * 各分组 grid 相对独立：左键停在分组首项（由调用方转为「返回菜单」），右键停在分组末项，横向不跨组。
 */
function cursorGroupBounds(view: ToolsViewState): {readonly start: number; readonly end: number} | null {
	for (const section of groupComponentsByToolGroup(view.components)) {
		const indices = section.components
			.map(component => view.components.findIndex(item => item.id === component.id))
			.filter(index => index >= 0);
		if (indices.length > 0 && indices.includes(view.cursor)) {
			return {start: Math.min(...indices), end: Math.max(...indices)};
		}
	}

	return null;
}

function groupedGridRows(view: ToolsViewState, columns: number): readonly GridRow[] {
	return groupComponentsByToolGroup(view.components).flatMap(section => {
		const indices = section.components
			.map(component => view.components.findIndex(item => item.id === component.id))
			.filter(index => index >= 0);
		const rows: GridRow[] = [];
		for (let offset = 0; offset < indices.length; offset += columns) {
			rows.push(indices.slice(offset, offset + columns));
		}

		return rows;
	});
}

function visualVerticalCursor(view: ToolsViewState, columns: number, direction: -1 | 1): number | null {
	const rows = groupedGridRows(view, columns);
	const rowIndex = rows.findIndex(row => row.includes(view.cursor));
	if (rowIndex === -1) {
		return null;
	}

	const currentRow = rows[rowIndex];
	if (!currentRow) {
		return null;
	}

	const columnIndex = currentRow.indexOf(view.cursor);
	const targetRow = rows[rowIndex + direction];
	if (!targetRow) {
		return null;
	}

	return targetRow[Math.min(columnIndex, targetRow.length - 1)] ?? null;
}

function renderGrid(view: ToolsViewState, scrollRef: React.RefObject<ScrollBoxRenderable | null>, active: boolean): React.ReactNode {
	// 加载态由 renderDetectionNotice 独占（Spinner「检测中...」），此处只处理「已加载但无组件」空状态，避免双重「检测中」。
	if (view.components.length === 0) {
		return view.loaded ? <ListEmptyState message="未检测到可管理的组件" /> : null;
	}

	const sections = groupComponentsByToolGroup(view.components);

	// 每组采用「分组 label + 该组 grid」；状态机仍使用扁平 view.components，避免改写光标/生命周期逻辑。
	// 外层用 ThemedScrollbox 承载溢出区域，键盘导航时 scrollChildIntoView 保证焦点卡片可见。
	return (
		<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, marginTop: 1}} viewportCulling scrollY scrollX={false}>
			<box flexDirection="column">
				{sections.map(section => (
					<box key={section.group} flexDirection="column" marginBottom={1}>
						<text
							fg={colors.primary}
							attributes={TextAttributes.BOLD}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>
							{section.label}
						</text>
						<box flexDirection="row" flexWrap="wrap">
							{section.components.map(component => {
								const index = view.components.findIndex(item => item.id === component.id);
								return (
									<box
										key={component.id}
										id={toolCardId(component, index)}
										marginRight={1}
										marginBottom={0}
										flexShrink={0}
									>
										<ToolCard
											component={component as SharedManagedComponent}
											focused={active && index === view.cursor}
											status={itemStatusOf(view, component.id)}
										/>
									</box>
								);
							})}
						</box>
					</box>
				))}
			</box>
		</ThemedScrollbox>
	);
}

// 管理开关 / 卸载确认 Modal 宽度：容纳最长 hint「↑/↓ 选择  空格 切换装/卸  Enter 应用  Esc 取消」单行不换行。
const INJECT_MODAL_WIDTH = 56;

function ToolCard({
	component,
	focused,
	status
}: {
	readonly component: SharedManagedComponent;
	readonly focused: boolean;
	readonly status: ComponentItemStatus;
}) {
	// 状态点在标题行右上角展示。CcgWorkflow 特例：平时两侧安装态已由卡片内 cc/cx 双态徽章行完整呈现，
	// 右上角聚合点冗余（且两侧版本可不同易误导），故隐藏；但「有更新」时（含更新执行态）于右上角高亮
	// 黄点 + 可更新版本号，便于快速发现待更新项。CodeGraph 是真·共享 CLI，右上角始终保留版本/更新态。
	// CcgWorkflow 平时靠卡片内双态徽章呈现两侧安装态，右上角聚合点冗余故隐藏；但「有更新」或
	// 处于执行态（安装/更新/卸载中）时于右上角展示状态点/loading，与其它工具一致。
	const titleRight =
		component.id === 'CcgWorkflow' ? (
			component.hasUpdate === true || status !== 'idle' ? (
				<StatusRight dot={toolStatusDot(component, status)} />
			) : undefined
		) : (
			<StatusRight dot={toolStatusDot(component, status)} />
		);
	// 卡片不固定高度：multiLine 让 body 按实际行数自然撑开（标题行 + 空行 + 描述 [+ 徽章行]），
	// inject 类比非 inject 高一行，同行按各自内容高度渲染，不再用 minHeight 强行拉平。
	return (
		<Card title={component.name} titleRight={titleRight} focused={focused} width={CARD_WIDTH} multiLine>
			<CardBody component={component} />
		</Card>
	);
}

// 标题行右上角：状态圆点 + 版本（toolStatusDot 的 label 已含版本/更新箭头）。
function StatusRight({dot}: {readonly dot: {readonly kind: StatusDotKind; readonly label: string}}) {
	return <StatusDot kind={dot.kind} label={dot.label} />;
}

// 卡片 body：inject 类为两行（行1 可跳转描述 + 行2 双态徽章）；非 inject 为单行可跳转描述。
// 描述统一走 DocsLink（官方文档 / GitHub），文案已在 tools-install 精简到卡片安全宽度，
// 保证 OSC-8 超链接序列不被 overflow 裁剪、终端可点击。
function CardBody({component}: {readonly component: SharedManagedComponent}) {
	if (component.sharingKind === 'shared-cli-per-agent-inject') {
		// 版本按侧独立展示：CcgWorkflow 两侧独立安装、可不同版本（cc=~/.claude/.ccg，cx=~/.codex/.ccg-version），
		// 故版本随各侧徽章走。CodeGraph 是真·共享 CLI，injectByAgent 无 version 字段，徽章不显版本（版本在右上角）。
		// inject 类用 cc/cx 双态徽章行替换标题下的空行（直接呈现两侧安装态），描述紧随徽章之下。
		return (
			<box flexDirection="column">
				<box flexDirection="row" height={1} overflow="hidden">
					<InjectBadge
						label={AGENT_CONTEXT_LABELS.cc}
						injected={Boolean(component.injectByAgent?.cc?.integrated)}
						version={component.injectByAgent?.cc?.version}
					/>
					<text fg={colors.muted}>{'  '}</text>
					<InjectBadge
						label={AGENT_CONTEXT_LABELS.cx}
						injected={Boolean(component.injectByAgent?.cx?.integrated)}
						version={component.injectByAgent?.cx?.version}
					/>
				</box>
				<box height={1} overflow="hidden">
					<DocsLink text={component.description} url={component.docsUrl} />
				</box>
			</box>
		);
	}

	// 非 inject（Agent 组 / statusLine / OpenSpec）：描述作为可点击链接跳官方文档 / GitHub。
	// 描述与标题行之间空一行分隔（spacer）。
	return (
		<box flexDirection="column">
			<box height={1} />
			<box height={1} overflow="hidden">
				<DocsLink text={component.description} url={component.docsUrl} />
			</box>
		</box>
	);
}

// 可跳转描述链接（OSC-8）：终端支持时可点击打开 docsUrl，不支持则降级为普通文本。
function DocsLink({text, url}: {readonly text: string; readonly url?: string}) {
	if (!url) {
		return (
			<text fg={colors.muted} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{text}
			</text>
		);
	}

	return (
		<text selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			<a href={url} fg={colors.primary} attributes={TextAttributes.UNDERLINE}>
				{text}
			</a>
		</text>
	);
}

// 双态徽章：已注入=success ●，未注入=muted ○（全称标签，禁 cc/cx 缩写）。
// version 按侧独立（CcgWorkflow cc/cx 可不同版本）：已注入且有版本时附版本号。
function InjectBadge({label, injected, version}: {readonly label: string; readonly injected: boolean; readonly version?: string}) {
	const suffix = injected && version ? ` ${version}` : '';
	return (
		<text fg={injected ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${injected ? '●' : '○'} ${label}${suffix}`}
		</text>
	);
}

function agentExclusiveScope(id: ComponentId): string {
	switch (id) {
		case 'Ccline':
			return '仅 Claude Code';
		case 'ClaudeCode':
			return 'Claude Code 本体';
		case 'CodexCli':
			return 'Codex 本体';
		default:
			return '';
	}
}

function createToolsBusyOverlayState(view: ToolsViewState, onCancel: () => void): BusyOverlayState | null {
	if (!isAnyBusy(view)) {
		return null;
	}

	const action = currentToolsBusyAction(view);
	const currentTask = latestActiveProgressTask(view);
	return {
		title: action ? busyActionTitle(action, '工具') : '正在执行工具操作',
		message: currentTask ? `${currentTask.name} · ${currentTask.message}` : undefined,
		onCancel
	};
}

function currentToolsBusyAction(view: ToolsViewState): BusyAction | undefined {
	if (view.busyAction) {
		return view.busyAction;
	}

	const statuses = Object.values(view.itemStatus);
	if (statuses.includes('uninstalling')) return 'uninstall';
	if (statuses.includes('updating')) return 'update';
	if (statuses.includes('installing')) return 'install';
	return undefined;
}

/** 把组件状态 + 执行态映射为圆点语义。执行态优先于版本态。 */
export function toolStatusDot(component: SharedManagedComponent, status: ComponentItemStatus): {kind: StatusDotKind; label: string} {
	if (status === 'installing') {
		return {kind: 'installing', label: '安装中'};
	}

	if (status === 'updating') {
		return {kind: 'updating', label: '更新中'};
	}

	if (status === 'uninstalling') {
		return {kind: 'uninstalling', label: '卸载中'};
	}

	// inject 类行1 = 共享体/接入态：CodeGraph 看共享 CLI；CcgWorkflow 无真·共享 CLI，看任一侧是否注入。
	if (component.sharingKind === 'shared-cli-per-agent-inject') {
		return injectSharedDot(component);
	}

	if (!component.installed) {
		return {kind: 'notInstalled', label: '未安装'};
	}

	if (component.hasUpdate === true) {
		return {kind: 'updatable', label: `${component.currentVersion || '-'} → ${component.latestVersion || '-'}`};
	}

	if (component.hasUpdate === false) {
		return {kind: 'latest', label: component.currentVersion || '最新'};
	}

	// hasUpdate === null：已安装但无法判定更新（如 AntigravityCli 无远端版本源），显示版本号 + 无法检测更新标识。
	return {kind: 'latest', label: `${component.currentVersion || '已安装'} · 无法检测更新`};
}

// inject 类行1：CodeGraph 用共享 CLI 版本态；CcgWorkflow 无共享 CLI，只要任一侧注入即视为已安装。
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

	// CcgWorkflow：无全局共享 CLI，cc/cx 各自独立安装、版本可不同。
	// 行 1 状态点取两侧较旧版本对外展示（保守口径，避免误以为整体已是最新）；
	// per-side 精确版本仍在管理开关 Modal 与行 2 双态徽章按侧展示。
	if (!anyInjected) {
		return {kind: 'notInstalled', label: '未安装'};
	}
	const olderVersion = olderInjectedVersion(component);
	if (component.hasUpdate === true) {
		// 与全页其它 updatable 组件统一口径：旧版本 → 最新版本；旧版本不可读时退回 latestVersion 单值。
		return {
			kind: 'updatable',
			label: olderVersion ? `${olderVersion} → ${component.latestVersion || '-'}` : `→ ${component.latestVersion || '-'}`
		};
	}
	return {kind: 'latest', label: olderVersion || '已安装'};
}

// CcgWorkflow 状态点版本口径：取 cc/cx 两侧已注入版本中较旧的一个（保守展示）。
// 仅一侧有版本时返回该版本；两侧皆无版本（已注入但版本文件不可读）返回空串由调用方兜底文案。
function olderInjectedVersion(component: SharedManagedComponent): string {
	const versions = AGENT_CONTEXT_ORDER.map(ctx => component.injectByAgent?.[ctx])
		.filter((snapshot): snapshot is AgentInjectSnapshot => Boolean(snapshot?.integrated && snapshot.version))
		.map(snapshot => snapshot.version as string);

	if (versions.length === 0) {
		return '';
	}

	return versions.reduce((older, current) => (semverCompare(current, older) < 0 ? current : older));
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
