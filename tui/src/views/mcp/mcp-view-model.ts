import type { FormField, KeyValueEntry } from '../../components/form/field-types.js';
import type { McpFormModel } from '../../core/mcp-form.js';

// MCP 视图纯逻辑：表单值模型、字段投影、env 解析、索引钳制。
// 与 OpenTUI 组件解耦，便于推理与单测；组件只负责输入分发、渲染和 service 调用。
// （业务逻辑零重写，byte 级迁移自 manage/source/views/mcp/mcp-view-model.ts）

export type McpViewMode = 'list' | 'detail' | 'add-type' | 'form' | 'confirm-remove' | 'message';

// 表单实时值：统一以 field.id 为键的字符串。key-value 字段序列化为 "K=V,K2=V2"。
export type McpFormValues = Record<string, string>;

const ENV_FIELD_ID = '__env';

/** 字段是否可编辑（readonly / disabled 不可编辑）。 */
export function isEditableField(field: FormField): boolean {
	return field.type !== 'readonly' && !field.disabled;
}

/** 把 key-value entries 序列化为单行可编辑文本。 */
export function serializeEnvEntries(entries: readonly KeyValueEntry[]): string {
	return entries.map((entry) => `${entry.key}=${entry.value}`).join(',');
}

/** 解析 "K=V,K2=V2" 文本为 key-value entries（忽略空段与无等号段）。 */
export function parseEnvEntries(raw: string): KeyValueEntry[] {
	const entries: KeyValueEntry[] = [];
	for (const segment of raw.split(',')) {
		const trimmed = segment.trim();
		if (trimmed === '') {
			continue;
		}

		const eq = trimmed.indexOf('=');
		if (eq <= 0) {
			continue;
		}

		entries.push({ key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1) });
	}

	return entries;
}

/** 从表单模型派生初始可编辑值（key-value 字段序列化为文本）。 */
export function initialFormValues(model: McpFormModel): McpFormValues {
	const values: McpFormValues = {};
	for (const field of model.fields) {
		if (field.type === 'key-value') {
			values[field.id] = serializeEnvEntries(field.entries);
		} else if (field.type === 'readonly' || field.type === 'select') {
			values[field.id] = field.value;
		} else {
			values[field.id] = field.value;
		}
	}

	return values;
}

/** 把实时值投影回 FormField[]，供 FormPanel 渲染当前编辑态。 */
export function projectFields(model: McpFormModel, values: McpFormValues): FormField[] {
	return model.fields.map((field) => {
		const live = values[field.id] ?? '';
		if (field.type === 'key-value') {
			// 渲染期把 env 文本回显为单一只读摘要行不便编辑，改为 text 行内编辑。
			return { id: field.id, type: 'text', label: field.label, value: live, helpText: field.helpText };
		}

		if (field.type === 'readonly') {
			return { ...field, value: live };
		}

		if (field.type === 'select') {
			return { ...field, value: live };
		}

		return { ...field, value: live };
	});
}

/** 收集自定义 stdio 表单的 env entries（从 __env 文本解析）。 */
export function collectEnvEntries(values: McpFormValues): KeyValueEntry[] {
	return parseEnvEntries(values[ENV_FIELD_ID] ?? '');
}

/** 索引钳制到 [0, length-1]，空集返回 0。 */
export function clampIndex(index: number, length: number): number {
	if (length <= 0) {
		return 0;
	}

	return Math.min(Math.max(index, 0), length - 1);
}

/** 找到下一个可编辑字段索引（用于 ↑/↓ 跳过 readonly），无则停在原位。 */
export function nextEditableIndex(fields: readonly FormField[], from: number, direction: 1 | -1): number {
	const length = fields.length;
	if (length === 0) {
		return 0;
	}

	for (let step = 1; step <= length; step++) {
		const candidate = from + direction * step;
		if (candidate < 0 || candidate >= length) {
			break;
		}

		if (isEditableField(fields[candidate]!)) {
			return candidate;
		}
	}

	return clampIndex(from, length);
}

/** 首个可编辑字段索引（表单初始聚焦）。 */
export function firstEditableIndex(fields: readonly FormField[]): number {
	const index = fields.findIndex(isEditableField);
	return index >= 0 ? index : 0;
}
