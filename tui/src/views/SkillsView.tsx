import React, {useCallback, useEffect, useMemo, useReducer, useRef} from 'react';
import {TextAttributes, type KeyEvent, type ScrollBoxRenderable} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {
	Card,
	Checkbox,
	ErrorPanel,
	ListEmptyState,
	ListLoadingState,
	Modal,
	ScrollList,
	SingleLineInput,
	ThemedScrollbox,
	ViewHeader,
	busyActionTitle,
	toast,
	type BusyOverlayState
} from '../components/index.js';
import {colors} from '../theme/index.js';
import type {DetectionState} from '../services/async-detection.js';
import type {DetectionCache} from '../hooks/use-detection-cache.js';
import type {InstalledSkill, SearchSkillResult, SkillSharedRow} from '../core/skills.js';
import {projectSharedSkills, searchSkillIdentity, skillSourcesEquivalent} from '../core/skills.js';
import type {ProgressCallback} from '../core/exec.js';
import {abortable, throwIfAborted} from '../core/exec.js';
import type {SkillsBatchExecution, SkillsReplacementExecution} from '../services/skills-service.js';
import {targetTopologyOfDraft, topologyOfInspection, type SkillTopology} from '../core/skills-storage.js';
import type {SkillsAdoptionResult} from '../services/skills-adoption.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../state/manage-state.js';
import {useTaskCancellation, type TaskCancellation} from '../hooks/use-task-cancellation.js';
import {viewShortcuts} from '../state/shortcuts.js';
import {
	createInitialSkillsViewState,
	displaySkillName,
	filteredInstalled,
	pendingInstallResults,
	pendingSourceReplacements,
	reduceSkillsViewState,
	searchInstallItems,
	selectedInstalled,
	shouldRunSearch,
	SKILLS_GRID_COLUMNS,
	uninstallTargets,
	type InstallDraft,
	type SkillsViewAction,
	type SkillsViewState,
	type SkillsViewMode
} from '../state/skills-view-state.js';

type Dispatch = React.Dispatch<SkillsViewAction>;

// Skills 视图（OpenTUI 适配）：共享本体 + 双侧注入架构（shared-resource-injection-ui Section 18）。
// 列表页：本地过滤框 + 两列共享网格（每张卡片一个 skill name + Claude Code/Codex 双态徽章）；
//   Enter 管理安装（切 Claude Code symlink）/ A 更新全部 / U 更新当前 / d 全量卸载（所有 Agent）/ r 刷新。
// 安装页：远程搜索框 + 扁平 skill 列表；Enter 弹安装目标 Modal（Codex 只读恒勾）。
// Modal（安装目标 / 管理安装 / 全量卸载确认）统一绝对定位居中覆盖，不挤占列表布局。
// Header 隐藏（app.tsx AGENT_HEADER_HIDDEN_MODULES）：检测走双侧聚合（一次 skills list -g --json 无 --agent），
// 不按 agentContext 过滤；顶行 ↑ no-op（不退 header）。检测缓存提升到 App 层：切走再切回不重跑；r 刷新。

// 安装目标 / 管理安装 / 卸载确认 Modal 宽度：对齐 Tools/MCP，容纳 hint 单行不换行。
const SKILLS_MODAL_WIDTH = 56;

function skillsModalHint(mode: SkillsViewMode): string {
	return viewShortcuts('skills', mode)
		.map(shortcut => `${shortcut.key} ${shortcut.label}`)
		.join('  ');
}

function skillsModalOpen(mode: SkillsViewMode): boolean {
	return (
		mode === 'select-install-target' ||
		mode === 'manage-inject' ||
		mode === 'confirm-topology-change' ||
		mode === 'confirm-source-replacement' ||
		mode === 'confirm-uninstall'
	);
}

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ok: true; results: readonly SearchSkillResult[]} | {ok: false; error: string; rawSummary?: string}>;
	// 扁平跨来源批量安装：service 内部按 source 顺序拆批，UI 仍只展示一次用户动作。
	readonly installBatchToTargets: (
		results: readonly SearchSkillResult[],
		targets: readonly AgentContext[],
		onProgress?: ProgressCallback,
		installed?: readonly SkillSharedRow[],
		signal?: AbortSignal
	) => Promise<SkillsBatchExecution>;
	readonly finalizeReplacementSnapshots: (
		replacements: readonly SkillsReplacementExecution[],
		confirmedKeys: readonly string[]
	) => Promise<void>;
	readonly transitionTopology: (
		skill: SkillSharedRow,
		target: SkillTopology,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<SkillsAdoptionResult>;
	// 更新两侧（A）：单次全局 update，由 skills lock 更新所有注入侧。
	readonly updateBothSides: (
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	// 更新单个（U）：skills update <name>，只更新列表页当前光标 skill。
	readonly updateOne: (
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	// 全量卸载（d）：单条 skills remove 省略 --agent，由 CLI 默认从所有 Agent 删除。
	readonly uninstallAllAgents: (
		name: string,
		onProgress?: ProgressCallback,
		signal?: AbortSignal
	) => Promise<{success: boolean; error?: string}>;
	readonly createDetectionRunner: (
		onChange: import('../services/detection-runner.js').DetectionStateSink<InstalledSkill[]>
	) => import('../services/detection-runner.js').DetectionRunner<InstalledSkill[]>;
	readonly runDetection: (runner: import('../services/detection-runner.js').DetectionRunner<InstalledSkill[]>) => Promise<unknown>;
};

export type SkillsViewProps = {
	readonly services: SkillsViewServices;
	readonly cache: DetectionCache<InstalledSkill[]>;
	readonly active?: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav?: () => void;
};

export function SkillsView({services, cache, active = true, onSubModeChange, onBusyStateChange, onExitToNav}: SkillsViewProps) {
	const [view, dispatch] = useReducer(reduceSkillsViewState, createInitialSkillsViewState());
	const detection = cache.state;
	const taskCancellation = useTaskCancellation();
	const cancelBusyTask = useCallback(() => {
		if (!taskCancellation.cancel()) {
			return;
		}

		dispatch({type: 'cancel-busy'});
		toast.info('已取消任务，正在刷新状态');
		cache.refresh();
	}, [cache, taskCancellation]);
	const busyOverlayState = useMemo(() => createSkillsBusyOverlayState(view, cancelBusyTask), [view, cancelBusyTask]);

	// 缓存检测成功时投影为双侧共享行灌入视图 reducer（一次 list 派生 Claude Code / Codex 双态）。
	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({type: 'installed-loaded', installed: projectSharedSkills(detection.result ?? [])});
		}
	}, [detection.status, detection.result]);

	// 上报当前子模式给 App footer（busy 态合并为 busy）。
	useEffect(() => {
		if (active) {
			onSubModeChange?.(view.busyAction ? 'busy' : view.mode);
		}
	}, [active, view.mode, view.busyAction, onSubModeChange]);

	useEffect(() => {
		onBusyStateChange?.(busyOverlayState);
	}, [busyOverlayState, onBusyStateChange]);

	useEffect(() => () => onBusyStateChange?.(null), [onBusyStateChange]);

	// 键盘输入处理（OpenTUI useKeyboard 回调参数是 KeyEvent 对象，键名取 .name）
	useKeyboard(keyEvent => {
		if (!active) {
			return;
		}

		handleKey(keyEvent, view, dispatch, services, cache, onExitToNav, taskCancellation);
	});

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="Skills 技能管理" subtitle="共享维护 Claude Code 与 Codex 两侧的 Skills（搜索、安装、更新、卸载）" />
			{renderDetectionNotice(detection)}
			{renderPage(view, detection, active && !skillsModalOpen(view.mode), dispatch)}
			{view.errorText ? (
				<box marginTop={1}>
					<ErrorPanel message={view.errorText} />
				</box>
			) : null}
			{view.mode === 'select-install-target' || view.mode === 'manage-inject' ? <InstallTargetModal view={view} /> : null}
			{view.mode === 'confirm-topology-change' ? <TopologyConfirmModal view={view} /> : null}
			{view.mode === 'confirm-source-replacement' ? <SourceReplacementConfirmModal view={view} /> : null}
			{view.mode === 'confirm-uninstall' ? renderConfirm(view) : null}
		</box>
	);
}

function createSkillsBusyOverlayState(view: SkillsViewState, onCancel: () => void): BusyOverlayState | null {
	if (!view.busyAction) {
		return null;
	}

	return {
		title: view.batchStage === 'reconciling' ? '正在同步 Skills 状态' : busyActionTitle(view.busyAction, ' Skill'),
		message: view.progress.at(-1),
		onCancel
	};
}

// ── 按键总分发 ─────────────────────────────────────────────────────────────

function handleKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	onExitToNav: (() => void) | undefined,
	taskCancellation: TaskCancellation
): void {
	// busy 进行中：忽略一切输入
	if (view.mode === 'busy') {
		return;
	}

	// 安装目标 / 管理安装 Modal：↑/↓ 选侧、空格切草稿（仅 Claude Code）、Enter 提交、Esc 取消
	if (view.mode === 'select-install-target' || view.mode === 'manage-inject') {
		handleTargetModalKey(keyEvent, view, dispatch, services, cache, taskCancellation);
		return;
	}

	if (view.mode === 'confirm-topology-change' || view.mode === 'confirm-source-replacement') {
		handleLifecycleConfirmKey(keyEvent, view, dispatch, services, cache, taskCancellation);
		return;
	}

	// 全量卸载确认：Enter 确认 / Esc 取消
	if (view.mode === 'confirm-uninstall') {
		const mapped = mapActionKey(keyEvent.name);
		if (mapped === 'enter') {
			dispatch({type: 'confirm'});
			runConfirmedUninstall(view, services, dispatch, cache, taskCancellation);
		} else if (mapped === 'escape') {
			dispatch({type: 'cancel'});
		}

		return;
	}

	if (view.mode === 'install') {
		handleInstallKey(keyEvent, view, dispatch, services, cache);
		return;
	}

	// mode === 'list'
	handleListKey(keyEvent, view, dispatch, services, cache, onExitToNav, taskCancellation);
}

/** 安装目标 / 管理安装 Modal 按键：复用 Tools InjectTargetModal 范式。 */
function handleTargetModalKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	const k = keyEvent.name.toLowerCase();
	if (k === 'up' || k === 'arrowup') {
		dispatch({type: 'install-target-nav', delta: -1});
		return;
	}

	if (k === 'down' || k === 'arrowdown') {
		dispatch({type: 'install-target-nav', delta: 1});
		return;
	}

	if (k === 'space' || keyEvent.name === ' ') {
		dispatch({type: 'install-target-toggle'});
		return;
	}

	if (k === 'escape') {
		dispatch({type: 'cancel'});
		return;
	}

	if (k === 'enter' || k === 'return') {
		if (view.mode === 'select-install-target') {
			if (pendingSourceReplacements(view).length > 0) {
				dispatch({type: 'request-source-replacement'});
			} else {
				runInstallToTargets(view, services, dispatch, cache, taskCancellation);
			}
		} else {
			dispatch({type: 'request-topology-change'});
		}
	}
}

function handleLifecycleConfirmKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	const mapped = mapActionKey(keyEvent.name);
	if (mapped === 'escape') {
		dispatch({type: 'cancel'});
		return;
	}

	if (mapped !== 'enter') {
		return;
	}

	if (view.mode === 'confirm-topology-change') {
		runTopologyTransition(view, services, dispatch, cache, taskCancellation);
	} else {
		runInstallToTargets(view, services, dispatch, cache, taskCancellation);
	}
}

/** 列表页按键：过滤框聚焦态 vs 浏览态。 */
function handleListKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	onExitToNav: (() => void) | undefined,
	taskCancellation: TaskCancellation
): void {
	const name = keyEvent.name;

	// 过滤框聚焦：编辑由原生 input 处理；页面只接管 Esc/Tab/Enter/上下导航。
	if (view.filterFocused) {
		if (name === 'escape') {
			keyEvent.preventDefault?.();
			dispatch({type: 'filter-clear'});
			return;
		}

		if (name === 'tab') {
			keyEvent.preventDefault?.();
			dispatch({type: 'filter-blur'});
			return;
		}

		const nav = mapNavKey(name);
		if (nav) {
			keyEvent.preventDefault?.();
			dispatch({type: 'nav-grid', direction: nav});
			return;
		}

		if (name === 'enter' || name === 'return') {
			keyEvent.preventDefault?.();
		}

		return;
	}

	// 浏览态：Esc 退回左侧导航；网格首项 ← 与 Esc 等效。
	if (name === 'escape' || ((name === 'left' || name === 'arrowleft') && view.installedIndex === 0)) {
		onExitToNav?.();
		return;
	}

	if (name === 'left' || name === 'arrowleft') {
		dispatch({type: 'nav-grid', direction: 'left'});
		return;
	}

	if (name === 'right' || name === 'arrowright') {
		dispatch({type: 'nav-grid', direction: 'right'});
		return;
	}

	const mapped = mapActionKey(name);
	switch (mapped) {
		case 'up':
			// Skills 隐藏 Header：网格 ↑/↓ 按列移动并在首尾行循环，不退回 header。
			dispatch({type: 'nav-grid', direction: 'up'});
			return;
		case 'down':
			dispatch({type: 'nav-grid', direction: 'down'});
			return;
		case 'tab':
			dispatch({type: 'filter-focus'});
			return;
		case 'enter':
			// 列表行 Enter → C/X/B 管理 Modal。
			if (selectedInstalled(view)) {
				dispatch({type: 'manage-inject'});
			}
			return;
		case 'install':
			// I：进入安装页。
			dispatch({type: 'open-install'});
			return;
		case 'update-all':
			// A：更新全部（skills update，空名单）。
			dispatch({type: 'request-update'});
			runUpdateIfReady(view, services, dispatch, cache, taskCancellation);
			return;
		case 'update-one':
			// U：更新当前光标单个 skill（skills update <name>）。
			dispatch({type: 'request-update-one'});
			runUpdateOneIfReady(view, services, dispatch, cache, taskCancellation);
			return;
		case 'uninstall':
			dispatch({type: 'request-uninstall'});
			return;
		case 'refresh':
			cache.refresh();
			return;
	}
}

/** 安装页按键：搜索框聚焦态 vs skill 浏览态。 */
function handleInstallKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>
): void {
	const name = keyEvent.name;

	// 搜索框聚焦：编辑由原生 input 处理；Enter 只由此处提交一次。
	if (view.queryFocused) {
		if (name === 'enter' || name === 'return') {
			keyEvent.preventDefault?.();
			dispatch({type: 'submit-search'});
			if (shouldRunSearch(view)) {
				runSearch(view.query, services, dispatch);
			}

			return;
		}

		if (name === 'escape') {
			keyEvent.preventDefault?.();
			dispatch({type: 'cancel'});
			return;
		}

		if (name === 'tab') {
			keyEvent.preventDefault?.();
			dispatch({type: 'query-blur'});
			return;
		}

		const nav = mapNavKey(name);
		if (nav) {
			keyEvent.preventDefault?.();
			dispatch({type: nav === 'up' ? 'nav-up' : 'nav-down'});
			return;
		}

		return;
	}

	// skill 浏览态：Space 多选 / a 全选 / Enter 弹一次安装目标 Modal / r 刷新安装事实。
	const lowerName = name.toLowerCase();
	if (lowerName === 'space' || name === ' ') {
		if (cache.state.status === 'success') {
			dispatch({type: 'toggle-result'});
		} else {
			toast.info(cache.state.status === 'error' ? '安装状态检测失败，请刷新后重试' : '正在检测安装状态，请稍候');
		}

		return;
	}

	if (lowerName === 'a') {
		if (cache.state.status === 'success') {
			dispatch({type: 'select-all-results'});
		} else {
			toast.info(cache.state.status === 'error' ? '安装状态检测失败，请刷新后重试' : '正在检测安装状态，请稍候');
		}

		return;
	}

	if (lowerName === 'r') {
		cache.refresh();
		return;
	}

	const mapped = mapActionKey(name);
	switch (mapped) {
		case 'up':
			// Skills 隐藏 Header：顶行 ↑ 停在首项（no-op），不退回 header。
			if (view.resultIndex > 0) {
				dispatch({type: 'nav-up'});
			}
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'tab':
			dispatch({type: 'query-focus'});
			return;
		case 'enter':
			if (cache.state.status === 'success' && view.results.length > 0) {
				dispatch({type: 'select-skill'});
			} else if (cache.state.status !== 'success') {
				toast.info(cache.state.status === 'error' ? '安装状态检测失败，请刷新后重试' : '正在检测安装状态，请稍候');
			}

			return;
		case 'escape':
			dispatch({type: 'cancel'});
			return;
	}
}

// ── 键名映射 ───────────────────────────────────────────────────────────────

/**
 * 动作键映射（浏览态用，大小写都触发）。列表页键位：
 * `a`→更新全部（update-all）、`i`→进安装页（install）、`u`→更新当前单个（update-one）、`d`→卸载。
 * 注意：安装页 `handleInstallKey` 独立处理 `a`（全选）/`space`（多选），不经此映射。
 */
function mapActionKey(key: string): string | null {
	const k = key.toLowerCase();
	if (k === 'up' || k === 'arrowup') {
		return 'up';
	}

	if (k === 'down' || k === 'arrowdown') {
		return 'down';
	}

	if (k === 'enter' || k === 'return') {
		return 'enter';
	}

	if (k === 'escape') {
		return 'escape';
	}

	if (k === 'tab') {
		return 'tab';
	}

	if (k === 'a') {
		return 'update-all';
	}

	if (k === 'i') {
		return 'install';
	}

	if (k === 'u') {
		return 'update-one';
	}

	if (k === 'd') {
		return 'uninstall';
	}

	if (k === 'r') {
		return 'refresh';
	}

	return null;
}

/** 仅方向键映射（输入框聚焦态用，避开字符冲突）。 */
function mapNavKey(key: string): 'up' | 'down' | null {
	const k = key.toLowerCase();
	if (k === 'up' || k === 'arrowup') {
		return 'up';
	}

	if (k === 'down' || k === 'arrowdown') {
		return 'down';
	}

	return null;
}

// ── 异步动作（经 service，进度回填 reducer） ─────────────────────────────────

function progressSink(dispatch: Dispatch): ProgressCallback {
	return event => {
		if (event.instruction) {
			dispatch({type: 'progress', message: event.instruction});
		}
	};
}

function runSearch(query: string, services: SkillsViewServices, dispatch: Dispatch): void {
	void services.searchSkills(query).then(outcome => {
		if (outcome.ok) {
			dispatch({type: 'search-done', results: outcome.results});
			if (outcome.results.length === 0) {
				toast.info('没有匹配的 Skill');
			}
		} else {
			dispatch({type: 'search-failed', error: outcome.error, rawSummary: outcome.rawSummary});
		}
	});
}

/** 安装目标 Modal 提交：整批只使用一份目标草稿，命令后等待共享检测并按最终事实对账。 */
function runInstallToTargets(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
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
				const detectionError = refreshed?.error ?? '安装状态检测未完成';
				const recoverySnapshots = execution.replacements
					.filter(item => item.recoveryPath)
					.map(item => `${item.skillName} 恢复快照：${item.recoveryPath}`);
				const detail = [detectionError, ...failedSources, ...recoverySnapshots].join('\n');
				dispatch({type: 'install-reconcile-failed', error: detail});
				return;
			}

			const installed = projectSharedSkills(refreshed.result ?? []);
			const confirmedKeys = confirmedInstallKeys(skills, view.installed, installed, execution, targets);
			await services.finalizeReplacementSnapshots(execution.replacements, confirmedKeys);
			throwIfAborted(signal);
			const confirmedCount = confirmedKeys.length;
			const missingCount = skills.length - confirmedCount;
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
			if (missingCount === 0) {
				toast.success(`已确认安装 ${confirmedCount} 个 Skill`);
			} else {
				toast.info(`安装结果：已确认 ${confirmedCount}，仍未安装 ${missingCount}`);
			}
		} catch (error) {
			if (signal.aborted) return;
			dispatch({type: 'action-failed', error: errorMessage(error)});
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
		if (!identity) {
			return [];
		}

		const current = installedByName.get(identity.skillName);
		if (!current) {
			return [];
		}

		const previousSkill = previousByName.get(identity.skillName);
		const isReplacement = Boolean(previousSkill?.source && !skillSourcesEquivalent(previousSkill.source, identity.source));
		if (!isReplacement) {
			return [identity.key];
		}

		const replacement = replacementByKey.get(identity.key);
		const targetReady = targets.includes('cc')
			? current.codexAvailable && current.claudeInjected
			: current.codexAvailable && !current.claudeInjected;
		return replacement?.success && targetReady && Boolean(current.source && skillSourcesEquivalent(current.source, identity.source))
			? [identity.key]
			: [];
	});
}

function runTopologyTransition(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
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
			if (signal.aborted) return;
			dispatch({type: 'action-failed', error: `拓扑切换失败：${errorMessage(error)}`});
		} finally {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		}
	})();
}

async function finishTopologyLifecycle(
	result: SkillsAdoptionResult,
	cache: DetectionCache<InstalledSkill[]>,
	dispatch: Dispatch,
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
	dispatch: Dispatch,
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
		dispatch({
			type: 'action-failed',
			error: feedback.error ? `${feedback.error}\n状态复检失败：${detectionError}` : detectionError
		});
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

	dispatch({
		type: 'lifecycle-reconciled',
		installed,
		...(feedback.error ? {error: feedback.error} : {})
	});
	if (feedback.message) {
		if (feedback.warning) {
			toast.info(feedback.message);
		} else {
			toast.success(feedback.message);
		}
	}
}

/** 全量卸载确认（confirm-uninstall Enter）：单条 skills remove 省略 --agent，从所有 Agent 删除。 */
function runConfirmedUninstall(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
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
		.then(res => {
			if (signal.aborted) return;
			if (res.success) {
				toast.success(`已从所有 Agent 卸载 ${name}`);
				dispatch({type: 'action-uninstall-done', names});
				cache.refresh();
			} else {
				dispatch({type: 'action-failed', error: res.error ?? '卸载失败'});
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

function runUpdateIfReady(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	if (view.installed.length === 0) {
		return;
	}

	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.updateBothSides(progressSink(dispatch), signal)
		.then(res => {
			if (signal.aborted) return;
			if (res.success) {
				toast.success(res.noChange ? 'skill 已是最新版本' : '已更新 skill');
				dispatch({type: 'action-done'});
			} else {
				dispatch({type: 'action-failed', error: res.error ?? '更新失败'});
			}
		})
		.catch((error: unknown) => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `更新失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
}

/** 更新当前光标单个 skill（U）：取列表页光标项 name，走 skills update <name>。 */
function runUpdateOneIfReady(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>,
	taskCancellation: TaskCancellation
): void {
	const current = selectedInstalled(view);
	if (!current?.source) {
		return;
	}

	const signal = taskCancellation.start();
	if (!signal) return;
	void services
		.updateOne(current.name, progressSink(dispatch), signal)
		.then(res => {
			if (signal.aborted) return;
			if (res.success) {
				toast.success(res.noChange ? `选中的 ${current.name} 已是最新版本` : `已更新选中的 ${current.name}`);
				dispatch({type: 'action-done'});
			} else {
				dispatch({type: 'action-failed', error: res.error ?? `更新 ${current.name} 失败`});
			}
		})
		.catch((error: unknown) => {
			if (!signal.aborted) dispatch({type: 'action-failed', error: `更新 ${current.name} 失败：${errorMessage(error)}`});
		})
		.finally(() => {
			taskCancellation.finish(signal);
			if (signal.aborted) cache.refresh();
		});
}

// ── 渲染 ───────────────────────────────────────────────────────────────────

/** 当前应渲染的页（Modal/执行时保持原页显示，仅叠加 Modal/进度）。 */
function pageOf(mode: SkillsViewMode, busyReturnMode?: 'list' | 'install'): 'list' | 'install' {
	// 安装页及其安装目标 Modal 停留安装页；busy 按动作来源保留对应底页 + 进度。
	if (mode === 'install' || mode === 'select-install-target' || mode === 'confirm-source-replacement') {
		return 'install';
	}

	if (mode === 'busy') {
		return busyReturnMode ?? 'list';
	}

	return 'list';
}

function renderDetectionNotice(detection: DetectionState<InstalledSkill[]>): React.ReactNode {
	const {status} = detection;
	if (status === 'idle' || status === 'loading') {
		return <ListLoadingState message="检测中..." />;
	}

	if (status === 'error') {
		return (
			<box marginBottom={1}>
				<ErrorPanel title="检测失败" message={detection.error ?? '无法检测已安装 skill'} />
			</box>
		);
	}

	return null;
}

/** 全量卸载确认框（confirm-uninstall）：从所有 Agent 卸载（移除 symlink 与共享本体）。 */
function renderConfirm(view: SkillsViewState): React.ReactNode {
	const names = uninstallTargets(view);
	return (
		<Modal active title="确认卸载 Skill" hint={skillsModalHint('confirm-uninstall')} tone="danger" width={SKILLS_MODAL_WIDTH}>
			<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{names.length > 0
					? `将在所有 Agent 中卸载 ${names.join(', ')}：移除 Claude Code symlink 与共享本体，此操作不可撤销。`
					: '无卸载目标'}
			</text>
		</Modal>
	);
}

function TopologyConfirmModal({view}: {readonly view: SkillsViewState}) {
	const current = selectedInstalled(view);
	const storage = current?.storage;
	const currentTopology = storage ? topologyOfInspection(storage) : undefined;
	const target = targetTopologyOfDraft(view.installDraft);
	const otherAgents = current?.otherAgents ?? [];
	return (
		<Modal
			active
			title={`确认切换安装拓扑：${current?.name ?? ''}`}
			hint={skillsModalHint('confirm-topology-change')}
			tone="warning"
			width={SKILLS_MODAL_WIDTH}
		>
			<box flexDirection="column">
				<text
					fg={colors.text}
				>{`${topologyLabel(currentTopology)} → ${target === 'empty' ? '无目标' : topologyLabel(target)}`}</text>
				<text fg={colors.muted}>{`Claude 路径：${storage?.claudePath ?? '未知'}`}</text>
				<text fg={colors.muted}>{`Codex 本体：${storage?.canonicalPath ?? '未知'}`}</text>
				<text fg={colors.warning}>
					内容会先快照；目标树删除、物化和投影均由官方 Skills CLI 完成。targeted remove 可能移除远程 lock，使结果转为本地来源。
				</text>
				{target === 'claude-only' ? (
					<text fg={colors.warning}>Codex 及直接读取 .agents/skills 的消费者将失去此 Skill。</text>
				) : null}
				{otherAgents.length > 0 ? <text fg={colors.danger}>{`其它 Agent：${otherAgents.join('、')}`}</text> : null}
			</box>
		</Modal>
	);
}

function topologyLabel(topology: SkillTopology | undefined): string {
	return topology === 'claude-only'
		? '仅 Claude Code'
		: topology === 'codex-only'
			? '仅 Codex'
			: topology === 'shared'
				? '双侧共享'
				: '部分完成';
}

function SourceReplacementConfirmModal({view}: {readonly view: SkillsViewState}) {
	const replacements = pendingSourceReplacements(view);
	const targets = AGENT_CONTEXT_ORDER.filter(ctx => view.installDraft[ctx])
		.map(ctx => AGENT_CONTEXT_LABELS[ctx])
		.join('、');
	const height = Math.max(3, Math.min(12, replacements.length * 4));
	return (
		<Modal
			active
			title="确认覆盖同名 Skill"
			hint={skillsModalHint('confirm-source-replacement')}
			tone="danger"
			width={SKILLS_MODAL_WIDTH}
		>
			<box flexDirection="column">
				<text fg={colors.warning}>
					新来源将直接覆盖同名共享本体与 lock 来源；只有 postflight 成功后才清理未选择的旧 Claude 投影。
				</text>
				<text fg={colors.text}>{`最终安装目标：${targets}`}</text>
				<box height={height} minHeight={0} marginTop={1}>
					<ThemedScrollbox style={{flexGrow: 1, minHeight: 0}} scrollY scrollX={false}>
						{replacements.map(item => (
							<box key={item.identity.key} flexDirection="column" marginBottom={1}>
								<text fg={colors.text} attributes={TextAttributes.BOLD}>
									{item.identity.skillName}
								</text>
								<text fg={colors.muted}>{`当前来源：${item.installed.source}`}</text>
								<text fg={colors.primary}>{`新来源：${item.identity.source}`}</text>
							</box>
						))}
					</ThemedScrollbox>
				</box>
			</box>
		</Modal>
	);
}

// ── 安装目标 / 管理安装 Modal：↑/↓ 选侧，空格切草稿（仅 Claude Code），Enter 提交，Esc 取消 ──
// 复用 Tools InjectTargetModal 范式：左 › <Agent 全称> focused 高亮 flexGrow，右状态标签右对齐。
// Codex 只读恒勾（装了必写本体、直读即可用，无法不装）；仅 Claude Code 可切。文案统一「安装/卸载」。
function InstallTargetModal({view}: {readonly view: SkillsViewState}) {
	const isManage = view.mode === 'manage-inject';
	const managed = selectedInstalled(view);
	const name = managed?.name ?? '';
	const title = isManage ? `管理安装：${name}` : `选择安装目标：${pendingInstallResults(view).length} 个 Skill`;
	const selected = AGENT_CONTEXT_ORDER[view.targetIndex] ?? 'cc';
	return (
		<Modal active title={title} hint={skillsModalHint(view.mode)} width={SKILLS_MODAL_WIDTH}>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map(ctx => {
					const checked = Boolean(view.installDraft[ctx]);
					const focused = ctx === selected;
					const readonly = isManage ? managedTargetReadonly(managed, ctx) : ctx === 'cx';
					const stateLabel = isManage
						? managedTargetLabel(managed, ctx, checked)
						: readonly
							? '● 安装'
							: checked
								? '● 安装'
								: '○ 不安装';
					return (
						<box key={ctx} flexDirection="row">
							<text
								fg={focused ? colors.primary : colors.muted}
								attributes={focused ? TextAttributes.BOLD : 0}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexGrow={1}
							>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]}${readonly ? '（只读）' : ''} `}
							</text>
							<text
								fg={checked ? colors.success : colors.muted}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
								flexShrink={0}
							>
								{stateLabel}
							</text>
						</box>
					);
				})}
				{isManage && managed?.storage?.kind === 'shared-copy' ? (
					<text fg={colors.warning}>当前为独立副本；直接应用将重试共享链接。</text>
				) : null}
				{isManage && managed?.storage?.error ? <text fg={colors.danger}>{managed.storage.error}</text> : null}
			</box>
		</Modal>
	);
}

function managedTargetReadonly(skill: SkillSharedRow | undefined, context: AgentContext): boolean {
	if (!skill) {
		return true;
	}

	if (!skill.storage) {
		return context === 'cx';
	}

	if (['invalid', 'invalid-link', 'conflict', 'missing'].includes(skill.storage.kind)) {
		return true;
	}

	return false;
}

function managedTargetLabel(skill: SkillSharedRow | undefined, context: AgentContext, checked: boolean): string {
	const kind = skill?.storage?.kind;
	if (kind === 'shared-copy' && checked) {
		return context === 'cc' ? '● 独立副本（选择双侧将修复）' : '● canonical 本体';
	}
	return checked ? '● 目标安装' : '○ 目标不安装';
}

// ── 行内双态徽章：已安装=success ●，未安装=muted ○（全称标签，禁 cc/cx 缩写） ──
// Claude Code = 可切 symlink 安装态；Codex = 只读镜像共享本体（codexAvailable），跟随本体不可单独切。
function DualStateBadges({skill}: {readonly skill: SkillSharedRow}) {
	const claudeLabel = skill.storage?.kind === 'shared-copy' ? `${AGENT_CONTEXT_LABELS.cc}（独立副本）` : AGENT_CONTEXT_LABELS.cc;
	return (
		<box flexDirection="row" height={1} overflow="hidden">
			<StateBadge label={claudeLabel} installed={skill.claudeInjected} />
			<text fg={colors.muted}>{'  '}</text>
			<StateBadge label={AGENT_CONTEXT_LABELS.cx} installed={skill.codexAvailable} />
		</box>
	);
}

function InstalledSkillBody({skill}: {readonly skill: SkillSharedRow}) {
	const warning = storageWarning(skill);
	return (
		<box flexDirection="column">
			<DualStateBadges skill={skill} />
			{warning ? <text fg={colors.warning}>{warning}</text> : null}
		</box>
	);
}

function installedSkillCardId(index: number): string {
	return `skills-grid-item-${index}`;
}

function InstalledSkillsGrid({
	skills,
	cursor,
	active
}: {
	readonly skills: readonly SkillSharedRow[];
	readonly cursor: number;
	readonly active: boolean;
}) {
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const safeCursor = skills.length === 0 ? 0 : Math.min(Math.max(cursor, 0), skills.length - 1);
	const activeSkill = skills[safeCursor];
	const activeCardId = activeSkill ? installedSkillCardId(safeCursor) : null;
	const rows = Array.from({length: Math.ceil(skills.length / SKILLS_GRID_COLUMNS)}, (_, rowIndex) => {
		const start = rowIndex * SKILLS_GRID_COLUMNS;
		return skills.slice(start, start + SKILLS_GRID_COLUMNS).map((skill, offset) => ({skill, index: start + offset}));
	});

	useEffect(() => {
		if (!scrollRef.current || !activeCardId) {
			return;
		}

		scrollRef.current.scrollChildIntoView(activeCardId);
	}, [activeCardId, activeSkill?.name]);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0} marginTop={0}>
			<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, minHeight: 0}} viewportCulling scrollY scrollX={false}>
				<box flexDirection="column">
					{rows.map((row, rowIndex) => (
						<box key={`skills-grid-row-${rowIndex}`} flexDirection="row" alignItems="stretch">
							{row.map(({skill, index}) => (
								<box
									key={skill.name}
									id={installedSkillCardId(index)}
									flexBasis={0}
									flexGrow={1}
									minWidth={0}
									marginRight={index % SKILLS_GRID_COLUMNS === 0 ? 1 : 0}
								>
									<Card title={skill.name} focused={active && index === safeCursor} minHeight={3} multiLine>
										<InstalledSkillBody skill={skill} />
									</Card>
								</box>
							))}
							{row.length < SKILLS_GRID_COLUMNS ? <box flexBasis={0} flexGrow={1} minWidth={0} /> : null}
						</box>
					))}
				</box>
			</ThemedScrollbox>
			<text
				flexShrink={0}
				fg={colors.muted}
				selectionBg={colors.selectionBg}
				selectionFg={colors.selectionFg}
			>{`(${safeCursor + 1}/${skills.length})`}</text>
		</box>
	);
}

function storageWarning(skill: SkillSharedRow): string | undefined {
	switch (skill.storage?.kind) {
		case 'shared-copy':
			return '部分完成：Claude Code 使用独立副本，可在管理安装中重试共享链接';
		case 'invalid-link':
		case 'conflict':
		case 'invalid':
			return skill.storage.error ?? 'Skill 存储状态异常，自动操作已阻止';
		default:
			return undefined;
	}
}

function StateBadge({label, installed}: {readonly label: string; readonly installed: boolean}) {
	return (
		<text fg={installed ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			{`${installed ? '●' : '○'} ${label}`}
		</text>
	);
}

function renderPage(
	view: SkillsViewState,
	detection: DetectionState<InstalledSkill[]>,
	active: boolean,
	dispatch: Dispatch
): React.ReactNode {
	const page = pageOf(view.mode, view.busyReturnMode);
	if (page === 'install') {
		return renderInstallPage(view, detection, active, dispatch);
	}

	// 列表页（默认）。detection 未就绪时由 detectionNotice 占位，body 留空。
	if (detection.status === 'success') {
		return renderListPage(view, active, dispatch);
	}

	return null;
}

/** 列表页：顶部本地过滤框 + 已装列表（过滤后）。 */
function renderListPage(view: SkillsViewState, active: boolean, dispatch: Dispatch): React.ReactNode {
	const filtered = filteredInstalled(view);

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<SingleLineInput
				label="过滤"
				value={view.filterText}
				focused={active && view.filterFocused}
				placeholder="输入关键词模糊筛选已装 skill"
				onChange={value => dispatch({type: 'filter-input', value})}
			/>
			{filtered.length === 0 ? (
				<ListEmptyState
					message={view.installed.length === 0 ? '暂无已安装 skill' : '没有匹配的已装 skill'}
					hint={view.installed.length === 0 ? {label: '进入安装页搜索安装', enabled: true} : undefined}
				/>
			) : (
				<InstalledSkillsGrid skills={filtered} cursor={view.installedIndex} active={active} />
			)}
		</box>
	);
}

/** 安装页：远程搜索框 + 扁平 skill 列表 + 表头。 */
function renderInstallPage(
	view: SkillsViewState,
	detection: DetectionState<InstalledSkill[]>,
	active: boolean,
	dispatch: Dispatch
): React.ReactNode {
	const detectionReady = detection.status === 'success';
	const projected = searchInstallItems(view);
	const items = projected.map((item, index) => {
		const {skillName = displaySkillName(item.result.name)} = item.identity ?? {};
		const skill = item.result;
		// 解析 skill 名称：owner/repo@skill 格式，提取 @ 后的 skill 名（复用 displaySkillName）
		const installCountText = skill.installCount ? formatInstallCount(skill.installCount) : '';
		// 拼接 title：name (source)
		const titleText = `${skillName} (${skill.source})`;
		const statusLabel = searchStatusLabel(item, detectionReady);
		const bodyParts = [skill.description, skill.url].filter(Boolean);

		return {
			key: item.identity?.key ?? `${index}:${skill.name}`,
			title: titleText,
			titleColor: active && index === view.resultIndex ? colors.primary : colors.text,
			titleAttrs: TextAttributes.BOLD,
			titleRight:
				statusLabel || installCountText ? (
					<box flexDirection="row">
						{statusLabel ? (
							<text
								fg={
									item.status === 'source-replacement'
										? colors.warning
										: item.status === 'installed'
											? colors.success
											: colors.muted
								}
							>
								{statusLabel}
							</text>
						) : null}
						{statusLabel && installCountText ? <text fg={colors.muted}>{'  '}</text> : null}
						{installCountText ? <text fg={colors.muted}>{installCountText}</text> : null}
					</box>
				) : undefined,
			leading: (
				<Checkbox
					checked={item.selected}
					disabled={!detectionReady || !item.selectable}
					focused={active && index === view.resultIndex}
				/>
			),
			body:
				bodyParts.length > 0 ? (
					<box flexDirection="column">
						{bodyParts.map((part, partIndex) => (
							<text
								key={`${item.identity?.key ?? skill.name}:${partIndex}`}
								fg={colors.muted}
								attributes={TextAttributes.DIM}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
							>
								{part}
							</text>
						))}
					</box>
				) : undefined,
			multiLine: true
		};
	});

	const header =
		items.length > 0 ? (
			<box flexDirection="row" justifyContent="space-between" paddingX={2} marginBottom={0}>
				<text fg={colors.muted} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					名称
				</text>
				<text fg={colors.muted} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					状态 / 下载量
				</text>
			</box>
		) : undefined;

	return (
		<box flexDirection="column" flexGrow={1}>
			<SingleLineInput
				label="搜索"
				value={view.query}
				focused={active && view.queryFocused}
				placeholder="输入关键词搜索 skills.sh"
				onChange={value => dispatch({type: 'query-input', value})}
			/>
			{view.searching ? (
				<ListLoadingState message="正在搜索..." />
			) : items.length > 0 ? (
				<box marginTop={1} flexGrow={1} flexDirection="column">
					<ScrollList items={items} cursor={view.resultIndex} header={header} active={active} focusIndicator="leading" />
				</box>
			) : (
				<ListEmptyState message="输入关键词开始搜索" />
			)}
		</box>
	);
}

function searchStatusLabel(item: ReturnType<typeof searchInstallItems>[number], detectionReady: boolean): string {
	if (!detectionReady) {
		return '○ 等待检测';
	}

	if (!item.identity) {
		return '○ 来源不可用';
	}

	const labels: Partial<Record<typeof item.status, string>> = {
		installed: '● 已安装',
		'claude-only': '● 仅 Claude Code',
		'codex-only': '● 仅 Codex',
		'shared-copy': '● Claude 独立副本',
		'source-replacement': '已有同名',
		'name-occupied': '● 同名来源未知',
		'selection-conflict': '○ 同名冲突'
	};
	return labels[item.status] ?? '';
}

/** 格式化安装数（2.3M / 513.8K / 1234）。 */
function formatInstallCount(count: number): string {
	if (count >= 1e6) {
		return `${(count / 1e6).toFixed(1)}M`;
	}

	if (count >= 1e3) {
		return `${(count / 1e3).toFixed(1)}K`;
	}

	return String(count);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
