import type {InstalledSkill, SearchSkillResult} from '../core/skills.js';

// Skills 视图纯状态机（design D11/D13；spec skills-tui）。
// 只负责 UI 模式/光标/选择/查询/通知的有界迁移，副作用（CLI 调用）由组件层执行后回填。
// 已安装检测状态由 view-detection runner 单独管理，组件以 props/state 注入，不混入此处。

export type SkillsViewMode =
	| 'list' // 已安装列表浏览
	| 'search-input' // 搜索框输入
	| 'search-results' // 搜索结果浏览
	| 'confirm-install' // 安装确认
	| 'confirm-uninstall' // 卸载确认
	| 'busy'; // 异步操作进行中

export type SkillsViewState = {
	readonly mode: SkillsViewMode;
	readonly installed: readonly InstalledSkill[];
	readonly installedIndex: number;
	readonly selectedNames: readonly string[];
	readonly query: string;
	readonly results: readonly SearchSkillResult[];
	readonly resultIndex: number;
	readonly notice?: string;
	readonly errorText?: string;
	readonly progress: readonly string[];
	readonly busyAction?: 'search' | 'install' | 'update' | 'uninstall';
};

export type SkillsViewAction =
	| {readonly type: 'installed-loaded'; readonly installed: readonly InstalledSkill[]}
	| {readonly type: 'nav-up'}
	| {readonly type: 'nav-down'}
	| {readonly type: 'toggle-select'}
	| {readonly type: 'open-search'}
	| {readonly type: 'query-input'; readonly value: string}
	| {readonly type: 'submit-search'}
	| {readonly type: 'search-done'; readonly results: readonly SearchSkillResult[]}
	| {readonly type: 'search-failed'; readonly error: string; readonly rawSummary?: string}
	| {readonly type: 'request-install'}
	| {readonly type: 'request-update'}
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm'}
	| {readonly type: 'cancel'}
	| {readonly type: 'progress'; readonly message: string}
	| {readonly type: 'action-done'; readonly summary: string}
	| {readonly type: 'action-failed'; readonly error: string};

export function createInitialSkillsViewState(): SkillsViewState {
	return {
		mode: 'list',
		installed: [],
		installedIndex: 0,
		selectedNames: [],
		query: '',
		results: [],
		resultIndex: 0,
		progress: []
	};
}

/** 当前查询是否应触发 skills find（空/纯空白不触发，对齐 design D11）。 */
export function shouldRunSearch(state: SkillsViewState): boolean {
	return state.query.trim().length > 0;
}

/** 列表为空时禁用 update / uninstall（spec skills-tui "No installed skills"）。 */
export function canManageInstalled(state: SkillsViewState): boolean {
	return state.installed.length > 0;
}

export function selectedInstalled(state: SkillsViewState): InstalledSkill | undefined {
	return state.installed[state.installedIndex];
}

export function selectedResult(state: SkillsViewState): SearchSkillResult | undefined {
	return state.results[state.resultIndex];
}

export function reduceSkillsViewState(state: SkillsViewState, action: SkillsViewAction): SkillsViewState {
	switch (action.type) {
		case 'installed-loaded':
			return {
				...state,
				installed: action.installed,
				installedIndex: clamp(state.installedIndex, action.installed.length),
				selectedNames: state.selectedNames.filter(name => action.installed.some(item => item.name === name))
			};

		case 'nav-up':
			return navigate(state, -1);

		case 'nav-down':
			return navigate(state, 1);

		case 'toggle-select':
			return toggleSelect(state);

		case 'open-search':
			return {...state, mode: 'search-input', query: '', errorText: undefined, notice: undefined};

		case 'query-input':
			return state.mode === 'search-input' ? {...state, query: action.value} : state;

		case 'submit-search':
			if (state.mode !== 'search-input' || !shouldRunSearch(state)) {
				return {...state, errorText: '请输入搜索关键词'};
			}

			return {...state, mode: 'busy', busyAction: 'search', errorText: undefined, progress: []};

		case 'search-done':
			return {
				...state,
				mode: 'search-results',
				busyAction: undefined,
				results: action.results,
				resultIndex: 0,
				notice: action.results.length === 0 ? '没有匹配的 Skill' : undefined,
				errorText: undefined
			};

		case 'search-failed':
			return {
				...state,
				mode: 'search-input',
				busyAction: undefined,
				results: [],
				errorText: action.error,
				notice: action.rawSummary
			};

		case 'request-install':
			return selectedResult(state) ? {...state, mode: 'confirm-install', errorText: undefined} : state;

		case 'request-update':
			return canManageInstalled(state)
				? {...state, mode: 'busy', busyAction: 'update', progress: [], errorText: undefined}
				: {...state, errorText: '没有可更新的 Skill'};

		case 'request-uninstall': {
			const names = uninstallTargets(state);
			return names.length > 0
				? {...state, mode: 'confirm-uninstall', errorText: undefined}
				: {...state, errorText: '请先选择要卸载的 Skill'};
		}

		case 'confirm':
			if (state.mode === 'confirm-install') {
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
				notice: action.summary,
				progress: state.progress
			};

		case 'action-failed':
			return {
				...state,
				mode: state.busyAction === 'search' ? 'search-input' : 'list',
				busyAction: undefined,
				errorText: action.error
			};
	}
}

function navigate(state: SkillsViewState, delta: number): SkillsViewState {
	if (state.mode === 'search-results') {
		return {...state, resultIndex: step(state.resultIndex, delta, state.results.length)};
	}

	if (state.mode === 'list') {
		return {...state, installedIndex: step(state.installedIndex, delta, state.installed.length)};
	}

	return state;
}

function toggleSelect(state: SkillsViewState): SkillsViewState {
	if (state.mode !== 'list') {
		return state;
	}

	const current = selectedInstalled(state);
	if (!current) {
		return state;
	}

	const exists = state.selectedNames.includes(current.name);
	return {
		...state,
		selectedNames: exists
			? state.selectedNames.filter(name => name !== current.name)
			: [...state.selectedNames, current.name]
	};
}

function cancel(state: SkillsViewState): SkillsViewState {
	switch (state.mode) {
		case 'confirm-install':
			return {...state, mode: 'search-results'};
		case 'confirm-uninstall':
			return {...state, mode: 'list'};
		case 'search-results':
		case 'search-input':
			return {...state, mode: 'list', errorText: undefined};
		default:
			return state;
	}
}

/** 卸载目标：多选优先，无多选时回退到当前光标项。 */
export function uninstallTargets(state: SkillsViewState): readonly string[] {
	if (state.selectedNames.length > 0) {
		return state.selectedNames;
	}

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
