import React, {useEffect, useReducer} from 'react';
import {TextAttributes} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import type {KeyEvent} from '@opentui/core';
import {ActionHint, Checkbox, ErrorPanel, ListEmptyState, ListLoadingState, Modal, ProgressLog, ScrollList, Spinner, ViewHeader, toast} from '../components/index.js';
import {borderColors, colors} from '../theme/index.js';
import type {DetectionState} from '../services/async-detection.js';
import type {DetectionCache} from '../hooks/use-detection-cache.js';
import type {InstalledSkill, SearchSkillResult} from '../core/skills.js';
import type {ProgressCallback} from '../core/exec.js';
import {AGENT_CONTEXT_LABELS, type AgentContext} from '../state/manage-state.js';
import {hasShortcutModifier} from '../utils/keyboard.js';
import {
	createInitialSkillsViewState,
	displaySkillName,
	filteredInstalled,
	reduceSkillsViewState,
	selectedResult,
	shouldRunSearch,
	uninstallTargets,
	type SkillsViewAction,
	type SkillsViewState,
	type SkillsViewMode
} from '../state/skills-view-state.js';

type Dispatch = React.Dispatch<SkillsViewAction>;

// Skills 视图（OpenTUI 适配）：扁平安装架构。
// 列表页：顶部本地过滤框（模糊查询已装）+ 已装列表；u 更新全部 / d 卸载单条 / r 刷新。
// 安装页：远程搜索框 + 扁平 skill 列表；Enter 触发确认弹窗。
// 列表页 `a` → 安装页；Esc 回退（安装页→列表页→导航）。
// 确认弹窗统一使用绝对定位 Modal 居中覆盖，不挤占列表布局。
// 检测缓存提升到 App 层：已安装检测由 cache 注入，切走再切回不重跑；r 键刷新。

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ok: true; results: readonly SearchSkillResult[]} | {ok: false; error: string; rawSummary?: string}>;
	readonly installResult: (result: SearchSkillResult, onProgress?: ProgressCallback, exec?: import('../core/skills-actions.js').SkillsExecFn) => Promise<{success: boolean; error?: string}>;
	readonly updateAll: (onProgress?: ProgressCallback, exec?: import('../core/skills-actions.js').SkillsExecFn) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	readonly uninstall: (names: readonly string[], onProgress?: ProgressCallback, exec?: import('../core/skills-actions.js').SkillsExecFn) => Promise<{success: boolean; error?: string}>;
	readonly createDetectionRunner: (
		onChange: import('../services/detection-runner.js').DetectionStateSink<InstalledSkill[]>
	) => import('../services/detection-runner.js').DetectionRunner<InstalledSkill[]>;
	readonly runDetection: (runner: import('../services/detection-runner.js').DetectionRunner<InstalledSkill[]>, options?: import('../services/detection-runner.js').DetectionRunOptions) => Promise<unknown>;
};

export type SkillsViewProps = {
	readonly services: SkillsViewServices;
	readonly cache: DetectionCache<InstalledSkill[]>;
	readonly agentContext?: AgentContext;
	readonly active?: boolean;
	readonly viewportHeight?: number;
	readonly viewportWidth?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav?: () => void;
	readonly onExitToHeader?: () => void;
};

export function SkillsView({
	services,
	cache,
	agentContext = 'cc',
	active = true,
	viewportHeight = 16,
	viewportWidth = 52,
	onSubModeChange,
	onExitToNav,
	onExitToHeader
}: SkillsViewProps) {
	const [view, dispatch] = useReducer(reduceSkillsViewState, createInitialSkillsViewState());
	const detection = cache.state;

	// 缓存检测成功时把已安装列表灌入视图 reducer。
	useEffect(() => {
		if (detection.status === 'success') {
			dispatch({type: 'installed-loaded', installed: detection.result ?? []});
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

		handleKey(keyEvent, view, dispatch, services, cache, onExitToNav, onExitToHeader);
	});

	// 确认态使用绝对定位 Modal，不再为确认框预留列表行数。
	const confirmActive = isConfirmMode(view.mode);
	const confirmRows = 0;
	const stretchLists = true;

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="Skills 技能管理" subtitle={`搜索、安装、更新和卸载 ${AGENT_CONTEXT_LABELS[agentContext]} Skills`} />
			{renderDetectionNotice(detection.status)}
			{renderPage(view, detection, viewportHeight, confirmRows, stretchLists, active)}
			{view.busyAction ? <ProgressLog title="执行进度" messages={view.progress} /> : null}
			{view.errorText ? (
				<box marginTop={1}>
					<ErrorPanel message={view.errorText} />
				</box>
			) : null}
			{confirmActive ? renderConfirm(view, viewportWidth, viewportHeight, agentContext) : null}
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
	onExitToNav?: () => void,
	onExitToHeader?: () => void
): void {
	// busy 进行中：忽略一切输入
	if (view.mode === 'busy') {
		return;
	}

	// 确认弹层：Enter 确认 / Esc 取消
	if (view.mode === 'confirm-install' || view.mode === 'confirm-uninstall') {
		const mapped = mapActionKey(keyEvent.name);
		if (mapped === 'enter') {
			dispatch({type: 'confirm'});
			runConfirmedAction(view, services, dispatch, cache);
		} else if (mapped === 'escape') {
			dispatch({type: 'cancel'});
		}

		return;
	}

	if (view.mode === 'install') {
		handleInstallKey(keyEvent, view, dispatch, services, onExitToHeader);
		return;
	}

	// mode === 'list'
	handleListKey(keyEvent, view, dispatch, services, cache, onExitToNav, onExitToHeader);
}

/** 列表页按键：过滤框聚焦态 vs 浏览态。 */
function handleListKey(
	keyEvent: KeyEvent,
	view: SkillsViewState,
	dispatch: Dispatch,
	services: SkillsViewServices,
	cache: DetectionCache<InstalledSkill[]>,
	onExitToNav?: () => void,
	onExitToHeader?: () => void
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
			if (view.installedIndex === 0 && onExitToHeader) {
				onExitToHeader();
			} else {
				dispatch({type: 'nav-up'});
			}
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'tab':
			dispatch({type: 'filter-focus'});
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
function handleInstallKey(keyEvent: KeyEvent, view: SkillsViewState, dispatch: Dispatch, services: SkillsViewServices, onExitToHeader?: () => void): void {
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

	// skill 浏览态：Enter 触发确认弹窗 / Tab 回搜索框 / Esc 回列表页
	const mapped = mapActionKey(name);
	switch (mapped) {
		case 'up':
			if (view.resultIndex === 0 && onExitToHeader) {
				onExitToHeader();
			} else {
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

function runConfirmedAction(
	view: SkillsViewState,
	services: SkillsViewServices,
	dispatch: Dispatch,
	cache: DetectionCache<InstalledSkill[]>
): void {
	if (view.mode === 'confirm-install') {
		const skill = selectedResult(view);
		if (!skill) {
			dispatch({type: 'action-failed', error: '没有可安装的 skill'});
			return;
		}

		void services.installResult(skill, progressSink(dispatch)).then((res) => {
			if (res.success) {
				toast.success(`已安装 ${skill.name}`);
				dispatch({type: 'action-done'});
				cache.refresh();
			} else {
				dispatch({type: 'action-failed', error: res.error ?? '安装失败'});
			}
		});
		return;
	}

	if (view.mode === 'confirm-uninstall') {
		const names = uninstallTargets(view);
		if (names.length === 0) {
			dispatch({type: 'action-failed', error: '没有选中要卸载的 skill'});
			return;
		}

		void services.uninstall(names, progressSink(dispatch)).then((res) => {
			if (res.success) {
				toast.success(`已卸载 ${names.join(', ')}`);
				dispatch({type: 'action-uninstall-done', names});
				cache.refresh();
			} else {
				dispatch({type: 'action-failed', error: res.error ?? '卸载失败'});
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
			toast.success(res.noChange ? '所有 skill 已是最新版本' : '已更新所有 skill');
			dispatch({type: 'action-done'});
		} else {
			dispatch({type: 'action-failed', error: res.error ?? '更新失败'});
		}
	});
}

// ── 渲染 ───────────────────────────────────────────────────────────────────

function isConfirmMode(mode: SkillsViewMode): boolean {
	return mode === 'confirm-install' || mode === 'confirm-uninstall';
}

/** 当前应渲染的页（确认/执行时保持原页显示，仅叠加底部确认框/进度）。 */
function pageOf(mode: SkillsViewMode, busyAction?: 'install' | 'update' | 'uninstall'): 'list' | 'install' {
	if (mode === 'install' || mode === 'confirm-install') {
		return 'install';
	}

	// busy(install) 保留安装页 + 进度；busy(update/uninstall) 回列表页
	if (mode === 'busy' && busyAction === 'install') {
		return 'install';
	}

	return 'list';
}

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

/** 底部确认框（confirm-install 单个 skill / confirm-uninstall 单条）。 */
function renderConfirm(view: SkillsViewState, viewportWidth: number, viewportHeight: number, agentContext: AgentContext): React.ReactNode {
	if (view.mode === 'confirm-install') {
		const skill = selectedResult(view);
		const skillName = skill ? displaySkillName(skill.name) : '';
		const source = skill?.source ?? '';
		return (
			<Modal active title="确认安装 Skill" hint="Enter 确认  Esc 取消" viewportWidth={viewportWidth} viewportHeight={viewportHeight}>
				<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{skill ? `即将安装 ${skillName} (${source})` : '无可用结果'}</text>
			</Modal>
		);
	}

	const names = uninstallTargets(view);
	// Codex 直接读共享目录 ~/.agents/skills：若该 Skill 仍被其他 Agent 引用，canonical 文件保留，Codex 仍可见。
	const codexHint = agentContext === 'cx' ? '（Codex 直读共享目录，若其他 Agent 仍引用则文件保留、Codex 仍可见）' : '';
	return (
		<Modal active title="确认卸载 Skill" hint="Enter 确认  Esc 取消" tone="danger" viewportWidth={viewportWidth} viewportHeight={viewportHeight}>
			<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{names.length > 0 ? `即将卸载：${names.join(', ')}` : '无卸载目标'}</text>
			{codexHint ? <text fg={colors.muted}>{codexHint}</text> : null}
		</Modal>
	);
}

function renderPage(
	view: SkillsViewState,
	detection: DetectionState<InstalledSkill[]>,
	viewportHeight: number,
	confirmRows: number,
	stretchLists: boolean,
	active: boolean
): React.ReactNode {
	const page = pageOf(view.mode, view.busyAction);
	if (page === 'install') {
		return renderInstallPage(view, viewportHeight, confirmRows, stretchLists, active);
	}

	// 列表页（默认）。detection 未就绪时由 detectionNotice 占位，body 留空。
	if (detection.status === 'success') {
		return renderListPage(view, viewportHeight, confirmRows, stretchLists, active);
	}

	return null;
}

/** 列表页：顶部本地过滤框 + 已装列表（过滤后）。 */
function renderListPage(view: SkillsViewState, viewportHeight: number, confirmRows: number, stretchLists: boolean, active: boolean): React.ReactNode {
	const filtered = filteredInstalled(view);
	const items = filtered.map((skill) => ({
		key: skill.name,
		title: skill.name
	}));

	return (
		<box flexDirection="column" flexGrow={stretchLists ? 1 : 0}>
			<InputBox label="过滤" value={view.filterText} focused={active && view.filterFocused} placeholder="输入关键词模糊筛选已装 skill" />
			{filtered.length === 0 ? (
				<ListEmptyState
					message={view.installed.length === 0 ? '暂无已安装 skill' : '没有匹配的已装 skill'}
					hint={view.installed.length === 0 ? {label: '按 a 进入安装页搜索安装', enabled: true} : undefined}
				/>
			) : stretchLists ? (
				<box marginTop={1} flexGrow={1}>
					<ScrollList items={items} cursor={view.installedIndex} viewportHeight={viewportHeight} reservedRows={6 + confirmRows} active={active} stretch />
				</box>
			) : (
				<box marginTop={1}>
					<ScrollList items={items} cursor={view.installedIndex} viewportHeight={viewportHeight} reservedRows={6 + confirmRows} active={active} />
				</box>
			)}
		</box>
	);
}

/** 安装页：远程搜索框 + 扁平 skill 列表 + 表头。 */
function renderInstallPage(view: SkillsViewState, viewportHeight: number, confirmRows: number, stretchLists: boolean, active: boolean): React.ReactNode {
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
		<box flexDirection="column" flexGrow={stretchLists ? 1 : 0}>
			<InputBox label="搜索" value={view.query} focused={active && view.queryFocused} placeholder="输入关键词搜索 skills.sh" />
			{view.searching ? (
				<ListLoadingState message="正在搜索..." />
			) : items.length > 0 ? (
				<box marginTop={1} flexGrow={stretchLists ? 1 : 0} flexDirection="column">
					<ScrollList
						items={items}
						cursor={view.resultIndex}
						viewportHeight={viewportHeight}
						reservedRows={7 + confirmRows}
						stretch={stretchLists}
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
				paddingX={1}
				flexGrow={1}
			>
				<text fg={colors.muted}>{label}：</text>
				<text fg={value ? colors.text : colors.muted}>{shown}</text>
				{focused ? <text fg={colors.primary}>_</text> : null}
			</box>
		</box>
	);
}
