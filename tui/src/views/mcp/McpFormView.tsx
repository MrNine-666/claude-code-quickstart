import React, {useEffect, useRef, useState} from 'react';
import {TextAttributes, type KeyEvent, type TextareaRenderable} from '@opentui/core';
import {useKeyboard, useRenderer} from '@opentui/react';
import {FormPanel, firstEditableIndex, nextEditableIndex} from '../../components/form/FormPanel.js';
import {handleTextareaEditKeys, handleTextareaIndentKey} from '../../components/editor/textarea-edit-keys.js';
import type {FormField} from '../../components/form/field-types.js';
import {getDefinition, saveMcpServer} from '../../services/mcp-service.js';
import {getMcpTemplateJson, listBuiltinMcpOptions, parseMcpJsonFormat} from '../../core/mcp-form.js';
import {borderColors, colors} from '../../theme/index.js';

// McpFormView：MCP 表单屏（JSON 即真源范式，复用 FormPanel 与供应商表单同构）
// - add：模板（radio，←/→ 或 Tab 切换；选内置即带出 JSON + Server ID + 凭据提示）+ Server ID（可填）+ JSON 编辑区
// - edit：Server ID 只读（标题展示）+ JSON 编辑区（加载现有 config）
// - 焦点：字段区 ↑/↓ 切换（FormPanel 统一），JSON textarea 第一行 ↑ / 最后行 ↓ 切字段
// - Ctrl/Cmd+S 保存（解析 JSON 落盘），Esc 取消
// 键位与供应商表单完全一致（复用 FormPanel + textarea-edit-keys），footer 已声明 ↑/↓ 字段 · ←/→ 选项。

// 「自定义」模板占位值（对应空白 JSON）。
const CUSTOM_TEMPLATE = '';
const BLANK_JSON = '{}\n';

export type McpFormViewProps = {
	readonly mode: 'add' | 'edit';
	// edit 模式的只读 Server ID；add 模式忽略（用户在表单内填）。
	readonly serverId: string;
	// 初始 JSON：edit=现有 config，add=空白。
	readonly initialJson: string;
	readonly active: boolean;
	readonly contentHeight?: number;
	readonly onSaved: (message: string) => void;
	readonly onCancel: () => void;
};

export function McpFormView({mode, serverId, initialJson, active, contentHeight = 16, onSaved, onCancel}: McpFormViewProps) {
	// 模板选项：自定义（空白）+ 内置 MCP 列表。useRef 固定一次构造，避免重渲染重建。
	const templateOptions = useRef([{value: CUSTOM_TEMPLATE, label: '自定义'}, ...listBuiltinMcpOptions()]).current;

	const isAdd = mode === 'add';

	// 字段定义（结构稳定；实时值经 values 注入，不嵌进字段，避免每次输入重建数组）。
	const fields: FormField[] = isAdd
		? [
				{id: 'template', type: 'radio', label: '模板', value: CUSTOM_TEMPLATE, options: templateOptions},
				{id: 'id', type: 'text', label: 'Server ID', value: '', helpText: '英文 ID，如 my-server'}
		  ]
		: [];

	const [focusedIndex, setFocusedIndex] = useState(0);
	const [templateId, setTemplateId] = useState(CUSTOM_TEMPLATE);
	const [serverIdText, setServerIdText] = useState(isAdd ? '' : serverId);
	const [jsonText, setJsonText] = useState(initialJson);
	// edit 模式：若为 env-file 类内置 MCP（原由安装链管理），提示用户修改将直接写入 config。
	const [credHint, setCredHint] = useState<string | undefined>(() =>
		mode === 'edit' && getDefinition(serverId)?.CredentialType === 'env-file'
			? '该 MCP 原由安装链用 env-file 管理，此处修改直接写入 config.env'
			: undefined
	);
	const [errors, setErrors] = useState<string[]>([]);
	const textareaRef = useRef<TextareaRenderable>(null);
	const renderer = useRenderer();

	// values 实时值（FormPanel 按 field.id 取，缺省回落 field.value）。
	const values: Record<string, string> = isAdd ? {template: templateId, id: serverIdText} : {};

	// JSON 区视为虚拟字段 fields.length：focusedIndex 落在字段内为字段焦点，等于 fields.length 为 JSON 焦点。
	const jsonFocused = focusedIndex === fields.length;
	const fieldFocused = !jsonFocused;

	// 应用模板：自定义给空白；内置带出 JSON + Server ID + 凭据提示。
	function applyTemplate(id: string): void {
		setTemplateId(id);
		if (id === CUSTOM_TEMPLATE) {
			setServerIdText('');
			setJsonText(BLANK_JSON);
			setCredHint(undefined);
			return;
		}

		const tpl = getMcpTemplateJson(id);
		if (tpl) {
			setServerIdText(id);
			setJsonText(tpl.json);
			setCredHint(tpl.credHint);
		}
	}

	// 字段间焦点切换（含 JSON 虚拟字段 = fields.length）：↑/↓ 跳过只读，循环。与供应商表单同构。
	function handleMoveFocus(direction: 1 | -1): void {
		setFocusedIndex((current) => {
			if (current === fields.length) {
				// textarea 按 ↑/↓ 切回紧邻的真实字段（越界 → nextEditableIndex 返回末位/首位）。
				return direction > 0 ? firstEditableIndex(fields) : nextEditableIndex(fields, fields.length, -1);
			}

			const next = nextEditableIndex(fields, current, direction);
			if (direction > 0 && next <= current) {
				return fields.length;
			}

			if (direction < 0 && next >= current) {
				return fields.length;
			}

			return next;
		});
	}

	// radio/select 选项切换（仅模板字段）：按方向算下一个模板并应用，带出 JSON + ID + credHint。
	function handleSelectChange(id: string, direction: 1 | -1): void {
		if (id !== 'template') {
			return;
		}

		const currentIndex = Math.max(0, templateOptions.findIndex((option) => option.value === templateId));
		const nextIndex = (currentIndex + direction + templateOptions.length) % templateOptions.length;
		const next = templateOptions[nextIndex];
		if (next) {
			applyTemplate(next.value);
		}
	}

	// 文本字段输入（Server ID）。
	function handleFieldChange(id: string, value: string): void {
		if (id === 'id') {
			setServerIdText(value);
		}

		setErrors([]);
	}

	// JSON 区编辑：JSON 即真源，更新文本 + 实时校验格式（对齐供应商表单：编辑即提示，无需等保存）。
	function handleJsonChange(content: string): void {
		setJsonText(content);
		const format = parseMcpJsonFormat(content);
		setErrors(format.ok ? [] : [format.error]);
	}

	// 切模板（或编辑回填）后把 jsonText 推到 textarea；用户在 textarea 内编辑产生的同值 setJsonText 不会触发 setText（plainText 已等）。
	useEffect(() => {
		const ta = textareaRef.current;
		if (!ta || ta.plainText === jsonText) {
			return;
		}

		ta.setText(jsonText);
	}, [jsonText]);

	// JSON textarea 键位（onKeyDown，handleKeyPress 之前）：Tab 缩进 + 边界 ↑/↓ 切字段。
	function handleTextareaKey(keyEvent: KeyEvent): void {
		if (handleTextareaIndentKey(keyEvent, textareaRef.current)) {
			return;
		}

		const ta = textareaRef.current;
		if (!ta) {
			return;
		}

		// 边界导航：第一行按 ↑ 切上一字段，最后行按 ↓ 切下一字段；中间行放行让 textarea 换行。
		const name = keyEvent.name.toLowerCase();
		const line = ta.logicalCursor?.row ?? 0;
		const last = Math.max(0, (ta.lineCount ?? 1) - 1);
		if ((name === 'up' || name === 'arrowup') && line <= 0) {
			keyEvent.preventDefault();
			handleMoveFocus(-1);
			return;
		}

		if ((name === 'down' || name === 'arrowdown') && line >= last) {
			keyEvent.preventDefault();
			handleMoveFocus(1);
		}
	}

	// JSON 区全局键位：Ctrl/Cmd+S 保存 · Ctrl+Z/Y 撤销重做 · Ctrl/Cmd+C 复制（OSC52）；Esc 取消整个表单。
	// 与供应商表单 JSON 区完全一致（复用 handleTextareaEditKeys）。
	useKeyboard((keyEvent) => {
		if (!active || !jsonFocused) {
			return;
		}

		if (handleTextareaEditKeys(
			keyEvent,
			textareaRef.current,
			renderer,
			handleSubmit,
			() => handleJsonChange(textareaRef.current?.plainText ?? jsonText)
		)) {
			return;
		}

		// textarea 的 Tab/方向键已由上方 onKeyDown 直接处置；这里只兜底 Esc 取消整个表单。
		if (keyEvent.name.toLowerCase() === 'escape') {
			onCancel();
		}
	});

	function handleSubmit(): void {
		const id = (isAdd ? serverIdText : serverId).trim();
		const result = saveMcpServer(id, jsonText);
		if (!result.ok) {
			setErrors([result.error]);
			return;
		}

		onSaved(`已保存 MCP Server ${id}`);
	}

	const jsonHeight = Math.max(5, contentHeight - (isAdd ? 10 : 7));
	const title = isAdd ? '新增 MCP Server' : `编辑 ${serverId}`;

	return (
		<box flexDirection="column">
			<FormPanel
				title={title}
				fields={fields}
				values={values}
				focusedIndex={fieldFocused ? focusedIndex : -1}
				active={active && fieldFocused}
				errors={undefined}
				onMoveFocus={handleMoveFocus}
				onSelectChange={handleSelectChange}
				onFieldChange={handleFieldChange}
				onSubmit={handleSubmit}
				onCancel={onCancel}
			/>

			{/* 凭据获取提示（选内置模板带出 / edit env-file 提示）*/}
			{credHint ? (
				<box marginBottom={1}>
					<text fg="gray" attributes={TextAttributes.DIM}>{`凭据获取：${credHint}`}</text>
				</box>
			) : null}

			{/* JSON 编辑区（真源）*/}
			<box flexDirection="column">
				<text fg={jsonFocused ? colors.primary : colors.muted} attributes={jsonFocused ? TextAttributes.BOLD : 0}>
					{`${jsonFocused ? '› ' : '  '}配置 JSON（直接编辑，保存时以此为准）`}
				</text>
				<box height={jsonHeight} borderStyle="rounded" borderColor={jsonFocused ? borderColors.active : borderColors.inactive}>
					<textarea
						ref={textareaRef}
						initialValue={jsonText}
						focused={active && jsonFocused}
						wrapMode="word"
						style={{flexGrow: 1}}
						onKeyDown={handleTextareaKey}
						onContentChange={() => handleJsonChange(textareaRef.current?.plainText ?? jsonText)}
					/>
				</box>
			</box>

			{errors.length > 0 ? (
				<box marginTop={1}>
					<text fg={colors.danger}>{errors.join('；')}</text>
				</box>
			) : null}
		</box>
	);
}
