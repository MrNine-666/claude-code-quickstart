import type {ComponentId, ManagedComponent} from '../core/tools-manage.js';

// 工具管理视图状态机（Phase 11D，design TDR-11）：合并工具安装 + 检查更新为单一全生命周期菜单。
// grid 卡片范式 + 2D 导航 + 多选批量安装 + 卸载强确认 + per-item install/update/uninstall busy。
// 只负责 UI 模式/光标/多选/确认词/进度/通知的有界迁移，副作用（exec 调用）由组件层执行后回填。
// 检测状态由 detection runner 单独管理，组件以 props/state 注入，不混入此处。

export const GRID_COLUMNS = 3;

export type ToolsViewMode =
	| 'grid' // 卡片网格浏览
	| 'confirm-uninstall' // 卸载强确认（输入确认词）
	| 'busy'; // 异步安装/更新/卸载进行中

/** 单卡片执行态（idle = 未在操作）。进行时态触发 loading 圆点。 */
export type ComponentAction = 'install' | 'update' | 'uninstall';
export type ComponentItemStatus = 'idle' | 'installing' | 'updating' | 'uninstalling' | 'done' | 'failed';

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
	readonly selected: readonly ComponentId[];
	readonly itemStatus: Readonly<Record<string, ComponentItemStatus>>;
	readonly itemError: Readonly<Record<string, string>>;
	readonly busyAction?: ComponentAction;
	readonly uninstallTarget?: ComponentId;
	readonly confirmInput: string;
	readonly notice?: string;
	readonly errorText?: string;
	readonly progress: readonly string[];
};

export type ToolsViewAction =
	| {readonly type: 'components-loaded'; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'detection-error'; readonly error: string}
	| {readonly type: 'nav'; readonly delta: number}
	| {readonly type: 'toggle-select'}
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm-input'; readonly value: string}
	| {readonly type: 'confirm-uninstall'}
	| {readonly type: 'cancel'}
	| {readonly type: 'item-start'; readonly id: ComponentId; readonly action: ComponentAction}
	| {readonly type: 'item-done'; readonly id: ComponentId; readonly summary: string; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'item-failed'; readonly id: ComponentId; readonly error: string; readonly components?: readonly ManagedComponent[]}
	| {readonly type: 'batch-start'; readonly action: ComponentAction; readonly ids: readonly ComponentId[]}
	| {readonly type: 'batch-done'; readonly summary: string; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'batch-failed'; readonly error: string; readonly components?: readonly ManagedComponent[]}
	| {readonly type: 'notice'; readonly message: string}
	| {readonly type: 'progress'; readonly message: string}
	| {readonly type: 'clear-notice'};

export function createInitialToolsViewState(): ToolsViewState {
	return {
		mode: 'grid',
		components: [],
		loaded: false,
		cursor: 0,
		selected: [],
		itemStatus: {},
		itemError: {},
		confirmInput: '',
		progress: []
	};
}

/** 当前光标组件。 */
export function cursorComponent(state: ToolsViewState): ManagedComponent | undefined {
	return state.components[state.cursor];
}

/** 批量安装目标：多选优先（仅未安装项），无多选时空数组（单项安装由组件层直接调 service）。 */
export function selectedInstallTargets(state: ToolsViewState): readonly ComponentId[] {
	return state.selected.filter(id => {
		const component = state.components.find(item => item.id === id);
		return component && !component.installed;
	});
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

/** 卸载确认词：输入组件 name 即视为确认（大小写不敏感）。 */
export function isUninstallConfirmed(state: ToolsViewState): boolean {
	if (!state.uninstallTarget) {
		return false;
	}

	const target = state.components.find(item => item.id === state.uninstallTarget);
	if (!target) {
		return false;
	}

	return state.confirmInput.trim().toLowerCase() === target.name.toLowerCase();
}

export function reduceToolsViewState(state: ToolsViewState, action: ToolsViewAction): ToolsViewState {
	switch (action.type) {
		case 'components-loaded':
			return {
				...state,
				components: action.components,
				loaded: true,
				cursor: clamp(state.cursor, action.components.length),
				selected: state.selected.filter(id => action.components.some(item => item.id === id))
			};

		case 'detection-error':
			return {...state, errorText: action.error};

		case 'nav':
			return {...state, cursor: clamp(state.cursor + action.delta, state.components.length)};

		case 'toggle-select': {
			const current = cursorComponent(state);
			if (!current || current.installed) {
				return state; // 仅未安装组件可多选安装
			}

			const exists = state.selected.includes(current.id);
			return {
				...state,
				selected: exists
					? state.selected.filter(id => id !== current.id)
					: [...state.selected, current.id]
			};
		}

		case 'request-uninstall': {
			const current = cursorComponent(state);
			if (!current || !current.installed) {
				return {...state, errorText: '该组件未安装，无需卸载'};
			}

			return {
				...state,
				mode: 'confirm-uninstall',
				uninstallTarget: current.id,
				confirmInput: '',
				errorText: undefined
			};
		}

		case 'confirm-input':
			return {...state, confirmInput: action.value};

		case 'confirm-uninstall':
			if (state.mode !== 'confirm-uninstall' || !isUninstallConfirmed(state)) {
				return {...state, errorText: '确认词不匹配，请输入组件名称'};
			}

			return {
				...state,
				mode: 'busy',
				busyAction: 'uninstall',
				progress: [],
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
				confirmInput: '',
				loaded: true,
				components: action.components,
				itemStatus: {...state.itemStatus, [action.id]: 'done'},
				notice: action.summary
			};

		case 'item-failed':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				confirmInput: '',
				loaded: action.components !== undefined,
				components: action.components ?? state.components,
				itemStatus: {...state.itemStatus, [action.id]: 'failed'},
				itemError: {...state.itemError, [action.id]: action.error},
				errorText: action.error
			};

		case 'batch-start':
			return {
				...state,
				mode: 'busy',
				busyAction: action.action,
				progress: [],
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
				selected: [],
				loaded: true,
				components: action.components,
				itemStatus: {},
				itemError: {},
				notice: action.summary,
				progress: state.progress
			};

		case 'batch-failed':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				selected: [],
				loaded: action.components !== undefined,
				components: action.components ?? state.components,
				itemStatus: {},
				itemError: {},
				errorText: action.error
			};

		case 'notice':
			return {...state, notice: action.message, errorText: undefined};

		case 'progress':
			return {...state, progress: [...state.progress, action.message].slice(-8)};

		case 'clear-notice':
			return {...state, notice: undefined, errorText: undefined};

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
				confirmInput: '',
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

function omit(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
	const next = {...record};
	delete next[key];
	return next;
}
