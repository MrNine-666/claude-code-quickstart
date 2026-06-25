// 集中主题：Claude 品牌橙 + ANSI 语义色系统
// （对齐 installer/windows/core/Ui.ps1:112-124）
// OpenTUI 适配：去除 ink-gradient，纯色方案

/** Claude 品牌橙（主色）：标题、焦点边框、选中项、Logo、进度 */
export const PRIMARY = '#D97757';
/** Claude 亮橙（渐变高亮端，保留但不用于 gradient） */
export const PRIMARY_BRIGHT = '#E8946A';

// 语义色（对齐 ps1 Write-Ui* 函数族）
export const colors = {
	primary: PRIMARY,
	primaryBright: PRIMARY_BRIGHT,
	success: 'green',
	warning: 'yellow',
	danger: 'red',
	info: 'white',
	muted: 'gray'
} as const;

/** 区域/卡片边框色：活跃用主色，非活跃用弱化灰 */
export const borderColors = {
	active: PRIMARY,
	inactive: 'gray'
} as const;

/**
 * 状态圆点语义色（检查更新页 + 通用状态指示，对齐 SC-3）
 * 注意：SKIP/最新 用 green（修正旧实现 skip:yellow 的偏差）
 */
export const statusDotColors = {
	updatable: colors.warning, // 可更新：黄
	latest: colors.success, // 最新：绿
	unknown: colors.muted, // 未知：灰
	updating: colors.primary, // 更新中：橙（loading）
	installing: colors.primary, // 安装中：橙（loading）
	uninstalling: colors.danger, // 卸载中：红（loading）
	failed: colors.danger, // 失败：红
	notInstalled: colors.muted // 未安装：灰
} as const;
