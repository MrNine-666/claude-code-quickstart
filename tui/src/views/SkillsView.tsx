import React, {useEffect, useReducer} from 'react';
import {TextAttributes} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import type {KeyEvent} from '@opentui/core';
import {ErrorPanel, ListEmptyState, ListLoadingState, Modal, ProgressLog, ScrollList, ViewHeader, toast} from '../components/index.js';
import {borderColors, colors} from '../theme/index.js';
import type {DetectionState} from '../services/async-detection.js';
import type {DetectionCache} from '../hooks/use-detection-cache.js';
import type {InstalledSkill, SearchSkillResult} from '../core/skills.js';
import {projectSharedSkills} from '../core/skills.js';
import type {ProgressCallback} from '../core/exec.js';
import type {SkillsSideResult} from '../services/skills-service.js';
import {AGENT_CONTEXT_LABELS, AGENT_CONTEXT_ORDER, type AgentContext} from '../state/manage-state.js';
import {hasShortcutModifier} from '../utils/keyboard.js';
import {
	createInitialSkillsViewState,
	displaySkillName,
	filteredInstalled,
	reduceSkillsViewState,
	selectedInstalled,
	selectedResult,
	shouldRunSearch,
	uninstallTargets,
	type InstallDraft,
	type SkillsViewAction,
	type SkillsViewState,
	type SkillsViewMode
} from '../state/skills-view-state.js';

type Dispatch = React.Dispatch<SkillsViewAction>;

// Skills 视图（OpenTUI 适配）：共享本体 + 双侧注入架构（shared-resource-injection-ui Section 18）。
// 列表页：本地过滤框 + 共享列表（一行一 skill name + Claude Code/Codex 双态徽章）；
//   Enter 管理安装（切 Claude Code symlink）/ u 更新两侧 / d 全量卸载（所有 Agent）/ r 刷新。
// 安装页：远程搜索框 + 扁平 skill 列表；Enter 弹安装目标 Modal（Codex 只读恒勾）。
// Modal（安装目标 / 管理安装 / 全量卸载确认）统一绝对定位居中覆盖，不挤占列表布局。
// Header 隐藏（app.tsx AGENT_HEADER_HIDDEN_MODULES）：检测走双侧聚合（一次 skills list -g --json 无 --agent），
// 不按 agentContext 过滤；顶行 ↑ no-op（不退 header）。检测缓存提升到 App 层：切走再切回不重跑；r 刷新。

// 安装目标 / 管理安装 / 卸载确认 Modal 宽度：对齐 Tools/MCP，容纳 hint 单行不换行。
const SKILLS_MODAL_WIDTH = 56;

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ok: true; results: readonly SearchSkillResult[]} | {ok: false; error: string; rawSummary?: string}>;
	// 多目标安装（安装目标 Modal 提交）：单次传入所选目标，结果按目标映射以保持接口兼容。
	readonly installToTargets: (result: SearchSkillResult, targets: readonly AgentContext[], onProgress?: ProgressCallback) => Promise<readonly SkillsSideResult[]>;
	// 切换 Claude Code 安装（管理安装 Modal 提交）：install=建 symlink / 卸载=删 symlink。
	readonly toggleClaude: (skill: import('../core/skills.js').SkillSharedRow, install: boolean, onProgress?: ProgressCallback) => Promise<{success: boolean; error?: string}>;
	// 更新两侧（u）：单次全局 update，由 skills lock 更新所有注入侧。
	readonly updateBothSides: (onProgress?: ProgressCallback) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	// 全量卸载（d）：单条 skills remove 省略 --agent，由 CLI 默认从所有 Agent 删除。
	readonly uninstallAllAgents: (name: string, onProgress?: ProgressCallback) => Promise<{success: boolean; error?: string}>;
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
	readonly onExitToNav?: () => void;
};

export function SkillsView({
	services,
	cache,
	active = true,
	onSubModeChange,
	onExitToNav
}: SkillsViewProps) {
	const [view, dispatch] = useReducer(reduceSkillsViewState, createInitialSkillsViewState());
	const detection = cache.state;

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

	// 键盘输入处理（OpenTUI useKeyboard 回调参数是 KeyEvent 对象，键名取 .name）
	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		handleKey(keyEvent, view, dispatch, services, cache, onExitToNav);
	});

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ViewHeader title="Skills 技能管理" subtitle="共享维护 Claude Code 与 Codex 两侧的 Skills（搜索、安装、更新、卸载）" />
			{renderDetectionNotice(detection)}
			{renderPage(view, detection, active)}
			{view.busyAction ? <ProgressLog title="执行进度" messages={view.progress} /> : null}
			{view.errorText ? (
				<box marginTop={1}>
					<ErrorPanel message={view.errorText} />
				</box>
			) : null}
			{view.mode === 'select-install-target' || view.mode === 'manage-inject' ? (
				<InstallTargetModal view={view} />
			) : null}
			{view.mode === 'confirm-uninstall' ? renderConfirm(view) : null}
		</box>
	);
}

// ── 按键总分发 ─────────────────────────────────────────────────────────────

function handleKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	onExitToNav?: () => void
): void {
	// busy 进行中：忽略一切输入
	if (view.mode === 'busy') {
		return;
	}

	// 安装目标 / 管理安装 Modal：↑/↓ 选侧、空格切草稿（仅 Claude Code）、Enter 提交、Esc 取消
	if (view.mode === 'select-install-target' || view.mode === 'manage-inject') {
		handleTargetModalKey(keyEvent, view, dispatch, services, cache);
		return;
	}

	// 全量卸载确认：Enter 确认 / Esc 取消
	if (view.mode === 'confirm-uninstall') {
		const mapped = mapActionKey(keyEvent.name);
		if (mapped === 'enter') {
			dispatch({type: 'confirm'});
			runConfirmedUninstall(view, services, dispatch, cache);
		} else if (mapped === 'escape') {
			dispatch({type: 'cancel'});
		}

		return;
	}

	if (view.mode === 'install') {
		handleInstallKey(keyEvent, view, dispatch, services);
		return;
	}

	// mode === 'list'
	handleListKey(keyEvent, view, dispatch, services, cache, onExitToNav);
}

/** 安装目标 / 管理安装 Modal 按键：复用 Tools InjectTargetModal 范式。 */
function handleTargetModalKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>
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
			runInstallToTargets(view, services, dispatch, cache);
		} else {
			runManageInject(view, services, dispatch, cache);
		}
	}
}

/** 列表页按键：过滤框聚焦态 vs 浏览态。 */
function handleListKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	onExitToNav?: () => void
): void {
	const name = keyEvent.name;

	// 过滤框聚焦：字符输入 / Backspace / Tab 失焦 / Esc 清空；方向键仍可导航过滤结果
	if (view.filterFocused) {
		if (name === 'escape') {
			dispatch({type: 'filter-clear'});
			return;
		}

		if (name === 'tab') {
			dispatch({type: 'filter-blur'});
			return;
		}

		if (name === 'backspace' || name === 'delete') {
			dispatch({type: 'filter-input', value: view.filterText.slice(0, -1)});
			return;
		}

		// 方向键导航（聚焦时也允许，边过滤边看结果）
		const nav = mapNavKey(name);
		if (nav) {
			dispatch({type: nav === 'up' ? 'nav-up' : 'nav-down'});
			return;
		}

		// 可打印字符追加：空格取实际字符，其余取单字符 name（排除任意修饰键与 tab）
		const char = name === 'space' ? ' ' : name;
		if (char.length === 1 && !hasShortcutModifier(keyEvent) && name !== 'tab') {
			dispatch({type: 'filter-input', value: view.filterText + char});
		}

		return;
	}

	// 浏览态：Esc/← 退回左侧导航
	if (name === 'escape' || name === 'left' || name === 'arrowleft') {
		onExitToNav?.();
		return;
	}

	const mapped = mapActionKey(name);
	switch (mapped) {
		case 'up':
			// Skills 隐藏 Header：顶行 ↑ 停在首项（no-op），不退回 header。
			dispatch({type: 'nav-up'});
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'tab':
			dispatch({type: 'filter-focus'});
			return;
		case 'enter':
			// 列表行 Enter → 管理安装 Modal（切 Claude Code symlink / Codex 只读随本体）。
			if (selectedInstalled(view)) {
				dispatch({type: 'manage-inject'});
			}
			return;
		case 'install':
			dispatch({type: 'open-install'});
			return;
		case 'update':
			dispatch({type: 'request-update'});
			runUpdateIfReady(view, services, dispatch);
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
function handleInstallKey(keyEvent: KeyEvent, view: SkillsViewState, dispatch: Dispatch, services: SkillsViewServices): void {
	const name = keyEvent.name;

	// 搜索框聚焦：字符输入 / Enter 提交搜索 / Tab 失焦 / Esc 回列表页
	if (view.queryFocused) {
		if (name === 'enter' || name === 'return') {
			dispatch({type: 'submit-search'});
			if (shouldRunSearch(view)) {
				runSearch(view.query, services, dispatch);
			}

			return;
		}

		if (name === 'escape') {
			dispatch({type: 'cancel'});
			return;
		}

		if (name === 'tab') {
			dispatch({type: 'query-blur'});
			return;
		}

		if (name === 'backspace' || name === 'delete') {
			dispatch({type: 'query-input', value: view.query.slice(0, -1)});
			return;
		}

		const nav = mapNavKey(name);
		if (nav) {
			dispatch({type: nav === 'up' ? 'nav-up' : 'nav-down'});
			return;
		}

		const char = name === 'space' ? ' ' : name;
		if (char.length === 1 && !hasShortcutModifier(keyEvent) && name !== 'tab') {
			dispatch({type: 'query-input', value: view.query + char});
		}

		return;
	}

	// skill 浏览态：Enter 弹安装目标 Modal / Tab 回搜索框 / Esc 回列表页
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
			if (view.results.length > 0) {
				dispatch({type: 'select-skill'});
			}

			return;
		case 'escape':
			dispatch({type: 'cancel'});
			return;
	}
}

// ── 键名映射 ───────────────────────────────────────────────────────────────

/** 动作键映射（浏览态用）。`a` 触发 open-install（需求②，原 `/`）。 */
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
		return 'install';
	}

	if (k === 'u') {
		return 'update';
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
	return (event) => dispatch({type: 'progress', message: event.message});
}

function runSearch(query: string, services: SkillsViewServices, dispatch: Dispatch): void {
	void services.searchSkills(query).then((outcome) => {
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

/** 安装目标 Modal 提交（select-install-target Enter）：按草稿单次提交所选目标。cx 恒 true。 */
function runInstallToTargets(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>
): void {
	const skill = selectedResult(view);
	if (!skill) {
		dispatch({type: 'action-failed', error: '没有可安装的 skill'});
		return;
	}

	const targets = AGENT_CONTEXT_ORDER.filter(ctx => view.installDraft[ctx]);
	dispatch({type: 'confirm'});
	void services.installToTargets(skill, targets, progressSink(dispatch)).then((sides) => {
		const failed = sides.filter(side => !side.result.success);
		if (failed.length === 0) {
			toast.success(`已安装 ${skill.name}`);
			dispatch({type: 'action-done'});
			cache.refresh();
		} else {
			const detail = failed.map(side => `${AGENT_CONTEXT_LABELS[side.agentContext]}: ${side.result.error ?? '安装失败'}`).join('；');
			dispatch({type: 'action-failed', error: detail});
		}
	});
}

/** 管理安装 Modal 提交（manage-inject Enter）：按 Claude Code 草稿 diff 建/删 symlink（Codex 只读不动）。 */
function runManageInject(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>
): void {
	const current = selectedInstalled(view);
	if (!current) {
		dispatch({type: 'cancel'});
		return;
	}

	const desired = view.installDraft.cc;
	if (desired === current.claudeInjected) {
		toast.info('未改变 Claude Code 安装状态');
		dispatch({type: 'cancel'});
		return;
	}

	dispatch({type: 'confirm'});
	void services.toggleClaude(current, desired, progressSink(dispatch)).then((res) => {
		if (res.success) {
			toast.success(`${current.name} · Claude Code 已${desired ? '安装' : '卸载'}`);
			dispatch({type: 'action-done'});
			cache.refresh();
		} else {
			dispatch({type: 'action-failed', error: res.error ?? '操作失败'});
		}
	});
}

/** 全量卸载确认（confirm-uninstall Enter）：单条 skills remove 省略 --agent，从所有 Agent 删除。 */
function runConfirmedUninstall(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>
): void {
	const names = uninstallTargets(view);
	if (names.length === 0) {
		dispatch({type: 'action-failed', error: '没有选中要卸载的 skill'});
		return;
	}

	const name = names[0]!;
	void services.uninstallAllAgents(name, progressSink(dispatch)).then((res) => {
		if (res.success) {
			toast.success(`已从所有 Agent 卸载 ${name}`);
			dispatch({type: 'action-uninstall-done', names});
			cache.refresh();
		} else {
			dispatch({type: 'action-failed', error: res.error ?? '卸载失败'});
		}
	});
}

function runUpdateIfReady(view: SkillsViewState, services: SkillsViewServices, dispatch: Dispatch): void {
	if (view.installed.length === 0) {
		return;
	}

	void services.updateBothSides(progressSink(dispatch)).then((res) => {
		if (res.success) {
			toast.success(res.noChange ? 'skill 已是最新版本' : '已更新 skill');
			dispatch({type: 'action-done'});
		} else {
			dispatch({type: 'action-failed', error: res.error ?? '更新失败'});
		}
	});
}

// ── 渲染 ───────────────────────────────────────────────────────────────────

/** 当前应渲染的页（Modal/执行时保持原页显示，仅叠加 Modal/进度）。 */
function pageOf(mode: SkillsViewMode, busyReturnMode?: 'list' | 'install'): 'list' | 'install' {
	// 安装页及其安装目标 Modal 停留安装页；busy 按动作来源保留对应底页 + 进度。
	if (mode === 'install' || mode === 'select-install-target') {
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
		<Modal active title="确认卸载 Skill" hint="Enter 确认  Esc 取消" tone="danger" width={SKILLS_MODAL_WIDTH}>
			<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{names.length > 0 ? `将在所有 Agent 中卸载 ${names.join(', ')}：移除 Claude Code symlink 与共享本体，此操作不可撤销。` : '无卸载目标'}
			</text>
		</Modal>
	);
}

// ── 安装目标 / 管理安装 Modal：↑/↓ 选侧，空格切草稿（仅 Claude Code），Enter 提交，Esc 取消 ──
// 复用 Tools InjectTargetModal 范式：左 › <Agent 全称> focused 高亮 flexGrow，右状态标签右对齐。
// Codex 只读恒勾（装了必写本体、直读即可用，无法不装）；仅 Claude Code 可切。文案统一「安装/卸载」。
function InstallTargetModal({view}: {readonly view: SkillsViewState}) {
	const isManage = view.mode === 'manage-inject';
	const name = isManage ? selectedInstalled(view)?.name ?? '' : displaySkillName(selectedResult(view)?.name ?? '');
	const title = isManage ? `管理安装：${name}` : `选择安装目标：${name}`;
	const selected = AGENT_CONTEXT_ORDER[view.targetIndex] ?? 'cc';
	return (
		<Modal active title={title} hint="↑/↓ 选择  空格 切换安装/卸载  Enter 应用  Esc 取消" width={SKILLS_MODAL_WIDTH}>
			<box flexDirection="column">
				{AGENT_CONTEXT_ORDER.map((ctx) => {
					const checked = Boolean(view.installDraft[ctx]);
					const focused = ctx === selected;
					// Codex 只读随本体：管理态显「已安装（随本体）/未安装」，安装态显「安装」恒勾。
					const readonly = ctx === 'cx';
					const stateLabel = readonly
						? (isManage ? (checked ? '● 已安装（随本体）' : '○ 未安装') : '● 安装')
						: (checked ? '● 安装' : '○ 不安装');
					return (
						<box key={ctx} flexDirection="row">
							<text fg={focused ? colors.primary : colors.muted} attributes={focused ? TextAttributes.BOLD : 0} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} flexGrow={1}>
								{`${focused ? '›' : ' '} ${AGENT_CONTEXT_LABELS[ctx]}${readonly ? '（只读）' : ''} `}
							</text>
							<text fg={checked ? colors.success : colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg} flexShrink={0}>
								{stateLabel}
							</text>
						</box>
					);
				})}
			</box>
		</Modal>
	);
}

// ── 行内双态徽章：已安装=success ●，未安装=muted ○（全称标签，禁 cc/cx 缩写） ──
// Claude Code = 可切 symlink 安装态；Codex = 只读镜像共享本体（codexAvailable），跟随本体不可单独切。
function DualStateBadges({claudeInjected, codexAvailable}: {readonly claudeInjected: boolean; readonly codexAvailable: boolean}) {
	return (
		<box flexDirection="row" height={1} overflow="hidden">
			<StateBadge label={AGENT_CONTEXT_LABELS.cc} installed={claudeInjected} />
			<text fg={colors.muted}>{'  '}</text>
			<StateBadge label={AGENT_CONTEXT_LABELS.cx} installed={codexAvailable} />
		</box>
	);
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
	active: boolean
): React.ReactNode {
	const page = pageOf(view.mode, view.busyReturnMode);
	if (page === 'install') {
		return renderInstallPage(view, active);
	}

	// 列表页（默认）。detection 未就绪时由 detectionNotice 占位，body 留空。
	if (detection.status === 'success') {
		return renderListPage(view, active);
	}

	return null;
}

/** 列表页：顶部本地过滤框 + 已装列表（过滤后）。 */
function renderListPage(view: SkillsViewState, active: boolean): React.ReactNode {
	const filtered = filteredInstalled(view);
	const items = filtered.map((skill) => ({
		key: skill.name,
		title: skill.name,
		body: <DualStateBadges claudeInjected={skill.claudeInjected} codexAvailable={skill.codexAvailable} />,
		multiLine: true
	}));

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<InputBox label="过滤" value={view.filterText} focused={active && view.filterFocused} placeholder="输入关键词模糊筛选已装 skill" />
			{filtered.length === 0 ? (
				<ListEmptyState
					message={view.installed.length === 0 ? '暂无已安装 skill' : '没有匹配的已装 skill'}
					hint={view.installed.length === 0 ? {label: '按 a 进入安装页搜索安装', enabled: true} : undefined}
				/>
			) : (
				<ScrollList items={items} cursor={view.installedIndex} active={active} />
			)}
		</box>
	);
}

/** 安装页：远程搜索框 + 扁平 skill 列表 + 表头。 */
function renderInstallPage(view: SkillsViewState, active: boolean): React.ReactNode {
	const items = view.results.map((skill) => {
		// 解析 skill 名称：owner/repo@skill 格式，提取 @ 后的 skill 名（复用 displaySkillName）
		const skillName = displaySkillName(skill.name);
		const installCountText = skill.installCount ? formatInstallCount(skill.installCount) : '';
		// 拼接 title：name (source)
		const titleText = `${skillName} (${skill.source})`;

		return {
			key: skill.name,
			title: titleText,
			titleColor: colors.primary,
			titleAttrs: TextAttributes.BOLD,
			titleRight: installCountText ? <text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{installCountText}</text> : undefined,
			body: skill.url ? (
				<text fg={colors.muted} attributes={TextAttributes.DIM} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{skill.url}</text>
			) : undefined,
			multiLine: true
		};
	});

	const header = items.length > 0 ? (
		<box flexDirection="row" justifyContent="space-between" paddingX={2} marginBottom={0}>
			<text fg={colors.muted} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>名称</text>
			<text fg={colors.muted} attributes={TextAttributes.BOLD} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>下载量</text>
		</box>
	) : undefined;

	return (
		<box flexDirection="column" flexGrow={1}>
			<InputBox label="搜索" value={view.query} focused={active && view.queryFocused} placeholder="输入关键词搜索 skills.sh" />
			{view.searching ? (
				<ListLoadingState message="正在搜索..." />
			) : items.length > 0 ? (
				<box marginTop={1} flexGrow={1} flexDirection="column">
					<ScrollList
						items={items}
						cursor={view.resultIndex}
						header={header}
						active={active}
					/>
				</box>
			) : (
				<ListEmptyState message="输入关键词开始搜索" />
			)}
		</box>
	);
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

/** 顶部输入框（列表页过滤 / 安装页搜索共用）。聚焦时高亮边框 + 光标。 */
function InputBox({
	label,
	value,
	focused,
	placeholder
}: {
	readonly label: string;
	readonly value: string;
	readonly focused: boolean;
	readonly placeholder: string;
}): React.ReactNode {
	const shown = value || (!focused ? placeholder : '');
	return (
		<box flexDirection="row" flexShrink={0}>
			<box
				flexDirection="row"
				borderStyle="rounded"
				borderColor={focused ? borderColors.active : borderColors.inactive}
				backgroundColor={focused ? colors.focusedBackground : undefined}
				flexGrow={1}
			>
				<text fg={colors.muted}>{label}：</text>
				<text fg={value ? colors.text : colors.muted}>{shown}</text>
				{focused ? <text fg={colors.primary}>_</text> : null}
			</box>
		</box>
	);
}
