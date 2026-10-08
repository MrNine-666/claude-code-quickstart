import {
	TRANSFER_CATEGORY_REGISTRY,
	TRANSFER_TOOLS,
	type TransferCategoryIdentity,
	type TransferErrorKind,
	type TransferTool
} from '../core/config-transfer.js';
import type {
	ConfigTransferApplyOutcome,
	ConfigTransferCategoryDecision,
	ConfigTransferExportCategorySummary,
	ConfigTransferImportPlanItem,
	TransferCategoryAction
} from '../core/config-transfer-plan.js';

// 系统设置视图状态机：单页纯 reducer，无 I/O。
// 页面 = 自动更新 SelectField + 本机清单树 + 加密选择（开启时显示密码）；
// 导入/导出明细都在覆盖页面的弹窗内完成，弹窗期间背景失活。
// 密码、路径与凭据值绝不写入 eventLog；预览/结果只保存 identity 与计数。

export type SystemSettingsFocus = 'auto-update' | 'encryption' | 'password';
export type SystemSettingsOperation = 'inventory' | 'prepare-export' | 'write-export' | 'load-import' | 'apply-import';
export type SystemSettingsFoldDirection = 'collapse' | 'expand' | 'toggle';

/** UI 侧导出摘要：只含计数、identity 与脱敏警告（transfer 领域类型，保留原命名）。 */
export type ConfigTransferExportSummary = {
	readonly categories: readonly ConfigTransferExportCategorySummary[];
	readonly containsCredentials: boolean;
	readonly warnings: readonly string[];
};

/** UI 侧导入预览摘要：只含计数、identity 与脱敏警告。 */
export type ConfigTransferImportSummary = {
	readonly containsCredentials: boolean;
	readonly items: readonly ConfigTransferImportPlanItem[];
	readonly warnings: readonly string[];
};

export type ConfigTransferExportResult = {
	readonly bundlePath: string;
	readonly categoryCount: number;
	readonly itemCount: number;
	readonly containsCredentials: boolean;
	readonly encrypted: boolean;
	readonly excluded: readonly string[];
};

/** 导出明细弹窗：工具→分类多选树 + 明文风险与错误行。 */
export type SystemSettingsExportModal = {
	readonly summary: ConfigTransferExportSummary;
	readonly selected: ReadonlySet<string>;
	readonly collapsed: ReadonlySet<TransferTool>;
	readonly cursor: number;
	readonly error: string | null;
};

/** 导入弹窗：加密包先输入密码，解析后展示分类树与逐类决策。 */
export type SystemSettingsImportModal =
	| {readonly kind: 'password'; readonly bundlePath: string; readonly password: string; readonly error: string | null}
	| {
			readonly kind: 'preview' | 'confirm';
			readonly bundlePath: string;
			readonly summary: ConfigTransferImportSummary;
			readonly cursor: number;
			readonly collapsed: ReadonlySet<TransferTool>;
			readonly decisions: Readonly<Record<string, TransferCategoryAction>>;
	  };

/** 本机全局配置清单（只读投影）。 */
export type SystemSettingsInventory = {
	readonly status: 'loading' | 'ready' | 'error';
	readonly rows: readonly ConfigTransferExportCategorySummary[];
	readonly warnings: readonly string[];
	readonly error: string | null;
};

export type SystemSettingsLastResult =
	| {readonly kind: 'export'; readonly result: ConfigTransferExportResult}
	| {readonly kind: 'import'; readonly outcome: ConfigTransferApplyOutcome}
	| null;

export type SystemSettingsRetry =
	| {readonly stage: 'prepare-export'; readonly categories: readonly TransferCategoryIdentity[]}
	| {
			readonly stage: 'write-export';
			readonly targetPath: string;
			readonly categories: readonly TransferCategoryIdentity[];
			readonly password: string;
			readonly encrypt: boolean;
	  }
	| {readonly stage: 'load-import'; readonly bundlePath: string; readonly password: string}
	| {readonly stage: 'apply-import'; readonly decisions: readonly ConfigTransferCategoryDecision[]};

export type SystemSettingsPageState = {
	readonly mode: 'page';
	readonly focus: SystemSettingsFocus;
	readonly inventory: SystemSettingsInventory;
	readonly inventoryCursor: number;
	readonly inventoryCollapsed: ReadonlySet<TransferTool>;
	readonly encryption: boolean;
	readonly password: string;
	readonly exportModal: SystemSettingsExportModal | null;
	readonly importModal: SystemSettingsImportModal | null;
	readonly notice: string | null;
	readonly error: string | null;
	readonly lastResult: SystemSettingsLastResult;
	readonly eventLog: readonly string[];
};

export type SystemSettingsBusyState = {
	readonly mode: 'busy';
	readonly operation: SystemSettingsOperation;
	readonly retry: SystemSettingsRetry;
	readonly restore: SystemSettingsPageState;
	readonly eventLog: readonly string[];
};

export type SystemSettingsState = SystemSettingsPageState | SystemSettingsBusyState;

export type SystemSettingsAction =
	| {readonly type: 'move'; readonly delta: number}
	| {readonly type: 'fold'; readonly direction: SystemSettingsFoldDirection}
	| {readonly type: 'toggle'}
	| {readonly type: 'primary'}
	| {readonly type: 'back'}
	| {readonly type: 'cycle-focus'; readonly direction: 1 | -1}
	| {readonly type: 'move-field'; readonly direction: 1 | -1}
	| {readonly type: 'load-backup-preferences'; readonly encryption: boolean; readonly password: string}
	| {readonly type: 'set-encryption'; readonly value: boolean}
	| {readonly type: 'password-input'; readonly value: string}
	| {readonly type: 'import-password-input'; readonly value: string}
	| {readonly type: 'request-export'}
	| {readonly type: 'export-prepared'; readonly summary: ConfigTransferExportSummary}
	| {readonly type: 'export-path-picked'; readonly path: string}
	| {readonly type: 'export-written'; readonly result: ConfigTransferExportResult}
	| {readonly type: 'export-modal-error'; readonly message: string}
	| {readonly type: 'import-picked'; readonly path: string; readonly savedPassword?: string}
	| {readonly type: 'import-loaded'; readonly summary: ConfigTransferImportSummary}
	| {readonly type: 'import-applied'; readonly outcome: ConfigTransferApplyOutcome}
	| {readonly type: 'inventory-loading'}
	| {
			readonly type: 'inventory-loaded';
			readonly rows: readonly ConfigTransferExportCategorySummary[];
			readonly warnings: readonly string[];
	  }
	| {readonly type: 'inventory-failed'; readonly message: string}
	| {readonly type: 'picker-unavailable'; readonly reason: string}
	| {readonly type: 'show-error'; readonly message: string}
	| {readonly type: 'failed'; readonly kind: TransferErrorKind; readonly message: string}
	| {readonly type: 'cancel-busy'};

export type SystemSettingsTreeRow =
	| {readonly key: string; readonly kind: 'tool'; readonly tool: TransferTool; readonly label: string}
	| {readonly key: string; readonly kind: 'category'; readonly tool: TransferTool; readonly category: string; readonly label: string};

const TOOL_LABELS: Readonly<Record<TransferTool, string>> = {
	ccq: 'CCQ',
	cc: 'Claude Code',
	cx: 'Codex',
	pi: 'Pi'
};

const BUSY_LOG: Readonly<Record<SystemSettingsOperation, string>> = {
	inventory: '刷新本机配置清单',
	'prepare-export': '准备导出',
	'write-export': '写入导出包',
	'load-import': '读取导出包',
	'apply-import': '执行导入'
};

const EVENT_LOG_LIMIT = 6;

export function systemSettingsToolLabel(tool: TransferTool): string {
	return TOOL_LABELS[tool];
}

export function systemSettingsCategoryKey(tool: TransferTool, category: string): string {
	return `${tool}:${category}`;
}

export function systemSettingsCategoryLabel(tool: TransferTool, category: string): string {
	const definition = TRANSFER_CATEGORY_REGISTRY.find(item => item.tool === tool && item.category === category);
	return definition?.label ?? category;
}

/** 只取文件名：导入预览、确认与结果只展示 basename，绝不展示绝对路径。 */
export function bundleBasename(filePath: string): string {
	const parts = filePath.split(/[\\/]/);
	return parts[parts.length - 1] || filePath;
}

/** 工具 → 分类两级的可见行序列；折叠的工具只输出工具行。 */
export function systemSettingsVisibleRows(collapsed: ReadonlySet<TransferTool>): readonly SystemSettingsTreeRow[] {
	const rows: SystemSettingsTreeRow[] = [];
	for (const tool of TRANSFER_TOOLS) {
		const categories = TRANSFER_CATEGORY_REGISTRY.filter(definition => definition.tool === tool);
		if (categories.length === 0) {
			continue;
		}

		rows.push({key: `tool:${tool}`, kind: 'tool', tool, label: TOOL_LABELS[tool]});
		if (collapsed.has(tool)) {
			continue;
		}

		for (const definition of categories) {
			rows.push({
				key: systemSettingsCategoryKey(tool, definition.category),
				kind: 'category',
				tool,
				category: definition.category,
				label: definition.label
			});
		}
	}

	return rows;
}

/** 导入预览的可见行：工具父行 + 包内分类子行。 */
export function systemSettingsImportRows(
	items: readonly ConfigTransferImportPlanItem[],
	collapsed: ReadonlySet<TransferTool>
): readonly SystemSettingsTreeRow[] {
	const rows: SystemSettingsTreeRow[] = [];
	for (const tool of TRANSFER_TOOLS) {
		const toolItems = items.filter(item => item.tool === tool);
		if (toolItems.length === 0) {
			continue;
		}

		rows.push({key: `tool:${tool}`, kind: 'tool', tool, label: TOOL_LABELS[tool]});
		if (collapsed.has(tool)) {
			continue;
		}

		for (const item of toolItems) {
			rows.push({
				key: systemSettingsCategoryKey(item.tool, item.category),
				kind: 'category',
				tool: item.tool,
				category: item.category,
				label: systemSettingsCategoryLabel(item.tool, item.category)
			});
		}
	}

	return rows;
}

export function systemSettingsDefaultSelection(): ReadonlySet<string> {
	return new Set(TRANSFER_CATEGORY_REGISTRY.map(definition => systemSettingsCategoryKey(definition.tool, definition.category)));
}

export function systemSettingsSelectedCategories(selected: ReadonlySet<string>): readonly TransferCategoryIdentity[] {
	return TRANSFER_CATEGORY_REGISTRY.filter(definition =>
		selected.has(systemSettingsCategoryKey(definition.tool, definition.category))
	).map(definition => ({tool: definition.tool, category: definition.category}));
}

export function systemSettingsToolCategories(tool: TransferTool): readonly string[] {
	return TRANSFER_CATEGORY_REGISTRY.filter(definition => definition.tool === tool).map(definition => definition.category);
}

export function systemSettingsToolSelectedCount(selected: ReadonlySet<string>, tool: TransferTool): number {
	return systemSettingsToolCategories(tool).filter(category => selected.has(systemSettingsCategoryKey(tool, category))).length;
}

export function systemSettingsToolFullySelected(selected: ReadonlySet<string>, tool: TransferTool): boolean {
	const categories = systemSettingsToolCategories(tool);
	return categories.length > 0 && categories.every(category => selected.has(systemSettingsCategoryKey(tool, category)));
}

export function systemSettingsDefaultDecisions(
	items: readonly ConfigTransferImportPlanItem[]
): Readonly<Record<string, TransferCategoryAction>> {
	return Object.fromEntries(items.map(item => [systemSettingsCategoryKey(item.tool, item.category), item.defaultAction]));
}

export function systemSettingsDecisionOf(
	decisions: Readonly<Record<string, TransferCategoryAction>>,
	item: {readonly tool: TransferTool; readonly category: string; readonly defaultAction: TransferCategoryAction}
): TransferCategoryAction {
	return decisions[systemSettingsCategoryKey(item.tool, item.category)] ?? item.defaultAction;
}

export function systemSettingsExcludedIdentities(summary: ConfigTransferExportSummary): readonly string[] {
	const entries: string[] = [];
	for (const category of summary.categories) {
		for (const identity of category.excluded) {
			entries.push(`${TOOL_LABELS[category.tool]} · ${systemSettingsCategoryLabel(category.tool, category.category)}：${identity}`);
		}

		for (const identity of category.excludedCredentials) {
			entries.push(
				`${TOOL_LABELS[category.tool]} · ${systemSettingsCategoryLabel(category.tool, category.category)} 凭据：${identity}`
			);
		}
	}

	return entries;
}

export function systemSettingsItemCount(summary: ConfigTransferExportSummary): number {
	return summary.categories.reduce((total, category) => total + category.itemCount, 0);
}

export type SystemSettingsExportValidation = {readonly ok: true} | {readonly ok: false; readonly error: string};

/** 导出弹窗 Enter 前的本地校验：至少一个分类；选择加密时必须已输入密码。 */
export function systemSettingsExportValidation(
	modal: SystemSettingsExportModal,
	encryption: boolean,
	password: string
): SystemSettingsExportValidation {
	if (systemSettingsSelectedCategories(modal.selected).length === 0) {
		return {ok: false, error: '请至少选择一个导出分类'};
	}

	if (encryption && password.length === 0) {
		return {ok: false, error: '选择加密时必须设置导出密码'};
	}

	return {ok: true};
}

export function systemSettingsBusyTitle(operation: SystemSettingsOperation): string {
	switch (operation) {
		case 'inventory':
			return '正在读取本机配置';
		case 'prepare-export':
			return '正在准备导出';
		case 'write-export':
			return '正在写入导出包';
		case 'load-import':
			return '正在读取导出包';
		case 'apply-import':
			return '正在执行导入';
	}
}

export function systemSettingsSubMode(state: SystemSettingsState): string {
	if (state.mode === 'busy') {
		return 'busy';
	}

	if (state.exportModal !== null) {
		return 'export-modal';
	}

	if (state.importModal?.kind === 'password') {
		return 'import-password';
	}

	if (state.importModal?.kind === 'preview' || state.importModal?.kind === 'confirm') {
		return state.importModal.kind === 'confirm' ? 'import-confirm' : 'import-preview';
	}

	switch (state.focus) {
		case 'auto-update':
			return 'page-auto-update';
		case 'encryption':
			return state.encryption ? 'page-encryption-enabled' : 'page-encryption';
		case 'password':
			return 'page-password';
		default:
			return 'page';
	}
}

export function createInitialSystemSettingsState(): SystemSettingsPageState {
	return {
		mode: 'page',
		focus: 'auto-update',
		inventory: {status: 'loading', rows: [], warnings: [], error: null},
		inventoryCursor: 0,
		inventoryCollapsed: new Set<TransferTool>(),
		encryption: false,
		password: '',
		exportModal: null,
		importModal: null,
		notice: null,
		error: null,
		lastResult: null,
		eventLog: ['系统设置已打开']
	};
}

export function reduceSystemSettingsState(state: SystemSettingsState, action: SystemSettingsAction): SystemSettingsState {
	switch (action.type) {
		case 'move':
			return state.mode === 'page' ? reduceMove(state, action.delta) : state;
		case 'fold':
			return state.mode === 'page' ? reduceFold(state, action.direction) : state;
		case 'toggle':
			return state.mode === 'page' ? reduceToggle(state) : state;
		case 'primary':
			return state.mode === 'page' ? reducePrimary(state) : state;
		case 'back':
			return state.mode === 'page' ? reduceBack(state) : state;
		case 'cycle-focus':
			return state.mode === 'page' ? reduceCycleFocus(state) : state;
		case 'move-field':
			return state.mode === 'page' ? reduceMoveField(state, action.direction) : state;
		case 'load-backup-preferences':
			return state.mode === 'page' ? {...state, encryption: action.encryption, password: action.password} : state;
		case 'set-encryption':
			return state.mode === 'page'
				? {
						...state,
						encryption: action.value,
						focus: !action.value && state.focus === 'password' ? 'encryption' : state.focus,
						error: null
					}
				: state;
		case 'password-input':
			return state.mode === 'page' ? {...state, password: action.value, error: null} : state;
		case 'import-password-input':
			return state.mode === 'page' && state.importModal?.kind === 'password'
				? {...state, importModal: {...state.importModal, password: action.value, error: null}}
				: state;
		case 'request-export':
			return state.mode === 'page' ? beginExportPrepare(state) : state;
		case 'export-prepared':
			return reduceExportPrepared(state, action.summary);
		case 'export-path-picked':
			return reduceExportPathPicked(state, action.path);
		case 'export-written':
			return reduceExportWritten(state, action.result);
		case 'export-modal-error':
			return state.mode === 'page' && state.exportModal
				? {...state, exportModal: {...state.exportModal, error: action.message}}
				: state;
		case 'import-picked':
			return reduceImportPicked(state, action.path, action.savedPassword ?? '');
		case 'import-loaded':
			return reduceImportLoaded(state, action.summary);
		case 'import-applied':
			return reduceImportApplied(state, action.outcome);
		case 'inventory-loading':
			return state.mode === 'page' ? {...state, inventory: {...state.inventory, status: 'loading', error: null}} : state;
		case 'inventory-loaded':
			return state.mode === 'page'
				? {
						...state,
						inventory: {status: 'ready', rows: action.rows, warnings: action.warnings, error: null}
					}
				: state;
		case 'inventory-failed':
			return state.mode === 'page' ? {...state, inventory: {status: 'error', rows: [], warnings: [], error: action.message}} : state;
		case 'picker-unavailable':
			return state.mode === 'page'
				? logged(state, '系统文件对话框不可用', {...state, notice: `系统文件对话框不可用：${action.reason}`})
				: state;
		case 'show-error':
			return state.mode === 'page' ? {...state, error: action.message, notice: null} : state;
		case 'failed':
			return reduceFailed(state, action.kind, action.message);
		case 'cancel-busy':
			return state.mode === 'busy' ? logged(state, '已取消配置迁移操作', state.restore) : state;
	}
}

/** 当前活动的树焦点：导出弹窗 > 导入预览 > 页面清单。 */
function activeTree(state: SystemSettingsPageState): 'export' | 'import' | 'inventory' {
	if (state.exportModal) {
		return 'export';
	}

	if (state.importModal?.kind === 'preview') {
		return 'import';
	}

	return 'inventory';
}

function activeRows(state: SystemSettingsPageState): readonly SystemSettingsTreeRow[] {
	if (state.exportModal) {
		return systemSettingsVisibleRows(state.exportModal.collapsed);
	}

	if (state.importModal?.kind === 'preview' || state.importModal?.kind === 'confirm') {
		return systemSettingsImportRows(state.importModal.summary.items, state.importModal.collapsed);
	}

	return systemSettingsVisibleRows(state.inventoryCollapsed);
}

function activeCursor(state: SystemSettingsPageState): number {
	if (state.exportModal) {
		return state.exportModal.cursor;
	}

	if (state.importModal?.kind === 'preview' || state.importModal?.kind === 'confirm') {
		return state.importModal.cursor;
	}

	return state.inventoryCursor;
}

function withActiveCursor(state: SystemSettingsPageState, cursor: number): SystemSettingsPageState {
	if (state.exportModal) {
		return {...state, exportModal: {...state.exportModal, cursor}};
	}

	if (state.importModal?.kind === 'preview' || state.importModal?.kind === 'confirm') {
		return {...state, importModal: {...state.importModal, cursor}};
	}

	return {...state, inventoryCursor: cursor};
}

function withActiveCollapsed(state: SystemSettingsPageState, collapsed: ReadonlySet<TransferTool>): SystemSettingsPageState {
	if (state.exportModal) {
		return {...state, exportModal: {...state.exportModal, collapsed}};
	}

	if (state.importModal?.kind === 'preview' || state.importModal?.kind === 'confirm') {
		return {...state, importModal: {...state.importModal, collapsed}};
	}

	return {...state, inventoryCollapsed: collapsed};
}

function reduceMove(state: SystemSettingsPageState, delta: number): SystemSettingsState {
	if (state.exportModal === null && state.importModal?.kind !== 'preview') {
		return state;
	}

	const rows = activeRows(state);
	return withActiveCursor(state, clampCursor(activeCursor(state) + delta, rows.length));
}

function reduceFold(state: SystemSettingsPageState, direction: SystemSettingsFoldDirection): SystemSettingsState {
	if (state.exportModal === null && state.importModal?.kind !== 'preview') {
		return state;
	}

	const rows = activeRows(state);
	const row = rows[activeCursor(state)];
	if (row?.kind !== 'tool') {
		return state;
	}

	const collapsed = new Set(
		state.exportModal
			? state.exportModal.collapsed
			: state.importModal?.kind === 'preview'
				? state.importModal.collapsed
				: state.inventoryCollapsed
	);
	const collapse = direction === 'collapse' ? true : direction === 'expand' ? false : !collapsed.has(row.tool);
	if (collapse) {
		collapsed.add(row.tool);
	} else {
		collapsed.delete(row.tool);
	}

	const next = withActiveCollapsed(state, collapsed);
	const nextRows = activeRows(next);
	const toolIndex = nextRows.findIndex(candidate => candidate.kind === 'tool' && candidate.tool === row.tool);
	return withActiveCursor(next, toolIndex < 0 ? activeCursor(state) : toolIndex);
}

function reduceToggle(state: SystemSettingsPageState): SystemSettingsState {
	if (state.importModal?.kind === 'password') {
		return state;
	}

	const scope = activeTree(state);
	const rows = activeRows(state);
	const row = rows[activeCursor(state)];
	if (!row) {
		return state;
	}

	if (scope === 'export' && state.exportModal) {
		return {...state, exportModal: {...state.exportModal, selected: toggleSelection(state.exportModal.selected, row)}};
	}

	if (scope === 'import' && state.importModal?.kind === 'preview') {
		return {
			...state,
			importModal: {
				...state.importModal,
				decisions: toggleDecisions(state.importModal.summary.items, state.importModal.decisions, row)
			}
		};
	}

	// 页面清单：Space 等同 Enter，折叠/展开工具行。
	if (row.kind === 'tool') {
		return reduceFold(state, 'toggle');
	}

	return state;
}

function toggleSelection(selected: ReadonlySet<string>, row: SystemSettingsTreeRow): ReadonlySet<string> {
	const next = new Set(selected);
	if (row.kind === 'tool') {
		const categories = systemSettingsToolCategories(row.tool);
		const fullySelected = categories.every(category => next.has(systemSettingsCategoryKey(row.tool, category)));
		for (const category of categories) {
			const key = systemSettingsCategoryKey(row.tool, category);
			if (fullySelected) {
				next.delete(key);
			} else {
				next.add(key);
			}
		}

		return next;
	}

	const key = systemSettingsCategoryKey(row.tool, row.category);
	if (next.has(key)) {
		next.delete(key);
	} else {
		next.add(key);
	}

	return next;
}

function toggleDecisions(
	items: readonly ConfigTransferImportPlanItem[],
	decisions: Readonly<Record<string, TransferCategoryAction>>,
	row: SystemSettingsTreeRow
): Readonly<Record<string, TransferCategoryAction>> {
	const next = {...decisions};
	if (row.kind === 'tool') {
		const toolItems = items.filter(item => item.tool === row.tool && item.status !== 'blocked');
		const canReplace = toolItems.every(item => item.replace?.status !== 'blocked');
		const allMerge = toolItems.length > 0 && toolItems.every(item => systemSettingsDecisionOf(next, item) === 'merge');
		const allReplace = toolItems.length > 0 && toolItems.every(item => systemSettingsDecisionOf(next, item) === 'replace');
		const batchAction: TransferCategoryAction = allMerge && canReplace ? 'replace' : allReplace ? 'skip' : 'merge';
		for (const item of toolItems) {
			next[systemSettingsCategoryKey(item.tool, item.category)] = batchAction;
		}

		return next;
	}

	const item = items.find(candidate => candidate.tool === row.tool && candidate.category === row.category);
	if (!item || item.status === 'blocked') {
		return next;
	}

	const key = systemSettingsCategoryKey(item.tool, item.category);
	const current = systemSettingsDecisionOf(next, item);
	const canReplace = item.replace?.status !== 'blocked';
	next[key] = current === 'merge' ? (canReplace ? 'replace' : 'skip') : current === 'replace' ? 'skip' : 'merge';
	return next;
}

function reducePrimary(state: SystemSettingsPageState): SystemSettingsState {
	if (state.importModal?.kind === 'password') {
		if (state.importModal.password.length === 0) {
			return {...state, importModal: {...state.importModal, error: '请输入导出包密码'}};
		}

		return beginBusy(
			state,
			'load-import',
			{stage: 'load-import', bundlePath: state.importModal.bundlePath, password: state.importModal.password},
			{}
		);
	}

	if (state.importModal?.kind === 'confirm') {
		return beginBusy(
			state,
			'apply-import',
			{stage: 'apply-import', decisions: decisionList(state.importModal.decisions)},
			{importModal: null}
		);
	}

	if (state.importModal?.kind === 'preview') {
		const importModal = state.importModal;
		const hasReplacement = importModal.summary.items.some(
			item => item.status !== 'blocked' && systemSettingsDecisionOf(importModal.decisions, item) === 'replace'
		);
		if (hasReplacement) {
			return {...state, importModal: {...importModal, kind: 'confirm'}};
		}

		return beginBusy(
			state,
			'apply-import',
			{stage: 'apply-import', decisions: decisionList(importModal.decisions)},
			{importModal: null}
		);
	}

	if (state.focus === 'auto-update') {
		return {...state, error: null};
	}

	if (state.focus === 'encryption') {
		return reduceSystemSettingsState(state, {type: 'set-encryption', value: !state.encryption});
	}

	const rows = activeRows(state);
	const row = rows[activeCursor(state)];
	return row?.kind === 'tool' ? reduceFold(state, 'toggle') : state;
}

function reduceCycleFocus(state: SystemSettingsPageState): SystemSettingsState {
	if (state.exportModal !== null || state.importModal !== null) return state;
	// Tab/Shift+Tab 只在两张卡片间切换，进入导入导出卡片时先聚焦加密选项。
	return {...state, focus: state.focus === 'auto-update' ? 'encryption' : 'auto-update'};
}

function reduceMoveField(state: SystemSettingsPageState, direction: 1 | -1): SystemSettingsState {
	if (state.exportModal !== null || state.importModal !== null) return state;
	const fields: SystemSettingsPageState['focus'][] = state.encryption
		? ['auto-update', 'encryption', 'password']
		: ['auto-update', 'encryption'];
	const index = fields.indexOf(state.focus);
	return {...state, focus: fields[(index + direction + fields.length) % fields.length]!};
}

function reduceBack(state: SystemSettingsPageState): SystemSettingsState {
	if (state.exportModal !== null) {
		return logged(state, '关闭导出明细弹窗', {...state, exportModal: null, error: null});
	}

	if (state.importModal?.kind === 'confirm') {
		return logged(state, '返回导入明细', {...state, importModal: {...state.importModal, kind: 'preview'}, error: null});
	}

	if (state.importModal !== null) {
		return logged(state, '关闭导入弹窗', {...state, importModal: null, error: null});
	}

	if (state.focus === 'password') {
		return {...state, focus: 'encryption'};
	}

	return state;
}

function beginExportPrepare(state: SystemSettingsPageState): SystemSettingsState {
	// 页面清单只用于浏览；导出默认全选，具体勾选在弹窗内完成。
	const categories = systemSettingsSelectedCategories(systemSettingsDefaultSelection());
	return beginBusy(
		{...state, exportModal: null, importModal: null, error: null, notice: null},
		'prepare-export',
		{stage: 'prepare-export', categories},
		{}
	);
}

function reduceExportPrepared(state: SystemSettingsState, summary: ConfigTransferExportSummary): SystemSettingsState {
	if (state.mode !== 'busy' || state.operation !== 'prepare-export') {
		return state;
	}

	const exportModal: SystemSettingsExportModal = {
		summary,
		selected: systemSettingsDefaultSelection(),
		collapsed: new Set<TransferTool>(),
		cursor: 0,
		error: null
	};
	return logged(state, '导出明细已生成', {...state.restore, exportModal, error: null, notice: null});
}

/** 导出弹窗 Enter 校验通过并拿到路径：进入写入事务，还原点是仍打开的弹窗。 */
function reduceExportPathPicked(state: SystemSettingsState, path: string): SystemSettingsState {
	if (state.mode !== 'page' || state.exportModal === null) {
		return state;
	}

	return beginBusy(
		logged(state, '已选择导出位置', {...state, notice: null, error: null}),
		'write-export',
		{
			stage: 'write-export',
			targetPath: path,
			categories: systemSettingsSelectedCategories(state.exportModal.selected),
			password: state.password,
			encrypt: state.encryption
		},
		{exportModal: null}
	);
}

function reduceExportWritten(state: SystemSettingsState, result: ConfigTransferExportResult): SystemSettingsState {
	if (state.mode !== 'busy' || state.operation !== 'write-export') {
		return state;
	}

	return logged(state, '导出完成', {
		...state.restore,
		exportModal: null,
		lastResult: {kind: 'export', result},
		error: null,
		notice: null
	});
}

function reduceImportPicked(state: SystemSettingsState, path: string, savedPassword: string): SystemSettingsState {
	if (state.mode !== 'page') {
		return state;
	}

	const importModal: SystemSettingsImportModal = {kind: 'password', bundlePath: path, password: savedPassword, error: null};
	const picked = logged(state, '已选择导出包', {
		...state,
		notice: null,
		error: null,
		exportModal: null,
		importModal
	});
	return beginBusy(picked, 'load-import', {stage: 'load-import', bundlePath: path, password: savedPassword}, {importModal});
}

function reduceImportLoaded(state: SystemSettingsState, summary: ConfigTransferImportSummary): SystemSettingsState {
	if (state.mode !== 'busy' || state.operation !== 'load-import' || state.retry.stage !== 'load-import') {
		return state;
	}

	const importModal: SystemSettingsImportModal = {
		kind: 'preview',
		bundlePath: state.retry.bundlePath,
		summary,
		cursor: 0,
		collapsed: new Set<TransferTool>(),
		decisions: systemSettingsDefaultDecisions(summary.items)
	};
	return logged(state, '导入明细已生成', {...state.restore, importModal, error: null, notice: null});
}

function reduceImportApplied(state: SystemSettingsState, outcome: ConfigTransferApplyOutcome): SystemSettingsState {
	if (state.mode !== 'busy' || state.operation !== 'apply-import') {
		return state;
	}

	return logged(state, '导入完成', {
		...state.restore,
		importModal: null,
		lastResult: {kind: 'import', outcome},
		error: null,
		notice: null
	});
}

function reduceFailed(state: SystemSettingsState, kind: TransferErrorKind, message: string): SystemSettingsState {
	if (state.mode !== 'busy') {
		return state;
	}

	if (kind === 'password' && state.restore.importModal?.kind === 'password') {
		return logged(state, '配置迁移操作失败', {
			...state.restore,
			importModal: {...state.restore.importModal, error: message},
			error: null
		});
	}

	return logged(state, '配置迁移操作失败', {
		...state.restore,
		exportModal: null,
		importModal: null,
		error: message
	});
}

function beginBusy(
	state: SystemSettingsPageState,
	operation: SystemSettingsOperation,
	retry: SystemSettingsRetry,
	restorePatch: Partial<SystemSettingsPageState> = {}
): SystemSettingsBusyState {
	const restore: SystemSettingsPageState = {...state, ...restorePatch, eventLog: state.eventLog};
	return {
		mode: 'busy',
		operation,
		retry,
		restore,
		eventLog: [...state.eventLog, BUSY_LOG[operation]].slice(-EVENT_LOG_LIMIT)
	};
}

function decisionList(decisions: Readonly<Record<string, TransferCategoryAction>>): readonly ConfigTransferCategoryDecision[] {
	return Object.entries(decisions).map(([key, action]) => {
		const separator = key.indexOf(':');
		return {tool: key.slice(0, separator) as TransferTool, category: key.slice(separator + 1), action};
	});
}

function logged<T extends SystemSettingsState>(state: SystemSettingsState, message: string, next: T): T {
	return {...next, eventLog: [...state.eventLog, message].slice(-EVENT_LOG_LIMIT)};
}

function clampCursor(cursor: number, length: number): number {
	if (length <= 0) {
		return 0;
	}

	return Math.min(Math.max(cursor, 0), length - 1);
}
