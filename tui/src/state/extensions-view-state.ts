import type {PiExtensionPackage, PiExtensionSearchPage} from '../core/extensions.js';

export type ExtensionsFocus = 'search' | 'grid';
export type ExtensionsViewMode = 'installed' | 'search' | 'confirm';
export type ExtensionActionKind = 'install' | 'update' | 'remove' | 'update-all';

export type PendingExtensionTarget = {
	readonly name: string;
	readonly source: string;
};

export type PendingExtensionAction =
	| ({readonly kind: Exclude<ExtensionActionKind, 'update-all'>} & PendingExtensionTarget)
	| {readonly kind: 'update-all'; readonly targets: readonly PendingExtensionTarget[]};

export type ExtensionsViewState = {
	readonly mode: ExtensionsViewMode;
	readonly focus: ExtensionsFocus;
	readonly query: string;
	readonly installed: readonly PiExtensionPackage[];
	readonly searchResults: readonly PiExtensionPackage[];
	readonly cursor: number;
	readonly page: number;
	readonly total: number;
	readonly hasPrevious: boolean;
	readonly hasNext: boolean;
	readonly loading: boolean;
	readonly searching: boolean;
	readonly mutating: boolean;
	readonly errorText?: string;
	readonly pendingAction?: PendingExtensionAction;
};

export type ExtensionsViewAction =
	| {readonly type: 'installed-loaded'; readonly items: readonly PiExtensionPackage[]}
	| {readonly type: 'installed-failed'; readonly error: string}
	| {readonly type: 'query-input'; readonly value: string}
	| {readonly type: 'focus-search'}
	| {readonly type: 'focus-grid'}
	| {readonly type: 'search-start'; readonly page: number}
	| {readonly type: 'search-done'; readonly result: PiExtensionSearchPage}
	| {readonly type: 'search-failed'; readonly error: string}
	| {readonly type: 'move'; readonly direction: 'up' | 'down' | 'left' | 'right'}
	| {readonly type: 'open-confirm'; readonly action: PendingExtensionAction}
	| {readonly type: 'cancel-confirm'}
	| {readonly type: 'mutation-start'}
	| {readonly type: 'mutation-done'}
	| {readonly type: 'mutation-failed'; readonly error: string};

export function createInitialExtensionsViewState(): ExtensionsViewState {
	return {
		mode: 'installed',
		focus: 'grid',
		query: '',
		installed: [],
		searchResults: [],
		cursor: 0,
		page: 0,
		total: 0,
		hasPrevious: false,
		hasNext: false,
		loading: true,
		searching: false,
		mutating: false
	};
}

export function visibleExtensions(state: ExtensionsViewState): readonly PiExtensionPackage[] {
	return state.query.trim() ? state.searchResults : state.installed;
}

export function selectedExtension(state: ExtensionsViewState): PiExtensionPackage | undefined {
	return visibleExtensions(state)[state.cursor];
}

export function isExtensionInstalled(
	item: Pick<PiExtensionPackage, 'name' | 'source' | 'installed'>,
	installed: readonly PiExtensionPackage[]
): boolean {
	if (item.installed) return true;
	const target = extensionIdentity(item.source || item.name);
	return installed.some(
		candidate =>
			extensionIdentity(candidate.source || candidate.name) === target ||
			extensionIdentity(candidate.name) === extensionIdentity(item.name)
	);
}

export function reduceExtensionsViewState(state: ExtensionsViewState, action: ExtensionsViewAction): ExtensionsViewState {
	switch (action.type) {
		case 'installed-loaded':
			return {
				...state,
				installed: action.items,
				loading: false,
				cursor: clampCursor(state.cursor, state.query.trim() ? state.searchResults.length : action.items.length),
				errorText: undefined
			};
		case 'installed-failed':
			return {...state, loading: false, errorText: action.error};
		case 'query-input': {
			const query = action.value;
			return {
				...state,
				query,
				mode: query.trim() ? 'search' : 'installed',
				searchResults: query.trim() ? [] : state.searchResults,
				cursor: 0,
				page: 0,
				total: 0,
				hasPrevious: false,
				hasNext: false,
				errorText: undefined
			};
		}
		case 'focus-search':
			return state.mode === 'confirm' ? state : {...state, focus: 'search'};
		case 'focus-grid':
			return state.mode === 'confirm' ? state : {...state, focus: 'grid'};
		case 'search-start':
			return {
				...state,
				mode: 'search',
				focus: 'grid',
				searching: true,
				searchResults: [],
				cursor: 0,
				page: action.page,
				errorText: undefined
			};
		case 'search-done':
			return {
				...state,
				mode: 'search',
				focus: 'grid',
				searching: false,
				searchResults: action.result.items,
				cursor: 0,
				page: action.result.page,
				total: action.result.total,
				hasPrevious: action.result.hasPrevious,
				hasNext: action.result.hasNext,
				errorText: undefined
			};
		case 'search-failed':
			return {
				...state,
				mode: 'search',
				focus: 'grid',
				searching: false,
				searchResults: [],
				cursor: 0,
				errorText: action.error
			};
		case 'move':
			return state.mode === 'confirm' || state.focus !== 'grid'
				? state
				: {...state, cursor: moveGridCursor(state.cursor, visibleExtensions(state).length, action.direction)};
		case 'open-confirm':
			return {...state, mode: 'confirm', pendingAction: action.action, errorText: undefined};
		case 'cancel-confirm':
			return {
				...state,
				mode: state.query.trim() ? 'search' : 'installed',
				pendingAction: undefined,
				mutating: false,
				errorText: undefined
			};
		case 'mutation-start':
			return {...state, mutating: true, errorText: undefined};
		case 'mutation-done':
			return {
				...state,
				mode: state.query.trim() ? 'search' : 'installed',
				pendingAction: undefined,
				mutating: false
			};
		case 'mutation-failed':
			return {
				...state,
				mode: state.query.trim() ? 'search' : 'installed',
				pendingAction: undefined,
				mutating: false,
				errorText: action.error
			};
	}
}

export function extensionsSubMode(state: ExtensionsViewState): string {
	if (state.mode === 'confirm') return 'confirm';
	if (state.mutating) return 'mutating';
	if (state.searching) return 'searching';
	if (state.focus === 'search') return 'search';
	if (state.mode === 'installed') return 'installed-grid';
	const selected = selectedExtension(state);
	return selected && !isExtensionInstalled(selected, state.installed) ? 'grid-uninstalled' : 'grid';
}

function clampCursor(cursor: number, length: number): number {
	return length === 0 ? 0 : Math.min(Math.max(cursor, 0), length - 1);
}

function moveGridCursor(cursor: number, length: number, direction: 'up' | 'down' | 'left' | 'right'): number {
	if (length === 0) return 0;
	switch (direction) {
		case 'up':
			return clampCursor(cursor - 2, length);
		case 'down':
			return clampCursor(cursor + 2, length);
		case 'left':
			return clampCursor(cursor - 1, length);
		case 'right':
			return clampCursor(cursor + 1, length);
	}
}

function extensionIdentity(value: string): string {
	const normalized = value.replace(/^npm:/, '').replace(/@latest$/, '');
	if (normalized.startsWith('@')) {
		const separator = normalized.indexOf('@', 1);
		return separator > 0 ? normalized.slice(0, separator) : normalized;
	}
	const separator = normalized.indexOf('@');
	return separator > 0 ? normalized.slice(0, separator) : normalized;
}
