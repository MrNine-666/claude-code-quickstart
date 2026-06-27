import {groupByRepo} from '../core/skills.js';
import type {InstalledSkill, RepoGroup, RepoSkill, SearchSkillResult} from '../core/skills.js';

// Skills 视图纯状态机（design D11/D13；spec skills-tui）。
// 三阶段安装架构（需求③）：列表页（本地过滤 + 已装管理）/ 安装页·父级（find 按 repo 去重）/ 安装页·子级（多选）。
// 只负责 UI 模式/光标/本地过滤/远程查询/多选集合的有界迁移，副作用（CLI 调用）由组件层执行后回填。
// 已安装检测状态由 view-detection runner 单独管理，组件以 props/state 注入，不混入此处。

export type SkillsViewMode =
	| 'list' // 列表页：本地过滤 + 已装列表浏览
	| 'install' // 安装页·父级：远程搜索框 + repo 列表（find 按 owner/repo 去重）
	| 'install-pick' // 安装页·子级：某 repo 下 skill 多选（skills add <repo> --list）
	| 'confirm-install' // 安装确认（多选汇总）
	| 'confirm-uninstall' // 卸载确认（单条）
	| 'busy'; // 安装/更新/卸载进行中（远程搜索/--list 走 inline，不进 busy）

export type InstallTarget = {
	readonly source: string;
	readonly skillName: string;
	readonly displayName: string;
};

export type SkillsViewState = {
	readonly mode: SkillsViewMode;
	// 列表页
	readonly installed: readonly InstalledSkill[];
	readonly installedIndex: number; // 索引 filteredInstalled（过滤后视图）
	readonly filterText: string; // 本地过滤词（大小写不敏感包含匹配 name）
	readonly filterFocused: boolean; // 本地过滤框是否聚焦（Tab 切换；失焦时 u/d/r 快捷键生效）
	// 安装页·父级
	readonly query: string; // 远程搜索词（skills find）
	readonly queryFocused: boolean; // 远程搜索框是否聚焦
	readonly repos: readonly RepoGroup[]; // find 结果按 owner/repo 去重的父级列表
	readonly repoIndex: number; // 父级光标
	readonly searching: boolean; // 远程搜索进行中（inline，不切 busy）
	// 安装页·子级
	readonly currentRepo?: string; // 当前展开的 repo（owner/repo）
	readonly repoSkills: readonly RepoSkill[]; // 当前 repo 的子 skill（--list 结果）
	readonly pickIndex: number; // 子级光标
	readonly pickedSkills: readonly string[]; // 多选集合（skill name）
	readonly loadingRepo: boolean; // --list 加载中（inline）
	// 共用
	readonly errorText?: string;
	readonly progress: readonly string[];
	readonly busyAction?: 'install' | 'update' | 'uninstall';
};

export type SkillsViewAction =
	| {readonly type: 'installed-loaded'; readonly installed: readonly InstalledSkill[]}
	| {readonly type: 'nav-up'}
	| {readonly type: 'nav-down'}
	| {readonly type: 'open-install'} // 列表页 `a` → 安装页·父级
	| {readonly type: 'filter-input'; readonly value: string}
	| {readonly type: 'filter-focus'}
	| {readonly type: 'filter-blur'}
	| {readonly type: 'filter-clear'}
	| {readonly type: 'query-input'; readonly value: string}
	| {readonly type: 'query-focus'}
	| {readonly type: 'query-blur'}
	| {readonly type: 'submit-search'} // 父级 Enter → 远程搜索（inline searching）
	| {readonly type: 'search-done'; readonly results: readonly SearchSkillResult[]}
	| {readonly type: 'search-failed'; readonly error: string; readonly rawSummary?: string}
	| {readonly type: 'select-repo'} // 父级 Enter → 子级 + 触发 --list（组件层异步）
	| {readonly type: 'repo-skills-loaded'; readonly repo: string; readonly skills: readonly RepoSkill[]}
	| {readonly type: 'repo-skills-failed'; readonly error: string; readonly rawSummary?: string}
	| {readonly type: 'toggle-pick'} // 子级 Space → 切换当前项
	| {readonly type: 'toggle-all-picks'} // 子级 a → 全选/取消全选
	| {readonly type: 'confirm-pick'} // 子级 Enter → confirm-install（pickedSkills 非空）
	| {readonly type: 'request-update'}
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm'}
	| {readonly type: 'cancel'}
	| {readonly type: 'progress'; readonly message: string}
	| {readonly type: 'action-done'}
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
		repos: [],
		repoIndex: 0,
		searching: false,
		repoSkills: [],
		pickIndex: 0,
		pickedSkills: [],
		loadingRepo: false,
		progress: []
	};
}

/** 按 filterText 过滤已装列表（大小写不敏感包含匹配 name）。纯函数，列表页与派生共用。 */
export function filterInstalled(installed: readonly InstalledSkill[], filterText: string): readonly InstalledSkill[] {
	const q = filterText.trim().toLowerCase();
	if (!q) {
		return installed;
	}

	return installed.filter(skill => skill.name.toLowerCase().includes(q));
}

/** 列表页当前可见的已装列表（过滤后）。 */
export function filteredInstalled(state: SkillsViewState): readonly InstalledSkill[] {
	return filterInstalled(state.installed, state.filterText);
}

/** 远程搜索词非空才触发 skills find（对齐 design D11）。 */
export function shouldRunSearch(state: SkillsViewState): boolean {
	return state.query.trim().length > 0;
}

/** 列表页有任意已装 skill 时允许 update（更新全部，不受过滤影响）。 */
export function canManageInstalled(state: SkillsViewState): boolean {
	return state.installed.length > 0;
}

/** 列表页当前光标已装 skill（基于过滤后视图）。 */
export function selectedInstalled(state: SkillsViewState): InstalledSkill | undefined {
	return filteredInstalled(state)[state.installedIndex];
}

/** 安装页·父级当前光标 repo。 */
export function selectedRepo(state: SkillsViewState): RepoGroup | undefined {
	return state.repos[state.repoIndex];
}

/** 安装页·子级当前光标 skill。 */
export function selectedRepoSkill(state: SkillsViewState): RepoSkill | undefined {
	return state.repoSkills[state.pickIndex];
}

/** 安装确认目标（子级多选汇总为 InstallTarget[]）。仅在 currentRepo 存在时有意义。 */
export function installTargets(state: SkillsViewState): readonly InstallTarget[] {
	if (!state.currentRepo) {
		return [];
	}

	const repo = state.currentRepo;
	return state.pickedSkills.map(name => ({
		source: repo,
		skillName: name,
		displayName: `${repo}@${name}`
	}));
}

/** 安装页·子级可否确认安装（至少选一个 skill）。 */
export function canConfirmPick(state: SkillsViewState): boolean {
	return state.mode === 'install-pick' && state.pickedSkills.length > 0;
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
				repos: groupByRepo(action.results),
				repoIndex: 0,
				queryFocused: false,
				// 搜索完成后焦点直接切到 repo 列表；新搜索重置子级（旧 repo/skills/多选全部作废）
				currentRepo: undefined,
				repoSkills: [],
				pickIndex: 0,
				pickedSkills: [],
				loadingRepo: false,
				errorText: undefined
			};

		case 'search-failed':
			return {
				...state,
				searching: false,
				repos: [],
				repoIndex: 0,
				errorText: action.rawSummary ? `${action.error}\n${action.rawSummary}` : action.error
			};

		case 'select-repo': {
			if (state.mode !== 'install') {
				return state;
			}

			const repo = selectedRepo(state);
			if (!repo) {
				return {...state, errorText: '没有可选的 repo'};
			}

			return {
				...state,
				mode: 'install-pick',
				currentRepo: repo.repo,
				loadingRepo: true,
				repoSkills: [],
				pickIndex: 0,
				pickedSkills: [],
				errorText: undefined
			};
		}

		case 'repo-skills-loaded':
			// 防竞态：仅当 repo 与当前一致才回填（用户可能已 Esc 回父级改选别的 repo）。
			if (state.mode !== 'install-pick' || state.currentRepo !== action.repo) {
				return state;
			}

			return {
				...state,
				loadingRepo: false,
				repoSkills: action.skills,
				pickIndex: 0,
				pickedSkills: [],
				errorText: action.skills.length === 0 ? '该 repo 暂无 skill' : undefined
			};

		case 'repo-skills-failed':
			if (state.mode !== 'install-pick') {
				return state;
			}

			return {
				...state,
				loadingRepo: false,
				errorText: action.rawSummary ? `${action.error}\n${action.rawSummary}` : action.error
			};

		case 'toggle-pick': {
			if (state.mode !== 'install-pick') {
				return state;
			}

			const skill = selectedRepoSkill(state);
			if (!skill) {
				return state;
			}

			const picked = state.pickedSkills.includes(skill.name)
				? state.pickedSkills.filter(name => name !== skill.name)
				: [...state.pickedSkills, skill.name];
			return {...state, pickedSkills: picked};
		}

		case 'toggle-all-picks': {
			if (state.mode !== 'install-pick') {
				return state;
			}

			if (state.repoSkills.length === 0) {
				return state;
			}

			const allNames = state.repoSkills.map(skill => skill.name);
			const allPicked = allNames.every(name => state.pickedSkills.includes(name));
			return {...state, pickedSkills: allPicked ? [] : allNames};
		}

		case 'confirm-pick':
			if (state.mode !== 'install-pick') {
				return state;
			}

			return state.pickedSkills.length > 0
				? {...state, mode: 'confirm-install', errorText: undefined}
				: {...state, errorText: '请至少选择一个 skill'};

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
				progress: state.progress
			};

		case 'action-failed':
			return {
				...state,
				// 安装失败回子级多选页（保留 currentRepo/pickedSkills 供重试），其余回列表页。
				mode: state.busyAction === 'install' ? 'install-pick' : 'list',
				busyAction: undefined,
				errorText: action.error
			};
	}
}

function navigate(state: SkillsViewState, delta: number): SkillsViewState {
	if (state.mode === 'install') {
		return {...state, repoIndex: step(state.repoIndex, delta, state.repos.length)};
	}

	if (state.mode === 'install-pick') {
		return {...state, pickIndex: step(state.pickIndex, delta, state.repoSkills.length)};
	}

	if (state.mode === 'list') {
		return {...state, installedIndex: step(state.installedIndex, delta, filteredInstalled(state).length)};
	}

	return state;
}

function cancel(state: SkillsViewState): SkillsViewState {
	switch (state.mode) {
		case 'confirm-install':
			// 回子级多选（保留已选，可调整后重试）。
			return {...state, mode: 'install-pick'};
		case 'confirm-uninstall':
			return {...state, mode: 'list'};
		case 'install-pick':
			// 回父级，清空子级（旧 repo 的 skills/多选作废）。
			return {
				...state,
				mode: 'install',
				currentRepo: undefined,
				repoSkills: [],
				pickIndex: 0,
				pickedSkills: [],
				loadingRepo: false,
				errorText: undefined
			};
		case 'install':
			// 安装页 Esc → 回列表页（放弃当前搜索词/结果）。
			return {...state, mode: 'list', queryFocused: false, errorText: undefined};
		default:
			return state;
	}
}

/** 卸载目标：列表页当前光标项（单条，已去多选）。 */
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
