import type {ComponentId, ManagedComponent} from '../core/tools-manage.js';

// 工具管理视图状态机（Phase 11D，design TDR-11）：合并工具安装 + 检查更新为单一全生命周期菜单。
// grid 卡片范式 + 2D 导航 + 一键批量更新 + 卸载强确认 + per-item install/update/uninstall busy。
// 只负责 UI 模式/光标/确认词/进度/通知的有界迁移，副作用（exec 调用）由组件层执行后回填。
// 检测状态由 detection runner 单独管理，组件以 props/state 注入，不混入此处。

// 网格布局：卡宽固定，列数随终端宽度自适应；导航 delta 跟随列数，避免视觉/语义错位。
// CARD_WIDTH=28（内宽 24）：容纳「● 版本号 · 无法检测更新」等长状态行，80 列退化 1 列、宽终端多列。
export const CARD_WIDTH = 28;
export const CARD_GAP = 1;

/** 根据内容区可用宽度计算网格列数（至少 1 列）。 */
export function computeColumns(contentWidth: number): number {
	if (contentWidth <= 0) {
		return 1;
	}
	return Math.max(1, Math.floor((contentWidth + CARD_GAP) / (CARD_WIDTH + CARD_GAP)));
}

export type ToolsViewMode =
	| 'grid' // 卡片网格浏览
	| 'confirm-uninstall' // 卸载强确认（Enter 确认 / Esc 取消）
	| 'busy'; // 异步安装/更新/卸载进行中

/** 单卡片执行态（idle = 未在操作）。进行时态触发 loading 圆点。 */
export type ComponentAction = 'install' | 'update' | 'uninstall';
export type ComponentItemStatus = 'idle' | 'installing' | 'updating' | 'uninstalling';

/** 动作 → 进行时态（itemStatus 存储）。 */
function progressTense(action: ComponentAction): ComponentItemStatus {
	switch (action) {
		case 'install':
			return 'installing';
		case 'update':
			return 'updating';
		case 'uninstall':
			return 'uninstalling';
		default:
			return 'idle';
	}
}

/** 进行时态集合（isAnyBusy 判定用）。 */
const PROGRESS_STATUSES = new Set<ComponentItemStatus>(['installing', 'updating', 'uninstalling']);

export type ToolsViewState = {
	readonly mode: ToolsViewMode;
	readonly components: readonly ManagedComponent[];
	readonly loaded: boolean;
	readonly cursor: number;
	readonly itemStatus: Readonly<Record<string, ComponentItemStatus>>;
	readonly itemError: Readonly<Record<string, string>>;
	readonly busyAction?: ComponentAction;
	readonly uninstallTarget?: ComponentId;
	readonly errorText?: string;
	readonly progressByComponent: Readonly<Record<string, string>>;
};

export type ToolsViewAction =
	| {readonly type: 'components-loaded'; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'detection-error'; readonly error: string}
	| {readonly type: 'nav'; readonly delta: number}
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm-uninstall'}
	| {readonly type: 'cancel'}
	| {readonly type: 'item-start'; readonly id: ComponentId; readonly action: ComponentAction}
	| {readonly type: 'item-done'; readonly id: ComponentId; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'item-failed'; readonly id: ComponentId; readonly error: string; readonly components?: readonly ManagedComponent[]}
	| {readonly type: 'batch-start'; readonly action: ComponentAction; readonly ids: readonly ComponentId[]}
	| {readonly type: 'batch-done'; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'batch-failed'; readonly error: string; readonly components?: readonly ManagedComponent[]}
	| {readonly type: 'progress'; readonly id: string; readonly message: string};

export function createInitialToolsViewState(): ToolsViewState {
	return {
		mode: 'grid',
		components: [],
		loaded: false,
		cursor: 0,
		itemStatus: {},
		itemError: {},
		progressByComponent: {}
	};
}

/** 当前光标组件。 */
export function cursorComponent(state: ToolsViewState): ManagedComponent | undefined {
	return state.components[state.cursor];
}

/** 当前可更新（hasUpdate === true）且非进行中的组件，用于一键更新。 */
export function updatableComponents(state: ToolsViewState): readonly ManagedComponent[] {
	return state.components.filter(
		component => component.hasUpdate === true && !PROGRESS_STATUSES.has(state.itemStatus[component.id] ?? 'idle')
	);
}

/** 是否有任意组件正在执行（用于禁用并发触发）。 */
export function isAnyBusy(state: ToolsViewState): boolean {
	if (state.mode === 'busy') {
		return true;
	}

	return Object.values(state.itemStatus).some(status => PROGRESS_STATUSES.has(status));
}

export function itemStatusOf(state: ToolsViewState, id: string): ComponentItemStatus {
	return state.itemStatus[id] ?? 'idle';
}

/** 进行时态 → 中文动作标签（无进度消息时的兜底显示）。 */
function actionTenseLabel(status: ComponentItemStatus): string {
	switch (status) {
		case 'installing':
			return '安装中…';
		case 'updating':
			return '更新中…';
		case 'uninstalling':
			return '卸载中…';
		default:
			return '处理中…';
	}
}

/** 活跃任务列表：遍历进行中的组件，每个一项（组件名 + 最新进度），完成（离开进行时态）自动消失、下方上移补齐。 */
export function activeProgressTasks(state: ToolsViewState): readonly {readonly id: string; readonly name: string; readonly message: string}[] {
	return state.components
		.filter(component => PROGRESS_STATUSES.has(state.itemStatus[component.id] ?? 'idle'))
		.map(component => ({
			id: component.id,
			name: component.name,
			message: state.progressByComponent[component.id] ?? actionTenseLabel(state.itemStatus[component.id] ?? 'idle')
		}));
}

export function reduceToolsViewState(state: ToolsViewState, action: ToolsViewAction): ToolsViewState {
	switch (action.type) {
		case 'components-loaded':
			return {
				...state,
				components: action.components,
				loaded: true,
				cursor: clamp(state.cursor, action.components.length)
			};

		case 'detection-error':
			return {...state, errorText: action.error};

		case 'nav':
			return {...state, cursor: clamp(state.cursor + action.delta, state.components.length)};

		case 'request-uninstall': {
			const current = cursorComponent(state);
			if (!current || !current.installed) {
				return {...state, errorText: '该组件未安装，无需卸载'};
			}

			return {
				...state,
				mode: 'confirm-uninstall',
				uninstallTarget: current.id,
				errorText: undefined
			};
		}

		case 'confirm-uninstall':
			if (state.mode !== 'confirm-uninstall') {
				return state;
			}

			return {
				...state,
				mode: 'busy',
				busyAction: 'uninstall',
				errorText: undefined,
				itemStatus: state.uninstallTarget ? {...state.itemStatus, [state.uninstallTarget]: 'uninstalling'} : state.itemStatus
			};

		case 'cancel':
			return cancel(state);

		case 'item-start':
			return {
				...state,
				itemStatus: {...state.itemStatus, [action.id]: progressTense(action.action)},
				itemError: omit(state.itemError, action.id),
				errorText: undefined
			};

		case 'item-done':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				loaded: true,
				components: action.components,
				itemStatus: {...state.itemStatus, [action.id]: 'idle'},
				progressByComponent: omit(state.progressByComponent, action.id)
			};

		case 'item-failed':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				loaded: action.components !== undefined,
				components: action.components ?? state.components,
				itemStatus: omit(state.itemStatus, action.id), // 失败后清除状态，允许重试
				itemError: {...state.itemError, [action.id]: action.error},
				progressByComponent: omit(state.progressByComponent, action.id),
				errorText: action.error
			};

		case 'batch-start':
			return {
				...state,
				mode: 'busy',
				busyAction: action.action,
				errorText: undefined,
				itemStatus: {
					...state.itemStatus,
					...Object.fromEntries(action.ids.map(id => [id, progressTense(action.action)]))
				}
			};

		case 'batch-done':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				loaded: true,
				components: action.components,
				itemStatus: {},
				itemError: {},
				progressByComponent: {}
			};

		case 'batch-failed':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				loaded: action.components !== undefined,
				components: action.components ?? state.components,
				itemStatus: {},
				itemError: {},
				progressByComponent: {},
				errorText: action.error
			};

		case 'progress':
			return {...state, progressByComponent: {...state.progressByComponent, [action.id]: action.message}};

		default:
			return state;
	}
}

function cancel(state: ToolsViewState): ToolsViewState {
	switch (state.mode) {
		case 'confirm-uninstall':
			return {
				...state,
				mode: 'grid',
				uninstallTarget: undefined,
				errorText: undefined
			};
		default:
			return state;
	}
}

function clamp(index: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	return Math.min(Math.max(index, 0), length - 1);
}

function omit<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
	const next = {...record};
	delete next[key];
	return next;
}
