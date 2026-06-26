import React, {useEffect, useRef, useState} from 'react';
import {TextAttributes, type TextareaRenderable} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {borderColors, colors} from '../../theme/index.js';
import {FormLabel} from '../../components/form/FormLabel.js';
import {FormControlFrame} from '../../components/form/FormControlFrame.js';
import {getDefinition, saveMcpServer} from '../../services/mcp-service.js';
import {getMcpTemplateJson, listBuiltinMcpOptions} from '../../core/mcp-form.js';

// McpFormView：MCP 表单屏（JSON 即真源范式，对齐供应商「表单内编辑」但去掉字段区）
// - add：模板选择（‹ 名称 ›，←/→ 切换；选内置即带出 JSON + Server ID + 凭据提示）+ Server ID（可填）+ JSON 编辑区
// - edit：Server ID 只读 + JSON 编辑区（加载现有 config）
// - 焦点：template → id → json（Tab 循环）；edit 固定 json
// - Ctrl/Cmd+S 保存（解析 JSON 落盘），Esc 取消

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

type FocusTarget = 'template' | 'id' | 'json';

export function McpFormView({mode, serverId, initialJson, active, contentHeight = 16, onSaved, onCancel}: McpFormViewProps) {
	// 模板选项：自定义（空白）+ 内置 MCP 列表。useRef 固定一次构造，避免重渲染重建。
	const templateOptions = useRef([{value: CUSTOM_TEMPLATE, label: '自定义'}, ...listBuiltinMcpOptions()]).current;

	const [focus, setFocus] = useState<FocusTarget>(mode === 'add' ? 'template' : 'json');
	const [templateId, setTemplateId] = useState(CUSTOM_TEMPLATE);
	const [serverIdText, setServerIdText] = useState(mode === 'add' ? '' : serverId);
	const [jsonText, setJsonText] = useState(initialJson);
	// edit 模式：若为 env-file 类内置 MCP（原由安装链管理），提示用户修改将直接写入 config。
	const [credHint, setCredHint] = useState<string | undefined>(() =>
		mode === 'edit' && getDefinition(serverId)?.CredentialType === 'env-file'
			? '该 MCP 原由安装链用 env-file 管理，此处修改直接写入 config.env'
			: undefined
	);
	const [errors, setErrors] = useState<string[]>([]);
	const textareaRef = useRef<TextareaRenderable>(null);

	const isAdd = mode === 'add';

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

	function changeTemplate(direction: 1 | -1): void {
		const idx = Math.max(0, templateOptions.findIndex((option) => option.value === templateId));
		const next = templateOptions[(idx + direction + templateOptions.length) % templateOptions.length]!;
		applyTemplate(next.value);
	}

	// 焦点循环：add = template → id → json；edit = json。
	function moveFocus(direction: 1 | -1): void {
		const order: FocusTarget[] = isAdd ? ['template', 'id', 'json'] : ['json'];
		const idx = order.indexOf(focus);
		const next = order[(idx + direction + order.length) % order.length]!;
		setFocus(next);
	}

	// 切模板（或编辑回填）后把 jsonText 推到 textarea；用户在 textarea 内编辑产生的同值 setJsonText 不会触发 setText（plainText 已等）。
	useEffect(() => {
		const ta = textareaRef.current;
		if (!ta || ta.plainText === jsonText) {
			return;
		}

		ta.setText(jsonText);
	}, [jsonText]);

	useKeyboard((keyEvent) => {
		if (!active) {
			return;
		}

		const name = keyEvent.name.toLowerCase();
		const mod = keyEvent.ctrl || keyEvent.super === true;

		// Ctrl/Cmd+S 保存（须在修饰键放行之前捕获）。
		if (name === 's' && mod) {
			handleSubmit();
			return;
		}

		// 放行其余 Ctrl/Meta/Super 组合（粘贴、终端快捷键）。
		if (keyEvent.ctrl || keyEvent.meta || keyEvent.super) {
			return;
		}

		if (name === 'escape') {
			onCancel();
			return;
		}

		if (name === 'tab' || name === 'shift-tab') {
			moveFocus(name === 'shift-tab' || keyEvent.shift ? -1 : 1);
			return;
		}

		// 仅模板焦点捕获 ←/→ 切换；其余焦点放行给 input/textarea（光标移动）。
		if (focus === 'template') {
			if (name === 'left' || name === 'arrowleft') {
				changeTemplate(-1);
				return;
			}

			if (name === 'right' || name === 'arrowright') {
				changeTemplate(1);
				return;
			}
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
	const currentTemplateLabel = templateOptions.find((option) => option.value === templateId)?.label ?? '自定义';

	return (
		<box flexDirection="column">
			<box marginBottom={1}>
				<text fg={colors.primary} attributes={TextAttributes.BOLD}>
					{isAdd ? '新增 MCP Server' : `编辑 ${serverId}`}
				</text>
			</box>

			{/* 模板选择（仅 add）*/}
			{isAdd ? (
				<box flexDirection="row" alignItems="center" marginBottom={1}>
					<FormLabel label="模板" focused={focus === 'template'} />
					<FormControlFrame>
						<text fg={focus === 'template' ? colors.primary : colors.muted}>{`‹ ${currentTemplateLabel} ›`}</text>
					</FormControlFrame>
				</box>
			) : null}

			{/* Server ID（add 可填 / edit 只读）*/}
			<box flexDirection="row" alignItems="center" marginBottom={1}>
				<FormLabel label="Server ID" focused={isAdd && focus === 'id'} />
				{isAdd ? (
					<FormControlFrame>
						{active && focus === 'id' ? (
							<input
								value={serverIdText}
								placeholder="my-server"
								focused
								onInput={(value: string) => {
									setServerIdText(value);
									setErrors([]);
								}}
							/>
						) : (
							<text fg={serverIdText ? undefined : 'gray'}>{serverIdText || '（输入英文 ID）'}</text>
						)}
					</FormControlFrame>
				) : (
					<FormControlFrame>
						<text fg={colors.muted}>{serverId}</text>
					</FormControlFrame>
				)}
			</box>

			{/* 凭据获取提示（选内置模板带出）*/}
			{credHint ? (
				<box marginBottom={1}>
					<text fg="gray" attributes={TextAttributes.DIM}>{`凭据获取：${credHint}`}</text>
				</box>
			) : null}

			{/* JSON 编辑区（真源）*/}
			<box flexDirection="column">
				<text fg={focus === 'json' ? colors.primary : colors.muted} attributes={focus === 'json' ? TextAttributes.BOLD : 0}>
					{`${focus === 'json' ? '› ' : '  '}配置 JSON（直接编辑，保存时以此为准）`}
				</text>
				<box height={jsonHeight} borderStyle="rounded" borderColor={focus === 'json' ? borderColors.active : borderColors.inactive}>
					<textarea
						ref={textareaRef}
						initialValue={jsonText}
						focused={active && focus === 'json'}
						wrapMode="word"
						style={{flexGrow: 1}}
						onContentChange={() => {
							setJsonText(textareaRef.current?.plainText ?? jsonText);
							setErrors([]);
						}}
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
