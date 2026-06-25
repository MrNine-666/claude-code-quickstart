import React, { useEffect, useReducer, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { Card, ErrorPanel, ProgressLog, StatusDot, StatusLabel, type StatusDotKind } from '../components/index.js';
import { colors } from '../theme/index.js';
import { truncateToWidth } from '../core/text-utils.js';
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
	selectedInstallTargets,
	updatableComponents,
	GRID_COLUMNS,
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

const CARD_WIDTH = 30;

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
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav?: () => void;
};

export function ToolsView({ services, cache, active = true, viewportHeight = 16, onSubModeChange, onExitToNav }: ToolsViewProps) {
	const [view, dispatch] = useReducer(reduceToolsViewState, undefined, createInitialToolsViewState);
	const detection = cache.state;

	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({ type: 'components-loaded', components: detection.result ?? [] });
		}

		if (detection.status === 'error') {
			dispatch({ type: 'detection-error', error: detection.error ?? '检测失败' });
		}
	}, [detection.status, detection.result, detection.error]);

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

		// grid 模式 Esc/← 退回左侧导航（与其他视图一致）。
		if (view.mode === 'grid' && (key === 'escape' || key === 'left' || key === 'arrowleft') && onExitToNav) {
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

		handleGridKey(key, view, services, dispatch, cache);
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<box marginBottom={1}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					工具管理
				</text>
				<text attributes={TextAttributes.DIM}>  安装 · 更新 · 卸载（全生命周期）</text>
			</box>
			{view.mode === 'confirm-uninstall' ? (
				<UninstallConfirm view={view} dispatch={dispatch} services={services} cache={cache} active={active} />
			) : (
				<>
					{renderDetectionNotice(detection.status)}
					{renderGrid(view)}
					{view.busyAction || isAnyBusy(view) ? <ProgressLog title="执行进度" messages={view.progress} /> : null}
					{view.notice ? <text fg={colors.success}>{view.notice}</text> : null}
					{view.errorText ? <ErrorPanel message={view.errorText} /> : null}
				</>
			)}
		</box>
	);
}

// ── grid 模式按键分发 ─────────────────────────────────────────────────────────

function handleGridKey(
	key: string,
	view: ToolsViewState,
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>
): void {
	const k = key.toLowerCase();

	if (k === 'up' || k === 'arrowup') {
		dispatch({ type: 'nav', delta: -GRID_COLUMNS });
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		dispatch({ type: 'nav', delta: GRID_COLUMNS });
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

	if (k === ' ') {
		dispatch({ type: 'toggle-select' });
		return;
	}

	if (k === 'a') {
		updateAll(view, services, dispatch, cache);
		return;
	}

	if (k === 'u' || k === 'x') {
		dispatch({ type: 'request-uninstall' });
		return;
	}

	if (k === 'r' && !isAnyBusy(view)) {
		dispatch({ type: 'clear-notice' });
		cache.refresh();
	}
}

// ── 默认操作（Enter）：按卡片状态分发安装/更新 ────────────────────────────────

function enterDefaultAction(view: ToolsViewState, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	const component = cursorComponent(view);
	if (!component) {
		return;
	}

	// 多选存在时，Enter 批量安装选中的未装项。
	const batch = selectedInstallTargets(view);
	if (batch.length > 0) {
		installBatch(batch, services, dispatch, cache);
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

	dispatch({ type: 'notice', message: `${component.name} 已是最新` });
}

// ── 安装（单项 / 批量，失败隔离） ─────────────────────────────────────────────

function progressSink(dispatch: Dispatch): ProgressCallback {
	return (event) => dispatch({ type: 'progress', message: event.message });
}

function installOne(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({ type: 'item-start', id: component.id, action: 'install' });
	void services
		.installComponent(component.id, progressSink(dispatch))
		.then(async (outcome) => {
			const components = await services.detectComponents();
			if (outcome.success) {
				dispatch({ type: 'item-done', id: component.id, summary: `${component.name} 安装成功`, components });
				cache.refresh();
			} else {
				dispatch({ type: 'item-failed', id: component.id, error: outcome.error ?? `${component.name} 安装失败`, components });
			}
		})
		.catch(async (error: unknown) => {
			const components = await services.detectComponents().catch(() => [] as readonly ManagedComponent[]);
			dispatch({ type: 'item-failed', id: component.id, error: errorMessage(error), components });
		});
}

function installBatch(
	ids: readonly ComponentId[],
	services: ToolsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<ManagedComponent[]>
): void {
	dispatch({ type: 'batch-start', action: 'install', ids });
	void services
		.installMultiple(ids, progressSink(dispatch))
		.then(async (outcomes) => {
			const failed = outcomes.filter((item) => !item.success);
			const components = await services.detectComponents();
			const summary =
				failed.length === 0
					? `已安装 ${ids.length} 个组件`
					: `${outcomes.length - failed.length}/${outcomes.length} 成功，失败: ${failed.map((item) => item.id).join(', ')}`;
			if (failed.length === 0) {
				dispatch({ type: 'batch-done', summary, components });
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

// ── 更新（单项 / 一键） ───────────────────────────────────────────────────────

function updateOne(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({ type: 'item-start', id: component.id, action: 'update' });
	void services
		.updateComponents([component], progressSink(dispatch))
		.then(async (result) => {
			const components = await services.detectComponents();
			const failed = result.updatedItems.some((item) => item.startsWith(`failed::${component.id}`));
			if (failed) {
				dispatch({ type: 'item-failed', id: component.id, error: `${component.name} 更新失败`, components });
			} else {
				dispatch({ type: 'item-done', id: component.id, summary: `${component.name} 已更新`, components });
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
		dispatch({ type: 'notice', message: '没有可更新的组件' });
		return;
	}

	dispatch({ type: 'batch-start', action: 'update', ids: targets.map((item) => item.id) });
	void services
		.updateComponents(targets, progressSink(dispatch))
		.then(async (result) => {
			const components = await services.detectComponents();
			const failedIds = result.updatedItems.filter((item) => item.startsWith('failed::')).map((item) => item.split('::')[1]);
			const updatedCount = targets.length - failedIds.length;
			const summary =
				failedIds.length === 0
					? `已更新 ${targets.length} 个组件`
					: `${updatedCount}/${targets.length} 成功，失败: ${failedIds.join(', ')}`;
			if (failedIds.length === 0) {
				dispatch({ type: 'batch-done', summary, components });
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

// ── 卸载强确认 ─────────────────────────────────────────────────────────────────

function UninstallConfirm({
	view,
	dispatch,
	services,
	cache,
	active
}: {
	readonly view: ToolsViewState;
	readonly dispatch: Dispatch;
	readonly services: ToolsViewServices;
	readonly cache: DetectionCache<ManagedComponent[]>;
	readonly active: boolean;
}) {
	const [value, setValue] = useState('');

	const target = view.components.find((item) => item.id === view.uninstallTarget);
	if (!target) {
		return null;
	}

	const matched = value.trim().toLowerCase() === target.name.toLowerCase();

	useKeyboard((keyEvent) => {
		if (!active) return;

		// OpenTUI 回调收到 KeyEvent 对象，取 .name 得到键名字符串。
		const key = keyEvent.name;

		if (key === 'escape') {
			dispatch({ type: 'cancel' });
			return;
		}

		if ((key === 'enter' || key === 'return') && matched) {
			// 先同步确认词到 state，reducer confirm-uninstall（在 runUninstall 内）再据此校验。
			dispatch({ type: 'confirm-input', value });
			runUninstall(target, services, dispatch, cache);
		}

		// 处理字符输入
		if (key === 'backspace' || key === 'delete') {
			setValue((prev) => prev.slice(0, -1));
			return;
		}

		// 可打印字符追加（排除修饰键组合与 tab）
		if (key.length === 1 && !keyEvent.ctrl && !keyEvent.meta && !keyEvent.option && key !== 'tab') {
			setValue((prev) => prev + key);
		}
	});

	return (
		<box flexDirection="column">
			<box marginBottom={1}>
				<text fg={colors.danger} attributes={TextAttributes.BOLD}>
					⚠ 卸载确认：{target.name}
				</text>
			</box>
			{target.isBase ? (
				<box marginBottom={1}>
					<text fg={colors.danger} attributes={TextAttributes.BOLD}>
						危险：这是基础组件，卸载将破坏整个 Claude Code 环境！
					</text>
				</box>
			) : null}
			<box marginBottom={1}>
				<text>输入组件名称 </text>
				<text fg={colors.warning} attributes={TextAttributes.BOLD}>
					{target.name}
				</text>
				<text> 以确认卸载：</text>
			</box>
			<box borderStyle="rounded" borderColor={matched ? colors.danger : 'gray'} paddingX={1}>
				<text>{value || target.name}</text>
				<text>_</text>
			</box>
			<box marginTop={1}>
				<text attributes={TextAttributes.DIM}>{matched ? 'Enter 确认卸载' : '确认词不匹配'}  Esc 取消</text>
			</box>
			{view.progress.length > 0 ? <ProgressLog title="执行进度" messages={view.progress} /> : null}
			{view.errorText ? <ErrorPanel message={view.errorText} /> : null}
		</box>
	);
}

function runUninstall(component: ManagedComponent, services: ToolsViewServices, dispatch: Dispatch, cache: DetectionCache<ManagedComponent[]>): void {
	dispatch({ type: 'confirm-uninstall' });
	void services
		.uninstallComponent(component.id, progressSink(dispatch))
		.then(async (outcome) => {
			const components = await services.detectComponents();
			if (outcome.success) {
				dispatch({ type: 'item-done', id: component.id, summary: `${component.name} 已卸载`, components });
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
		return <StatusLabel kind="loading" label="正在检测组件状态与远程版本..." />;
	}

	if (status === 'error') {
		return <StatusLabel kind="fail" label="检测失败，可按 r 重试" />;
	}

	return null;
}

function renderGrid(view: ToolsViewState): React.ReactNode {
	if (view.components.length === 0) {
		return <text attributes={TextAttributes.DIM}>{view.loaded ? '未检测到可管理的组件' : '检测中...'}</text>;
	}

	// flex 自由换行：每卡固定宽度，按终端宽度自动排布（对齐原 UpdateView 范式）。
	return (
		<box flexWrap="wrap">
			{view.components.map((component, index) => (
				<ToolCard
					key={component.id}
					component={component}
					focused={index === view.cursor}
					status={itemStatusOf(view, component.id)}
					selected={view.selected.includes(component.id)}
				/>
			))}
		</box>
	);
}

function ToolCard({
	component,
	focused,
	status,
	selected
}: {
	readonly component: ManagedComponent;
	readonly focused: boolean;
	readonly status: ComponentItemStatus;
	readonly selected: boolean;
}) {
	const dot = dotKindFor(component, status);
	return (
		<Card title={component.name} titleRight={<StatusDot kind={dot.kind} label={dot.label} />} focused={focused} width={CARD_WIDTH} minHeight={4} selected={selected}>
			<text attributes={TextAttributes.DIM}>
				{component.currentVersion || '-'} → {component.latestVersion || '-'}
			</text>
			<box height={1} overflow="hidden">
				<text attributes={TextAttributes.DIM}>{truncateToWidth(component.description, CARD_WIDTH - 4)}</text>
			</box>
		</Card>
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

	if (status === 'failed') {
		return { kind: 'failed', label: '失败' };
	}

	if (status === 'done') {
		return { kind: 'latest', label: '已完成' };
	}

	if (!component.installed) {
		return { kind: 'notInstalled', label: '未安装' };
	}

	if (component.hasUpdate === true) {
		return { kind: 'updatable', label: '可更新' };
	}

	if (component.hasUpdate === false) {
		return { kind: 'latest', label: '最新' };
	}

	return { kind: 'unknown', label: '未知' };
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
