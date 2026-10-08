import type {KeyEvent} from '@opentui/core';
import type {SystemSettingsAction, SystemSettingsState} from '../../state/system-settings-state.js';
import {viewShortcuts} from '../../state/shortcuts.js';

// 系统设置键盘意图映射（纯函数，无 I/O）。
// 页面：↑/↓ 在两张卡片及密码字段间移动；Tab 与 Ctrl+I 的传统终端输入统一导入。
// Ctrl+O 打开导出明细弹窗，Ctrl+I 先调起系统文件对话框。

export type SystemSettingsKeyIntent =
	| {readonly kind: 'none'}
	| {readonly kind: 'exit'}
	| {readonly kind: 'open-export'}
	| {readonly kind: 'confirm-export'}
	| {readonly kind: 'pick-import'}
	| {readonly kind: 'toggle-auto-update'}
	| {readonly kind: 'clear-saved-password'}
	| {readonly kind: 'save'}
	| {readonly kind: 'action'; readonly action: SystemSettingsAction};

const NONE: SystemSettingsKeyIntent = {kind: 'none'};

function action(value: SystemSettingsAction): SystemSettingsKeyIntent {
	return {kind: 'action', action: value};
}

function normalizeKeyName(name: string): string {
	return name.toLowerCase() === 'return' ? 'enter' : name.toLowerCase();
}

/** Modal 副文案从统一 shortcut registry 派生；页面 footer 由 App 单独渲染。 */
export function systemSettingsHint(subMode: string): string {
	return viewShortcuts('system-settings', subMode)
		.map(shortcut => `${shortcut.key} ${shortcut.label}`)
		.join('  ');
}

export function mapSystemSettingsKey(state: SystemSettingsState, keyEvent: KeyEvent): SystemSettingsKeyIntent {
	if (state.mode === 'busy') {
		return NONE;
	}

	const key = normalizeKeyName(keyEvent.name);
	const appModified = keyEvent.ctrl === true;

	// 导出明细弹窗：Enter 确认并打开系统另存为；背景页面失活。
	if (state.exportModal !== null) {
		if (key === 'enter') return {kind: 'confirm-export'};
		if (key === 'escape') return action({type: 'back'});
		if (key === 'up') return action({type: 'move', delta: -1});
		if (key === 'down') return action({type: 'move', delta: 1});
		if (key === 'space') return action({type: 'toggle'});
		if (key === 'left') return action({type: 'fold', direction: 'collapse'});
		if (key === 'right') return action({type: 'fold', direction: 'expand'});
		return NONE;
	}

	// 导入弹窗：密码阶段只处理 Enter/Esc，输入本身由 TextField 消费。
	if (state.importModal?.kind === 'password') {
		if (key === 'enter') return action({type: 'primary'});
		if (key === 'escape') return action({type: 'back'});
		return NONE;
	}

	if (state.importModal?.kind === 'confirm') {
		if (key === 'enter') return action({type: 'primary'});
		if (key === 'escape') return action({type: 'back'});
		return NONE;
	}

	// 导入明细：Enter 执行导入；含覆盖分类时先进入危险确认。
	if (state.importModal?.kind === 'preview') {
		if (key === 'up') return action({type: 'move', delta: -1});
		if (key === 'down') return action({type: 'move', delta: 1});
		if (key === 'space') return action({type: 'toggle'});
		if (key === 'enter') return action({type: 'primary'});
		if (key === 'escape') return action({type: 'back'});
		if (key === 'left') return action({type: 'fold', direction: 'collapse'});
		if (key === 'right') return action({type: 'fold', direction: 'expand'});
		return NONE;
	}

	// 仅页面密码输入焦点允许清除本机记住的密码；弹窗与背景状态不响应。
	if (state.focus === 'password' && appModified && key === 'k') return {kind: 'clear-saved-password'};
	if (appModified && key === 's') return {kind: 'save'};

	// 系统文件对话框：任何页面焦点下都可调起；密码输入框不抢 Ctrl+O/Ctrl+I。
	if (appModified && key === 'o') return {kind: 'open-export'};
	if ((appModified && key === 'i') || (key === 'tab' && !keyEvent.shift && !keyEvent.meta)) return {kind: 'pick-import'};

	if (key === 'escape') return {kind: 'exit'};
	if (key === 'up' || key === 'down') return action({type: 'move-field', direction: key === 'up' ? -1 : 1});

	if (state.focus === 'auto-update') {
		// 横向原生 tab-select 接管左右键；此处只保留快捷切换键，避免重复回调。
		if (key === 'space' || key === 'enter') {
			return {kind: 'toggle-auto-update'};
		}

		return NONE;
	}

	if (state.focus === 'encryption') {
		if (key === 'space' || key === 'enter') {
			return action({type: 'set-encryption', value: !state.encryption});
		}

		return NONE;
	}

	return NONE;
}
