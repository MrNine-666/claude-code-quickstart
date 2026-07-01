import React, { useEffect, useMemo, useReducer } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Card, ErrorPanel, ListEmptyState, ListLoadingState, Modal, Spinner, StatusDot, ViewHeader, toast, type StatusDotKind } from '../components/index.js';
import { colors } from '../theme/index.js';
import type { ProgressCallback } from '../core/exec.js';
import type { DetectionState } from '../services/async-detection.js';
import type { DetectionCache } from '../hooks/use-detection-cache.js';
import type { DetectionRunner, DetectionStateSink } from '../services/detection-runner.js';
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

type Dispatch = React.Dispatch<ToolsViewAction>;

// 工具管理视图（Phase 4，OpenTUI 适配）：合并工具安装 + 检查更新为全生命周期菜单。
// grid 卡片范式：flexWrap 布局 + StatusDot 彩色圆点 + 上下左右 2D 导航。
// 卡片按状态暴露操作：未装→安装 / 可更新→更新 / 已装→卸载（u 强确认）。
// 检测缓存提升到 App 层：切走再切回不重跑；r 键刷新。
// OpenTUI 适配：useKeyboard 替代 useInput，<box>/<text> 小写元素，<input> 替代 ink-text-input。

export type ToolsViewServices = {
	readonly detectComponents: () => Promise<readonly ManagedComponent[]>;
	readonly installComponent: (id: ComponentId, onProgress?: ProgressCallback) => Promise<ComponentInstallOutcome>;
	readonly installMultiple: (ids: readonly ComponentId[], onProgress?: ProgressCallback) => Promise<readonly ComponentInstallOutcome[]>;
	readonly updateComponents: (components: readonly ManagedComponent[], onProgress?: ProgressCallback) => Promise<ApplyUpdatesResult>;
	readonly uninstallComponent: (id: ComponentId, onProgress?: ProgressCallback) => Promise<ComponentUninstallOutcome>;
	readonly createDetectionRunner: (onChange: DetectionStateSink<ManagedComponent[]>) => DetectionRunner<ManagedComponent[]>;
	readonly runDetection: (runner: DetectionRunner<ManagedComponent[]>) => Promise<unknown>;
};

export type ToolsViewProps = {
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly active?: boolean;
	readonly viewportHeight?: number;
	readonly viewportWidth?: number;
	readonly contentWidth?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav?: () => void;
};

export function ToolsView({ services, cache, active = true, viewportHeight = 16, viewportWidth = 52, contentWidth, onSubModeChange, onExitToNav }: ToolsViewProps) {
	const [view, dispatch] = useReducer(reduceToolsViewState, undefined, createInitialToolsViewState);
	const detection = cache.state;

	// 网格列数随终端内容区宽度自适应（卡宽固定），导航上下键 delta 跟随列数，避免视觉/语义错位。
	const columns = useMemo(() => computeColumns(contentWidth ?? 52), [contentWidth]);

	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({ type: 'components-loaded', components: detection.result ?? [] });
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

	// 上报当前子模式给 App footer。
	useEffect(() => {
		if (active) {
			onSubModeChange?.(view.mode === 'busy' ? 'busy' : view.mode === 'confirm-uninstall' ? 'confirm-uninstall' : 'grid');
		}
	}, [active, view.mode, onSubModeChange]);

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

		handleGridKey(key, view, services, dispatch, cache, columns);
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="工具管理" subtitle="管理常用 CLI 工具的安装、更新与卸载" />
			{renderDetectionNotice(detection.status)}
			{/* 检测中时隐藏网格，仅显示 Spinner；检测完成后才显示网格或空状态 */}
			{detection.status !== 'loading' && detection.status !== 'idle' ? renderGrid(view) : null}
			{activeProgressTasks(view).length > 0 ? <ActiveProgressTasks tasks={activeProgressTasks(view)} /> : null}
			{view.errorText ? <ErrorPanel message={view.errorText} /> : null}
			{view.mode === 'confirm-uninstall' ? <UninstallConfirm view={view} dispatch={dispatch} services={services} cache={cache} active={active} viewportWidth={viewportWidth} viewportHeight={viewportHeight} /> : null}
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
	columns: number
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		dispatch({ type: 'nav', delta: -columns });
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		dispatch({ type: 'nav', delta: columns });
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
		cache.refresh();
	}
}

// ── 默认操作（Enter）：按卡片状态分发安装/更新 ────────────────────────────────

function enterDefaultAction(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	const status = itemStatusOf(view, component.id);

	// 失败状态：允许重试安装/更新
	if (status === 'failed') {
		if (!component.installed) {
			installOne(component, services, dispatch, cache);
		} else if (component.hasUpdate === true) {
			updateOne(component, services, dispatch, cache);
		}
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
	return (event) => dispatch({ type: 'progress', id: event.componentId ?? fallbackId, message: event.message });
}

function installOne(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({ type: 'item-start', id: component.id, action: 'install' });
	void services
		.installComponent(component.id, progressSink(dispatch, component.id))
		.then(async (outcome) => {
			// 安装完成后立即刷新检测，获取最新状态（支持 ccg-init / shell-script 等需要环境变量刷新的工具）
			cache.refresh();
			// 等待检测完成后再更新状态
			await new Promise(resolve => setTimeout(resolve, 1000));
			const components = await services.detectComponents();
			if (outcome.success) {
				toast.success(`${component.name} 安装成功`);
				dispatch({ type: 'item-done', id: component.id, components });
			} else {
				dispatch({ type: 'item-failed', id: component.id, error: outcome.error ?? `${component.name} 安装失败`, components });
			}
		})
		.catch(async (error: unknown) => {
			const components = await services.detectComponents().catch(() => [] as readonly ManagedComponent[]);
			dispatch({ type: 'item-failed', id: component.id, error: errorMessage(error), components });
		});
}

// ── 更新（单项 / 一键） ───────────────────────────────────────────────────────

function updateOne(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({ type: 'item-start', id: component.id, action: 'update' });
	void services
		.updateComponents([component], progressSink(dispatch, component.id))
		.then(async (result) => {
			const components = await services.detectComponents();
			const failed = result.updatedItems.some((item) => item.startsWith(`failed::${component.id}`));
			if (failed) {
				dispatch({ type: 'item-failed', id: component.id, error: `${component.name} 更新失败`, components });
			} else {
				toast.success(`${component.name} 已更新`);
				dispatch({ type: 'item-done', id: component.id, components });
			}

			cache.refresh();
		})
		.catch(async (error: unknown) => {
			const components = await services.detectComponents().catch(() => [] as readonly ManagedComponent[]);
			dispatch({ type: 'item-failed', id: component.id, error: errorMessage(error), components });
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
	viewportWidth,
	viewportHeight
}: {
	readonly view: ToolsViewState;
	readonly dispatch: Dispatch;
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly active: boolean;
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
			height={target.isBase ? 9 : 7}
		>
			<box flexDirection="column">
				{target.isBase ? (
					<text fg={colors.danger} attributes={TextAttributes.BOLD}>
						危险：这是基础组件，卸载将破坏整个 Claude Code 环境！
					</text>
				) : null}
				<text>{target.isBase ? '基础组件卸载风险极高，确认继续？' : '确认卸载此组件？此操作不可撤销。'}</text>
			</box>
		</Modal>
	);
}

function runUninstall(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({ type: 'confirm-uninstall' });
	void services
		.uninstallComponent(component.id, progressSink(dispatch, component.id))
		.then(async (outcome) => {
			const components = await services.detectComponents();
			if (outcome.success) {
				toast.success(`${component.name} 已卸载`);
				dispatch({ type: 'item-done', id: component.id, components });
				cache.refresh();
			} else {
				const message = outcome.manualHint
					? `${outcome.error ?? '卸载失败'}\n${outcome.manualHint}`
					: outcome.error ?? `${component.name} 卸载失败`;
				dispatch({ type: 'item-failed', id: component.id, error: message, components });
			}
		})
		.catch(async (error: unknown) => {
			const components = await services.detectComponents().catch(() => [] as readonly ManagedComponent[]);
			dispatch({ type: 'item-failed', id: component.id, error: errorMessage(error), components });
		});
}

// ── 渲染 ─────────────────────────────────────────────────────────────────────

function renderDetectionNotice(status: DetectionState<ManagedComponent[]>['status']): React.ReactNode {
	if (status === 'loading' || status === 'idle') {
		return <ListLoadingState message="检测中..." />;
	}

	return null;
}

function renderGrid(view: ToolsViewState): React.ReactNode {
	// 加载态由 renderDetectionNotice 独占（Spinner「检测中...」），此处只处理「已加载但无组件」空状态，避免双重「检测中」。
	if (view.components.length === 0) {
		return view.loaded ? <ListEmptyState message="未检测到可管理的组件" /> : null;
	}

	// flex 自由换行：每卡固定宽度，按终端宽度自动排布（对齐原 UpdateView 范式）。
	// 卡片间留 1 字符水平间距（marginRight）提升视觉呼吸感。
	return (
		<box flexDirection="row" flexWrap="wrap">
			{view.components.map((component, index) => (
				<box key={component.id} marginRight={1} marginBottom={0}>
					<ToolCard
						component={component}
						focused={index === view.cursor}
						status={itemStatusOf(view, component.id)}
					/>
				</box>
			))}
		</box>
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
function ActiveProgressTasks({tasks}: {readonly tasks: readonly {readonly id: string; readonly name: string; readonly message: string}[]}) {
	return (
		<box flexDirection="column">
			<text attributes={TextAttributes.BOLD}>执行进度</text>
			{tasks.map(task => (
				<text key={task.id}>· {task.name} · {task.message}</text>
			))}
		</box>
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
