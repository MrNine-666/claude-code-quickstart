import type {SearchSkillResult, SkillSharedRow} from '../core/skills.js';
import {AGENT_CONTEXT_ORDER, type AgentContext} from './manage-state.js';

// Skills 视图纯状态机（design D11/D13；spec skills-tui / skills-multitool / skills-tui 共享投影）。
// 共享本体 + 双侧注入架构：列表页数据源为 SkillSharedRow（双态徽章）；安装页选目标 Modal（Codex 只读恒勾）。
// 只负责 UI 模式/光标/本地过滤/远程查询/安装草稿的有界迁移，副作用（CLI 调用）由组件层执行后回填。
// 已安装检测状态由 view-detection runner 单独管理（无 --agent 全量扫），组件以 props/state 注入，不混入此处。

export type SkillsViewMode =
	| 'list' // 列表页：本地过滤 + 已装双态列表浏览
	| 'install' // 安装页：远程搜索框 + 扁平 skill 列表（默认 TOP 20）
	| 'select-install-target' // 安装目标 Modal（安装页选中 skill 后 Enter）：Claude Code 可切 / Codex 只读恒勾
	| 'manage-inject' // 管理安装 Modal（列表行 Enter）：切 Claude Code symlink / Codex 只读随本体
	| 'confirm-uninstall' // 全量卸载确认（单条，两侧 + 本体）
	| 'busy'; // 安装/更新/卸载进行中（远程搜索走 inline，不进 busy）

// 安装/管理草稿：双侧勾选态。Codex 恒 true（只读，装了必写本体、直读即可用，无法不装）；仅 Claude Code 可切。
export type InstallDraft = Readonly<Record<AgentContext, boolean>>;

// 安装页默认草稿：两侧都装（cc symlink + cx 本体）。
const DEFAULT_INSTALL_DRAFT: InstallDraft = {cc: true, cx: true};

export type SkillsViewState = {
	readonly mode: SkillsViewMode;
	// 列表页（共享投影行，一行一 skill name）
	readonly installed: readonly SkillSharedRow[];
	readonly installedIndex: number; // 索引 filteredInstalled（过滤后视图）
	readonly filterText: string; // 本地过滤词（大小写不敏感包含匹配 name）
	readonly filterFocused: boolean; // 本地过滤框是否聚焦（Tab 切换；失焦时 u/d/r 快捷键生效）
	// 安装页
	readonly query: string; // 远程搜索词（skills find <query>）
	readonly queryFocused: boolean; // 远程搜索框是否聚焦
	readonly results: readonly SearchSkillResult[]; // 扁平 skill 列表（搜索结果）
	readonly resultIndex: number; // 安装页光标
	readonly searching: boolean; // 远程搜索进行中（inline，不切 busy）
	// 目标 / 管理 Modal（select-install-target / manage-inject 共用）
	readonly installDraft: InstallDraft; // 双侧草稿（cx 恒 true）
	readonly targetIndex: number; // Modal 内选中侧索引（loop）
	// 共用
	readonly errorText?: string;
	readonly progress: readonly string[];
	readonly busyAction?: 'install' | 'update' | 'uninstall';
};

export type SkillsViewAction =
	| {readonly type: 'installed-loaded'; readonly installed: readonly SkillSharedRow[]}
	| {readonly type: 'nav-up'}
	| {readonly type: 'nav-down'}
	| {readonly type: 'open-install'} // 列表页 `a` → 安装页（触发自动加载热门）
	| {readonly type: 'filter-input'; readonly value: string}
	| {readonly type: 'filter-focus'}
	| {readonly type: 'filter-blur'}
	| {readonly type: 'filter-clear'}
	| {readonly type: 'query-input'; readonly value: string}
	| {readonly type: 'query-focus'}
	| {readonly type: 'query-blur'}
	| {readonly type: 'submit-search'} // 搜索框 Enter → 远程搜索（inline searching）
	| {readonly type: 'search-done'; readonly results: readonly SearchSkillResult[]}
	| {readonly type: 'search-failed'; readonly error: string; readonly rawSummary?: string}
	| {readonly type: 'select-skill'} // 安装页 Enter → select-install-target Modal
	| {readonly type: 'manage-inject'} // 列表行 Enter → manage-inject Modal
	| {readonly type: 'install-target-nav'; readonly delta: number} // Modal ↑/↓ 选侧（loop）
	| {readonly type: 'install-target-toggle'} // Modal 空格切草稿（仅 cc 可切，cx no-op）
	| {readonly type: 'request-update'}
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm'}
	| {readonly type: 'cancel'}
	| {readonly type: 'progress'; readonly message: string}
	| {readonly type: 'action-done'}
	| {readonly type: 'action-uninstall-done'; readonly names: readonly string[]}
	| {readonly type: 'action-failed'; readonly error: string};

export function createInitialSkillsViewState(): SkillsViewState {
	return {
		mode: 'list',
		installed: [],
		installedIndex: 0,
		filterText: '',
		filterFocused: false,
		query: '',
		queryFocused: false,
		results: [],
		resultIndex: 0,
		searching: false,
		installDraft: DEFAULT_INSTALL_DRAFT,
		targetIndex: 0,
		progress: []
	};
}

/** 按 filterText 过滤已装列表（大小写不敏感包含匹配 name）。纯函数，列表页与派生共用。 */
export function filterInstalled(installed: readonly SkillSharedRow[], filterText: string): readonly SkillSharedRow[] {
	const q = filterText.trim().toLowerCase();
	if (!q) {
		return installed;
	}

	return installed.filter(skill => skill.name.toLowerCase().includes(q));
}

/** 列表页当前可见的已装列表（过滤后）。 */
export function filteredInstalled(state: SkillsViewState): readonly SkillSharedRow[] {
	return filterInstalled(state.installed, state.filterText);
}

/** 远程搜索词非空才触发 skills find <query>（对齐 design D11）。 */
export function shouldRunSearch(state: SkillsViewState): boolean {
	return state.query.trim().length > 0;
}

/** 列表页有任意已装 skill 时允许 update（更新全部，不受过滤影响）。 */
export function canManageInstalled(state: SkillsViewState): boolean {
	return state.installed.length > 0;
}

/** 列表页当前光标已装 skill（基于过滤后视图）。 */
export function selectedInstalled(state: SkillsViewState): SkillSharedRow | undefined {
	return filteredInstalled(state)[state.installedIndex];
}

/** 安装页当前光标 skill。 */
export function selectedResult(state: SkillsViewState): SearchSkillResult | undefined {
	return state.results[state.resultIndex];
}

/** 从 `owner/repo@skill` 形态提取展示用 skill 名（@ 后部分）；无 @ 返回原 name。
 *  安装页列表 title 与确认弹窗共用，避免 `owner/repo` 在 name 与 source 中重复显示。 */
export function displaySkillName(name: string): string {
	if (!name.includes('@')) {
		return name;
	}

	return name.split('@')[1] || name;
}

export function reduceSkillsViewState(state: SkillsViewState, action: SkillsViewAction): SkillsViewState {
	switch (action.type) {
		case 'installed-loaded':
			return {
				...state,
				installed: action.installed,
				installedIndex: clamp(state.installedIndex, filterInstalled(action.installed, state.filterText).length)
			};

		case 'nav-up':
			return navigate(state, -1);

		case 'nav-down':
			return navigate(state, 1);

		case 'open-install':
			return {...state, mode: 'install', queryFocused: true, errorText: undefined};

		case 'filter-input':
			return state.mode === 'list'
				? {...state, filterText: action.value, installedIndex: 0}
				: state;

		case 'filter-focus':
			return state.mode === 'list' ? {...state, filterFocused: true} : state;

		case 'filter-blur':
			return state.mode === 'list' ? {...state, filterFocused: false} : state;

		case 'filter-clear':
			return {...state, filterText: '', filterFocused: false, installedIndex: 0};

		case 'query-input':
			return state.mode === 'install' ? {...state, query: action.value} : state;

		case 'query-focus':
			return state.mode === 'install' ? {...state, queryFocused: true} : state;

		case 'query-blur':
			return state.mode === 'install' ? {...state, queryFocused: false} : state;

		case 'submit-search':
			if (state.mode !== 'install' || !shouldRunSearch(state)) {
				return {...state, errorText: '请输入搜索关键词'};
			}

			return {...state, searching: true, errorText: undefined};

		case 'search-done':
			return {
				...state,
				searching: false,
				results: action.results,
				resultIndex: 0,
				queryFocused: false,
				errorText: undefined
			};

		case 'search-failed':
			return {
				...state,
				searching: false,
				results: [],
				resultIndex: 0,
				errorText: action.rawSummary ? `${action.error}\n${action.rawSummary}` : action.error
			};

		case 'select-skill': {
			if (state.mode !== 'install') {
				return state;
			}

			const skill = selectedResult(state);
			if (!skill) {
				return {...state, errorText: '没有可选的 skill'};
			}

			// 安装页 Enter → 安装目标 Modal，草稿预置两侧勾选（cx 恒 true 只读）。
			return {...state, mode: 'select-install-target', installDraft: DEFAULT_INSTALL_DRAFT, targetIndex: 0, errorText: undefined};
		}

		case 'manage-inject': {
			if (state.mode !== 'list') {
				return state;
			}

			// 列表行 Enter → 管理安装 Modal，草稿预置当前安装态（cc=claudeInjected；cx 只读，如实随本体 codexAvailable）。
			// 注意：安装场景（select-install-target）cx 恒 true（装必写本体）；管理场景 cx 须如实反映当前本体态，
			// 否则仅装 Claude Code 侧（codexAvailable=false）的 skill 会在列表显「○ 未安装」而 Modal 显「● 已安装」自相矛盾。
			const current = selectedInstalled(state);
			if (!current) {
				return {...state, errorText: '当前没有可管理的 Skill'};
			}

			return {
				...state,
				mode: 'manage-inject',
				installDraft: {cc: current.claudeInjected, cx: current.codexAvailable},
				targetIndex: 0,
				errorText: undefined
			};
		}

		case 'install-target-nav': {
			if (state.mode !== 'select-install-target' && state.mode !== 'manage-inject') {
				return state;
			}

			// ↑/↓ 选侧首尾相接（loop）。
			const count = AGENT_CONTEXT_ORDER.length;
			return {...state, targetIndex: (state.targetIndex + action.delta + count) % count};
		}

		case 'install-target-toggle': {
			if (state.mode !== 'select-install-target' && state.mode !== 'manage-inject') {
				return state;
			}

			// 仅 Claude Code（cc）可切；Codex（cx）只读恒 true，toggle 为 no-op。
			const target = AGENT_CONTEXT_ORDER[state.targetIndex] ?? 'cc';
			if (target === 'cx') {
				return state;
			}

			return {...state, installDraft: {...state.installDraft, [target]: !state.installDraft[target]}};
		}

		case 'request-update':
			return canManageInstalled(state)
				? {...state, mode: 'busy', busyAction: 'update', progress: [], errorText: undefined}
				: {...state, errorText: '没有可更新的 Skill'};

		case 'request-uninstall': {
			const names = uninstallTargets(state);
			return names.length > 0
				? {...state, mode: 'confirm-uninstall', errorText: undefined}
				: {...state, errorText: '当前没有可卸载的 Skill'};
		}

		case 'confirm':
			// select-install-target / manage-inject 的提交由组件层执行（按草稿 diff），reducer 只切 busy。
			if (state.mode === 'select-install-target' || state.mode === 'manage-inject') {
				return {...state, mode: 'busy', busyAction: 'install', progress: [], errorText: undefined};
			}

			if (state.mode === 'confirm-uninstall') {
				return {...state, mode: 'busy', busyAction: 'uninstall', progress: [], errorText: undefined};
			}

			return state;

		case 'cancel':
			return cancel(state);

		case 'progress':
			return {...state, progress: [...state.progress, action.message].slice(-8)};

		case 'action-done':
			return {
				...createInitialSkillsViewState(),
				installed: state.installed,
				progress: state.progress
			};

		case 'action-uninstall-done': {
			const remaining = state.installed.filter(s => !action.names.includes(s.name));
			return {
				...createInitialSkillsViewState(),
				installed: remaining,
				installedIndex: clamp(state.installedIndex, filterInstalled(remaining, state.filterText).length),
				progress: state.progress
			};
		}

		case 'action-failed':
			return {
				...state,
				mode: state.busyAction === 'install' ? 'install' : 'list',
				busyAction: undefined,
				errorText: action.error
			};
	}
}

function navigate(state: SkillsViewState, delta: number): SkillsViewState {
	if (state.mode === 'install') {
		return {...state, resultIndex: step(state.resultIndex, delta, state.results.length)};
	}

	if (state.mode === 'list') {
		return {...state, installedIndex: step(state.installedIndex, delta, filteredInstalled(state).length)};
	}

	return state;
}

function cancel(state: SkillsViewState): SkillsViewState {
	switch (state.mode) {
		case 'select-install-target':
			// 安装目标 Modal Esc → 回安装页（保留搜索结果）
			return {...state, mode: 'install'};
		case 'manage-inject':
			// 管理安装 Modal Esc → 回列表页，无写盘
			return {...state, mode: 'list'};
		case 'confirm-uninstall':
			return {...state, mode: 'list'};
		case 'install':
			// 安装页 Esc → 回列表页（放弃当前搜索词/结果）
			return {...state, mode: 'list', queryFocused: false, errorText: undefined};
		default:
			return state;
	}
}

/** 卸载目标：列表页当前光标项（单条）。 */
export function uninstallTargets(state: SkillsViewState): readonly string[] {
	const current = selectedInstalled(state);
	return current ? [current.name] : [];
}

function step(index: number, delta: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	return Math.min(Math.max(index + delta, 0), length - 1);
}

function clamp(index: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	return Math.min(Math.max(index, 0), length - 1);
}
