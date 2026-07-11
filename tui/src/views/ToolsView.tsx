import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { TextAttributes, type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Card, ErrorPanel, ListEmptyState, ListLoadingState, Modal, ProgressLog, StatusDot, ThemedScrollbox, ViewHeader, toast, type StatusDotKind } from '../components/index.js';
import { colors } from '../theme/index.js';
import type {ProgressCallback} from '../core/exec.js';
import type { DetectionState } from '../services/async-detection.js';
import type { DetectionCache } from '../hooks/use-detection-cache.js';
import type { DetectionRunner, DetectionRunOptions, DetectionStateSink } from '../services/detection-runner.js';
import type { ComponentId, ComponentInstallOutcome, ComponentUninstallOutcome, ManagedComponent, SharedManagedComponent } from '../core/tools-manage.js';
import type { ApplyUpdatesResult } from '../core/update.js';
import {
	createInitialToolsViewState,
	cursorComponent,
	isAnyBusy,
	itemStatusOf,
	reduceToolsViewState,
	updatableComponents,
	activeProgressTasks,
	injectTargetContext,
	initialInjectDraft,
	CARD_WIDTH,
	computeColumns,
	type ComponentItemStatus,
	type ToolsViewAction,
	type ToolsViewState
} from '../state/tools-view-state.js';
import {groupComponentsByToolGroup, isInjectableComponent, projectSharedToolComponents, uninstallImpactNotice} from '../core/tools-manage.js';
import {openUrl} from '../core/open-url.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../state/manage-state.js';

type Dispatch = React.Dispatch<ToolsViewAction>;

// 工具管理视图（Phase 4，OpenTUI 适配）：合并工具安装 + 检查更新为全生命周期菜单。
// grid 卡片范式：flexWrap 布局 + StatusDot 彩色圆点 + 上下左右 2D 导航。
// 卡片按状态暴露操作：未装→安装 / 可更新→更新 / 已装→卸载（u 强确认）。
// 检测缓存提升到 App 层：切走再切回不重跑；r 键刷新。
// OpenTUI 适配：useKeyboard 替代 useInput，<box>/<text> 小写元素，<input> 替代 ink-text-input。

/** 卸载调用选项：Enter 单侧 eject 传 agentContext；d 全量卸载传 fullUninstall。 */
export type UninstallOptions = {
	readonly agentContext?: AgentContext;
	readonly fullUninstall?: boolean;
};

export type ToolsViewServices = {
	readonly detectComponents: () => Promise<readonly ManagedComponent[]>;
	readonly installComponent: (id: ComponentId, onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<ComponentInstallOutcome>;
	readonly installMultiple: (ids: readonly ComponentId[], onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<readonly ComponentInstallOutcome[]>;
	readonly updateComponents: (components: readonly ManagedComponent[], onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<ApplyUpdatesResult>;
	readonly uninstallComponent: (id: ComponentId, onProgress?: ProgressCallback, options?: UninstallOptions) => Promise<ComponentUninstallOutcome>;
	// 单侧 inject/eject：显式传目标 Agent，禁止依赖 Header agentContext（design D5/4.2）。
	readonly injectComponent: (id: ComponentId, target: AgentContext, onProgress?: ProgressCallback) => Promise<ComponentInstallOutcome>;
	readonly ejectComponent: (id: ComponentId, target: AgentContext, onProgress?: ProgressCallback) => Promise<ComponentUninstallOutcome>;
	readonly createDetectionRunner: (onChange: DetectionStateSink<ManagedComponent[]>) => DetectionRunner<ManagedComponent[]>;
	readonly runDetection: (runner: DetectionRunner<ManagedComponent[]>) => Promise<unknown>;
	readonly refreshDetection?: (runner: DetectionRunner<ManagedComponent[]>, options?: DetectionRunOptions) => Promise<unknown>;
};

export type ToolsViewProps = {
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly agentContext: AgentContext;
	readonly active?: boolean;
	readonly viewportHeight?: number;
	readonly viewportWidth?: number;
	readonly contentWidth?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav?: () => void;
};

export function ToolsView({ services: rawServices, cache, agentContext, active = true, viewportHeight = 16, viewportWidth = 52, contentWidth, onSubModeChange, onExitToNav }: ToolsViewProps) {
	const [view, dispatch] = useReducer(reduceToolsViewState, undefined, createInitialToolsViewState);
	const detection = cache.state;

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
			dispatch({ type: 'components-loaded', components: projectSharedToolComponents(detection.result ?? []) });
		}

		if (detection.status === 'error') {
			dispatch({ type: 'detection-error', error: detection.error ?? '检测失败' });
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

	// 上报当前子模式给 App footer：inject 类光标下 grid → grid-inject（footer 展示「选择注入目标」）。
	const cursorInjectable = cursorCard ? isInjectableComponent(cursorCard.id) : false;
	useEffect(() => {
		if (!active) {
			return;
		}
		const subMode =
			view.mode === 'busy' ? 'busy'
			: view.mode === 'confirm-uninstall' ? 'confirm-uninstall'
			: view.mode === 'select-inject-target' ? 'select-inject-target'
			: cursorInjectable ? 'grid-inject'
			: 'grid';
		onSubModeChange?.(subMode);
	}, [active, view.mode, cursorInjectable, onSubModeChange]);

	useEffect(() => {
		if (!scrollRef.current || !activeCardId) {
			return;
		}

		scrollRef.current.scrollChildIntoView(activeCardId);
	}, [activeCardId]);

	// 键盘输入处理
	useKeyboard((keyEvent) => {
		if (!active) return;

		// OpenTUI 回调收到 KeyEvent 对象，取 .name 得到键名字符串。
		const key = keyEvent.name;

		// grid 模式 Esc 退回左侧导航；←/→ 留给网格内光标移动（横向布局下选中相邻工具）。
		if (view.mode === 'grid' && key === 'escape' && onExitToNav) {
			onExitToNav();
			return;
		}

		// grid 模式选中第一个时，← 直接退回左侧导航（行首边界快捷返回，与 Esc 等效）。
		if (view.mode === 'grid' && (key === 'left' || key === 'arrowleft') && view.cursor === 0 && onExitToNav) {
			onExitToNav();
			return;
		}

		if (view.mode === 'confirm-uninstall') {
			// 卸载确认模式由 UninstallConfirm 内部处理
			return;
		}

		if (view.mode === 'select-inject-target') {
			handleInjectTargetKey(key, view, services, dispatch, cache);
			return;
		}

		if (view.mode === 'busy') {
			return; // 执行中禁用操作
		}

		handleGridKey(key, view, services, dispatch, cache, columns);
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="工具管理" subtitle="管理常用 CLI 工具的安装、更新与卸载" />
			{renderDetectionNotice(detection.status)}
			{/* 检测中时隐藏网格，仅显示加载态；检测完成后才显示分组网格或空状态 */}
			{detection.status !== 'loading' && detection.status !== 'idle' ? renderGrid(view, scrollRef, active) : null}
			{activeProgressTasks(view).length > 0 ? <ActiveProgressTasks tasks={activeProgressTasks(view)} /> : null}
			{view.errorText ? <ErrorPanel message={view.errorText} /> : null}
			{view.mode === 'confirm-uninstall' ? <UninstallConfirm view={view} dispatch={dispatch} services={services} cache={cache} active={active} agentContext={agentContext} viewportWidth={viewportWidth} viewportHeight={viewportHeight} /> : null}
			{view.mode === 'select-inject-target' ? <InjectTargetModal view={view} viewportWidth={viewportWidth} viewportHeight={viewportHeight} /> : null}
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
	columns: number
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		const nextCursor = visualVerticalCursor(view, columns, -1);
		if (nextCursor !== null) {
			dispatch({ type: 'nav', delta: nextCursor - view.cursor });
		}
		// 顶行 ↑：停在首项（Tools 无 Header，不退回）。
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		const nextCursor = visualVerticalCursor(view, columns, 1);
		if (nextCursor !== null) {
			dispatch({ type: 'nav', delta: nextCursor - view.cursor });
		}
		return;
	}

	if (k === 'left' || k === 'arrowleft') {
		dispatch({ type: 'nav', delta: -1 });
		return;
	}

	if (k === 'right' || k === 'arrowright') {
		dispatch({ type: 'nav', delta: 1 });
		return;
	}

	// i：安装当前项（仅非 inject 未安装项）；单义键，取代原多义 Enter。
	if (k === 'i') {
		installCurrent(view, services, dispatch, cache);
		return;
	}

	// m：管理开关（仅 inject 类 CodeGraph / CcgWorkflow，打开注入开关 Modal）；单义键，取代原多义 Enter。
	if (k === 'm') {
		manageInjectCurrent(view, dispatch);
		return;
	}

	// u：更新当前项（含 inject 类共享 CLI）。
	if (k === 'u') {
		updateCurrent(view, services, dispatch, cache);
		return;
	}

	if (k === 'a') {
		updateAll(view, services, dispatch, cache);
		return;
	}

	if (k === 'd') {
		dispatch({ type: 'request-uninstall' });
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

	void openUrl(component.docsUrl).then((result) => {
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
	cache: DetectionCache<ManagedComponent[]>
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		dispatch({ type: 'inject-target-nav', delta: -1 });
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		dispatch({ type: 'inject-target-nav', delta: 1 });
		return;
	}

	if (k === 'space' || key === ' ') {
		dispatch({ type: 'inject-target-toggle' });
		return;
	}

	if (k === 'escape') {
		dispatch({ type: 'cancel' });
		return;
	}

	if (k === 'enter' || k === 'return') {
		applyInjectDraft(view, services, dispatch, cache);
	}
}

// ── i：安装当前项（仅非 inject 未安装项）─────────────────────────────────────────

function installCurrent(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const component = cursorComponent(view) as SharedManagedComponent | undefined;
	if (!component) {
		return;
	}

	if (itemStatusOf(view, component.id) !== 'idle') {
		return;
	}

	// inject 类的安装/接入统一走「管理开关」（m）；i 仅处理非 inject 项。
	if (isInjectableComponent(component.id)) {
		toast.info(`${component.name} 请按 m 管理开关`);
		return;
	}

	if (!component.installed) {
		installOne(component, services, dispatch, cache);
		return;
	}

	if (component.hasUpdate === true) {
		toast.info(`${component.name} 有更新，请按 u 更新`);
		return;
	}

	toast.success(`${component.name} 已安装`);
}

// ── m：管理开关（仅 inject 类，打开注入开关 Modal）─────────────────────────────────

function manageInjectCurrent(view: ToolsViewState, dispatch: Dispatch): void {
	const component = cursorComponent(view) as SharedManagedComponent | undefined;
	if (!component) {
		return;
	}

	if (itemStatusOf(view, component.id) !== 'idle') {
		return;
	}

	if (!isInjectableComponent(component.id)) {
		toast.info(`${component.name} 无注入开关`);
		return;
	}

	// inject 类（CodeGraph / CcgWorkflow）：打开开关 Modal，用当前状态初始化草稿（D5）。
	dispatch({ type: 'open-inject-target', draft: initialInjectDraft(component) });
}

// ── u：更新当前项（含 inject 类共享 CLI；无更新则提示已是最新） ──────────────────

function updateCurrent(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	if (itemStatusOf(view, component.id) !== 'idle') {
		return;
	}

	if (component.hasUpdate === true) {
		updateOne(component, services, dispatch, cache);
		return;
	}

	if (!component.installed) {
		toast.info(`${component.name} 未安装`);
		return;
	}

	toast.success(`${component.name} 已是最新`);
}

// ── Enter 应用开关草稿：对比草稿与实际态，对每个变化侧顺序执行 inject/eject ──────────

function applyInjectDraft(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const component = cursorComponent(view) as SharedManagedComponent | undefined;
	const draft = view.injectDraft;
	if (!component || !isInjectableComponent(component.id) || !draft) {
		dispatch({ type: 'cancel' });
		return;
	}

	// 计算与实际态有差异的侧（草稿 true=开启注入，false=关闭）。
	const changes = AGENT_CONTEXT_ORDER
		.map(ctx => ({ ctx, desired: draft[ctx], actual: Boolean(component.injectByAgent?.[ctx]?.integrated) }))
		.filter(item => item.desired !== item.actual);

	if (changes.length === 0) {
		toast.info('未改变任何开关');
		dispatch({ type: 'cancel' });
		return;
	}

	dispatch({ type: 'item-start', id: component.id, action: 'install' });
	void runInjectChanges(component, changes, services, dispatch)
		.then((nextInject) => {
			dispatch({ type: 'item-patched', id: component.id, patch: { injectByAgent: nextInject } });
			// 经共享投影重投影双侧，避免旧检测覆盖局部 patch。
			cache.refresh();
		})
		.catch((error: unknown) => {
			dispatch({ type: 'item-failed', id: component.id, error: errorMessage(error) });
		});
}

// 顺序执行各侧开/关；任一侧失败即抛错中止（已成功侧的结果由后续 refresh 重投影兜底）。
async function runInjectChanges(
	component: SharedManagedComponent,
	changes: readonly {readonly ctx: AgentContext; readonly desired: boolean}[],
	services: ToolsViewServices,
	dispatch: Dispatch
): Promise<SharedManagedComponent['injectByAgent']> {
	let nextInject = { ...(component.injectByAgent ?? {}) } as Record<AgentContext, {context: AgentContext; integrated: boolean}>;

	for (const { ctx, desired } of changes) {
		const label = AGENT_CONTEXT_LABELS[ctx];
		const outcome = desired
			? await services.injectComponent(component.id, ctx, progressSink(dispatch, component.id))
			: await services.ejectComponent(component.id, ctx, progressSink(dispatch, component.id));

		if (!outcome.success) {
			throw new Error(outcome.error ?? `${component.name} · ${label} 操作失败`);
		}

		nextInject = { ...nextInject, [ctx]: { context: ctx, integrated: desired } };
		toast.success(`${component.name} · ${label} 已${desired ? '开启' : '关闭'}`);
	}

	return nextInject as SharedManagedComponent['injectByAgent'];
}

// ── 安装（单项 / 批量，失败隔离） ─────────────────────────────────────────────

function progressSink(dispatch: Dispatch, fallbackId: string): ProgressCallback {
	return (event) => dispatch({type: 'progress', id: event.componentId ?? fallbackId, message: event.message, level: event.level});
}

function installOne(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({type: 'item-start', id: component.id, action: 'install'});
	void services
		.installComponent(component.id, progressSink(dispatch, component.id))
		.then((outcome) => {
			if (outcome.success) {
				toast.success(`${component.name} 安装成功`);
				// 就地 patch 单 item：装好后置为已安装、无更新；版本使用安装后检测结果，避免卡片短暂显示版本为空。
				dispatch({type: 'item-patched', id: component.id, patch: {installed: true, hasUpdate: false, currentVersion: outcome.version ?? component.currentVersion, statusHint: undefined}});
				// 同步 App 层检测缓存，避免切换 Agent 后旧 detection.result 覆盖局部 patch。
				cache.refresh();
			} else {
				dispatch({type: 'item-failed', id: component.id, error: outcome.error ?? `${component.name} 安装失败`});
			}
		})
		.catch((error: unknown) => {
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
		});
}

// ── 更新（单项 / 一键） ───────────────────────────────────────────────────────

function updateOne(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({type: 'item-start', id: component.id, action: 'update'});
	void services
		.updateComponents([component], progressSink(dispatch, component.id))
		.then((result) => {
			const failed = result.updatedItems.some((item) => item.startsWith(`failed::${component.id}`));
			if (failed) {
				dispatch({type: 'item-failed', id: component.id, error: `${component.name} 更新失败`});
				return;
			}

			toast.success(`${component.name} 已更新`);
			// 就地 patch：缓存的 latestVersion 即新安装的目标版本，置为 currentVersion 并清掉 hasUpdate，不整页强刷。
			dispatch({
				type: 'item-patched',
				id: component.id,
				patch: {
					installed: true,
					hasUpdate: false,
					currentVersion: component.latestVersion || component.currentVersion,
					statusHint: undefined
				}
			});
			// 同步 App 层检测缓存，避免切换 Agent 后旧 detection.result 覆盖局部 patch。
			cache.refresh();
		})
		.catch((error: unknown) => {
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
		});
}

function updateAll(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const targets = updatableComponents(view);
	if (targets.length === 0) {
		toast.info('没有可更新的组件');
		return;
	}

	dispatch({ type: 'batch-start', action: 'update', ids: targets.map((item) => item.id) });
	void services
		.updateComponents(targets, progressSink(dispatch, targets[0]?.id ?? 'batch-update'))
		.then(async (result) => {
			const components = await services.detectComponents();
			const failedIds = result.updatedItems.filter((item) => item.startsWith('failed::')).map((item) => item.split('::')[1]);
			const updatedCount = targets.length - failedIds.length;
			const summary =
				failedIds.length === 0
					? `已更新 ${targets.length} 个组件`
					: `${updatedCount}/${targets.length} 成功，失败: ${failedIds.join(', ')}`;
			if (failedIds.length === 0) {
				toast.success(summary);
				dispatch({ type: 'batch-done', components });
			} else {
				dispatch({ type: 'batch-failed', error: summary, components });
			}

			cache.refresh();
		})
		.catch(async (error: unknown) => {
			const components = await services.detectComponents().catch(() => []);
			dispatch({ type: 'batch-failed', error: errorMessage(error), components });
		});
}

// ── 卸载确认 ─────────────────────────────────────────────────────────────────

function UninstallConfirm({
	view,
	dispatch,
	services,
	cache,
	active,
	agentContext,
	viewportWidth,
	viewportHeight
}: {
	readonly view: ToolsViewState;
	readonly dispatch: Dispatch;
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly active: boolean;
	readonly agentContext: AgentContext;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
}) {
	const target = view.components.find((item) => item.id === view.uninstallTarget);
	if (!target) {
		return null;
	}

	// d = 全量卸载（design D5）：inject 类解除两侧注入 + 共享 CLI/包；非 inject 走既有全局卸载。
	const fullUninstall = isInjectableComponent(target.id);

	useKeyboard((keyEvent) => {
		if (!active) return;

		const key = keyEvent.name;

		if (key === 'escape') {
			dispatch({ type: 'cancel' });
			return;
		}

		if (key === 'enter' || key === 'return') {
			runUninstall(target, services, dispatch, cache, fullUninstall);
		}
	});

	return (
		<Modal
			active
			title={`卸载确认：${target.name}`}
			hint="Enter 确认  Esc 取消"
			tone="danger"
			viewportWidth={viewportWidth}
			viewportHeight={viewportHeight}
			width={INJECT_MODAL_WIDTH}
		>
			<box flexDirection="column">
				{target.isBase ? (
					<text fg={colors.danger} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						危险：这是基础组件，卸载将破坏整个 Claude Code 环境！
					</text>
				) : null}
				{/* inject 类：全量卸载文案（CLI + 全部注入）；非 inject：既有全局卸载文案。agentContext 仅用于非 inject 分支。 */}
				<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{uninstallImpactNotice(target.id, agentContext, {fullUninstall})}</text>
			</box>
		</Modal>
	);
}

function runUninstall(
	component: ManagedComponent,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	fullUninstall: boolean
): void {
	dispatch({type: 'confirm-uninstall'});
	void services
		.uninstallComponent(component.id, progressSink(dispatch, component.id), {fullUninstall})
		.then((outcome) => {
			if (outcome.success) {
				toast.success(`${component.name} 已卸载`);
				// inject 类全量卸载后两侧 inject 与共享体均置空；非 inject 置为未安装。经 refresh 重投影恢复真实态。
				const patch = fullUninstall
					? {installed: false, hasUpdate: null, currentVersion: '', latestVersion: '', sharedInstalled: false, statusHint: undefined}
					: {installed: false, hasUpdate: null, currentVersion: '', latestVersion: '', statusHint: undefined};
				dispatch({type: 'item-patched', id: component.id, patch});
				// 同步 App 层检测缓存，refresh 后经共享投影重投影双侧，禁止单上下文塌缩。
				cache.refresh();
			} else {
				const message = outcome.manualHint
					? `${outcome.error ?? '卸载失败'}\n${outcome.manualHint}`
					: outcome.error ?? `${component.name} 卸载失败`;
				dispatch({type: 'item-failed', id: component.id, error: message});
			}
		})
		.catch((error: unknown) => {
			dispatch({type: 'item-failed', id: component.id, error: errorMessage(error)});
		});
}

// ── 开关管理 Modal：↑/↓ 选 Claude Code / Codex，空格切换草稿开/关，Enter 统一应用，Esc 取消 ──

function InjectTargetModal({
	view,
	viewportWidth,
	viewportHeight
}: {
	readonly view: ToolsViewState;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
}) {
	const shared = cursorComponent(view) as SharedManagedComponent | undefined;
	const selected = injectTargetContext(view);
	const draft = view.injectDraft;

	return (
		<Modal
			active
			title={`管理开关：${shared?.name ?? ''}`}
			hint="↑/↓ 选择  空格 切换开/关  Enter 应用  Esc 取消"
			viewportWidth={viewportWidth}
			viewportHeight={viewportHeight}
			width={INJECT_MODAL_WIDTH}
		>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map((ctx) => {
					const enabled = Boolean(draft?.[ctx]);
					const focused = ctx === selected;
					return (
						<box key={ctx} flexDirection="row">
							<text fg={focused ? colors.primary : colors.muted} attributes={focused ? TextAttributes.BOLD : 0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} flexGrow={1}>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]} `}
							</text>
							<text fg={enabled ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} flexShrink={0}>
								{enabled ? '● 开启' : '○ 关闭'}
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

function groupedGridRows(view: ToolsViewState, columns: number): readonly GridRow[] {
	return groupComponentsByToolGroup(view.components).flatMap(section => {
		const indices = section.components.map(component => view.components.findIndex(item => item.id === component.id)).filter(index => index >= 0);
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
		<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1}} viewportCulling scrollY scrollX={false}>
			<box flexDirection="column">
				{sections.map(section => (
					<box key={section.group} flexDirection="column" marginBottom={1}>
						<text fg={colors.primary} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{section.label}</text>
						<box flexDirection="row" flexWrap="wrap">
							{section.components.map(component => {
								const index = view.components.findIndex(item => item.id === component.id);
								return (
									<box key={component.id} id={toolCardId(component, index)} marginRight={1} marginBottom={0} flexShrink={0}>
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

// 卡高统一：title 行（含右上角状态/版本）+ body（inject 类 2 行：描述链接 + 双态徽章；非 inject 1 行描述）+ 边框 2。
// inject 类 body 增至 2 行，minHeight 由 4→5 使 flexWrap 行内所有卡片等高。
const CARD_MIN_HEIGHT = 5;

// 管理开关 / 卸载确认 Modal 宽度：容纳最长 hint「↑/↓ 选择  空格 切换开/关  Enter 应用  Esc 取消」单行不换行。
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
	// 状态 + 版本移到标题行右上角；CcgWorkflow 除外（两侧版本可不同，随各侧徽章走）。
	const titleRight = component.id === 'CcgWorkflow' ? undefined : <StatusRight dot={dotKindFor(component, status)} />;
	return (
		<Card title={component.name} titleRight={titleRight} focused={focused} width={CARD_WIDTH} minHeight={CARD_MIN_HEIGHT}>
			<CardBody component={component} />
		</Card>
	);
}

// 标题行右上角：状态圆点 + 版本（dotKindFor 的 label 已含版本/更新箭头）。
function StatusRight({ dot }: { readonly dot: { readonly kind: StatusDotKind; readonly label: string } }) {
	return <StatusDot kind={dot.kind} label={dot.label} />;
}

// 卡片 body：inject 类为两行（行1 可跳转描述 + 行2 双态徽章）；非 inject 为单行可跳转描述。
// 描述统一走 DocsLink（官方文档 / GitHub），文案已在 tools-install 精简到卡片安全宽度，
// 保证 OSC-8 超链接序列不被 overflow 裁剪、终端可点击。
function CardBody({ component }: { readonly component: SharedManagedComponent }) {
	if (component.sharingKind === 'shared-cli-per-agent-inject') {
		// 版本按侧独立展示：CcgWorkflow 两侧独立安装、可不同版本（cc=~/.claude/.ccg，cx=~/.codex/.ccg-version），
		// 故版本随各侧徽章走。CodeGraph 是真·共享 CLI，injectByAgent 无 version 字段，徽章不显版本（版本在右上角）。
		return (
			<box flexDirection="column">
				<box height={1} overflow="hidden">
					<DocsLink text={component.description} url={component.docsUrl} />
				</box>
				<box flexDirection="row" height={1} overflow="hidden">
					<InjectBadge label={AGENT_CONTEXT_LABELS.cc} injected={Boolean(component.injectByAgent?.cc?.integrated)} version={component.injectByAgent?.cc?.version} />
					<text fg={colors.muted}>{'  '}</text>
					<InjectBadge label={AGENT_CONTEXT_LABELS.cx} injected={Boolean(component.injectByAgent?.cx?.integrated)} version={component.injectByAgent?.cx?.version} />
				</box>
			</box>
		);
	}

	// 非 inject（Agent 组 / statusLine / OpenSpec）：描述作为可点击链接跳官方文档 / GitHub。
	return (
		<box height={1} overflow="hidden">
			<DocsLink text={component.description} url={component.docsUrl} />
		</box>
	);
}

// 可跳转描述链接（OSC-8）：终端支持时可点击打开 docsUrl，不支持则降级为普通文本。
function DocsLink({ text, url }: { readonly text: string; readonly url?: string }) {
	if (!url) {
		return (
			<text fg={colors.muted} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{text}
			</text>
		);
	}

	return (
		<text selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			<a href={url} fg={colors.primary} attributes={TextAttributes.UNDERLINE}>{text}</a>
		</text>
	);
}

// 双态徽章：已注入=success ●，未注入=muted ○（全称标签，禁 cc/cx 缩写）。
// version 按侧独立（CcgWorkflow cc/cx 可不同版本）：已注入且有版本时附版本号。
function InjectBadge({ label, injected, version }: { readonly label: string; readonly injected: boolean; readonly version?: string }) {
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

/** 活跃任务进度：遍历进行中的组件，每个一项；完成（离开进行时态）自动从列表消失，下方上移补齐。 */
function ActiveProgressTasks({tasks}: {readonly tasks: ReturnType<typeof activeProgressTasks>}) {
	return (
		<ProgressLog
			title="执行进度"
			entries={tasks.map(task => ({id: task.id, message: `${task.name} · ${task.message}`, level: task.level}))}
		/>
	);
}

/** 把组件状态 + 执行态映射为圆点语义。执行态优先于版本态。 */
function dotKindFor(component: SharedManagedComponent, status: ComponentItemStatus): { kind: StatusDotKind; label: string } {
	if (status === 'installing') {
		return { kind: 'installing', label: '安装中' };
	}

	if (status === 'updating') {
		return { kind: 'updating', label: '更新中' };
	}

	if (status === 'uninstalling') {
		return { kind: 'uninstalling', label: '卸载中' };
	}

	// inject 类行1 = 共享体/接入态：CodeGraph 看共享 CLI；CcgWorkflow 无真·共享 CLI，看任一侧是否注入。
	if (component.sharingKind === 'shared-cli-per-agent-inject') {
		return injectSharedDot(component);
	}

	if (!component.installed) {
		return { kind: 'notInstalled', label: '未安装' };
	}

	if (component.hasUpdate === true) {
		return { kind: 'updatable', label: `${component.currentVersion || '-'} → ${component.latestVersion || '-'}` };
	}

	if (component.hasUpdate === false) {
		return { kind: 'latest', label: component.currentVersion || '最新' };
	}

	// hasUpdate === null：已安装但无法判定更新（如 AntigravityCli 无远端版本源），显示版本号 + 无法检测更新标识。
	return { kind: 'latest', label: `${component.currentVersion || '已安装'} · 无法检测更新` };
}

// inject 类行1：CodeGraph 用共享 CLI 版本态；CcgWorkflow 无共享 CLI，只要任一侧注入即视为已安装。
function injectSharedDot(component: SharedManagedComponent): { kind: StatusDotKind; label: string } {
	const anyInjected = component.injectByAgent
		? Object.values(component.injectByAgent).some(snapshot => snapshot.integrated)
		: false;

	if (component.id === 'CodeGraph') {
		if (!component.sharedInstalled) {
			return anyInjected ? { kind: 'latest', label: 'CLI 已装' } : { kind: 'notInstalled', label: '未安装' };
		}
		if (component.hasUpdate === true) {
			return { kind: 'updatable', label: `${component.currentVersion || '-'} → ${component.latestVersion || '-'}` };
		}
		return { kind: 'latest', label: component.currentVersion || 'CLI 已装' };
	}

	// CcgWorkflow：无全局共享 CLI，cc/cx 各自独立安装、版本可不同。
	// 行 1 只表达「已安装/未安装 + 是否有更新」共享层状态；per-side 版本放行 2 双态徽章，避免两侧版本冲突时误导。
	if (!anyInjected) {
		return { kind: 'notInstalled', label: '未安装' };
	}
	if (component.hasUpdate === true) {
		return { kind: 'updatable', label: '有更新' };
	}
	return { kind: 'latest', label: '已安装' };
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
