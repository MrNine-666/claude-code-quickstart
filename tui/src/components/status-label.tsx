import React from 'react';

export type StatusKind = 'pass' | 'fail' | 'skip' | 'manual' | 'info' | 'loading';

const statusColor: Record<StatusKind, string> = {
	pass: 'green',
	fail: 'red',
	skip: 'yellow',
	manual: 'magenta',
	info: 'cyan',
	loading: 'blue'
};

const statusText: Record<StatusKind, string> = {
	pass: 'PASS',
	fail: 'FAIL',
	skip: 'SKIP',
	manual: 'MANUAL',
	info: 'INFO',
	loading: 'LOAD'
};

export type StatusLabelProps = {
	readonly kind: StatusKind;
	readonly label?: string;
};

export function StatusLabel({ kind, label }: StatusLabelProps) {
	return (
		<text fg={statusColor[kind]}>
			[{statusText[kind]}]{label ? ` ${label}` : ''}
		</text>
	);
}
