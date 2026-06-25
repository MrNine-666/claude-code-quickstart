import React, { useState } from 'react';
import { FormPanel, firstEditableIndex, nextEditableIndex } from '../../components/form/FormPanel.js';
import { serializeEntries, parseEntries } from '../../components/form/KeyValueField.js';
import type { FormField, KeyValueEntry } from '../../components/form/field-types.js';
import type { McpFormModel } from '../../core/mcp-form.js';
import { saveMcpServer, type McpServiceResult } from '../../services/mcp-service.js';

// McpFormView：MCP Server 编辑表单屏（复用通用 FormPanel，参照 provider-form.tsx 范式）。
// - 本期只做基础字段编辑（凭据 / command / args / env），不做字段↔JSON 双向联动（tasks 5.3 分两步走）
// - Server ID 只读（编辑场景不可改名），Enter 保存走 saveMcpServer，Esc 取消返回详情
// - env key-value 字段：序列化为单行 K=V 文本编辑，提交时反序列化为 envEntries

/** 从字段列表派生初始实时值（key-value 序列化为单行 K=V 文本）。 */
function deriveValues(fields: readonly FormField[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const field of fields) {
		result[field.id] = field.type === 'key-value' ? serializeEntries(field.entries) : field.value;
	}

	return result;
}

export type McpFormViewProps = {
	readonly model: McpFormModel;
	readonly active: boolean;
	readonly onSaved: (message: string) => void;
	readonly onError: (error: string) => void;
	readonly onCancel: () => void;
};

export function McpFormView({ model, active, onSaved, onError, onCancel }: McpFormViewProps) {
	const [fields] = useState(model.fields);
	const [values, setValues] = useState<Record<string, string>>(() => deriveValues(model.fields));
	const [focusedIndex, setFocusedIndex] = useState(() => firstEditableIndex(model.fields));
	const [errors, setErrors] = useState<string[]>([]);

	const handleMoveFocus = (direction: 1 | -1) => {
		setFocusedIndex(nextEditableIndex(fields, focusedIndex, direction));
	};

	const handleFieldChange = (id: string, value: string) => {
		setValues((prev) => ({ ...prev, [id]: value }));
		setErrors([]);
	};

	const handleSubmit = () => {
		if (!model.editable) {
			setErrors(['该 MCP 由安装链管理，不支持编辑保存']);
			return;
		}

		// 收集 env key-value 字段（自定义 stdio 的 __env），反序列化为 envEntries。
		let envEntries: readonly KeyValueEntry[] | undefined;
		const envField = fields.find((f) => f.type === 'key-value');
		if (envField) {
			envEntries = parseEntries(values[envField.id] ?? '');
		}

		const result: McpServiceResult = saveMcpServer({ model, values, envEntries });
		if (!result.ok) {
			setErrors([result.error]);
			onError(result.error);
			return;
		}

		onSaved(`已保存 MCP Server ${model.serverId}`);
	};

	return (
		<FormPanel
			title={`编辑 ${model.serverId}`}
			fields={fields}
			values={values}
			focusedIndex={focusedIndex}
			active={active}
			errors={errors}
			onMoveFocus={handleMoveFocus}
			onFieldChange={handleFieldChange}
			onSubmit={handleSubmit}
			onCancel={onCancel}
		/>
	);
}
