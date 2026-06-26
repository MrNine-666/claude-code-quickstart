import React, { useRef, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import type { TextareaRenderable, SyntaxStyle, KeyEvent } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import { colors, borderColors } from '../../theme/index.js';
import { ErrorPanel } from '../error-panel.js';
import { handleTextareaEditKeys, handleTextareaIndentKey } from './textarea-edit-keys.js';

// TextareaEditor：编辑/预览双模式内嵌编辑器（HC-EDITOR-OPENTUI，零外部编辑器）
// - 编辑模式：OpenTUI <textarea> 纯文本编辑，Ctrl/Cmd+S 保存、Ctrl/Cmd+Z 撤销、Ctrl/Cmd+C 复制选中、Esc 取消、Ctrl/Cmd+P 切预览、Tab 缩进（2 空格）
// - 预览模式（只读）：markdown 用 <markdown>，代码/JSON 用 <line-number><code>（语法高亮 + 行号），Esc 返回编辑
// - isJson 模式：保存前 JSON.parse 校验，失败显示错误但不退出（容忍中间态）

/** 预览渲染用的文件类型；text 不提供预览（直接禁用切换）。 */
export type EditorFiletype = 'markdown' | 'typescript' | 'javascript' | 'json' | 'text';

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

export function TextareaEditor({
	title,
	initialContent,
	active,
	isJson = false,
	filetype = 'text',
	syntaxStyle = null,
	onModeChange,
	onSave,
	onCancel
}: TextareaEditorProps) {
	const ref = useRef<TextareaRenderable>(null);
	const renderer = useRenderer();
	const [error, setError] = useState<string | null>(null);
	const [mode, setMode] = useState<'edit' | 'preview'>('edit');
	// 预览内容快照（进入预览时从 textarea 取最新文本）。
	const [previewContent, setPreviewContent] = useState(initialContent);

	const canPreview = filetype !== 'text';

	const enterPreview = (): void => {
		// 语法高亮未就绪（Tree-sitter 仍在初始化）时不进预览，避免渲染降级。
		if (!syntaxStyle) {
			return;
		}

		setPreviewContent(ref.current?.plainText ?? initialContent);
		setMode('preview');
		onModeChange?.('preview');
	};

	const backToEdit = (): void => {
		setMode('edit');
		onModeChange?.('edit');
	};

	// Ctrl/Cmd+S 保存：isJson 模式先校验 JSON，再回调 onSave。
	const saveContent = (): void => {
		const content = ref.current?.plainText ?? '';

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

	// 编辑模式 textarea onKeyDown（handleKeyPress 之前）：Tab 缩进 / Shift+Tab 反向缩进。
	const handleEditorKey = (keyEvent: KeyEvent) => {
		if (active && mode === 'edit') {
			handleTextareaIndentKey(keyEvent, ref.current);
		}
	};

	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		const name = keyEvent.name;
		// 跨平台主修饰键：Windows/Linux=Ctrl，macOS=Cmd（KeyEvent.super，非 meta/Alt）。
		const mod = keyEvent.ctrl || keyEvent.super === true;

		// 预览模式：Esc 返回编辑（滚动由 scrollbox 自身处理）。
		if (mode === 'preview') {
			if (name === 'escape') {
				backToEdit();
			}

			return;
		}

		// ── 编辑模式 ──
		if (name === 'escape') {
			onCancel();
			return;
		}

		// Ctrl/Cmd+P 切预览（仅 filetype 支持时）；Tab 已归缩进（onKeyDown）。
		if (canPreview && name === 'p' && mod) {
			enterPreview();
			return;
		}

		// Ctrl/Cmd+S 保存 · Ctrl+Z 撤销 · Ctrl+Shift+Z/Y 重做 · Ctrl/Cmd+C 复制选中（OSC52）。
		handleTextareaEditKeys(keyEvent, ref.current, renderer, saveContent, () => setError(null));
	});

	// ── 预览模式渲染 ──（enterPreview 已保证 syntaxStyle 非 null）
	if (mode === 'preview' && syntaxStyle) {
		return (
			<box flexDirection="column" flexGrow={1}>
				<box marginBottom={1}>
					<text fg={colors.primary} attributes={TextAttributes.BOLD}>
						{`预览 · ${title}`}
					</text>
				</box>

				<box flexGrow={1} borderStyle="rounded" borderColor={borderColors.active}>
					{filetype === 'markdown' ? (
						<scrollbox style={{ flexGrow: 1 }}>
							<markdown content={previewContent} syntaxStyle={syntaxStyle} />
						</scrollbox>
					) : (
						<scrollbox style={{ flexGrow: 1 }}>
							<line-number fg="#6b7280" bg="#161b22" minWidth={3} paddingRight={1} showLineNumbers style={{ flexGrow: 1 }}>
								<code
									content={previewContent}
									filetype={codeFiletype(filetype)}
									syntaxStyle={syntaxStyle}
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
	return (
		<box flexDirection="column" flexGrow={1}>
			<box marginBottom={1}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					{title}
				</text>
			</box>

			<box flexGrow={1} borderStyle="rounded" borderColor={active ? borderColors.active : borderColors.inactive}>
				<textarea ref={ref} initialValue={initialContent} focused={active} onKeyDown={handleEditorKey} style={{ flexGrow: 1 }} />
			</box>

			{error ? (
				<box marginTop={1}>
					<ErrorPanel message={error} />
				</box>
			) : null}
		</box>
	);
}
