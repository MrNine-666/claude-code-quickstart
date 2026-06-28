import React, {useEffect, useReducer} from 'react';
import {TextAttributes} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import type {KeyEvent} from '@opentui/core';
import {ActionHint, Checkbox, ErrorPanel, Modal, ProgressLog, ScrollList, Spinner, ViewHeader, toast} from '../components/index.js';
import {borderColors, colors} from '../theme/index.js';
import type {DetectionState} from '../services/async-detection.js';
import type {DetectionCache} from '../hooks/use-detection-cache.js';
import type {InstalledSkill, RepoSkill, SearchSkillResult} from '../core/skills.js';
import type {ProgressCallback} from '../core/exec.js';
import {
	createInitialSkillsViewState,
	filteredInstalled,
	installTargets,
	reduceSkillsViewState,
	selectedRepo,
	shouldRunSearch,
	uninstallTargets,
	type SkillsViewAction,
	type SkillsViewState,
	type SkillsViewMode
} from '../state/skills-view-state.js';

type Dispatch = React.Dispatch<SkillsViewAction>;

// Skills 视图（OpenTUI 适配）：三阶段安装架构（需求③）。
// 列表页：顶部本地过滤框（模糊查询已装）+ 已装列表；u 更新全部 / d 卸载单条 / r 刷新。
// 安装页·父级：远程搜索框 + repo 列表（find 按 owner/repo 去重）；Enter 展开子 skill。
// 安装页·子级：某 repo 下 skill 多选（Space 切换 / Enter 确认安装）；Esc 回父级。
// 列表页 `a` → 安装页；Esc 逐级回退（子级→父级→列表页→导航）。
// 确认弹窗统一使用绝对定位 Modal 居中覆盖，不挤占列表布局。
// 检测缓存提升到 App 层：已安装检测由 cache 注入，切走再切回不重跑；r 键刷新。

export type SkillsViewServices = {
	readonly searchSkills: (
		query: string
	) => Promise<{ok: true; results: readonly SearchSkillResult[]} | {ok: false; error: string; rawSummary?: string}>;
	readonly installResult: (result: SearchSkillResult, onProgress?: ProgressCallback) => Promise<{success: boolean; error?: string}>;
	readonly listRepoSkills: (
		repo: string
	) => Promise<{ok: true; skills: readonly RepoSkill[]} | {ok: false; error: string; rawSummary?: string}>;
	readonly installMultiple: (
		input: {source: string; skillNames: readonly string[]; displayName?: string},
		onProgress?: ProgressCallback
	) => Promise<{success: boolean; error?: string}>;
	readonly updateAll: (onProgress?: ProgressCallback) => Promise<{success: boolean; error?: string; noChange?: boolean}>;
	readonly uninstall: (names: readonly string[], onProgress?: ProgressCallback) => Promise<{success: boolean; error?: string}>;
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
	readonly viewportWidth?: number;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav?: () => void;
};

export function SkillsView({
	services,
	cache,
	active = true,
	viewportHeight = 16,
	viewportWidth = 52,
	onSubModeChange,
	onExitToNav
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

		handleKey(keyEvent, view, dispatch, services, cache, onExitToNav);
	});

	// 确认态使用绝对定位 Modal，不再为确认框预留列表行数。
	const confirmActive = isConfirmMode(view.mode);
	const confirmRows = 0;
	const stretchLists = true;

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title="Skills 技能管理" subtitle="搜索、安装、更新和卸载 Claude Code Skills" />
			{renderDetectionNotice(detection.status)}
			{renderPage(view, detection, viewportHeight, confirmRows, stretchLists)}
			{view.busyAction ? <ProgressLog title="执行进度" messages={view.progress} /> : null}
			{view.errorText ? (
				<box marginTop={1}>
					<ErrorPanel message={view.errorText} />
				</box>
			) : null}
			{confirmActive ? renderConfirm(view, viewportWidth, viewportHeight) : null}
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

	// 确认弹层：Enter 确认 / Esc 取消
	if (view.mode === 'confirm-install' || view.mode === 'confirm-uninstall') {
		const mapped = mapActionKey(keyEvent.name);
		if (mapped === 'enter') {
			dispatch({type: 'confirm'});
			runConfirmedAction(view, services, dispatch);
		} else if (mapped === 'escape') {
			dispatch({type: 'cancel'});
		}

		return;
	}

	if (view.mode === 'install-pick') {
		handleInstallPickKey(keyEvent, view, dispatch);
		return;
	}

	if (view.mode === 'install') {
		handleInstallKey(keyEvent, view, dispatch, services);
		return;
	}

	// mode === 'list'
	handleListKey(keyEvent, view, dispatch, services, cache, onExitToNav);
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

		// 可打印字符追加：空格取实际字符，其余取单字符 name（排除带修饰键与 tab）
		const char = name === 'space' ? ' ' : name;
		if (char.length === 1 && !keyEvent.ctrl && !keyEvent.meta && !keyEvent.option && name !== 'tab') {
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
			dispatch({type: 'nav-up'});
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

/** 安装页·父级按键：搜索框聚焦态 vs repo 浏览态。 */
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
		if (char.length === 1 && !keyEvent.ctrl && !keyEvent.meta && !keyEvent.option && name !== 'tab') {
			dispatch({type: 'query-input', value: view.query + char});
		}

		return;
	}

	// repo 浏览态：Enter 展开当前光标 repo（触发 --list）/ Tab 回搜索框 / Esc 回列表页
	const mapped = mapActionKey(name);
	switch (mapped) {
		case 'up':
			dispatch({type: 'nav-up'});
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'tab':
			dispatch({type: 'query-focus'});
			return;
		case 'enter':
			if (view.repos.length > 0) {
				dispatch({type: 'select-repo'});
				runListRepoIfReady(view, services, dispatch);
			}

			return;
		case 'escape':
			dispatch({type: 'cancel'});
			return;
	}
}

/** 安装页·子级按键：Space 多选 / Enter 确认安装 / ↑↓ 导航 / Esc 回父级。 */
function handleInstallPickKey(keyEvent: KeyEvent, view: SkillsViewState, dispatch: Dispatch): void {
	const name = keyEvent.name;

	// --list 加载中：仅允许 Esc 回父级，其余禁用（避免在空列表上误操作）
	if (view.loadingRepo) {
		if (name === 'escape') {
			dispatch({type: 'cancel'});
		}

		return;
	}

	// a 全选/取消全选（子级专用；仅在 install-pick 中生效，不与列表页 a 安装页冲突）
	if (name === 'a') {
		dispatch({type: 'toggle-all-picks'});
		return;
	}

	// Space 切换当前光标 skill 选中（子级专用，未走 mapActionKey）
	if (name === 'space') {
		dispatch({type: 'toggle-pick'});
		return;
	}

	const mapped = mapActionKey(name);
	switch (mapped) {
		case 'up':
			dispatch({type: 'nav-up'});
			return;
		case 'down':
			dispatch({type: 'nav-down'});
			return;
		case 'enter':
			dispatch({type: 'confirm-pick'});
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

/** 选中父 repo 后异步拉取该 repo 全部子 skill（skills add <repo> --list）。 */
function runListRepoIfReady(view: SkillsViewState, services: SkillsViewServices, dispatch: Dispatch): void {
	const repo = selectedRepo(view);
	if (!repo) {
		return;
	}

	void services.listRepoSkills(repo.repo).then((outcome) => {
		if (outcome.ok) {
			dispatch({type: 'repo-skills-loaded', repo: repo.repo, skills: outcome.skills});
			if (outcome.skills.length === 0) {
				toast.info('该 repo 暂无 skill');
			}
		} else {
			dispatch({type: 'repo-skills-failed', error: outcome.error, rawSummary: outcome.rawSummary});
		}
	});
}

function runConfirmedAction(view: SkillsViewState, services: SkillsViewServices, dispatch: Dispatch): void {
	if (view.mode === 'confirm-install') {
		const targets = installTargets(view);
		if (targets.length === 0) {
			dispatch({type: 'action-failed', error: '没有可安装的 skill'});
			return;
		}

		const source = targets[0]!.source;
		const skillNames = targets.map(target => target.skillName);
		void services.installMultiple({source, skillNames, displayName: source}, progressSink(dispatch)).then((res) => {
			if (res.success) {
				toast.success(`已安装 ${skillNames.length} 个 skill`);
				dispatch({type: 'action-done'});
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
				dispatch({type: 'action-done'});
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

/** 当前应渲染的页（确认/执行时保持原页显示，仅叠加底部确认框/进度，需求①）。 */
function pageOf(mode: SkillsViewMode, busyAction?: 'install' | 'update' | 'uninstall'): 'list' | 'install' | 'install-pick' {
	if (mode === 'install') {
		return 'install';
	}

	if (mode === 'install-pick' || mode === 'confirm-install') {
		return 'install-pick';
	}

	// busy(install) 保留子级多选视图 + 进度；busy(update/uninstall) 回列表页
	if (mode === 'busy' && busyAction === 'install') {
		return 'install-pick';
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

/** 底部确认框（confirm-install 列多选汇总 / confirm-uninstall 单条）。 */
function renderConfirm(view: SkillsViewState, viewportWidth: number, viewportHeight: number): React.ReactNode {
	if (view.mode === 'confirm-install') {
		const targets = installTargets(view);
		const names = targets.map(target => target.skillName);
		const repo = targets[0]?.source ?? '';
		return (
			<Modal active title="确认安装 Skill" hint="Enter 确认  Esc 取消" viewportWidth={viewportWidth} viewportHeight={viewportHeight}>
				<text>{names.length > 0 ? `即将安装 ${repo} 下：${names.join(', ')}` : '无可用结果'}</text>
			</Modal>
		);
	}

	const names = uninstallTargets(view);
	return (
		<Modal active title="确认卸载 Skill" hint="Enter 确认  Esc 取消" tone="danger" viewportWidth={viewportWidth} viewportHeight={viewportHeight}>
			<text>{names.length > 0 ? `即将卸载：${names.join(', ')}` : '无卸载目标'}</text>
		</Modal>
	);
}

function renderPage(
	view: SkillsViewState,
	detection: DetectionState<InstalledSkill[]>,
	viewportHeight: number,
	confirmRows: number,
	stretchLists: boolean
): React.ReactNode {
	const page = pageOf(view.mode, view.busyAction);
	if (page === 'install') {
		return renderInstallRepoPage(view, viewportHeight, confirmRows, stretchLists);
	}

	if (page === 'install-pick') {
		return renderInstallPickPage(view, viewportHeight, confirmRows, stretchLists);
	}

	// 列表页（默认）。detection 未就绪时由 detectionNotice 占位，body 留空。
	if (detection.status === 'success') {
		return renderListPage(view, viewportHeight, confirmRows, stretchLists);
	}

	return null;
}

/** 列表页：顶部本地过滤框 + 已装列表（过滤后）。 */
function renderListPage(view: SkillsViewState, viewportHeight: number, confirmRows: number, stretchLists: boolean): React.ReactNode {
	const filtered = filteredInstalled(view);
	const items = filtered.map((skill) => ({
		key: skill.name,
		title: skill.name
	}));

	return (
		<box flexDirection="column" flexGrow={stretchLists ? 1 : 0}>
			<InputBox label="过滤" value={view.filterText} focused={view.filterFocused} placeholder="输入关键词模糊筛选已装 skill" />
			{filtered.length === 0 ? (
				<box flexDirection="column" flexGrow={1} justifyContent="center">
					<text fg={colors.muted}>{view.installed.length === 0 ? '暂无已安装 skill' : '没有匹配的已装 skill'}</text>
					{view.installed.length === 0 ? (
						<box marginTop={1}>
							<ActionHint label="按 a 进入安装页搜索安装" enabled />
						</box>
					) : null}
				</box>
			) : stretchLists ? (
				<box marginTop={1} flexGrow={1}>
					<ScrollList items={items} cursor={view.installedIndex} viewportHeight={viewportHeight} reservedRows={6 + confirmRows} stretch />
				</box>
			) : (
				<box marginTop={1}>
					<ScrollList items={items} cursor={view.installedIndex} viewportHeight={viewportHeight} reservedRows={6 + confirmRows} />
				</box>
			)}
		</box>
	);
}

/** 安装页·父级：远程搜索框 + repo 列表（find 结果按 owner/repo 去重）。 */
function renderInstallRepoPage(view: SkillsViewState, viewportHeight: number, confirmRows: number, stretchLists: boolean): React.ReactNode {
	const items = view.repos.map((group) => ({
		key: group.repo,
		title: group.repo,
		titleRight: <text fg={colors.muted}>{`命中 ${group.hitCount}`}</text>
	}));

	return (
		<box flexDirection="column" flexGrow={stretchLists ? 1 : 0}>
			<InputBox label="搜索" value={view.query} focused={view.queryFocused} placeholder="输入关键词，Enter 远程搜索 skills.sh" />
			{view.searching ? (
				<box marginTop={1}>
					<text fg={colors.primary}>正在搜索...</text>
				</box>
			) : null}
			{items.length > 0 ? (
				<box marginTop={1} flexGrow={stretchLists ? 1 : 0}>
					<ScrollList items={items} cursor={view.repoIndex} viewportHeight={viewportHeight} reservedRows={6 + confirmRows} stretch={stretchLists} />
				</box>
			) : null}
		</box>
	);
}

/** 安装页·子级：某 repo 下 skill 多选（Space 切换 / Enter 安装选中）。 */
function renderInstallPickPage(view: SkillsViewState, viewportHeight: number, confirmRows: number, stretchLists: boolean): React.ReactNode {
	const repo = view.currentRepo ?? '';
	const items: Array<{
		readonly key: string;
		readonly title: string;
		readonly leading: React.ReactNode;
		readonly body?: React.ReactNode;
		readonly multiLine: boolean;
	}> = view.repoSkills.map((skill) => {
		const picked = view.pickedSkills.includes(skill.name);
		return {
			key: skill.name,
			title: skill.name,
			leading: <Checkbox checked={picked} />,
			body: skill.description ? <text fg={colors.muted}>{skill.description}</text> : undefined,
			multiLine: true
		};
	});

	return (
		<box flexDirection="column" flexGrow={stretchLists ? 1 : 0}>
			<box flexDirection="row" marginBottom={1}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>{repo}</text>
				<text> 下 </text>
				<text fg={colors.primary}>{view.repoSkills.length}</text>
				<text fg={colors.muted}> 个 skill，可多选后安装</text>
			</box>
			{view.loadingRepo ? <Spinner label="正在拉取 repo skill 列表..." /> : null}
			{!view.loadingRepo && items.length > 0 ? (
				<ScrollList items={items} cursor={view.pickIndex} viewportHeight={viewportHeight} reservedRows={6 + confirmRows} emptyText="该 repo 暂无 skill" stretch={stretchLists} />
			) : null}
		</box>
	);
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
				<text fg={value ? undefined : colors.muted}>{shown}</text>
				{focused ? <text fg={colors.primary}>_</text> : null}
			</box>
		</box>
	);
}
