import React, { useEffect, useReducer } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type { KeyEvent } from '@opentui/core';
import { ConfirmModal, ErrorPanel, ProgressLog, ScrollList, StatusLabel } from '../components/index.js';
import { colors } from '../theme/index.js';
import type { DetectionState } from '../services/async-detection.js';
import type { DetectionCache } from '../hooks/use-detection-cache.js';
import type { InstalledSkill, SearchSkillResult } from '../core/skills.js';
import type { ProgressCallback } from '../core/exec.js';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	selectedInstalled,
	selectedResult,
	shouldRunSearch,
	uninstallTargets,
	type SkillsViewState,
	type SkillsViewAction
} from '../state/skills-view-state.js';

type Dispatch = React.Dispatch<SkillsViewAction>;

// Skills 视图（OpenTUI 适配）：已安装列表 + 搜索安装 + 更新/卸载，全部经 service。
// 检测缓存提升到 App 层：已安装检测由 cache 注入，切走再切回不重跑；r 键刷新。

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ ok: true; results: readonly SearchSkillResult[] } | { ok: false; error: string; rawSummary?: string }>;
	readonly installResult: (result: SearchSkillResult, onProgress?: ProgressCallback) => Promise<{ success: boolean; error?: string }>;
	readonly updateAll: (onProgress?: ProgressCallback) => Promise<{ success: boolean; error?: string; noChange?: boolean }>;
	readonly uninstall: (names: readonly string[], onProgress?: ProgressCallback) => Promise<{ success: boolean; error?: string }>;
	readonly createDetectionRunner: (
		onChange: import('../services/detection-runner.js').DetectionStateSink<InstalledSkill[]>
	) => import('../services/detection-runner.js').DetectionRunner<InstalledSkill[]>;
	readonly runDetection: (runner: import('../services/detection-runner.js').DetectionRunner<InstalledSkill[]>) => Promise<unknown>;
};

export type SkillsViewProps = {
	readonly services: SkillsViewServices;
	readonly cache: DetectionCache<InstalledSkill[]>;
	readonly active?: boolean;
	readonly viewportHeight?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav?: () => void;
};

export function SkillsView({
	services,
	cache,
	active = true,
	viewportHeight = 16,
	onSubModeChange,
	onExitToNav
}: SkillsViewProps) {
	const [view, dispatch] = useReducer(reduceSkillsViewState, createInitialSkillsViewState());
	const detection = cache.state;

	// 缓存检测成功时把已安装列表灌入视图 reducer。
	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({ type: 'installed-loaded', installed: detection.result ?? [] });
		}
	}, [detection.status, detection.result]);

	// 上报当前子模式给 App footer（busy 态合并为 busy）。
	useEffect(() => {
		if (active) {
			onSubModeChange?.(view.busyAction ? 'busy' : view.mode);
		}
	}, [active, view.mode, view.busyAction, onSubModeChange]);

	// 键盘输入处理（OpenTUI useKeyboard 回调参数是 KeyEvent 对象，键名取 .name）
	useKeyboard((keyEvent) => {
		if (!active) return;

		if (view.mode === 'search-input') {
			handleSearchInput(keyEvent, view, dispatch, services);
			return;
		}

		const key = keyEvent.name;

		// 列表层 Esc/← 退回左侧导航
		if (view.mode === 'list' && (key === 'escape' || key === 'left' || key === 'arrowleft') && onExitToNav) {
			onExitToNav();
			return;
		}

		const mapped = mapKey(key);
		if (mapped) {
			handleViewKey(view, mapped, services, dispatch, cache);
		}
	});

	return (
		<box flexDirection="column" flexGrow={1}>
			<box marginBottom={1}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					Skills 技能管理
				</text>
				<text attributes={TextAttributes.DIM}>  搜索安装 · 已装检测 · 更新 · 卸载</text>
			</box>
			{renderDetectionNotice(detection.status)}
			{renderBody(view, detection, viewportHeight)}
			{view.busyAction ? <ProgressLog title="执行进度" messages={view.progress} /> : null}
		</box>
	);
}

// ── 输入映射 ─────────────────────────────────────────────────────────────────

function mapKey(key: string): string | null {
	const k = key.toLowerCase();
	if (k === 'up' || k === 'arrowup') return 'up';
	if (k === 'down' || k === 'arrowdown') return 'down';
	if (k === 'enter' || k === 'return') return 'enter';
	if (k === 'escape') return 'escape';
	if (k === 'tab') return 'tab';
	if (k === 'space') return 'space';
	if (k === '/') return 'search';
	if (k === 'u') return 'update';
	if (k === 'd') return 'uninstall';
	if (k === 'r') return 'refresh';
	return null;
}

/** 搜索框字符级输入：可打印字符追加，Backspace 删除，Enter 提交，Esc 取消。 */
function handleSearchInput(keyEvent: KeyEvent, view: SkillsViewState, dispatch: Dispatch, services: SkillsViewServices): void {
	const name = keyEvent.name;

	if (name === 'enter' || name === 'return') {
		if (shouldRunSearch(view)) {
			dispatch({ type: 'submit-search' });
			runSearch(view.query, services, dispatch);
		} else {
			dispatch({ type: 'submit-search' });
		}
		return;
	}

	if (name === 'escape') {
		dispatch({ type: 'cancel' });
		return;
	}

	if (name === 'backspace' || name === 'delete') {
		dispatch({ type: 'query-input', value: view.query.slice(0, -1) });
		return;
	}

	// 可打印字符追加：空格取实际字符，其余取单字符 name（排除带修饰键与 tab）。
	const char = name === 'space' ? ' ' : name;
	if (char.length === 1 && !keyEvent.ctrl && !keyEvent.meta && !keyEvent.option && name !== 'tab') {
		dispatch({ type: 'query-input', value: view.query + char });
	}
}

// ── 按键分发 ─────────────────────────────────────────────────────────────────

function handleViewKey(
	view: SkillsViewState,
	mapped: string,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>
): void {
	if (view.mode === 'confirm-install' || view.mode === 'confirm-uninstall') {
		if (mapped === 'enter') {
			dispatch({ type: 'confirm' });
			runConfirmedAction(view, services, dispatch);
		} else if (mapped === 'escape') {
			dispatch({ type: 'cancel' });
		}
		return;
	}

	if (view.mode === 'busy') {
		return;
	}

	switch (mapped) {
		case 'up':
			dispatch({ type: 'nav-up' });
			return;
		case 'down':
			dispatch({ type: 'nav-down' });
			return;
		case 'space':
			dispatch({ type: 'toggle-select' });
			return;
		case 'search':
			dispatch({ type: 'open-search' });
			return;
		case 'update':
			dispatch({ type: 'request-update' });
			runUpdateIfReady(view, services, dispatch);
			return;
		case 'uninstall':
			dispatch({ type: 'request-uninstall' });
			return;
		case 'refresh':
			if (view.mode === 'list') {
				cache.refresh();
			}
			return;
		case 'enter':
			if (view.mode === 'search-results') {
				dispatch({ type: 'request-install' });
			}
			return;
		case 'escape':
			dispatch({ type: 'cancel' });
			return;
	}
}

// ── 异步动作（经 service，进度回填 reducer） ─────────────────────────────────

function progressSink(dispatch: Dispatch): ProgressCallback {
	return (event) => dispatch({ type: 'progress', message: event.message });
}

function runSearch(query: string, services: SkillsViewServices, dispatch: Dispatch): void {
	void services.searchSkills(query).then((outcome) => {
		if (outcome.ok) {
			dispatch({ type: 'search-done', results: outcome.results });
		} else {
			dispatch({ type: 'search-failed', error: outcome.error, rawSummary: outcome.rawSummary });
		}
	});
}

function runConfirmedAction(view: SkillsViewState, services: SkillsViewServices, dispatch: Dispatch): void {
	if (view.mode === 'confirm-install') {
		const result = selectedResult(view);
		if (!result) {
			dispatch({ type: 'action-failed', error: '没有可安装的搜索结果' });
			return;
		}

		void services.installResult(result, progressSink(dispatch)).then((res) => {
			if (res.success) {
				dispatch({ type: 'action-done', summary: `已安装 ${result.name}` });
			} else {
				dispatch({ type: 'action-failed', error: res.error ?? '安装失败' });
			}
		});
		return;
	}

	if (view.mode === 'confirm-uninstall') {
		const names = uninstallTargets(view);
		if (names.length === 0) {
			dispatch({ type: 'action-failed', error: '没有选中要卸载的 skill' });
			return;
		}

		void services.uninstall(names, progressSink(dispatch)).then((res) => {
			if (res.success) {
				dispatch({ type: 'action-done', summary: `已卸载 ${names.join(', ')}` });
			} else {
				dispatch({ type: 'action-failed', error: res.error ?? '卸载失败' });
			}
		});
	}
}

function runUpdateIfReady(view: SkillsViewState, services: SkillsViewServices, dispatch: Dispatch): void {
	if (view.installed.length === 0) {
		return;
	}

	void services.updateAll(progressSink(dispatch)).then((res) => {
		if (res.success) {
			if (res.noChange) {
				dispatch({ type: 'action-done', summary: '所有 skill 已是最新版本' });
			} else {
				dispatch({ type: 'action-done', summary: '已更新所有 skill' });
			}
		} else {
			dispatch({ type: 'action-failed', error: res.error ?? '更新失败' });
		}
	});
}

// ── 渲染辅助 ─────────────────────────────────────────────────────────────────

function renderDetectionNotice(status: DetectionState<InstalledSkill[]>['status']): React.ReactNode {
	if (status === 'idle') {
		return (
			<box marginBottom={1}>
				<text attributes={TextAttributes.DIM}>等待检测已安装 skill...</text>
			</box>
		);
	}

	if (status === 'loading') {
		return (
			<box marginBottom={1}>
				<text fg={colors.primary}>正在检测已安装 skill...</text>
			</box>
		);
	}

	if (status === 'error') {
		return (
			<box marginBottom={1}>
				<ErrorPanel title="检测失败" message="无法检测已安装 skill" />
			</box>
		);
	}

	return null;
}

function renderBody(view: SkillsViewState, detection: DetectionState<InstalledSkill[]>, viewportHeight: number): React.ReactNode {
	// 搜索输入屏
	if (view.mode === 'search-input') {
		return (
			<box flexDirection="column">
				<text attributes={TextAttributes.BOLD}>搜索 Skills</text>
				<box marginTop={1}>
					<text>查询：</text>
					<text fg={colors.primary}>{view.query}</text>
					<text>_</text>
				</box>
				<box marginTop={1}>
					<text attributes={TextAttributes.DIM}>输入关键词，Enter 搜索，Esc 取消</text>
				</box>
			</box>
		);
	}

	// 搜索结果屏
	if (view.mode === 'search-results') {
		const items = view.results.map((r) => ({
			key: r.name,
			title: r.name,
			body: <text attributes={TextAttributes.DIM}>{r.description ?? '无描述'}</text>
		}));

		return (
			<box flexDirection="column">
				<text attributes={TextAttributes.BOLD}>搜索结果：{view.query}</text>
				<box marginTop={1}>
					<ScrollList items={items} cursor={view.resultIndex} viewportHeight={viewportHeight} reservedRows={3} />
				</box>
				<box marginTop={1}>
					<text attributes={TextAttributes.DIM}>Enter 安装 · Esc 返回列表</text>
				</box>
			</box>
		);
	}

	// 确认安装
	if (view.mode === 'confirm-install') {
		const result = selectedResult(view);
		return (
			<box marginTop={1}>
				<ConfirmModal
					title="确认安装 Skill"
					message={result ? `即将安装 ${result.name}` : '无可用结果'}
					confirmLabel="Enter 确认"
					cancelLabel="Esc 取消"
				/>
			</box>
		);
	}

	// 确认卸载
	if (view.mode === 'confirm-uninstall') {
		const names = uninstallTargets(view);
		return (
			<box marginTop={1}>
				<ConfirmModal
					title="确认卸载 Skills"
					message={`即将卸载：${names.join(', ')}`}
					confirmLabel="Enter 确认"
					cancelLabel="Esc 取消"
				/>
			</box>
		);
	}

	// 已安装列表（默认）
	if (detection.status === 'success') {
		const items = view.installed.map((skill) => ({
			key: skill.name,
			title: skill.name,
			body: <text attributes={TextAttributes.DIM}>{skill.description ?? '无描述'}</text>,
			selected: view.selectedNames.includes(skill.name)
		}));

		return (
			<box flexDirection="column">
				{view.notice ? (
					<box marginBottom={1}>
						<StatusLabel kind="pass" label={view.notice} />
					</box>
				) : null}
				{view.errorText ? (
					<box marginBottom={1}>
						<ErrorPanel message={view.errorText} />
					</box>
				) : null}
				{items.length === 0 ? (
					<text attributes={TextAttributes.DIM}>暂无已安装 skill。按 / 搜索安装。</text>
				) : (
					<ScrollList items={items} cursor={view.installedIndex} viewportHeight={viewportHeight} reservedRows={3} />
				)}
				<box marginTop={1}>
					<text attributes={TextAttributes.DIM}>Space 选择 · / 搜索 · U 更新全部 · D 卸载选中 · R 刷新</text>
				</box>
			</box>
		);
	}

	return null;
}
