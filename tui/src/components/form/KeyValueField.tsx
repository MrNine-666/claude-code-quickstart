import React from 'react';
import { TextAttributes } from '@opentui/core';
import { colors } from '../../theme/index.js';
import type { KeyValueEntry } from './field-types.js';

export type KeyValueFieldProps = {
	readonly label: string;
	readonly entries: readonly KeyValueEntry[];
	readonly text: string;
	readonly helpText?: string;
	readonly focused: boolean;
	readonly active: boolean;
	readonly onChange: (text: string) => void;
};

/**
 * KeyValueField：键值对编辑（单行 `K=V,K2=V2` 文本形式）
 * - 编辑态用 <input> 录入逗号分隔的 K=V 文本，由 FormPanel 解析回 entries
 * - 非编辑态以多行只读形式展示当前键值对，便于阅读
 * - Enter 由 FormPanel 统一处理（保存）
 */
export function KeyValueField({ label, entries, text, helpText, focused, active, onChange }: KeyValueFieldProps) {
	return (
		<box flexDirection="column" marginBottom={1}>
			<text fg={focused ? colors.primary : undefined} attributes={(focused) ? TextAttributes.BOLD : 0}>
				{focused ? '› ' : '  '}
				{label}
			</text>
			{active && focused ? (
				<input value={text} placeholder="KEY=VALUE,KEY2=VALUE2" onInput={onChange} focused />
			) : entries.length === 0 ? (
				<text fg="gray">（无）</text>
			) : (
				<box flexDirection="column">
					{entries.map((entry) => (
						<text key={entry.key} fg={colors.muted}>
							{entry.key}={entry.value}
						</text>
					))}
				</box>
			)}
			{helpText ? (
				<text fg="gray" attributes={TextAttributes.DIM}>
					{helpText}
				</text>
			) : null}
		</box>
	);
}

/** 序列化 entries 为单行 `K=V,K2=V2` 文本（供 KeyValueField 编辑态初值）。 */
export function serializeEntries(entries: readonly KeyValueEntry[]): string {
	return entries.map((entry) => `${entry.key}=${entry.value}`).join(',');
}

/** 解析 `K=V,K2=V2` 文本为 entries（忽略空段与无等号段）。 */
export function parseEntries(raw: string): KeyValueEntry[] {
	const result: KeyValueEntry[] = [];
	for (const segment of raw.split(',')) {
		const trimmed = segment.trim();
		if (trimmed === '') {
			continue;
		}

		const eq = trimmed.indexOf('=');
		if (eq <= 0) {
			continue;
		}

		result.push({ key: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1) });
	}

	return result;
}
