import {
	searchSkillIdentity,
	skillSourcesEquivalent,
	type SearchSkillIdentity,
	type SearchSkillResult,
	type SkillSharedRow
} from '../core/skills.js';
import {AGENT_CONTEXT_ORDER, type AgentContext} from './manage-state.js';
import {targetTopologyOfDraft, topologyOfInspection} from '../core/skills-storage.js';

// Skills 视图纯状态机（design D11/D13；spec skills-tui / skills-multitool / skills-tui 共享投影）。
// 单实体 C/X/B 架构：列表页数据源为 SkillSharedRow（双态徽章）；新安装 Codex 必选，存量管理两侧均可编辑。
// 只负责 UI 模式/光标/本地过滤/远程查询/安装草稿的有界迁移，副作用（CLI 调用）由组件层执行后回填。
// 已安装检测状态由 view-detection runner 单独管理（无 --agent 全量扫），组件以 props/state 注入，不混入此处。

export type SkillsViewMode =
	| 'list' // 列表页：本地过滤 + 已装双态列表浏览
	| 'install' // 安装页：远程搜索框 + 扁平 skill 列表（默认 TOP 20）
	| 'select-install-target' // 新安装目标 Modal：Claude Code 可切 / Codex 必选
	| 'manage-inject' // 存量管理 Modal：编辑 C/X/B 目标草稿
	| 'confirm-topology-change' // C/X/B 任意非 no-op 切换的统一强确认
	| 'confirm-source-replacement' // 同名不同源覆盖 canonical/lock 的强确认
	| 'confirm-uninstall' // 全量卸载确认（单条，两侧 + 本体）
	| 'busy'; // 安装/更新/卸载进行中（远程搜索走 inline，不进 busy）

// 安装/管理草稿：新安装 Codex 恒 true；存量管理允许三种非空组合映射 C/X/B。
export type InstallDraft = Readonly<Record<AgentContext, boolean>>;

export type SearchInstallStatus =
	| 'available'
	| 'installed'
	| 'claude-only'
	| 'codex-only'
	| 'shared-copy'
	| 'source-replacement'
	| 'name-occupied'
	| 'selection-conflict';

export type SearchInstallItem = {
	readonly result: SearchSkillResult;
	readonly identity?: SearchSkillIdentity;
	readonly status: SearchInstallStatus;
	readonly selected: boolean;
	readonly selectable: boolean;
};

export type SourceReplacementItem = {
	readonly result: SearchSkillResult;
	readonly identity: SearchSkillIdentity;
	readonly installed: SkillSharedRow;
};

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
	readonly pickedResultKeys: readonly string[]; // 当前扁平结果中的显式多选
	readonly pendingInstallKeys: readonly string[]; // Modal / busy 期间不可变提交快照
	// 目标 / 管理 Modal（select-install-target / manage-inject 共用）
	readonly installDraft: InstallDraft;
	readonly targetIndex: number; // Modal 内选中侧索引（loop）
	// 共用
	readonly errorText?: string;
	readonly progress: readonly string[];
	readonly busyAction?: 'install' | 'update' | 'uninstall';
	readonly busyReturnMode?: 'list' | 'install'; // busy 结束后返回的底页（区分新装与管理安装）
	readonly batchStage?: 'executing' | 'reconciling';
	readonly batchSummary?: string;
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
	| {readonly type: 'toggle-result'} // 安装页 Space：只切当前可安装项
	| {readonly type: 'select-all-results'} // 安装页上下文全选：只选可安装且名称唯一的项
	| {readonly type: 'select-skill'} // 安装页 Enter → select-install-target Modal
	| {readonly type: 'manage-inject'} // 列表行 Enter → manage-inject Modal
	| {readonly type: 'request-topology-change'} // 管理草稿提交 → 统一拓扑确认/no-op/零目标阻断
	| {readonly type: 'request-source-replacement'} // 安装目标提交且含 replacement → 强确认
	| {readonly type: 'install-target-nav'; readonly delta: number} // Modal ↑/↓ 选侧（loop）
	| {readonly type: 'install-target-toggle'} // Modal 空格切草稿（仅 cc 可切，cx no-op）
	| {readonly type: 'request-update'}
	| {readonly type: 'request-update-one'} // 列表页 U → 更新当前光标单个 skill
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm'}
	| {readonly type: 'cancel'}
	| {readonly type: 'progress'; readonly message: string}
	| {readonly type: 'install-execution-done'}
	| {readonly type: 'install-reconciled'; readonly installed: readonly SkillSharedRow[]; readonly confirmedKeys?: readonly string[]; readonly error?: string}
	| {readonly type: 'install-reconcile-failed'; readonly error: string}
	| {readonly type: 'lifecycle-reconciled'; readonly installed: readonly SkillSharedRow[]; readonly error?: string}
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
		pickedResultKeys: [],
		pendingInstallKeys: [],
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

/** 安装页扁平结果投影：复用全局安装事实与显式选择，集中判定已安装/同名冲突/可选性。 */
export function searchInstallItems(state: SkillsViewState): readonly SearchInstallItem[] {
	const installedByName = new Map(state.installed.map(skill => [skill.name, skill]));
	const pickedKeys = new Set(state.pickedResultKeys);
	const pickedNames = new Set<string>();
	for (const result of state.results) {
		const identity = searchSkillIdentity(result);
		if (identity && pickedKeys.has(identity.key)) {
			pickedNames.add(identity.skillName);
		}
	}

	return state.results.map(result => {
		const identity = searchSkillIdentity(result);
		const selected = Boolean(identity && pickedKeys.has(identity.key));
		if (!identity) {
			return {result, status: 'name-occupied', selected: false, selectable: false};
		}

		if (!selected && pickedNames.has(identity.skillName)) {
			return {result, identity, status: 'selection-conflict', selected: false, selectable: false};
		}

		const installed = installedByName.get(identity.skillName);
		if (installed) {
			const sourceMismatch = Boolean(installed.source && !skillSourcesEquivalent(installed.source, identity.source));
			const storage = installed.storage;
			const replacementSafe = Boolean(storage && !['invalid', 'invalid-link', 'conflict', 'missing'].includes(storage.kind));
			if (sourceMismatch && replacementSafe) {
				return {result, identity, status: 'source-replacement', selected, selectable: true};
			}

			return {
				result,
				identity,
				status: sourceMismatch ? 'name-occupied' : installedStatus(installed),
				selected,
				selectable: false
			};
		}

		return {result, identity, status: 'available', selected, selectable: true};
	});
}

function installedStatus(skill: SkillSharedRow): SearchInstallStatus {
	switch (skill.storage?.kind) {
		case 'claude-only':
			return 'claude-only';
		case 'canonical-only':
			return 'codex-only';
		case 'shared-copy':
			return 'shared-copy';
		default:
			return 'installed';
	}
}

/** 当前显式选择，始终按扁平结果原顺序返回。 */
export function selectedSearchResults(state: SkillsViewState): readonly SearchSkillResult[] {
	const picked = new Set(state.pickedResultKeys);
	return state.results.filter(result => {
		const identity = searchSkillIdentity(result);
		return Boolean(identity && picked.has(identity.key));
	});
}

/** Modal / busy 提交快照，始终按扁平结果原顺序返回。 */
export function pendingInstallResults(state: SkillsViewState): readonly SearchSkillResult[] {
	const pending = new Set(state.pendingInstallKeys);
	return state.results.filter(result => {
		const identity = searchSkillIdentity(result);
		return Boolean(identity && pending.has(identity.key));
	});
}

/** 当前提交快照中可证明的同名异来源项，供强确认和 replacement service 复用。 */
export function pendingSourceReplacements(state: SkillsViewState): readonly SourceReplacementItem[] {
	const pending = new Set(state.pendingInstallKeys);
	const installedByName = new Map(state.installed.map(skill => [skill.name, skill]));
	return state.results.flatMap(result => {
		const identity = searchSkillIdentity(result);
		if (!identity || !pending.has(identity.key)) {
			return [];
		}

		const installed = installedByName.get(identity.skillName);
		return installed?.source && !skillSourcesEquivalent(installed.source, identity.source)
			? [{result, identity, installed}]
			: [];
	});
}

/** 从 `owner/repo@skill` 形态提取展示用 skill 名（@ 后部分）；无 @ 返回原 name。
 *  安装页列表 title 与确认弹窗共用，避免 `owner/repo` 在 name 与 source 中重复显示。 */
export function displaySkillName(name: string): string {
	if (!name.includes('@')) {
		return name;
	}

	return name.split('@')[1] || name;
}

function isRecoverableStorageKind(kind: NonNullable<SkillSharedRow['storage']>['kind'] | undefined): boolean {
	return kind === 'claude-only' || kind === 'canonical-only' || kind === 'shared-symlink' || kind === 'shared-copy';
}

export function reduceSkillsViewState(state: SkillsViewState, action: SkillsViewAction): SkillsViewState {
	switch (action.type) {
		case 'installed-loaded':
			return {
				...state,
				installed: action.installed,
				pickedResultKeys: removeInstalledPickedKeys(state, action.installed),
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

			return {
				...state,
				searching: true,
				pickedResultKeys: [],
				pendingInstallKeys: [],
				batchSummary: undefined,
				errorText: undefined
			};

		case 'search-done':
			return {
				...state,
				searching: false,
				results: action.results,
				resultIndex: 0,
				pickedResultKeys: [],
				pendingInstallKeys: [],
				queryFocused: false,
				batchSummary: undefined,
				errorText: undefined
			};

		case 'search-failed':
			return {
				...state,
				searching: false,
				results: [],
				resultIndex: 0,
				pickedResultKeys: [],
				pendingInstallKeys: [],
				errorText: action.rawSummary ? `${action.error}\n${action.rawSummary}` : action.error
			};

		case 'toggle-result':
			return toggleCurrentResult(state);

		case 'select-all-results':
			return state.mode === 'install'
				? {...state, pickedResultKeys: selectableResultKeys(state), errorText: undefined}
				: state;

		case 'select-skill': {
			if (state.mode !== 'install') {
				return state;
			}

			const explicitKeys = searchInstallItems(state)
				.filter(item => item.selected && item.selectable && item.identity)
				.map(item => item.identity!.key);
			const current = searchInstallItems(state)[state.resultIndex];
			const pendingInstallKeys = explicitKeys.length > 0
				? explicitKeys
				: current?.selectable && current.identity
					? [current.identity.key]
					: [];
			if (pendingInstallKeys.length === 0) {
				return {...state, errorText: '没有可选的 skill'};
			}

			// 安装页 Enter → 安装目标 Modal，草稿预置两侧勾选（cx 恒 true 只读）。
			return {
				...state,
				mode: 'select-install-target',
				pendingInstallKeys,
				installDraft: DEFAULT_INSTALL_DRAFT,
				targetIndex: 0,
				batchSummary: undefined,
				errorText: undefined
			};
		}

		case 'manage-inject': {
			if (state.mode !== 'list') {
				return state;
			}

			// 列表行 Enter → 管理安装 Modal，草稿严格按实时 C/X 路径事实初始化。
			const current = selectedInstalled(state);
			if (!current) {
				return {...state, errorText: '当前没有可管理的 Skill'};
			}

			return {
				...state,
				mode: 'manage-inject',
				installDraft: {
					cc: current.storage?.claudeValid ?? current.claudeInjected,
					cx: current.storage?.canonicalValid ?? current.codexAvailable
				},
				targetIndex: 0,
				errorText: undefined
			};
		}

		case 'request-topology-change': {
			const current = selectedInstalled(state);
			if (state.mode !== 'manage-inject' || !current?.storage) {
				return {...state, errorText: '当前 Skill 缺少可验证的存储事实'};
			}

			if (!isRecoverableStorageKind(current.storage.kind)) {
				return {...state, errorText: current.storage.error ?? '当前 Skill 存储异常，不能自动切换'};
			}

			const target = targetTopologyOfDraft(state.installDraft);
			if (target === 'empty') {
				return {...state, errorText: '至少保留一个安装目标；如需全部删除请取消后按 d 卸载'};
			}

			const currentTopology = topologyOfInspection(current.storage);
			if (currentTopology === target) {
				return {...state, mode: 'list', errorText: undefined};
			}

			return {...state, mode: 'confirm-topology-change', errorText: undefined};
		}

		case 'request-source-replacement':
			return state.mode === 'select-install-target' && pendingSourceReplacements(state).length > 0
				? {...state, mode: 'confirm-source-replacement', errorText: undefined}
				: {...state, errorText: '当前批次没有可确认的同名来源替换'};

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

			// 新装仍固定物化 Codex；管理模式的两个 checkbox 只表达 C/X/B 目标可用侧。
			const target = AGENT_CONTEXT_ORDER[state.targetIndex] ?? 'cc';
			const current = selectedInstalled(state);
			const canToggle = state.mode === 'select-install-target'
				? target === 'cc'
				: isRecoverableStorageKind(current?.storage?.kind);
			if (!canToggle) {
				return state;
			}

			return {...state, installDraft: {...state.installDraft, [target]: !state.installDraft[target]}};
		}

		case 'request-update':
			return canManageInstalled(state)
				? {...state, mode: 'busy', busyAction: 'update', busyReturnMode: 'list', progress: [], errorText: undefined}
				: {...state, errorText: '没有可更新的 Skill'};

		case 'request-update-one':
			// 本地快照拓扑没有可验证远程 lock/source，不得让 update 静默重建或改写拓扑。
			return selectedInstalled(state)?.source
				? {...state, mode: 'busy', busyAction: 'update', busyReturnMode: 'list', progress: [], errorText: undefined}
				: {...state, errorText: selectedInstalled(state) ? '当前 Skill 为本地来源，无法远程更新' : '当前没有可更新的 Skill'};

		case 'request-uninstall': {
			const names = uninstallTargets(state);
			return names.length > 0
				? {...state, mode: 'confirm-uninstall', errorText: undefined}
				: {...state, errorText: '当前没有可卸载的 Skill'};
		}

		case 'confirm':
			// select-install-target / manage-inject 的提交由组件层执行（按草稿 diff），reducer 只切 busy。
			if (state.mode === 'select-install-target' || state.mode === 'manage-inject'
				|| state.mode === 'confirm-topology-change' || state.mode === 'confirm-source-replacement') {
				return {
					...state,
					mode: 'busy',
					busyAction: 'install',
					busyReturnMode: state.mode === 'select-install-target' || state.mode === 'confirm-source-replacement' ? 'install' : 'list',
					batchStage: state.mode === 'select-install-target' || state.mode === 'confirm-source-replacement' ? 'executing' : undefined,
					progress: [],
					errorText: undefined
				};
			}

			if (state.mode === 'confirm-uninstall') {
				return {...state, mode: 'busy', busyAction: 'uninstall', busyReturnMode: 'list', progress: [], errorText: undefined};
			}

			return state;

		case 'cancel':
			return cancel(state);

		case 'progress':
			return {...state, progress: [...state.progress, action.message].slice(-8)};

		case 'install-execution-done':
			return state.mode === 'busy' && state.busyAction === 'install' && state.busyReturnMode === 'install'
				? {...state, batchStage: 'reconciling'}
				: state;

		case 'install-reconciled': {
			const installedNames = new Set(action.installed.map(skill => skill.name));
			const externallyConfirmed = action.confirmedKeys ? new Set(action.confirmedKeys) : undefined;
			const successfulKeys = new Set<string>();
			const missingKeys: string[] = [];
			for (const result of pendingInstallResults(state)) {
				const identity = searchSkillIdentity(result);
				if (!identity) {
					continue;
				}

				if (externallyConfirmed ? externallyConfirmed.has(identity.key) : installedNames.has(identity.skillName)) {
					successfulKeys.add(identity.key);
				} else {
					missingKeys.push(identity.key);
				}
			}

			const picked = new Set(state.pickedResultKeys.filter(key => !successfulKeys.has(key)));
			for (const key of missingKeys) {
				picked.add(key);
			}

			const confirmedCount = successfulKeys.size;
			const missingCount = missingKeys.length;
			return {
				...state,
				mode: 'install',
				installed: action.installed,
				pickedResultKeys: [...picked],
				pendingInstallKeys: [],
				busyAction: undefined,
				busyReturnMode: undefined,
				batchStage: undefined,
				batchSummary: `安装结果：已确认 ${confirmedCount}，仍未安装 ${missingCount}`,
				errorText: action.error ?? (missingCount > 0 ? `${missingCount} 个 Skill 仍未安装，已保留选择以便重试` : undefined)
			};
		}

		case 'install-reconcile-failed': {
			const picked = new Set([...state.pickedResultKeys, ...state.pendingInstallKeys]);
			return {
				...state,
				mode: 'install',
				pickedResultKeys: [...picked],
				pendingInstallKeys: [],
				busyAction: undefined,
				busyReturnMode: undefined,
				batchStage: undefined,
				batchSummary: `安装结果：${picked.size} 个状态未确认`,
				errorText: action.error
			};
		}

		case 'lifecycle-reconciled':
			return {
				...createInitialSkillsViewState(),
				installed: action.installed,
				progress: state.progress,
				errorText: action.error
			};

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
			if (state.busyReturnMode === 'install') {
				return {
					...state,
					mode: 'install',
					pickedResultKeys: [...new Set([...state.pickedResultKeys, ...state.pendingInstallKeys])],
					pendingInstallKeys: [],
					busyAction: undefined,
					busyReturnMode: undefined,
					batchStage: undefined,
					errorText: action.error
				};
			}

			return {
				...state,
				mode: state.busyReturnMode ?? 'list',
				busyAction: undefined,
				busyReturnMode: undefined,
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
			return {...state, mode: 'install', pendingInstallKeys: []};
		case 'manage-inject':
			// 管理安装 Modal Esc → 回列表页，无写盘
			return {...state, mode: 'list'};
			case 'confirm-topology-change':
				return {...state, mode: 'manage-inject'};
		case 'confirm-source-replacement':
			return {...state, mode: 'select-install-target'};
		case 'confirm-uninstall':
			return {...state, mode: 'list'};
		case 'install':
			// 安装页 Esc → 回列表页（放弃当前搜索词/结果）
			return {...state, mode: 'list', queryFocused: false, errorText: undefined};
		default:
			return state;
	}
}

function toggleCurrentResult(state: SkillsViewState): SkillsViewState {
	if (state.mode !== 'install') {
		return state;
	}

	const item = searchInstallItems(state)[state.resultIndex];
	if (!item?.identity) {
		return {...state, errorText: '当前 Skill 来源不可用'};
	}

	if (item.selected) {
		return {
			...state,
			pickedResultKeys: state.pickedResultKeys.filter(key => key !== item.identity!.key),
			errorText: undefined
		};
	}

	if (!item.selectable) {
		return state;
	}

	return {...state, pickedResultKeys: [...state.pickedResultKeys, item.identity.key], errorText: undefined};
}

function selectableResultKeys(state: SkillsViewState): readonly string[] {
	const currentPicked = new Set(state.pickedResultKeys);
	const keys: string[] = [];
	const names = new Set<string>();
	const items = searchInstallItems(state);

	// 先保留现有选择，确保同名不同来源时不会因为全选改换来源。
	for (const item of items) {
		const identity = item.identity;
		if (!identity || !item.selectable || !currentPicked.has(identity.key) || names.has(identity.skillName)) {
			continue;
		}

		keys.push(identity.key);
		names.add(identity.skillName);
	}

	for (const item of items) {
		const identity = item.identity;
		if (!identity || !item.selectable || names.has(identity.skillName)) {
			continue;
		}

		keys.push(identity.key);
		names.add(identity.skillName);
	}

	return keys;
}

function removeInstalledPickedKeys(state: SkillsViewState, installed: readonly SkillSharedRow[]): readonly string[] {
	const installedByName = new Map(installed.map(skill => [skill.name, skill]));
	const previousByName = new Map(state.installed.map(skill => [skill.name, skill]));
	const identityByKey = new Map<string, SearchSkillIdentity>();
	for (const result of state.results) {
		const identity = searchSkillIdentity(result);
		if (identity) {
			identityByKey.set(identity.key, identity);
		}
	}

	return state.pickedResultKeys.filter(key => {
		const identity = identityByKey.get(key);
		if (!identity) {
			return false;
		}

		const current = installedByName.get(identity.skillName);
		const previous = previousByName.get(identity.skillName);
		if (sameSelectionFacts(previous, current)) {
			return true;
		}

		return !current || Boolean(current.source && !skillSourcesEquivalent(current.source, identity.source));
	});
}

function sameSelectionFacts(left: SkillSharedRow | undefined, right: SkillSharedRow | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}

	const sameSource = left.source && right.source
		? skillSourcesEquivalent(left.source, right.source)
		: left.source === right.source;
	return sameSource
		&& left.sharedInstalled === right.sharedInstalled
		&& left.claudeInjected === right.claudeInjected
		&& left.codexAvailable === right.codexAvailable
		&& left.storage?.kind === right.storage?.kind;
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

	return ((index + delta) % length + length) % length;
}

function clamp(index: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	return Math.min(Math.max(index, 0), length - 1);
}
