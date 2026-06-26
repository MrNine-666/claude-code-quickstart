import React from 'react';

export type FormControlFrameProps = {
	readonly children: React.ReactNode;
};

// 表单值区容器：无边框、透明背景。focused 层次由 FormLabel 的主色 + 加粗提供。
export function FormControlFrame({ children }: FormControlFrameProps) {
	return (
		<box flexGrow={1} minWidth={0} overflow="hidden" paddingX={1}>
			{children}
		</box>
	);
}
