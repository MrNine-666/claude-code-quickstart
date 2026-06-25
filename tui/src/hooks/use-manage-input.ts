import { useBindings } from '@opentui/keymap/react';
import type { ManageKeyName } from '../state/manage-state.js';

const manageInputBindings: readonly { readonly key: string; readonly keyName: ManageKeyName }[] = [
	{ key: 'up', keyName: 'up' },
	{ key: 'down', keyName: 'down' },
	{ key: 'left', keyName: 'left' },
	{ key: 'right', keyName: 'right' },
	{ key: 'enter', keyName: 'enter' },
	{ key: 'escape', keyName: 'escape' },
	{ key: 'tab', keyName: 'tab' },
	{ key: 'shift+tab', keyName: 'shift-tab' },
	{ key: 'ctrl+s', keyName: 'ctrl-s' },
	{ key: 'ctrl+c', keyName: 'ctrl-c' },
	{ key: 'q', keyName: 'q' }
];

/**
 * Phase 1B.4：基于 keymap useBindings 的全局键盘输入处理。
 * 保留原签名兼容（onKey, enabled），内部改用 keymap 绑定层。
 */
export function useManageInput(
	onKey: (keyName: ManageKeyName) => void,
	enabled = true
): void {
	useBindings(() => ({
		name: 'manage-input-nav',
		enabled,
		priority: 100,
		bindings: manageInputBindings.map(({ key, keyName }) => ({
			key,
			cmd: () => {
				onKey(keyName);
			}
		}))
	}), [onKey, enabled]);
}
