// 集中主题：Claude 品牌橙 + 终端 dark/light 双套语义色系统
// OpenTUI 通过 renderer.themeMode 检测终端主题，脚本侧通过 OSC 11/COLORFGBG 对齐

import type { ThemeMode as OpenTuiThemeMode } from '@opentui/core';

export type AppThemeMode = Extract<OpenTuiThemeMode, 'dark' | 'light'>;

export type SyntaxPalette = {
	readonly keyword: string;
	readonly string: string;
	readonly number: string;
	readonly comment: string;
	readonly function: string;
	readonly type: string;
	readonly operator: string;
	readonly markupHeading: string;
	readonly markupHeading1: string;
	readonly markupHeading2: string;
	readonly markupHeading3: string;
	readonly markupBold: string;
	readonly markupList: string;
	readonly markupListChecked: string;
	readonly markupQuote: string;
	readonly markupRaw: string;
	readonly markupLink: string;
	readonly default: string;
};

export type JsonTokenPalette = {
	readonly key: string;
	readonly string: string;
	readonly number: string;
	readonly boolean: string;
	readonly punct: string;
	readonly space: string;
};

export type ThemePalette = {
	readonly mode: AppThemeMode;
	readonly primary: string;
	readonly primaryBright: string;
	readonly logoColors: readonly [string, string, string];
	readonly colors: {
		readonly primary: string;
		readonly primaryBright: string;
		readonly focusedBackground: string;
		readonly success: string;
		readonly warning: string;
		readonly danger: string;
		readonly info: string;
		readonly muted: string;
		readonly text: string;
		readonly navSelectedForeground: string;
		readonly navInactiveSelectedBackground: string;
		readonly modalBackground: string;
		readonly lineNumberForeground: string;
		readonly lineNumberBackground: string;
		readonly inputText: string;
		readonly inputFocusedText: string;
		readonly inputCursor: string;
		readonly selectionBg: string;
		readonly selectionFg: string;
	};
	readonly borderColors: {
		readonly active: string;
		readonly inactive: string;
		readonly formItem: string;
	};
	readonly statusDotColors: {
		readonly updatable: string;
		readonly latest: string;
		readonly unknown: string;
		readonly updating: string;
		readonly installing: string;
		readonly uninstalling: string;
		readonly failed: string;
		readonly notInstalled: string;
	};
	readonly syntax: SyntaxPalette;
	readonly jsonTokens: JsonTokenPalette;
};

const GITHUB_DARK_SYNTAX: SyntaxPalette = {
	keyword: '#FF7B72',
	string: '#A5D6FF',
	number: '#79C0FF',
	comment: '#8B949E',
	function: '#D2A8FF',
	type: '#FFA657',
	operator: '#FF7B72',
	markupHeading: '#58A6FF',
	markupHeading1: '#79C0FF',
	markupHeading2: '#58A6FF',
	markupHeading3: '#58A6FF',
	markupBold: '#F0F6FC',
	markupList: '#FF7B72',
	markupListChecked: '#3FB950',
	markupQuote: '#8B949E',
	markupRaw: '#A5D6FF',
	markupLink: '#58A6FF',
	default: '#E6EDF3'
};

const GITHUB_LIGHT_SYNTAX: SyntaxPalette = {
	keyword: '#CF222E',
	string: '#0A3069',
	number: '#0550AE',
	comment: '#6E7781',
	function: '#8250DF',
	type: '#953800',
	operator: '#CF222E',
	markupHeading: '#0550AE',
	markupHeading1: '#0550AE',
	markupHeading2: '#0550AE',
	markupHeading3: '#0550AE',
	markupBold: '#24292F',
	markupList: '#CF222E',
	markupListChecked: '#1A7F37',
	markupQuote: '#6E7781',
	markupRaw: '#0A3069',
	markupLink: '#0969DA',
	default: '#24292F'
};

export const darkTheme: ThemePalette = {
	mode: 'dark',
	primary: '#D97757',
	primaryBright: '#E8946A',
	logoColors: ['#FFC09A', '#D97757', '#C25F40'],
	colors: {
		primary: '#D97757',
		primaryBright: '#E8946A',
		focusedBackground: '#2A1A10',
		success: 'green',
		warning: 'yellow',
		danger: 'red',
		info: 'white',
		muted: 'gray',
		text: '#E6EDF3',
		navSelectedForeground: '#1A1A1A',
		navInactiveSelectedBackground: '#3A2A20',
		modalBackground: '#16110D',
		lineNumberForeground: '#6B7280',
		lineNumberBackground: '#161B22',
		inputText: '#E6EDF3',
		inputFocusedText: '#FFFFFF',
		inputCursor: '#D97757'
	},
	borderColors: {
		active: '#D97757',
		inactive: '#555555',
		formItem: '#333333'
	},
	statusDotColors: {
		updatable: 'yellow',
		latest: 'green',
		unknown: 'gray',
		updating: '#D97757',
		installing: '#D97757',
		uninstalling: 'red',
		failed: 'red',
		notInstalled: 'gray'
	},
	syntax: GITHUB_DARK_SYNTAX,
	jsonTokens: {
		key: '#FFA657',
		string: '#A5D6FF',
		number: '#79C0FF',
		boolean: '#FF7B72',
		punct: 'gray',
		space: 'white'
	}
};

export const lightTheme: ThemePalette = {
	mode: 'light',
	primary: '#B85C3E',
	primaryBright: '#C26A47',
	logoColors: ['#7A3F2A', '#B85C3E', '#8A422E'],
	colors: {
		primary: '#B85C3E',
		primaryBright: '#C26A47',
		focusedBackground: '#F5EDE5',
		success: '#2E7D32',
		warning: '#B58900',
		danger: '#C0392B',
		info: 'black',
		muted: '#6A6A6A',
		text: '#24292F',
		navSelectedForeground: '#FFFFFF',
		navInactiveSelectedBackground: '#F0D9CC',
		modalBackground: '#F5EDE5',
		lineNumberForeground: '#6A737D',
		lineNumberBackground: '#F6F8FA',
		inputText: '#24292F',
		inputFocusedText: '#000000',
		inputCursor: '#B85C3E',
		selectionBg: '#B8D4E8',
		selectionFg: '#000000'
	},
	borderColors: {
		active: '#B85C3E',
		inactive: '#8A8A8A',
		formItem: '#C8B7AE'
	},
	statusDotColors: {
		updatable: '#B58900',
		latest: '#2E7D32',
		unknown: '#6A6A6A',
		updating: '#B85C3E',
		installing: '#B85C3E',
		uninstalling: '#C0392B',
		failed: '#C0392B',
		notInstalled: '#6A6A6A'
	},
	syntax: GITHUB_LIGHT_SYNTAX,
	jsonTokens: {
		key: '#953800',
		string: '#0A3069',
		number: '#0550AE',
		boolean: '#CF222E',
		punct: '#6A6A6A',
		space: 'black'
	}
};

let activeTheme = darkTheme;

/** Claude 品牌主色：保留导出名，值随 activeTheme 更新。 */
export let PRIMARY = activeTheme.primary;
/** Claude 亮橙：保留导出名，值随 activeTheme 更新。 */
export let PRIMARY_BRIGHT = activeTheme.primaryBright;

// 语义色对象保持引用稳定，便于现有组件继续 import { colors }。
export const colors = {...activeTheme.colors};

/** 区域/卡片边框色：活跃用主色，非活跃用中性边框。 */
export const borderColors = {...activeTheme.borderColors};

/** 区域边框样式：活跃用 double（加粗视觉），非活跃用 rounded（轻量）。 */
export const borderStyles = {
	active: 'double' as const,
	inactive: 'rounded' as const
};

/** 状态圆点语义色（检查更新页 + 通用状态指示，对齐 SC-3）。 */
export const statusDotColors = {...activeTheme.statusDotColors};

export function getTheme(mode: AppThemeMode | null | undefined): ThemePalette {
	return mode === 'light' ? lightTheme : darkTheme;
}

export function getActiveTheme(): ThemePalette {
	return activeTheme;
}

export function setActiveTheme(mode: AppThemeMode | null | undefined): ThemePalette {
	activeTheme = getTheme(mode);
	PRIMARY = activeTheme.primary;
	PRIMARY_BRIGHT = activeTheme.primaryBright;
	Object.assign(colors, activeTheme.colors);
	Object.assign(borderColors, activeTheme.borderColors);
	Object.assign(statusDotColors, activeTheme.statusDotColors);
	return activeTheme;
}
