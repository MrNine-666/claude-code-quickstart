import type {KeyEvent} from '@opentui/core';
import type {PiExtensionPackage} from '../../core/extensions.js';
import {
	isExtensionInstalled,
	selectedExtension,
	type ExtensionsViewAction,
	type ExtensionsViewState,
	type PendingExtensionAction
} from '../../state/extensions-view-state.js';

export type ExtensionsViewInputHandlers = {
	readonly dispatch: (action: ExtensionsViewAction) => void;
	readonly onSearch: (page: number) => void;
	readonly onOpenExternal: (item: PiExtensionPackage) => void;
	readonly onOpenConfirm: (action: PendingExtensionAction) => void;
	readonly onRunConfirm: (action: PendingExtensionAction) => void;
	readonly onExitToNav: () => void;
};

// 扩展页与 Skills 安装页保持同一焦点合同：搜索框 ↔ 结果 Grid 由 Tab 切换，
// 搜索框 Enter 才触发远端查询，Grid 的 Enter/D 执行安装/更新/卸载意图。
export function handleExtensionsKey(
	keyEvent: KeyEvent,
	view: ExtensionsViewState,
	handlers: ExtensionsViewInputHandlers,
	installed: Parameters<typeof isExtensionInstalled>[1]
): void {
	if (view.mutating) return;
	const key = keyEvent.name.toLowerCase();

	if (view.mode === 'confirm') {
		if (key === 'escape') {
			keyEvent.preventDefault?.();
			handlers.dispatch({type: 'cancel-confirm'});
			return;
		}
		if (key === 'enter' || key === 'return') {
			keyEvent.preventDefault?.();
			if (view.pendingAction) handlers.onRunConfirm(view.pendingAction);
			return;
		}
		return;
	}

	if (view.focus === 'search') {
		if (key === 'tab') {
			keyEvent.preventDefault?.();
			handlers.dispatch({type: 'focus-grid'});
			return;
		}
		return;
	}

	if (key === 'tab') {
		keyEvent.preventDefault?.();
		handlers.dispatch({type: 'focus-search'});
		return;
	}
	if (key === 'escape') {
		handlers.onExitToNav();
		return;
	}
	if ((key === 'left' || key === 'arrowleft') && view.cursor === 0) {
		keyEvent.preventDefault?.();
		handlers.onExitToNav();
		return;
	}

	if (
		key === 'up' ||
		key === 'arrowup' ||
		key === 'down' ||
		key === 'arrowdown' ||
		key === 'left' ||
		key === 'arrowleft' ||
		key === 'right' ||
		key === 'arrowright'
	) {
		keyEvent.preventDefault?.();
		handlers.dispatch({type: 'move', direction: directionOf(key)});
		return;
	}

	if (key === 'pageup' && view.hasPrevious && view.query.trim()) {
		keyEvent.preventDefault?.();
		handlers.onSearch(view.page - 1);
		return;
	}
	if (key === 'pagedown' && view.hasNext && view.query.trim()) {
		keyEvent.preventDefault?.();
		handlers.onSearch(view.page + 1);
		return;
	}

	if (key === 'a') {
		if (installed.length === 0) return;
		keyEvent.preventDefault?.();
		handlers.onOpenConfirm({
			kind: 'update-all',
			targets: installed.map(item => ({name: item.name, source: item.source}))
		});
		return;
	}

	if (key === 'enter' || key === 'return') {
		keyEvent.preventDefault?.();
		const item = selectedExtension(view);
		if (!item) return;
		handlers.onOpenConfirm({
			kind: isExtensionInstalled(item, installed) ? 'update' : 'install',
			name: item.name,
			source: item.source
		});
		return;
	}

	if (key === 'o') {
		keyEvent.preventDefault?.();
		const item = selectedExtension(view);
		if (item) handlers.onOpenExternal(item);
		return;
	}

	if (key === 'd') {
		const item = selectedExtension(view);
		if (!item || !isExtensionInstalled(item, installed)) return;
		keyEvent.preventDefault?.();
		handlers.onOpenConfirm({kind: 'remove', name: item.name, source: item.source});
	}
}

function directionOf(key: string): 'up' | 'down' | 'left' | 'right' {
	if (key === 'up' || key === 'arrowup') return 'up';
	if (key === 'down' || key === 'arrowdown') return 'down';
	if (key === 'left' || key === 'arrowleft') return 'left';
	return 'right';
}
