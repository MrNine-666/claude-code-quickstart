import type {Binding} from '@opentui/keymap';
import {formatCommandBindings, formatKeySequence} from '@opentui/keymap/extras';
import type {Shortcut} from '../components/index.js';
import {
	CONFIG_COMMANDS,
	MCP_COMMANDS,
	NAV_COMMANDS,
	PROMPTS_COMMANDS,
	PROVIDER_COMMANDS,
	SKILLS_COMMANDS,
	TOOLS_COMMANDS,
	VIEW_COMMON_COMMANDS,
	configBindings,
	mcpBindings,
	navBindings,
	promptsBindings,
	providerBindings,
	skillsBindings,
	toolsBindings,
	viewCommonBindings
} from '../config/keybindings.js';
import type {ManageModuleId} from './manage-state.js';

// footer 动态快捷键集中解析：删除各视图内部 ShortcutBar，由 App footer
// 按「当前菜单 + 焦点 + 视图上报的子模式」统一渲染。各视图通过 onSubModeChange 上报
// 自己的子模式字符串；这里把 (menuId, subMode) 映射为快捷键列表。

// 视图子模式：各视图自定义的内部状态标识（list/detail/grid/form/search/...）。
export type ViewSubMode = string;

type ShortcutSpec = {
	readonly command: string;
	readonly label: string;
};

const bindingLookup = new Map<string, readonly Binding[]>();
for (const binding of [
	...navBindings,
	...viewCommonBindings,
	...providerBindings,
	...mcpBindings,
	...skillsBindings,
	...promptsBindings,
	...configBindings,
	...toolsBindings
]) {
	if (typeof binding.cmd !== 'string') continue;
	const bindings = bindingLookup.get(binding.cmd) ?? [];
	bindingLookup.set(binding.cmd, [...bindings, binding]);
}

const KEY_NAME_ALIASES = {
	escape: 'Esc',
	enter: 'Enter',
	return: 'Enter',
	up: '↑',
	down: '↓',
	left: '←',
	right: '→',
	space: 'Space',
	tab: 'Tab'
} as const;

const MODIFIER_ALIASES = {
	ctrl: 'Ctrl',
	shift: 'Shift',
	meta: 'Meta',
	super: 'Super',
	hyper: 'Hyper'
} as const;

// 左侧导航（菜单焦点）。
export function navShortcuts(): readonly Shortcut[] {
	return buildShortcuts([
		{command: NAV_COMMANDS.NAV_UP, label: '菜单'},
		{command: NAV_COMMANDS.NAV_DOWN, label: '菜单'},
		{command: NAV_COMMANDS.NAV_ENTER, label: '进入'},
		{command: NAV_COMMANDS.NAV_RIGHT, label: '进入'},
		{command: NAV_COMMANDS.QUIT, label: '退出'}
	]);
}

// 右侧视图：按菜单 + 子模式解析。subMode 为空时给出该视图的默认（list/grid）快捷键。
export function viewShortcuts(menuId: ManageModuleId, subMode: ViewSubMode): readonly Shortcut[] {
	switch (menuId) {
		case 'provider':
			return providerShortcuts(subMode);
		case 'mcp':
			return mcpShortcuts(subMode);
		case 'skills':
			return skillsShortcuts(subMode);
		case 'prompts':
			return promptsShortcuts(subMode);
		case 'config':
			return configShortcuts(subMode);
		case 'tools':
			return toolsShortcuts(subMode);
	}
}

function providerShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'confirm-delete') {
		return manualShortcuts([{key: 'Enter', label: '确认删除'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'form') {
		return manualShortcuts([
			{key: '↑/↓', label: '字段'},
			{key: '←/→', label: '选项'},
			{key: 'Ctrl+S', label: '保存'},
			{key: 'Esc', label: '取消'}
		]);
	}

	if (subMode === 'empty') {
		return buildShortcuts([
			{command: PROVIDER_COMMANDS.ADD, label: '添加供应商'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
		]);
	}

	return buildShortcuts([
		{command: PROVIDER_COMMANDS.LIST_UP, label: '选择'},
		{command: PROVIDER_COMMANDS.LIST_DOWN, label: '选择'},
		{command: PROVIDER_COMMANDS.TOGGLE_ACTIVE, label: '切换活跃'},
		{command: PROVIDER_COMMANDS.ADD, label: '添加'},
		{command: PROVIDER_COMMANDS.EDIT, label: '编辑'},
		{command: PROVIDER_COMMANDS.DELETE, label: '删除'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
	]);
}

function mcpShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'form') {
		return manualShortcuts([{key: '↑/↓', label: '字段'}, {key: '←/→', label: '选项'}, {key: 'Ctrl+S', label: '保存'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'confirm-remove') {
		return manualShortcuts([{key: 'Enter', label: '确认删除'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'empty') {
		return buildShortcuts([
			{command: MCP_COMMANDS.ADD, label: '新增'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
		]);
	}

	return buildShortcuts([
		{command: MCP_COMMANDS.LIST_UP, label: '选择'},
		{command: MCP_COMMANDS.LIST_DOWN, label: '选择'},
		{command: MCP_COMMANDS.TOGGLE, label: '切换状态'},
		{command: MCP_COMMANDS.ADD, label: '新增'},
		{command: MCP_COMMANDS.EDIT, label: '编辑'},
		{command: MCP_COMMANDS.DELETE, label: '删除'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'}
	]);
}

function skillsShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'search-input') {
		return manualShortcuts([{key: '输入', label: '关键词'}, {key: 'Enter', label: '搜索'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'search-results') {
		return manualShortcuts([{key: '↑/↓', label: '选择'}, {key: 'Enter', label: '安装'}, {key: 'Esc', label: '返回'}]);
	}

	if (subMode === 'confirm-install' || subMode === 'confirm-uninstall') {
		return manualShortcuts([{key: 'Enter', label: '确认'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'busy') {
		return manualShortcuts([{key: '请稍候', label: '执行中'}]);
	}

	return buildShortcuts([
		{command: SKILLS_COMMANDS.LIST_UP, label: '选择'},
		{command: SKILLS_COMMANDS.LIST_DOWN, label: '选择'},
		{command: SKILLS_COMMANDS.TOGGLE_SELECT, label: '多选'},
		{command: SKILLS_COMMANDS.SEARCH, label: '搜索安装'},
		{command: SKILLS_COMMANDS.UPDATE_ALL, label: '更新全部'},
		{command: SKILLS_COMMANDS.UNINSTALL, label: '卸载'},
		{command: SKILLS_COMMANDS.REFRESH, label: '刷新'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'}
	]);
}

function promptsShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'editor') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: PROMPTS_COMMANDS.EDITOR_PREVIEW, label: '预览'},
			{command: PROMPTS_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	if (subMode === 'preview') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.PREVIEW_BACK, label: '返回编辑'},
			{command: PROMPTS_COMMANDS.PREVIEW_UP, label: '滚动'},
			{command: PROMPTS_COMMANDS.PREVIEW_DOWN, label: '滚动'}
		]);
	}

	if (subMode === 'confirm-import') {
		return manualShortcuts([{key: 'Enter', label: '确认导入'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'busy') {
		return manualShortcuts([{key: '请稍候', label: '执行中'}]);
	}

	return buildShortcuts([
		{command: PROMPTS_COMMANDS.IMPORT, label: '导入'},
		{command: PROMPTS_COMMANDS.COPY, label: '复制'},
		{command: PROMPTS_COMMANDS.EDIT, label: '编辑器'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
	]);
}

function configShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'editor') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: CONFIG_COMMANDS.EDITOR_PREVIEW, label: '预览'},
			{command: CONFIG_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	if (subMode === 'preview') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.PREVIEW_BACK, label: '返回编辑'},
			{command: CONFIG_COMMANDS.PREVIEW_UP, label: '滚动'},
			{command: CONFIG_COMMANDS.PREVIEW_DOWN, label: '滚动'}
		]);
	}

	if (subMode === 'confirm-import') {
		return manualShortcuts([{key: 'Enter', label: '确认补全'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'busy') {
		return manualShortcuts([{key: '请稍候', label: '执行中'}]);
	}

	return buildShortcuts([
		{command: CONFIG_COMMANDS.IMPORT, label: '补全'},
		{command: CONFIG_COMMANDS.COPY, label: '复制'},
		{command: CONFIG_COMMANDS.EDIT, label: '编辑器'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
	]);
}

function toolsShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'busy') {
		return manualShortcuts([{key: '请稍候', label: '执行中'}]);
	}

	if (subMode === 'confirm-uninstall') {
		return manualShortcuts([{key: '输入确认词', label: '确认卸载'}, {key: 'Esc', label: '取消'}]);
	}

	return buildShortcuts([
		{command: TOOLS_COMMANDS.UP, label: '选择'},
		{command: TOOLS_COMMANDS.DOWN, label: '选择'},
		{command: TOOLS_COMMANDS.LEFT, label: '选择'},
		{command: TOOLS_COMMANDS.RIGHT, label: '选择'},
		{command: TOOLS_COMMANDS.INSTALL_OR_UPDATE, label: '安装/更新'},
		{command: TOOLS_COMMANDS.UPDATE_ALL, label: '更新全部'},
		{command: TOOLS_COMMANDS.UNINSTALL, label: '卸载'},
		{command: TOOLS_COMMANDS.REFRESH, label: '重新检测'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'}
	]);
}

function buildShortcuts(specs: readonly ShortcutSpec[]): readonly Shortcut[] {
	return compactShortcuts(
		specs.map(({command, label}) => ({
			key: formatCommand(command),
			label
		}))
	);
}

function manualShortcuts(shortcuts: readonly Shortcut[]): readonly Shortcut[] {
	return compactShortcuts(shortcuts);
}

function compactShortcuts(shortcuts: readonly Shortcut[]): readonly Shortcut[] {
	const merged = new Map<string, Shortcut>();
	for (const shortcut of shortcuts) {
		const existing = merged.get(shortcut.label);
		if (!existing) {
			merged.set(shortcut.label, shortcut);
			continue;
		}

		merged.set(shortcut.label, {
			key: mergeKeys(existing.key, shortcut.key),
			label: shortcut.label
		});
	}

	return [...merged.values()].filter(shortcut => shortcut.key.length > 0);
}

function mergeKeys(left: string, right: string): string {
	if (left === right) return left;
	const parts = [...left.split('/'), ...right.split('/')].filter(Boolean);
	return [...new Set(parts)].join('/');
}

function formatCommand(command: string): string {
	const bindings = bindingLookup.get(command) ?? [];
	const parsed = bindings.map(binding => ({
		sequence: parseKeySequence(binding.key)
	}));

	return formatCommandBindings(parsed, {
		bindingSeparator: '/',
		keyNameAliases: KEY_NAME_ALIASES,
		modifierAliases: MODIFIER_ALIASES
	}) ?? '';
}

function parseKeySequence(key: Binding['key']) {
	const value = typeof key === 'string' ? key : key.name;
	return value.split(' ').map(part => parseKeyStroke(part));
}

function parseKeyStroke(value: string) {
	const parts = value.split('+');
	const rawName = parts[parts.length - 1] ?? value;
	const name = rawName === 'return' ? 'enter' : rawName;
	const stroke = {
		name,
		ctrl: parts.includes('ctrl'),
		shift: parts.includes('shift'),
		meta: parts.includes('meta'),
		super: parts.includes('super')
	};

	return {
		stroke,
		display: value,
		match: value
	};
}
