import React, { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import type { TextareaRenderable, SyntaxStyle, KeyEvent } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import { colors, borderColors } from '../../theme/index.js';
import { isAppModifier } from '../../utils/keyboard.js';
import { ErrorPanel } from '../error-panel.js';
import { handleTextareaEditKeys, handleTextareaIndentKey } from './textarea-edit-keys.js';

// TextareaEditor：编辑/预览双模式内嵌编辑器（HC-EDITOR-OPENTUI，零外部编辑器）
// - 编辑模式：OpenTUI <textarea> 纯文本编辑，macOS Cmd+S 保存 / Cmd+C 复制，其他平台 Ctrl+S / Ctrl+C；Ctrl+P 切预览、Esc 取消、Tab 缩进（2 空格）
// - 预览模式（只读）：markdown 用 <markdown>，代码/JSON 用 <line-number><code>（语法高亮 + 行号），Esc 返回编辑
// - isJson 模式：保存前 JSON.parse 校验，失败显示错误但不退出（容忍中间态）
// - 命令式能力（forwardRef）：insertText/replaceText/getText/focus/blur，供工作台等父视图程序化插入片段 / 灌缓冲
// - tabMode='cycle-focus'：Tab 不缩进，改由父视图切焦点（工作台双栏）
// - escapeMode='bubble'：编辑态 Esc 不触发 onCancel，交给父视图处理（工作台 Esc 退菜单单一入口）

/** 预览渲染用的文件类型；text 不提供预览（直接禁用切换）。 */
export type EditorFiletype = 'markdown' | 'typescript' | 'javascript' | 'json' | 'text';

/** 命令式句柄：父视图通过 ref 程序化操作编辑器（工作台插入片段 / 灌缓冲）。 */
export type TextEditorHandle = {
	/** 在当前光标处插入文本（不替换全文，保留 undo 历史）。 */
	insertText(text: string): void;
	/** 替换全文并保留 undo 历史（可 Ctrl+Z 撤销）。 */
	replaceText(text: string): void;
	/** 读取当前全文。 */
	getText(): string;
	/** 聚焦 textarea。 */
	focus(): void;
	/** 使 textarea 失焦。 */
	blur(): void;
};

export type TextareaEditorProps = {
	readonly title: string;
	readonly initialContent: string;
	readonly active: boolean;
	// JSON 模式：保存前做 JSON.parse 校验。
	readonly isJson?: boolean;
	// 预览渲染文件类型（默认 text，text 无预览）。
	readonly filetype?: EditorFiletype;
	// Tree-sitter 语法样式（App 初始化后传入；null 时代码预览降级为纯展示）。
	readonly syntaxStyle?: SyntaxStyle | null;
	// 上报子模式给 App footer（edit / preview）。
	readonly onModeChange?: (mode: 'edit' | 'preview') => void;
	// 保存回调：返回 { ok:false, error } 时停留编辑器并展示错误。
	readonly onSave: (content: string) => { ok: boolean; error?: string };
	readonly onCancel: () => void;
	// 内容变更通知（用户输入 / 缩进 / undo/redo / 程序化插入均触发），供父视图做脏标记。
	readonly onContentChange?: () => void;
	// Tab 行为：'indent'（默认，Tab/Shift+Tab 缩进 2 空格）| 'cycle-focus'（Tab 切焦点，由 onCycleFocus 处理）。
	readonly tabMode?: 'indent' | 'cycle-focus';
	// tabMode='cycle-focus' 时 Tab/Shift+Tab 回调（reverse=true 为反向）。
	readonly onCycleFocus?: (reverse: boolean) => void;
	// Esc 行为：'cancel'（默认，Esc → onCancel）| 'bubble'（编辑态 Esc 不处理，交给父视图，避免双触发）。
	readonly escapeMode?: 'cancel' | 'bubble';
	// textarea 是否获焦；不传则回退到 active（向后兼容）。
	readonly textareaFocused?: boolean;
	// 是否启用 Ctrl+P 预览模式（默认 true）。false 时禁用预览
	// （如全局规则页保存后已回只读展示，编辑器内无需重复预览）。
	readonly previewEnabled?: boolean;
};

/** filetype → CodeRenderable 的 filetype 字符串（markdown/text 不走 code 预览）。 */
function codeFiletype(filetype: EditorFiletype): string {
	switch (filetype) {
		case 'json':
			return 'json';
		case 'javascript':
			return 'javascript';
		case 'typescript':
		default:
			return 'typescript';
	}
}

export const TextareaEditor = forwardRef<TextEditorHandle, TextareaEditorProps>(function TextareaEditor({
	title,
	initialContent,
	active,
	isJson = false,
	filetype = 'text',
	syntaxStyle = null,
	onModeChange,
	onSave,
	onCancel,
	onContentChange,
	tabMode = 'indent',
	onCycleFocus,
	escapeMode = 'cancel',
	textareaFocused,
	previewEnabled = true
}, ref) {
	const taRef = useRef<TextareaRenderable>(null);
	const renderer = useRenderer();
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<'edit' | 'preview'>('edit');
	// 预览内容快照（进入预览时从 textarea 取最新文本）。
	const [previewContent, setPreviewContent] = useState(initialContent);

	const canPreview = filetype !== 'text' && previewEnabled !== false;

	const enterPreview = (): void => {
		// 语法高亮未就绪（Tree-sitter 仍在初始化）时不进预览，避免渲染降级。
		if (!syntaxStyle) {
			return;
		}

		setPreviewContent(taRef.current?.plainText ?? initialContent);
		setMode('preview');
		onModeChange?.('preview');
	};

	const backToEdit = (): void => {
		setMode('edit');
		onModeChange?.('edit');
	};

	// 保存：macOS Cmd+S，其他平台 Ctrl+S；isJson 模式先校验 JSON，再回调 onSave。
	const saveContent = (): void => {
		const content = taRef.current?.plainText ?? '';

		if (isJson) {
			try {
				JSON.parse(content);
			} catch (e) {
				setError(`JSON 格式错误: ${e instanceof Error ? e.message : String(e)}`);
				return;
			}
		}

		const result = onSave(content);
		if (!result.ok) {
			setError(result.error ?? '保存失败');
			return;
		}

		setError(null);
	};

	// 编辑模式 textarea onKeyDown（handleKeyPress 之前）：
	// - tabMode='cycle-focus'：Tab/Shift+Tab preventDefault + onCycleFocus（不缩进）
	// - tabMode='indent'：Tab/Shift+Tab 缩进 2 空格，插入后通知内容变更
	const handleEditorKey = (keyEvent: KeyEvent) => {
		if (!active || mode !== 'edit') {
			return;
		}

		if (tabMode === 'cycle-focus') {
			const name = keyEvent.name.toLowerCase();
			if (name === 'tab' || name === 'shift-tab') {
				keyEvent.preventDefault();
				onCycleFocus?.(name === 'shift-tab' || keyEvent.shift === true);
			}
			return;
		}

		if (handleTextareaIndentKey(keyEvent, taRef.current)) {
			onContentChange?.();
		}
	};

	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		const name = keyEvent.name;
		// 预览是 TUI 应用功能，始终使用 Ctrl+P，避免占用 macOS Cmd+P 打印语义。

		// 预览模式：Esc 返回编辑（滚动由 scrollbox 自身处理）。
		if (mode === 'preview') {
			if (name === 'escape') {
				backToEdit();
			}

			return;
		}

		// ── 编辑模式 ──
		if (name === 'escape') {
			// escapeMode='bubble'：编辑态 Esc 交给父视图（工作台退菜单单一入口），不调 onCancel 避免双触发。
			if (escapeMode !== 'bubble') {
				onCancel();
			}
			return;
		}

		// Ctrl+P 切预览（仅 filetype 支持时）；Tab 已归缩进/切焦点（onKeyDown）。
		if (canPreview && name === 'p' && isAppModifier(keyEvent)) {
			enterPreview();
			return;
		}

		// 保存/复制按编辑语义：macOS Cmd，其他平台 Ctrl；预览/面板类动作保留 Ctrl。
		// onContentMutate：undo/redo 走底层 FFI 不触发 onContentChange，需手动通知脏标记 + 清错误。
		handleTextareaEditKeys(keyEvent, taRef.current, renderer, saveContent, () => {
			setError(null);
			onContentChange?.();
		});
	});

	// 命令式句柄：供父视图程序化插入片段 / 灌缓冲 / 读取 / 聚焦。
	useImperativeHandle(ref, () => ({
		insertText: (text: string) => {
			taRef.current?.insertText(text);
			onContentChange?.();
		},
		replaceText: (text: string) => {
			taRef.current?.replaceText(text);
			onContentChange?.();
		},
		getText: () => taRef.current?.plainText ?? '',
		focus: () => taRef.current?.focus(),
		blur: () => taRef.current?.blur()
	}), [onContentChange]);

	// ── 预览模式渲染 ──（enterPreview 已保证 syntaxStyle 非 null）
	if (mode === 'preview' && syntaxStyle) {
		return (
			<box flexDirection="column" flexGrow={1}>
				<box>
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>
						{`预览 · ${title}`}
					</text>
				</box>

				<box flexGrow={1} minHeight={0} borderStyle="rounded" borderColor={borderColors.active}>
					{filetype === 'markdown' ? (
						<scrollbox style={{ flexGrow: 1 }}>
							<markdown content={previewContent} syntaxStyle={syntaxStyle} />
						</scrollbox>
					) : (
						<scrollbox style={{ flexGrow: 1 }}>
							<line-number fg={colors.lineNumberForeground} bg={colors.lineNumberBackground} minWidth={3} paddingRight={1} showLineNumbers style={{ flexGrow: 1 }}>
								<code
									content={previewContent}
									filetype={codeFiletype(filetype)}
									syntaxStyle={syntaxStyle}
									fg={colors.text}
									selectionBg={colors.selectionBg}
									selectionFg={colors.selectionFg}
									style={{ flexGrow: 1 }}
								/>
							</line-number>
						</scrollbox>
					)}
				</box>

				<box marginTop={1}>
					<text attributes={TextAttributes.DIM}>{'Esc 返回编辑 · ↑/↓ 滚动'}</text>
				</box>
			</box>
		);
	}

	// ── 编辑模式渲染 ──
	// 统一 flex 标准：根 box flexGrow={1} 填满父容器，标题行 flexShrink={0} 稳定占 1 行，
	// 边框 box flexGrow={1} minHeight={0} 吃满剩余高度、超出行数由 textarea 自身滚动（光标跟随）。
	// 横向：textarea native measure 把最长逻辑行宽当 min-content，flex 默认不收缩到 min-content
	// 以下，会逐层把边框撑破右边框外、连带挤乱同层推荐栏滚动条 x 位置。minWidth 不向下传导，根 box /
	// 边框 box / textarea 三层各自声明 minWidth={0}，让宽度按父容器分配、内容超出时由 textarea 自身换行。
	return (
		<box flexDirection="column" flexGrow={1} minWidth={0}>
			<box flexShrink={0}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					{title}
				</text>
			</box>

			<box flexGrow={1} minWidth={0} minHeight={0} borderStyle="rounded" borderColor={active ? borderColors.active : borderColors.inactive}>
				<textarea
					ref={taRef}
					initialValue={initialContent}
					focused={textareaFocused ?? active}
					textColor={colors.inputText}
					focusedTextColor={colors.inputFocusedText}
					cursorColor={colors.inputCursor}
					selectionBg={colors.selectionBg}
					selectionFg={colors.selectionFg}
					onContentChange={onContentChange ? () => onContentChange() : undefined}
					onKeyDown={handleEditorKey}
					style={{ flexGrow: 1, minWidth: 0, minHeight: 0 }}
				/>
			</box>

			{error ? (
				<box marginTop={1}>
					<ErrorPanel message={error} />
				</box>
			) : null}
		</box>
	);
});
