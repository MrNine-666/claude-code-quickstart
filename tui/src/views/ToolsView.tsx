import React, { useEffect, useMemo, useReducer, useRef } from 'react';
import { TextAttributes, type ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Card, ErrorPanel, ListEmptyState, ListLoadingState, Modal, ProgressLog, StatusDot, ThemedScrollbox, ViewHeader, toast, type StatusDotKind } from '../components/index.js';
import { colors } from '../theme/index.js';
import type {ProgressCallback} from '../core/exec.js';
import type { DetectionState } from '../services/async-detection.js';
import type { DetectionCache } from '../hooks/use-detection-cache.js';
import type { DetectionRunner, DetectionRunOptions, DetectionStateSink } from '../services/detection-runner.js';
import type { ComponentId, ComponentInstallOutcome, ComponentUninstallOutcome, ManagedComponent } from '../core/tools-manage.js';
import type { ApplyUpdatesResult } from '../core/update.js';
import {
	createInitialToolsViewState,
	cursorComponent,
	isAnyBusy,
	itemStatusOf,
	reduceToolsViewState,
	updatableComponents,
	activeProgressTasks,
	CARD_WIDTH,
	computeColumns,
	type ComponentItemStatus,
	type ToolsViewAction,
	type ToolsViewState
} from '../state/tools-view-state.js';
import {filterVisibleComponents, groupComponentsByToolGroup, uninstallImpactNotice} from '../core/tools-manage.js';
import type {AgentContext} from '../state/manage-state.js';

type Dispatch = React.Dispatch<ToolsViewAction>;

// 工具管理视图（Phase 4，OpenTUI 适配）：合并工具安装 + 检查更新为全生命周期菜单。
// grid 卡片范式：flexWrap 布局 + StatusDot 彩色圆点 + 上下左右 2D 导航。
// 卡片按状态暴露操作：未装→安装 / 可更新→更新 / 已装→卸载（u 强确认）。
// 检测缓存提升到 App 层：切走再切回不重跑；r 键刷新。
// OpenTUI 适配：useKeyboard 替代 useInput，<box>/<text> 小写元素，<input> 替代 ink-text-input。

export type ToolsViewServices = {
	readonly detectComponents: () => Promise<readonly ManagedComponent[]>;
	readonly installComponent: (id: ComponentId, onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<ComponentInstallOutcome>;
	readonly installMultiple: (ids: readonly ComponentId[], onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<readonly ComponentInstallOutcome[]>;
	readonly updateComponents: (components: readonly ManagedComponent[], onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<ApplyUpdatesResult>;
	readonly uninstallComponent: (id: ComponentId, onProgress?: ProgressCallback, agentContext?: AgentContext) => Promise<ComponentUninstallOutcome>;
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
	readonly onExitToHeader?: () => void;
};

export function ToolsView({ services: rawServices, cache, agentContext, active = true, viewportHeight = 16, viewportWidth = 52, contentWidth, onSubModeChange, onExitToNav, onExitToHeader }: ToolsViewProps) {
	const [view, dispatch] = useReducer(reduceToolsViewState, undefined, createInitialToolsViewState);
	const detection = cache.state;

	// 绑定 agentContext 到生命周期动作（install/uninstall/installMultiple）：CodeGraph 接入目标、
	// CcgWorkflow Codex 引导/卸载分支均随当前上下文（design D3/D4/D5）。下游辅助函数无需感知 agentContext。
	const services = useMemo<ToolsViewServices>(() => ({
		...rawServices,
		installComponent: (id, onProgress) => rawServices.installComponent(id, onProgress, agentContext),
		installMultiple: (ids, onProgress) => rawServices.installMultiple(ids, onProgress, agentContext),
		updateComponents: (components, onProgress) => rawServices.updateComponents(components, onProgress, agentContext),
		uninstallComponent: (id, onProgress) => rawServices.uninstallComponent(id, onProgress, agentContext)
	}), [rawServices, agentContext]);

	// 网格列数随终端内容区宽度自适应（卡宽固定），导航上下键 delta 跟随列数，避免视觉/语义错位。
	const columns = useMemo(() => computeColumns(contentWidth ?? 52), [contentWidth]);

	// 按 agentContext 过滤检测结果：ClaudeCode/CodexCli 两上下文常显，Ccline 仅 Claude Code（design D3）。
	// 过滤在下发给状态机前完成，光标/导航/一键更新均只作用于可见组件。
	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({ type: 'components-loaded', components: filterVisibleComponents(detection.result ?? [], agentContext) });
		}

		if (detection.status === 'error') {
			dispatch({ type: 'detection-error', error: detection.error ?? '检测失败' });
		}
	}, [detection.status, detection.result, detection.error, agentContext]);

	// 检测失败时弹 toast（长停留，保留「按 r 重试」指引；仅在 status 变 error 时触发一次）。
	useEffect(() => {
		if (detection.status === 'error') {
			toast.error('检测失败，可按 r 重试', 6000);
		}
	}, [detection.status]);

	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const cursorCard = view.components[view.cursor];
	const activeCardId = cursorCard ? toolCardId(cursorCard, view.cursor) : null;

	// 上报当前子模式给 App footer。
	useEffect(() => {
		if (active) {
			onSubModeChange?.(view.mode === 'busy' ? 'busy' : view.mode === 'confirm-uninstall' ? 'confirm-uninstall' : 'grid');
		}
	}, [active, view.mode, onSubModeChange]);

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

		if (view.mode === 'busy') {
			return; // 执行中禁用操作
		}

		handleGridKey(key, view, services, dispatch, cache, columns, onExitToHeader);
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
		</box>
	);
}

// ── grid 模式按键分发 ─────────────────────────────────────────────────────────

function handleGridKey(
	key: string,
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>,
	columns: number,
	onExitToHeader?: () => void
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		const nextCursor = visualVerticalCursor(view, columns, -1);
		if (nextCursor === null && onExitToHeader) {
			onExitToHeader();
		} else if (nextCursor !== null) {
			dispatch({ type: 'nav', delta: nextCursor - view.cursor });
		}
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

	if (k === 'enter' || k === 'return') {
		enterDefaultAction(view, services, dispatch, cache);
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
	}
}

// ── 默认操作（Enter）：按卡片状态分发安装/更新 ────────────────────────────────

function enterDefaultAction(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	const status = itemStatusOf(view, component.id);
	if (status !== 'idle') {
		return;
	}

	if (!component.installed) {
		installOne(component, services, dispatch, cache);
		return;
	}

	if (component.hasUpdate === true) {
		updateOne(component, services, dispatch, cache);
		return;
	}

	toast.success(`${component.name} 已是最新`);
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

	useKeyboard((keyEvent) => {
		if (!active) return;

		const key = keyEvent.name;

		if (key === 'escape') {
			dispatch({ type: 'cancel' });
			return;
		}

		if (key === 'enter' || key === 'return') {
			runUninstall(target, services, dispatch, cache);
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
			height={target.isBase ? 10 : 8}
		>
			<box flexDirection="column">
				{target.isBase ? (
					<text fg={colors.danger} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						危险：这是基础组件，卸载将破坏整个 Claude Code 环境！
					</text>
				) : null}
				{/* 真实影响范围文案（3.11）：按组件 + agentContext 解析，提示 CodeGraph 默认只解除集成、CcgWorkflow Codex 不删 config.toml 等 */}
				<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{uninstallImpactNotice(target.id, agentContext)}</text>
			</box>
		</Modal>
	);
}

function runUninstall(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({type: 'confirm-uninstall'});
	void services
		.uninstallComponent(component.id, progressSink(dispatch, component.id))
		.then((outcome) => {
			if (outcome.success) {
				toast.success(`${component.name} 已卸载`);
				// 就地 patch：卸载后置为未安装，不整页强刷。
				dispatch({type: 'item-patched', id: component.id, patch: {installed: false, hasUpdate: null, currentVersion: '', latestVersion: '', statusHint: undefined}});
				// 同步 App 层检测缓存，避免切换 Agent 后旧 detection.result 覆盖局部 patch。
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
											component={component}
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

function ToolCard({
	component,
	focused,
	status
}: {
	readonly component: ManagedComponent;
	readonly focused: boolean;
	readonly status: ComponentItemStatus;
}) {
	const dot = dotKindFor(component, status);
	return (
		<Card title={component.name} focused={focused} width={CARD_WIDTH} minHeight={4}>
			<StatusDot kind={dot.kind} label={dot.label} />
		</Card>
	);
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
function dotKindFor(component: ManagedComponent, status: ComponentItemStatus): { kind: StatusDotKind; label: string } {
	if (status === 'installing') {
		return { kind: 'installing', label: '安装中' };
	}

	if (status === 'updating') {
		return { kind: 'updating', label: '更新中' };
	}

	if (status === 'uninstalling') {
		return { kind: 'uninstalling', label: '卸载中' };
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

// ── 工具 ─────────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
