import type { TextareaRenderable, CliRenderer, KeyEvent } from '@opentui/core';

type KeyEventLike = {
	readonly name: string;
	readonly ctrl?: boolean;
	readonly super?: boolean;
	readonly shift?: boolean;
};

/**
 * textarea 通用编辑快捷键：Ctrl/Cmd+S 保存、Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做、
 * Ctrl/Cmd+C 复制选中文字（OSC52 写系统剪贴板）。
 *
 * 命中并处理时返回 true（调用方应立即 return，不再处理该按键）；未命中返回 false。
 *
 * 设计要点：
 * - Ctrl+Z / Ctrl+Y 仅绑 Ctrl：macOS Cmd+Z / Shift+Cmd+Z 由 textarea 默认 keyBindings 处理，避免双触发；
 * - Ctrl/Cmd+S 与 Ctrl/Cmd+C 绑主修饰键 mod（Windows/Linux=Ctrl，macOS=Cmd/super），跨平台一致；
 * - OSC52 复制在终端不支持或无选中文本时静默跳过。
 */
export function handleTextareaEditKeys(
	keyEvent: KeyEventLike,
	textarea: TextareaRenderable | null,
	renderer: CliRenderer | null,
	onSave: () => void,
	onContentMutate?: () => void
): boolean {
	const name = keyEvent.name.toLowerCase();
	const mod = keyEvent.ctrl || keyEvent.super === true;

	if (name === 's' && mod) {
		onSave();
		return true;
	}

	if (name === 'z' && keyEvent.ctrl) {
		if (keyEvent.shift) {
			textarea?.redo();
		} else {
			textarea?.undo();
		}

		// undo/redo 走底层 FFI，不触发 onContentChange，需手动通知调用方重新解析。
		onContentMutate?.();
		return true;
	}

	if (name === 'y' && keyEvent.ctrl) {
		textarea?.redo();
		onContentMutate?.();
		return true;
	}

	if (name === 'c' && mod) {
		if (textarea && textarea.hasSelection() && renderer?.isOsc52Supported()) {
			const selected = textarea.getSelectedText();
			if (selected) {
				renderer.copyToClipboardOSC52(selected);
			}
		}

		return true;
	}

	return false;
}

/** 删除 textarea 当前行行首至多 2 个空格（Shift+Tab 反向缩进）。 */
function outdentCurrentLine(ta: TextareaRenderable): void {
	const cursor = ta.logicalCursor;
	if (!cursor) {
		return;
	}

	// 从 plainText 取当前行（避免 getTextRangeByCoords 列语义不确定）。
	const lineText = ta.plainText.split('\n')[cursor.row] ?? '';
	const match = lineText.match(/^ {1,2}/);
	if (!match) {
		return;
	}

	ta.deleteRange(cursor.row, 0, cursor.row, match[0].length);
}

/**
 * textarea Tab 缩进 / Shift+Tab 反向缩进。须在 textarea 的 onKeyDown（handleKeyPress 之前）调用：
 * 命中 Tab 时 preventDefault 阻止 textarea 默认行为，并插入 / 删除 2 空格，返回 true；否则返回 false。
 */
export function handleTextareaIndentKey(keyEvent: KeyEvent, textarea: TextareaRenderable | null): boolean {
	// 兼容 Shift+Tab 的两种键名：'shift-tab'（部分终端）与 'tab'+shift（kitty 协议）。
	const name = keyEvent.name.toLowerCase();
	if (name !== 'tab' && name !== 'shift-tab') {
		return false;
	}

	const isOutdent = name === 'shift-tab' || keyEvent.shift;
	keyEvent.preventDefault();
	if (textarea) {
		if (isOutdent) {
			outdentCurrentLine(textarea);
		} else {
			textarea.insertText('  ');
		}
	}

	return true;
}
