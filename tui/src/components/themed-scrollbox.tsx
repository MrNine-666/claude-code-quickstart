import React from 'react';
import type { ScrollBoxRenderable } from '@opentui/core';
import { colors } from '../theme/index.js';

/**
 * 主题化滚动容器（对齐 scroll-list.tsx 滚动条配色）。
 *
 * 封装 OpenTUI <scrollbox> 并自动应用品牌橙滚动条样式，
 * 颜色随终端 dark/light 主题切换（app.tsx setActiveTheme 接管）。
 *
 * @example
 * ```tsx
 * const ref = useRef<ScrollBoxRenderable>(null);
 * <ThemedScrollbox ref={ref} style={{flexGrow: 1}}>
 *   <text>内容</text>
 * </ThemedScrollbox>
 * ```
 */
export const ThemedScrollbox = React.forwardRef<
	ScrollBoxRenderable,
	{
		readonly children?: React.ReactNode;
		readonly height?: number;
		readonly width?: number | 'auto' | `${number}%`;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		readonly style?: any;
		readonly scrollY?: boolean;
		readonly scrollX?: boolean;
		readonly viewportCulling?: boolean;
	}
>(function ThemedScrollbox(
	{ children, height, width, style, scrollY = true, scrollX = false, viewportCulling = false },
	ref
) {
	return (
		<scrollbox
			ref={ref}
			height={height}
			width={width ?? '100%'}
			style={style}
			scrollY={scrollY}
			scrollX={scrollX}
			viewportCulling={viewportCulling}
			verticalScrollbarOptions={{
				showArrows: false,
				trackOptions: {
					foregroundColor: colors.primary,
					backgroundColor: colors.navInactiveSelectedBackground
				}
			}}
		>
			{children}
		</scrollbox>
	);
});
