import {isInjectableComponent, type ComponentId, type ManagedComponent, type SharedManagedComponent} from '../core/tools-manage.js';
import type {ProgressLevel} from '../core/exec.js';
import type {AgentContext} from './manage-state.js';
import {AGENT_CONTEXT_ORDER} from './manage-state.js';

// 工具管理视图状态机：grid + 单侧 inject 目标选择 + 全量卸载确认 + per-item busy。
// 副作用（exec）由视图层执行后回填；检测由 App 层 cache 注入。

// CARD_WIDTH=44：容纳标题行右上角状态/版本 + 描述文档链接 + 双态徽章行；列数随终端宽度自适应。
export const CARD_WIDTH = 44;
export const CARD_GAP = 1;

/** 根据内容区可用宽度计算网格列数（至少 1 列）。 */
export function computeColumns(contentWidth: number): number {
	if (contentWidth <= 0) {
		return 1;
	}
	return Math.max(1, Math.floor((contentWidth + CARD_GAP) / (CARD_WIDTH + CARD_GAP)));
}

export type ToolsViewMode = 'grid' | 'select-inject-target' | 'confirm-uninstall' | 'busy';

export type ComponentAction = 'install' | 'update' | 'uninstall';
export type ComponentItemStatus = 'idle' | 'installing' | 'updating' | 'uninstalling';

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
	/** select-inject-target：0=Claude Code, 1=Codex */
	readonly injectTargetIndex: number;
	/** Modal 内草稿开关状态：进入 Modal 时复制 injectByAgent 的 integrated 快照，空格切换、Enter 应用前不落盘。 */
	readonly injectDraft?: Readonly<Record<AgentContext, boolean>>;
	readonly errorText?: string;
	readonly progressByComponent: Readonly<Record<string, string>>;
	readonly progressLevelByComponent: Readonly<Record<string, ProgressLevel>>;
	readonly latestProgressId?: string;
};

export type ComponentPatch = {
	readonly installed?: boolean;
	readonly currentVersion?: string;
	readonly latestVersion?: string;
	readonly hasUpdate?: boolean | null;
	readonly statusHint?: string;
	readonly lifecycle?: ManagedComponent['lifecycle'];
	readonly sharedInstalled?: boolean;
	readonly sharedVersion?: string;
	readonly injectByAgent?: SharedManagedComponent['injectByAgent'];
};

export type ToolsViewAction =
	| {readonly type: 'components-loaded'; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'detection-error'; readonly error: string}
	| {readonly type: 'nav'; readonly delta: number}
	| {readonly type: 'open-inject-target'; readonly draft: Readonly<Record<AgentContext, boolean>>}
	| {readonly type: 'inject-target-nav'; readonly delta: number}
	| {readonly type: 'inject-target-toggle'}
	| {readonly type: 'request-uninstall'}
	| {readonly type: 'confirm-uninstall'}
	| {readonly type: 'cancel'}
	| {readonly type: 'cancel-busy'}
	| {readonly type: 'item-start'; readonly id: ComponentId; readonly action: ComponentAction}
	| {readonly type: 'item-done'; readonly id: ComponentId; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'item-patched'; readonly id: ComponentId; readonly patch: ComponentPatch}
	| {
			readonly type: 'item-failed';
			readonly id: ComponentId;
			readonly error: string;
			readonly patch?: ComponentPatch;
			readonly components?: readonly ManagedComponent[];
		}
	| {readonly type: 'batch-start'; readonly action: ComponentAction; readonly ids: readonly ComponentId[]}
	| {readonly type: 'batch-done'; readonly components: readonly ManagedComponent[]}
	| {readonly type: 'batch-failed'; readonly error: string; readonly components?: readonly ManagedComponent[]}
	| {readonly type: 'progress'; readonly id: string; readonly message: string; readonly level: ProgressLevel};

export function createInitialToolsViewState(): ToolsViewState {
	return {
		mode: 'grid',
		components: [],
		loaded: false,
		cursor: 0,
		itemStatus: {},
		itemError: {},
		injectTargetIndex: 0,
		progressByComponent: {},
		progressLevelByComponent: {},
		latestProgressId: undefined
	};
}

export function cursorComponent(state: ToolsViewState): ManagedComponent | undefined {
	return state.components[state.cursor];
}

export type ToolsPrimaryAction = 'manage' | 'install' | 'update' | 'repair' | 'blocked' | 'latest';

/** Resolve the grid Enter action from the selected component's current facts. */
export function resolveToolsPrimaryAction(component: ManagedComponent): ToolsPrimaryAction {
	if (component.lifecycle) {
		switch (component.lifecycle.state) {
			case 'not-installed':
				return 'install';
			case 'managed':
				return component.hasUpdate === true ? 'update' : 'latest';
			case 'broken':
			case 'version-mismatch':
				return 'repair';
			case 'external':
			case 'path-conflict':
			case 'npm-unavailable':
			case 'verification-unknown':
				return 'blocked';
		}
	}

	if (isInjectableComponent(component.id)) {
		return 'manage';
	}

	if (!component.installed) {
		return 'install';
	}

	return component.hasUpdate === true ? 'update' : 'latest';
}

export function updatableComponents(state: ToolsViewState): readonly ManagedComponent[] {
	return state.components.filter(
		component => component.installed && component.hasUpdate === true && !PROGRESS_STATUSES.has(state.itemStatus[component.id] ?? 'idle')
	);
}

export function isAnyBusy(state: ToolsViewState): boolean {
	if (state.mode === 'busy') {
		return true;
	}

	return Object.values(state.itemStatus).some(status => PROGRESS_STATUSES.has(status));
}

export function itemStatusOf(state: ToolsViewState, id: string): ComponentItemStatus {
	return state.itemStatus[id] ?? 'idle';
}

export function injectTargetContext(state: ToolsViewState): AgentContext {
	return state.injectTargetIndex === 1 ? 'cx' : 'cc';
}

/** 从组件双侧 inject 快照构造 Modal 初始草稿（integrated → 开）。 */
export function initialInjectDraft(component: SharedManagedComponent): Record<AgentContext, boolean> {
	return {
		cc: Boolean(component.injectByAgent?.cc?.integrated),
		cx: Boolean(component.injectByAgent?.cx?.integrated)
	};
}

export function latestActiveProgressTask(
	state: ToolsViewState
): {readonly id: string; readonly name: string; readonly message: string; readonly level: ProgressLevel} | undefined {
	const isActive = (component: ManagedComponent): boolean => PROGRESS_STATUSES.has(state.itemStatus[component.id] ?? 'idle');
	const component =
		state.components.find(item => item.id === state.latestProgressId && isActive(item)) ?? state.components.find(isActive);
	const message = component ? state.progressByComponent[component.id] : undefined;
	if (!component || !message) {
		return undefined;
	}

	return {
		id: component.id,
		name: component.name,
		message,
		level: state.progressLevelByComponent[component.id] ?? 'info'
	};
}

function patchComponent(components: readonly ManagedComponent[], id: ComponentId, patch: ComponentPatch): readonly ManagedComponent[] {
	const before = components.find(component => component.id === id);
	if (!before) {
		return components;
	}

	const beforeShared = before as SharedManagedComponent;
	const hasPatchField = (field: keyof ComponentPatch): boolean => Object.prototype.hasOwnProperty.call(patch, field);
	const patched = {
		...beforeShared,
		installed: patch.installed ?? beforeShared.installed,
		currentVersion: patch.currentVersion ?? beforeShared.currentVersion,
		latestVersion: patch.latestVersion ?? beforeShared.latestVersion,
		hasUpdate: hasPatchField('hasUpdate') ? (patch.hasUpdate ?? null) : beforeShared.hasUpdate,
		statusHint: hasPatchField('statusHint') ? patch.statusHint : beforeShared.statusHint,
		lifecycle: hasPatchField('lifecycle') ? patch.lifecycle : beforeShared.lifecycle,
		sharedInstalled: patch.sharedInstalled ?? beforeShared.sharedInstalled,
		sharedVersion: patch.sharedVersion ?? beforeShared.sharedVersion,
		injectByAgent: patch.injectByAgent ?? beforeShared.injectByAgent
	} as ManagedComponent;
	return components.map(component => (component.id === id ? patched : component));
}

function canRequestUninstall(component: ManagedComponent): boolean {
	if (component.lifecycle) {
		return component.lifecycle.canUninstall;
	}

	const shared = component as SharedManagedComponent;
	if (shared.sharingKind === 'shared-cli-per-agent-inject') {
		const hasInject = Boolean(shared.injectByAgent && Object.values(shared.injectByAgent).some(s => s.integrated));
		return component.installed || shared.sharedInstalled || hasInject;
	}
	return component.installed;
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

		case 'open-inject-target': {
			const current = cursorComponent(state) as SharedManagedComponent | undefined;
			if (!current) {
				return state;
			}
			// 进入 Modal 用当前实际注入态初始化草稿；空格切换草稿，Enter 前不落盘。
			const inject = current.injectByAgent;
			return {
				...state,
				mode: 'select-inject-target',
				injectTargetIndex: 0,
				injectDraft: {
					cc: Boolean(inject?.cc?.integrated),
					cx: Boolean(inject?.cx?.integrated)
				},
				errorText: undefined
			};
		}

		case 'inject-target-nav': {
			if (state.mode !== 'select-inject-target') {
				return state;
			}
			// 上下选择首尾相接（loop）：两侧（Claude Code / Codex）循环，避免边界卡死。
			const targetCount = AGENT_CONTEXT_ORDER.length;
			return {
				...state,
				injectTargetIndex: (state.injectTargetIndex + action.delta + targetCount) % targetCount
			};
		}

		case 'inject-target-toggle': {
			if (state.mode !== 'select-inject-target' || !state.injectDraft) {
				return state;
			}
			const target = state.injectTargetIndex === 1 ? 'cx' : 'cc';
			return {
				...state,
				injectDraft: {...state.injectDraft, [target]: !state.injectDraft[target]}
			};
		}

		case 'request-uninstall': {
			const current = cursorComponent(state);
			if (!current || !canRequestUninstall(current)) {
				return {
					...state,
					errorText:
						current?.lifecycle && !current.lifecycle.canUninstall
							? current.lifecycle.diagnostic
							: '该组件未安装，无需卸载'
				};
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
				latestProgressId: state.uninstallTarget,
				errorText: undefined,
				itemStatus: state.uninstallTarget ? {...state.itemStatus, [state.uninstallTarget]: 'uninstalling'} : state.itemStatus
			};

		case 'cancel':
			return cancel(state);

		case 'cancel-busy':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				injectTargetIndex: 0,
				injectDraft: undefined,
				itemStatus: {},
				progressByComponent: {},
				progressLevelByComponent: {},
				latestProgressId: undefined,
				errorText: undefined
			};

		case 'item-start':
			// 生命周期开始即关闭任何打开的 Modal（inject 开关 Modal 经此路径进入执行态）：
			// 回到 grid 并清理草稿，让「安装中」loading 统一在卡片右上角展示，与单项 i/u 安装一致。
			// 对已在 grid 的 installOne/updateOne 为 no-op。
			return {
				...state,
				mode: 'grid',
				injectTargetIndex: 0,
				injectDraft: undefined,
				itemStatus: {...state.itemStatus, [action.id]: progressTense(action.action)},
				latestProgressId: action.id,
				itemError: omit(state.itemError, action.id),
				errorText: undefined
			};

		case 'item-done':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				injectTargetIndex: 0,
				injectDraft: undefined,
				loaded: true,
				components: action.components,
				itemStatus: {...state.itemStatus, [action.id]: 'idle'},
				progressByComponent: omit(state.progressByComponent, action.id),
				progressLevelByComponent: omit(state.progressLevelByComponent, action.id),
				latestProgressId: state.latestProgressId === action.id ? undefined : state.latestProgressId
			};

		case 'item-patched':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				injectTargetIndex: 0,
				injectDraft: undefined,
				components: patchComponent(state.components, action.id, action.patch),
				itemStatus: {...state.itemStatus, [action.id]: 'idle'},
				itemError: omit(state.itemError, action.id),
				progressByComponent: omit(state.progressByComponent, action.id),
				progressLevelByComponent: omit(state.progressLevelByComponent, action.id),
				latestProgressId: state.latestProgressId === action.id ? undefined : state.latestProgressId,
				errorText: undefined
			};

		case 'item-failed': {
			const components = action.patch
				? patchComponent(action.components ?? state.components, action.id, action.patch)
				: (action.components ?? state.components);
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				uninstallTarget: undefined,
				injectTargetIndex: 0,
				injectDraft: undefined,
				loaded: action.components !== undefined ? true : state.loaded,
				components,
				itemStatus: omit(state.itemStatus, action.id),
				itemError: {...state.itemError, [action.id]: action.error},
				progressByComponent: omit(state.progressByComponent, action.id),
				progressLevelByComponent: omit(state.progressLevelByComponent, action.id),
				latestProgressId: state.latestProgressId === action.id ? undefined : state.latestProgressId,
				errorText: action.error
			};
		}

		case 'batch-start':
			return {
				...state,
				mode: 'busy',
				busyAction: action.action,
				latestProgressId: action.ids[0],
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
				progressByComponent: {},
				progressLevelByComponent: {},
				latestProgressId: undefined
			};

		case 'batch-failed':
			return {
				...state,
				mode: 'grid',
				busyAction: undefined,
				loaded: action.components !== undefined ? true : state.loaded,
				components: action.components ?? state.components,
				itemStatus: {},
				itemError: {},
				progressByComponent: {},
				progressLevelByComponent: {},
				latestProgressId: undefined,
				errorText: action.error
			};

		case 'progress':
			return {
				...state,
				progressByComponent: {...state.progressByComponent, [action.id]: action.message},
				progressLevelByComponent: {...state.progressLevelByComponent, [action.id]: action.level},
				latestProgressId: action.id
			};

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
		case 'select-inject-target':
			return {
				...state,
				mode: 'grid',
				injectTargetIndex: 0,
				injectDraft: undefined,
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
