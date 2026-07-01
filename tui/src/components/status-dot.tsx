import React from 'react';
import { colors, statusDotColors } from '../theme/index.js';
import { Spinner } from './spinner.js';

// 状态圆点：彩色 ● + 文字（OpenTUI 适配）
// 语义对齐工具管理页：updatable / latest / unknown / updating / installing / uninstalling / failed / notInstalled
// loading 态（updating/installing/uninstalling）使用 Spinner 动画

export type StatusDotKind = keyof typeof statusDotColors;

export type StatusDotProps = {
	readonly kind: StatusDotKind;
	readonly label?: string;
};

const SPINNER_KINDS = new Set<StatusDotKind>(['updating', 'installing', 'uninstalling']);

const SPINNER_LABELS: Readonly<Partial<Record<StatusDotKind, string>>> = {
	updating: '更新中',
	installing: '安装中',
	uninstalling: '卸载中'
};

export function StatusDot({ kind, label }: StatusDotProps) {
	if (SPINNER_KINDS.has(kind)) {
		return <Spinner label={label ?? SPINNER_LABELS[kind] ?? '处理中'} />;
	}

	return (
		<text fg={statusDotColors[kind]} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
			●{label ? ` ${label}` : ''}
		</text>
	);
}
