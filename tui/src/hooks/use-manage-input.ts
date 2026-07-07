import { useBindings } from '@opentui/keymap/react';
import type { ManageKeyName } from '../state/manage-state.js';

const manageInputBindings: readonly { readonly key: string; readonly keyName: ManageKeyName }[] = [
	{ key: 'up', keyName: 'up' },
	{ key: 'down', keyName: 'down' },
	{ key: 'left', keyName: 'left' },
	{ key: 'right', keyName: 'right' },
	// OpenTUI 键盘事件将回车规范化为 return；同时保留 enter 兼容部分组件/终端别名。
	{ key: 'return', keyName: 'enter' },
	{ key: 'enter', keyName: 'enter' },
	{ key: 'escape', keyName: 'escape' },
	{ key: 'tab', keyName: 'tab' },
	{ key: 'q', keyName: 'q' }
];

/**
 * Phase 1B.4：基于 keymap useBindings 的全局键盘输入处理。
 * 保留原签名兼容（onKey, enabled），内部改用 keymap 绑定层。
 *
 * 注意：keymap 不识别 layer 的 `enabled` 字段（会触发 "Unknown layer field enabled"
 * 警告并被忽略），所以这里改为——禁用时注册空 bindings，使该 layer 不拦截任何按键。
 * 否则导航绑定（enter/escape 等）会在视图获焦时仍生效并 stopPropagation，阻断视图
 * 自身的 useKeyboard（这正是 textarea 里 Ctrl+S 等失效的根因）。
 */
export function useManageInput(
	onKey: (keyName: ManageKeyName) => void,
	enabled = true
): void {
	useBindings(() => ({
		name: 'manage-input-nav',
		priority: 100,
		bindings: enabled
			? manageInputBindings.map(({ key, keyName }) => ({
					key,
					cmd: () => {
						onKey(keyName);
					}
				}))
			: []
	}), [onKey, enabled]);
}
