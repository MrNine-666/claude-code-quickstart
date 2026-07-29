import {searchSkillIdentity, type SearchSkillIdentity, type SearchSkillResult} from '../core/skills.js';
import {
	currentTopologyOfItem,
	itemAvailableOn,
	needsManagedMigration,
	normalizeSkillSourceIdentity,
	skillSourcesEquivalent,
	storageRootsOf,
	type InstalledSkillItem,
	type SkillProjection,
	type SkillsStorageRoot
} from '../core/skills-installed.js';
import {AGENT_CONTEXT_ORDER, type AgentContext} from './manage-state.js';
import {targetTopologyOfDraft, type SkillTopology} from '../core/skills-storage.js';

// Skills 视图纯状态机（design D11/D13；spec skills-tui / skills-multitool / skills-tui 共享投影）。
// 逻辑实例架构（task 07-28）：列表页数据源为 InstalledSkillItem，身份是 (name, sourceIdentity)。
// 同名异来源是多个独立 Item；一切异步/Modal 意图快照 item.id，不按 name 或 cursor 复查。
// 只负责 UI 模式/光标/本地过滤/远程查询/安装草稿的有界迁移，副作用（CLI 调用）由组件层执行后回填。
// 已安装检测状态由 view-detection runner 单独管理（无 --agent 全量扫），组件以 props/state 注入，不混入此处。

export type SkillsViewMode =
	| 'list' // 列表页：本地过滤 + flat/grouped 单列多选维护
	| 'install' // 安装页：远程搜索框 + 扁平 skill 列表（默认 TOP 20）
	| 'select-install-target' // 新安装目标 Modal：Claude Code 可切 / Codex 必选
	| 'manage-inject' // 存量管理 Modal：编辑 C/X/B 目标草稿
	| 'confirm-topology-change' // C/X/B 任意非 no-op 切换的统一强确认
	| 'confirm-source-replacement' // 同名不同源覆盖 canonical/lock 的强确认
	| 'confirm-uninstall' // 实例感知的批量卸载确认（全部 Agent + 可证明投影）
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
	readonly installed: InstalledSkillItem;
	/** 该旧实例中本次确实会被覆盖的目标根投影；其它根不得在确认文案中误报。 */
	readonly projections: readonly SkillProjection[];
};

// 安装页默认草稿：两侧都装（cc symlink + cx 本体）。
const DEFAULT_INSTALL_DRAFT: InstallDraft = {cc: true, cx: true};

export type SkillsHomeLayout = 'flat' | 'grouped';

export type SkillsSourceGroup = {
	readonly key: string;
	readonly label: string;
	readonly items: readonly InstalledSkillItem[];
};

export type SkillsHomeRow =
	| {readonly kind: 'group'; readonly key: string; readonly group: SkillsSourceGroup}
	| {readonly kind: 'skill'; readonly key: string; readonly item: InstalledSkillItem};

export type SkillsViewState = {
	readonly mode: SkillsViewMode;
	// 列表页（逻辑实例；同名异源仍是多个独立 Item）
	readonly installed: readonly InstalledSkillItem[];
	readonly installedIndex: number; // 索引 skillsHomeRows（当前布局/过滤/收缩后的交互行）
	readonly filterText: string; // 本地过滤词（大小写不敏感包含匹配 name）
	readonly filterFocused: boolean; // 本地过滤框是否聚焦（Tab 切换；失焦时 u/d/r 快捷键生效）
	readonly homeLayout: SkillsHomeLayout;
	readonly collapsedSourceKeys: readonly string[];
	readonly pickedInstalledIds: readonly string[];
	readonly pendingBatchInstanceIds: readonly string[];
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
	// Modal / busy 期间锁定的逻辑实例 id。确认后不得再按 cursor 或 name 重查，
	// 否则刷新导致的排序变化会把操作打到同名另一来源上（task 07-28 R2/R7）。
	readonly pendingInstanceId?: string;
	// 共用
	readonly errorText?: string;
	readonly progress: readonly string[];
	readonly busyAction?: 'install' | 'update' | 'uninstall';
	readonly busyReturnMode?: 'list' | 'install'; // busy 结束后返回的底页（区分新装与管理安装）
	readonly batchStage?: 'executing' | 'reconciling';
};

export type SkillsViewAction =
	| {readonly type: 'installed-loaded'; readonly installed: readonly InstalledSkillItem[]}
	| {readonly type: 'nav-up'}
	| {readonly type: 'nav-down'}
	| {readonly type: 'toggle-home-layout'}
	| {readonly type: 'toggle-all-source-groups'}
	| {readonly type: 'toggle-installed-selection'}
	| {readonly type: 'toggle-source-group'}
	| {readonly type: 'select-all-installed'}
	| {readonly type: 'open-install'} // 列表页 `i` → 安装页（触发自动加载热门）
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
	| {readonly type: 'request-update'} // 列表页 U → 更新显式多选；无多选时更新当前 Item
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm'}
	| {readonly type: 'cancel'}
	| {readonly type: 'cancel-busy'}
	| {readonly type: 'progress'; readonly message: string}
	| {readonly type: 'install-execution-done'}
	| {
			readonly type: 'install-reconciled';
			readonly installed: readonly InstalledSkillItem[];
			readonly confirmedKeys?: readonly string[];
			readonly error?: string;
	  }
	| {readonly type: 'install-reconcile-failed'; readonly error: string}
	| {readonly type: 'lifecycle-reconciled'; readonly installed: readonly InstalledSkillItem[]; readonly error?: string}
	// 删除后必须以完整检测结果替换列表，不再按名称乐观过滤（R7）。
	| {readonly type: 'uninstall-reconciled'; readonly installed: readonly InstalledSkillItem[]; readonly error?: string}
	| {readonly type: 'action-done'}
	| {readonly type: 'action-failed'; readonly error: string};

export function createInitialSkillsViewState(): SkillsViewState {
	return {
		mode: 'list',
		installed: [],
		installedIndex: 0,
		filterText: '',
		filterFocused: false,
		homeLayout: 'flat',
		collapsedSourceKeys: [],
		pickedInstalledIds: [],
		pendingBatchInstanceIds: [],
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
export function filterInstalled(installed: readonly InstalledSkillItem[], filterText: string): readonly InstalledSkillItem[] {
	const q = filterText.trim().toLowerCase();
	if (!q) {
		return installed;
	}

	return installed.filter(item => item.name.toLowerCase().includes(q));
}

/** 列表页当前可见的已装列表（过滤后）。 */
export function filteredInstalled(state: SkillsViewState): readonly InstalledSkillItem[] {
	return filterInstalled(state.installed, state.filterText);
}

/** Item 的来源展示 label。未知来源只影响展示，不改变其 path-qualified identity。 */
export function installedSourceLabel(item: InstalledSkillItem): string {
	return item.provenance.kind === 'known' ? item.provenance.source ?? item.provenance.sourceUrl ?? '未知来源' : '未知来源';
}

/** 分组模式来源投影。所有 unknown Item 进入同一个展示组，但仍保留各自 Item id。 */
export function groupInstalledBySource(items: readonly InstalledSkillItem[]): readonly SkillsSourceGroup[] {
	const groups = new Map<string, {label: string; items: InstalledSkillItem[]}>();
	for (const item of items) {
		const key = item.provenance.kind === 'known' ? `known:${item.provenance.identity}` : 'unknown';
		const label = installedSourceLabel(item);
		const group = groups.get(key);
		if (group) group.items.push(item);
		else groups.set(key, {label, items: [item]});
	}

	return [...groups.entries()]
		.map(([key, group]) => ({key, label: group.label, items: group.items}))
		.sort((left, right) => left.label.localeCompare(right.label, undefined, {sensitivity: 'base'}));
}

/** 当前布局下的交互行；收缩仅影响投影，不影响过滤结果或选择范围。 */
export function skillsHomeRows(state: SkillsViewState): readonly SkillsHomeRow[] {
	const filtered = filteredInstalled(state);
	if (state.homeLayout === 'flat') {
		return filtered.map(item => ({kind: 'skill', key: `skill:${item.id}`, item}));
	}

	const collapsed = new Set(state.collapsedSourceKeys);
	return groupInstalledBySource(filtered).flatMap(group => [
		{kind: 'group' as const, key: `group:${group.key}`, group},
		...(collapsed.has(group.key)
			? []
			: group.items.map(item => ({kind: 'skill' as const, key: `skill:${item.id}`, item})))
	]);
}

export function selectedHomeRow(state: SkillsViewState): SkillsHomeRow | undefined {
	return skillsHomeRows(state)[state.installedIndex];
}

/** 远程搜索词非空才触发 skills find <query>（对齐 design D11）。 */
export function shouldRunSearch(state: SkillsViewState): boolean {
	return state.query.trim().length > 0;
}

/** 列表页是否存在任意已安装 Skill。 */
export function canManageInstalled(state: SkillsViewState): boolean {
	return state.installed.length > 0;
}

/** 列表页当前光标 Skill；组标题不伪装为 Item。 */
export function selectedInstalled(state: SkillsViewState): InstalledSkillItem | undefined {
	const row = selectedHomeRow(state);
	return row?.kind === 'skill' ? row.item : undefined;
}

/** 批量动作优先显式选择；无选择时回退当前 Skill。 */
export function selectedOrCurrentInstalled(state: SkillsViewState): readonly InstalledSkillItem[] {
	if (state.pickedInstalledIds.length > 0) {
		const picked = new Set(state.pickedInstalledIds);
		return state.installed.filter(item => picked.has(item.id));
	}

	const current = selectedInstalled(state);
	return current ? [current] : [];
}

/** Modal / busy 期间的不可变批量目标快照。 */
export function pendingBatchInstances(state: SkillsViewState): readonly InstalledSkillItem[] {
	const pending = new Set(state.pendingBatchInstanceIds);
	return state.installed.filter(item => pending.has(item.id));
}

/**
 * Modal / busy 期间锁定的逻辑实例。确认后必须用它而不是 cursor 重查，
 * 否则复检导致的排序变化会把操作打到同名另一来源上（R2/R7）。
 */
export function pendingInstance(state: SkillsViewState): InstalledSkillItem | undefined {
	return state.pendingInstanceId === undefined
		? undefined
		: state.installed.find(item => item.id === state.pendingInstanceId);
}

// currentTopologyOfItem / needsManagedMigration 已下沉到 core（skills-installed.ts），
// 供 service 迁移事务与本视图层共用同一拓扑派生；此处转出口保持现有 import 路径稳定。
export {currentTopologyOfItem, needsManagedMigration};

/** 安装页当前光标 skill。 */
export function selectedResult(state: SkillsViewState): SearchSkillResult | undefined {
	return state.results[state.resultIndex];
}

/**
 * 安装页扁平结果投影（R4）。已安装判定按来源感知：
 * - 同名同来源 → 已安装，不可选；
 * - 同名不同来源 → 仍可选，但目标根冲突时在目标 Modal 后进入 `已有同名` 覆盖确认；
 * - 同一批次仍不允许把两个不同来源的同名 Skill 选进同一目标集合。
 */
export function searchInstallItems(state: SkillsViewState): readonly SearchInstallItem[] {
	const installedByName = groupInstalledByName(state.installed);
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

		const sameName = installedByName.get(identity.skillName) ?? [];
		// 同名同来源才算已安装；只按 CLI 报告的来源判定，不比较内容。
		const sameSource = sameName.find(item => itemMatchesSource(item, identity.source));
		if (sameSource) {
			return {result, identity, status: 'installed', selected, selectable: false};
		}

		// 同名但来源不同：仅当存在可证明异源的已知来源实例时才可选（R4）。
		// 旧来源未知（unknown）无法证明来源差异，不得猜测为可替换（R3：unknown 不得被收编）。
		if (sameName.length > 0) {
			const hasKnownInstance = sameName.some(item => item.provenance.kind === 'known');
			return {result, identity, status: 'source-replacement', selected, selectable: hasKnownInstance};
		}

		return {result, identity, status: 'available', selected, selectable: true};
	});
}

function groupInstalledByName(installed: readonly InstalledSkillItem[]): ReadonlyMap<string, readonly InstalledSkillItem[]> {
	const byName = new Map<string, InstalledSkillItem[]>();
	for (const item of installed) {
		const bucket = byName.get(item.name);
		if (bucket) {
			bucket.push(item);
		} else {
			byName.set(item.name, [item]);
		}
	}

	return byName;
}

/** Item 是否属于给定来源。未知来源永远不匹配任何搜索来源（R3：不得被收编）。 */
function itemMatchesSource(item: InstalledSkillItem, source: string): boolean {
	return item.provenance.kind === 'known' && normalizeSkillSourceIdentity(source) === item.provenance.identity;
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

/**
 * 当前提交快照中会覆盖目标根同名实例的项（R4）。
 * 只有当同名异来源实例确实占用了本次选定目标根时才需要覆盖确认；
 * 位于其它根的同名异来源 Item 不受影响，因此不进入此列表。
 */
export function pendingSourceReplacements(state: SkillsViewState): readonly SourceReplacementItem[] {
	const pending = new Set(state.pendingInstallKeys);
	const installedByName = groupInstalledByName(state.installed);
	const targetRoots = targetRootsOfDraft(state.installDraft);
	return state.results.flatMap(result => {
		const identity = searchSkillIdentity(result);
		if (!identity || !pending.has(identity.key)) {
			return [];
		}

		const sameName = installedByName.get(identity.skillName) ?? [];
		// 同源视为同一实例更新，不是覆盖；Shared 目标下两个根可能分别由不同来源占用，
		// 因此按旧实例展开，并携带每个实例实际会被覆盖的目标根投影。
		return sameName.flatMap(installed => {
			const projections = installed.projections.filter(projection => targetRoots.includes(projection.root));
			return !itemMatchesSource(installed, identity.source) && projections.length > 0
				? [{result, identity, installed, projections}]
				: [];
		});
	});
}

/**
 * 来源感知对账键。安装确认必须同时匹配 name 与归一化来源身份，
 * 只按 name 判定会把同名另一来源误判为本次安装成功（R4/R5）。
 */
function sourceMatchKey(name: string, sourceIdentity: string): string {
	return JSON.stringify([name, sourceIdentity]);
}

/** 安装草稿映射到受管存储根；新安装绝不以 `.codex` 为目标（R4）。 */
export function targetRootsOfDraft(draft: InstallDraft): readonly SkillsStorageRoot[] {
	const roots: SkillsStorageRoot[] = [];
	if (draft.cx) {
		roots.push('agents');
	}

	if (draft.cc) {
		roots.push('claude');
	}

	return roots;
}

/** 从 `owner/repo@skill` 形态提取展示用 skill 名（@ 后部分）；无 @ 返回原 name。
 *  安装页列表 title 与确认弹窗共用，避免 `owner/repo` 在 name 与 source 中重复显示。 */
export function displaySkillName(name: string): string {
	if (!name.includes('@')) {
		return name;
	}

	return name.split('@')[1] || name;
}

/** 能力门禁只由 provenance 派生（R3）；存储路径可用性属于 mutation preflight，不在此处预判。 */
function canManageAgentsOf(item: InstalledSkillItem | undefined): boolean {
	return item?.capabilities.manageAgents === true;
}

export function reduceSkillsViewState(state: SkillsViewState, action: SkillsViewAction): SkillsViewState {
	switch (action.type) {
		case 'installed-loaded':
			return reconcileInstalledState(state, action.installed, {
				pickedResultKeys: removeInstalledPickedKeys(state, action.installed)
			}, false);

		case 'nav-up':
			return navigate(state, -1);

		case 'nav-down':
			return navigate(state, 1);

		case 'toggle-home-layout':
			return state.mode === 'list' ? switchHomeLayout(state) : state;

		case 'toggle-all-source-groups':
			return toggleAllSourceGroups(state);

		case 'toggle-installed-selection':
			return toggleCurrentInstalledSelection(state);

		case 'toggle-source-group':
			return toggleCurrentSourceGroup(state);

		case 'select-all-installed':
			return toggleAllFilteredInstalled(state);

		case 'open-install':
			return {...state, mode: 'install', queryFocused: true, errorText: undefined};

		case 'filter-input':
			return state.mode === 'list' ? {...state, filterText: action.value, installedIndex: 0} : state;

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
			return state.mode === 'install' ? {...state, pickedResultKeys: selectableResultKeys(state), errorText: undefined} : state;

		case 'select-skill': {
			if (state.mode !== 'install') {
				return state;
			}

			const explicitKeys = searchInstallItems(state)
				.filter(item => item.selected && item.selectable && item.identity)
				.map(item => item.identity!.key);
			const current = searchInstallItems(state)[state.resultIndex];
			const pendingInstallKeys =
				explicitKeys.length > 0 ? explicitKeys : current?.selectable && current.identity ? [current.identity.key] : [];
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
				errorText: undefined
			};
		}

		case 'manage-inject': {
			if (state.mode !== 'list') {
				return state;
			}

			// 列表行 Enter → 管理安装 Modal。草稿只由 CLI `agents` 派生（R6）。
			const current = selectedInstalled(state);
			if (!current) {
				return {...state, errorText: '当前没有可管理的 Skill'};
			}

			// 未知来源没有可证明的重装来源，不得进入可提交的 Agent 管理流程（R3）。
			if (!current.capabilities.manageAgents) {
				return {...state, errorText: '未知来源的 Skill 仅支持删除；如需改变请删除后重新安装'};
			}

			return {
				...state,
				mode: 'manage-inject',
				pendingInstanceId: current.id,
				installDraft: {
					cc: itemAvailableOn(current, 'cc'),
					cx: itemAvailableOn(current, 'cx')
				},
				targetIndex: 0,
				errorText: undefined
			};
		}

		case 'request-topology-change': {
			const current = pendingInstance(state) ?? selectedInstalled(state);
			if (state.mode !== 'manage-inject' || !current) {
				return {...state, errorText: '当前没有可管理的 Skill'};
			}

			if (!current.capabilities.migrate) {
				return {...state, errorText: '未知来源的 Skill 不能迁移或切换 Agent'};
			}

			const target = targetTopologyOfDraft(state.installDraft);
			if (target === 'empty') {
				return {...state, errorText: '至少保留一个安装目标；如需全部删除请取消后按 d 卸载'};
			}

			// `.codex` 实例即使目标同侧也必须迁移到 `.agents`，不是 no-op（R6）。
			if (currentTopologyOfItem(current) === target && !needsManagedMigration(current, target)) {
				return {...state, mode: 'list', pendingInstanceId: undefined, errorText: undefined};
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
			const current = pendingInstance(state) ?? selectedInstalled(state);
			const canToggle = state.mode === 'select-install-target' ? target === 'cc' : Boolean(current?.capabilities.manageAgents);
			if (!canToggle) {
				return state;
			}

			return {...state, installDraft: {...state.installDraft, [target]: !state.installDraft[target]}};
		}

		case 'request-update': {
			const targets = selectedOrCurrentInstalled(state);
			if (targets.length === 0) {
				return {...state, errorText: '当前没有可更新的 Skill'};
			}

			return targets.some(item => item.capabilities.update)
				? {
						...state,
						mode: 'busy',
						busyAction: 'update',
						busyReturnMode: 'list',
						pendingBatchInstanceIds: targets.map(item => item.id),
						progress: [],
						errorText: undefined
					}
				: {...state, errorText: '选中的 Skill 均为未知来源，无法远程更新'};
		}

		case 'request-uninstall': {
			// 删除是唯一对未知来源也开放的能力（R7）；确认页锁定完整 Item id 集合。
			const targets = selectedOrCurrentInstalled(state);
			return targets.length > 0
				? {
						...state,
						mode: 'confirm-uninstall',
						pendingBatchInstanceIds: targets.map(item => item.id),
						errorText: undefined
					}
				: {...state, errorText: '当前没有可卸载的 Skill'};
		}

		case 'confirm':
			// select-install-target / manage-inject 的提交由组件层执行（按草稿 diff），reducer 只切 busy。
			if (
				state.mode === 'select-install-target' ||
				state.mode === 'manage-inject' ||
				state.mode === 'confirm-topology-change' ||
				state.mode === 'confirm-source-replacement'
			) {
				return {
					...state,
					mode: 'busy',
					busyAction: 'install',
					busyReturnMode:
						state.mode === 'select-install-target' || state.mode === 'confirm-source-replacement' ? 'install' : 'list',
					batchStage:
						state.mode === 'select-install-target' || state.mode === 'confirm-source-replacement' ? 'executing' : undefined,
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

		case 'cancel-busy':
			if (state.busyReturnMode === 'install') {
				return {
					...state,
					mode: 'install',
					pickedResultKeys: [...new Set([...state.pickedResultKeys, ...state.pendingInstallKeys])],
					pendingInstallKeys: [],
					busyAction: undefined,
					busyReturnMode: undefined,
					batchStage: undefined,
					progress: [],
					errorText: undefined
				};
			}

			return {
				...state,
				mode: state.busyReturnMode ?? 'list',
				busyAction: undefined,
				busyReturnMode: undefined,
				batchStage: undefined,
				pendingBatchInstanceIds: [],
				progress: [],
				errorText: undefined
			};

		case 'progress':
			return {...state, progress: [...state.progress, action.message].slice(-8)};

		case 'install-execution-done':
			return state.mode === 'busy' && state.busyAction === 'install' && state.busyReturnMode === 'install'
				? {...state, batchStage: 'reconciling'}
				: state;

		case 'install-reconciled': {
			// 对账按 `(name, sourceIdentity)` 判定，不再以名称存在即算成功（R4/design Section 7）。
			const installedSourceIdentities = new Set(
				action.installed.flatMap(item =>
					item.provenance.kind === 'known' ? [sourceMatchKey(item.name, item.provenance.identity)] : []
				)
			);
			const externallyConfirmed = action.confirmedKeys ? new Set(action.confirmedKeys) : undefined;
			const successfulKeys = new Set<string>();
			const missingKeys: string[] = [];
			for (const result of pendingInstallResults(state)) {
				const identity = searchSkillIdentity(result);
				if (!identity) {
					continue;
				}

				const sourceIdentity = normalizeSkillSourceIdentity(identity.source);
				const installedBySource = Boolean(
					sourceIdentity && installedSourceIdentities.has(sourceMatchKey(identity.skillName, sourceIdentity))
				);
				if (externallyConfirmed ? externallyConfirmed.has(identity.key) : installedBySource) {
					successfulKeys.add(identity.key);
				} else {
					missingKeys.push(identity.key);
				}
			}

			const picked = new Set(state.pickedResultKeys.filter(key => !successfulKeys.has(key)));
			for (const key of missingKeys) {
				picked.add(key);
			}

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
				errorText: action.error
			};
		}

		case 'lifecycle-reconciled':
			return reconcileInstalledState(state, action.installed, {errorText: action.error});

		case 'action-done':
			return reconcileInstalledState(state, state.installed);

		case 'uninstall-reconciled':
			// 删除后的最终状态只由完整复检的 JSON 决定，不做名称级乐观过滤（R7）。
			return reconcileInstalledState(state, action.installed, {errorText: action.error});

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
				pendingBatchInstanceIds: [],
				errorText: action.error
			};
	}
}

function navigate(state: SkillsViewState, delta: number): SkillsViewState {
	if (state.mode === 'install') {
		return {...state, resultIndex: step(state.resultIndex, delta, state.results.length)};
	}

	if (state.mode === 'list') {
		return {...state, installedIndex: step(state.installedIndex, delta, skillsHomeRows(state).length)};
	}

	return state;
}

function cancel(state: SkillsViewState): SkillsViewState {
	switch (state.mode) {
		case 'select-install-target':
			// 安装目标 Modal Esc → 回安装页（保留搜索结果）
			return {...state, mode: 'install', pendingInstallKeys: []};
		case 'manage-inject':
			// 管理安装 Modal Esc → 回列表页，无写盘；实例快照必须随之失效，
			// 否则下一次操作会沿用上一轮锁定的来源（R2）。
			return {...state, mode: 'list', pendingInstanceId: undefined};
		case 'confirm-topology-change':
			// 退回管理 Modal 仍在同一实例流程内，保留快照。
			return {...state, mode: 'manage-inject'};
		case 'confirm-source-replacement':
			return {...state, mode: 'select-install-target'};
		case 'confirm-uninstall':
			return {...state, mode: 'list', pendingBatchInstanceIds: []};
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

/**
 * 刷新后清理已完成的选择。只有「目标来源已确实安装」才丢弃选择；
 * 同名异来源仍在时保留选择以便重试（R4）。
 */
function removeInstalledPickedKeys(state: SkillsViewState, installed: readonly InstalledSkillItem[]): readonly string[] {
	const identityByKey = new Map<string, SearchSkillIdentity>();
	for (const result of state.results) {
		const identity = searchSkillIdentity(result);
		if (identity) {
			identityByKey.set(identity.key, identity);
		}
	}

	// 完整 list 刷新按「来源 identity + Agent 投影」确认已安装（design §191）：
	// 只清除来源匹配且投影已覆盖本次安装全部目标根的选择；投影未完全物化的同名项保留供重试，
	// 不得被同一份 postflight cache 结果推翻 reducer 已保留的未确认选择。
	const targetRoots = targetRootsOfDraft(state.installDraft);
	return state.pickedResultKeys.filter(key => {
		const identity = identityByKey.get(key);
		if (!identity) {
			return false;
		}

		return !installedFullyConfirmed(installed, identity, targetRoots);
	});
}

/**
 * 已安装列表中是否存在「同名、来源等价、且投影覆盖全部目标根」的逻辑实例。
 * 仅来源匹配但投影未齐（如目标含 Claude 而 Item 仅 Codex）不算完全确认，
 * 完整 list 刷新不得据此清除 reducer 已保留的未确认选择（design §191 / R4）。
 */
function installedFullyConfirmed(
	installed: readonly InstalledSkillItem[],
	identity: SearchSkillIdentity,
	targetRoots: readonly SkillsStorageRoot[]
): boolean {
	const targetIdentity = normalizeSkillSourceIdentity(identity.source);
	if (!targetIdentity) {
		return false;
	}

	return installed.some(
		item =>
			item.name === identity.skillName &&
			item.provenance.kind === 'known' &&
			item.provenance.identity === targetIdentity &&
			targetRoots.every(root => storageRootsOf(item).includes(root))
	);
}

/** 卸载目标快照。删除对未知来源同样开放。 */
export function uninstallTargets(state: SkillsViewState): readonly InstalledSkillItem[] {
	const pending = pendingBatchInstances(state);
	return pending.length > 0 ? pending : selectedOrCurrentInstalled(state);
}

/** 兼容单项调用方：仅在目标恰为一个时返回该 Item。 */
export function uninstallTarget(state: SkillsViewState): InstalledSkillItem | undefined {
	const targets = uninstallTargets(state);
	return targets.length === 1 ? targets[0] : undefined;
}

function switchHomeLayout(state: SkillsViewState): SkillsViewState {
	const current = selectedHomeRow(state);
	const next: SkillsViewState = {
		...state,
		homeLayout: state.homeLayout === 'flat' ? 'grouped' : 'flat',
		installedIndex: 0,
		errorText: undefined
	};
	const rows = skillsHomeRows(next);
	if (current?.kind === 'skill') {
		const index = rows.findIndex(row => row.kind === 'skill' && row.item.id === current.item.id);
		return {...next, installedIndex: index >= 0 ? index : clamp(state.installedIndex, rows.length)};
	}

	if (current?.kind === 'group') {
		const firstItem = current.group.items[0];
		const index = firstItem ? rows.findIndex(row => row.kind === 'skill' && row.item.id === firstItem.id) : -1;
		return {...next, installedIndex: index >= 0 ? index : clamp(state.installedIndex, rows.length)};
	}

	return {...next, installedIndex: clamp(state.installedIndex, rows.length)};
}

function toggleCurrentInstalledSelection(state: SkillsViewState): SkillsViewState {
	if (state.mode !== 'list') return state;
	const current = selectedInstalled(state);
	if (!current) return state;
	const picked = new Set(state.pickedInstalledIds);
	if (picked.has(current.id)) picked.delete(current.id);
	else picked.add(current.id);
	return {...state, pickedInstalledIds: [...picked], errorText: undefined};
}

function toggleAllFilteredInstalled(state: SkillsViewState): SkillsViewState {
	if (state.mode !== 'list') return state;
	const targets = filteredInstalled(state);
	if (targets.length === 0) return state;
	const picked = new Set(state.pickedInstalledIds);
	const allSelected = targets.every(item => picked.has(item.id));
	for (const item of targets) {
		if (allSelected) picked.delete(item.id);
		else picked.add(item.id);
	}
	return {...state, pickedInstalledIds: [...picked], errorText: undefined};
}

function toggleCurrentSourceGroup(state: SkillsViewState): SkillsViewState {
	if (state.mode !== 'list') return state;
	const row = selectedHomeRow(state);
	if (row?.kind !== 'group') return state;
	const collapsed = new Set(state.collapsedSourceKeys);
	if (collapsed.has(row.group.key)) collapsed.delete(row.group.key);
	else collapsed.add(row.group.key);
	const next = {...state, collapsedSourceKeys: [...collapsed], errorText: undefined};
	return {...next, installedIndex: clamp(state.installedIndex, skillsHomeRows(next).length)};
}

function toggleAllSourceGroups(state: SkillsViewState): SkillsViewState {
	if (state.mode !== 'list' || state.homeLayout !== 'grouped') return state;
	const groups = groupInstalledBySource(state.installed);
	if (groups.length === 0) return state;

	const current = selectedHomeRow(state);
	const currentGroupKey =
		current?.kind === 'group'
			? current.group.key
			: current?.kind === 'skill'
				? groupInstalledBySource(filteredInstalled(state)).find(group => group.items.some(item => item.id === current.item.id))?.key
				: undefined;
	const collapsed = new Set(state.collapsedSourceKeys);
	const expandAll = groups.every(group => collapsed.has(group.key));
	const next: SkillsViewState = {
		...state,
		collapsedSourceKeys: expandAll ? [] : groups.map(group => group.key),
		errorText: undefined
	};
	const rows = skillsHomeRows(next);
	const currentItemIndex =
		expandAll && current?.kind === 'skill'
			? rows.findIndex(row => row.kind === 'skill' && row.item.id === current.item.id)
			: -1;
	const currentGroupIndex = currentGroupKey
		? rows.findIndex(row => row.kind === 'group' && row.group.key === currentGroupKey)
		: -1;
	const installedIndex = currentItemIndex >= 0 ? currentItemIndex : currentGroupIndex >= 0 ? currentGroupIndex : clamp(state.installedIndex, rows.length);
	return {...next, installedIndex};
}

function reconcileInstalledState(
	state: SkillsViewState,
	installed: readonly InstalledSkillItem[],
	patch: Partial<SkillsViewState> = {},
	settleLifecycle = true
): SkillsViewState {
	const current = selectedHomeRow(state);
	const installedIds = new Set(installed.map(item => item.id));
	const next: SkillsViewState = {
		...state,
		...patch,
		mode: settleLifecycle ? 'list' : state.mode,
		installed,
		installedIndex: 0,
		pickedInstalledIds: state.pickedInstalledIds.filter(id => installedIds.has(id)),
		pendingBatchInstanceIds: settleLifecycle ? [] : state.pendingBatchInstanceIds,
		pendingInstanceId: settleLifecycle ? undefined : state.pendingInstanceId,
		busyAction: settleLifecycle ? undefined : state.busyAction,
		busyReturnMode: settleLifecycle ? undefined : state.busyReturnMode,
		batchStage: settleLifecycle ? undefined : state.batchStage
	};
	const rows = skillsHomeRows(next);
	const index = current
		? rows.findIndex(row =>
				current.kind === 'skill'
					? row.kind === 'skill' && row.item.id === current.item.id
					: row.kind === 'group' && row.group.key === current.group.key
			)
		: -1;
	return {...next, installedIndex: index >= 0 ? index : clamp(state.installedIndex, rows.length)};
}

function step(index: number, delta: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	return (((index + delta) % length) + length) % length;
}

function clamp(index: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	return Math.min(Math.max(index, 0), length - 1);
}
