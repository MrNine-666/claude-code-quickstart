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

// 左侧导航（「检查更新」按钮选中时）。
export function updateButtonShortcuts(): readonly Shortcut[] {
	return buildShortcuts([
		{command: NAV_COMMANDS.NAV_UP, label: '菜单'},
		{command: NAV_COMMANDS.NAV_DOWN, label: '菜单'},
		{command: NAV_COMMANDS.NAV_ENTER, label: '检查更新'},
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
		default:
			return [];
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
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
	]);
}

function skillsShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'confirm-install' || subMode === 'confirm-uninstall') {
		return manualShortcuts([{key: 'Enter', label: '确认'}, {key: 'Esc', label: '取消'}]);
	}

	if (subMode === 'busy') {
		return manualShortcuts([{key: '请稍候', label: '执行中'}]);
	}

	// 安装页·父级：搜索框 + repo 列表（find 按 owner/repo 去重）
	if (subMode === 'install') {
		return manualShortcuts([
			{key: 'Tab', label: '搜索框/repo'},
			{key: '↑/↓', label: '选择 repo'},
			{key: 'Enter', label: '展开子 skill'},
			{key: 'Esc', label: '返回列表页'}
		]);
	}

	// 安装页·子级：某 repo 下 skill 多选（需求③）
	if (subMode === 'install-pick') {
		return manualShortcuts([
			{key: 'A', label: '全选/取消'},
			{key: 'Space', label: '选中/取消'},
			{key: '↑/↓', label: '选择'},
			{key: 'Enter', label: '安装选中'},
			{key: 'Esc', label: '返回 repo 列表'}
		]);
	}

	// 列表页（默认）：本地过滤 + 已装管理
	return buildShortcuts([
		{command: SKILLS_COMMANDS.TOGGLE_FOCUS, label: '过滤框/列表'},
		{command: SKILLS_COMMANDS.LIST_UP, label: '选择'},
		{command: SKILLS_COMMANDS.LIST_DOWN, label: '选择'},
		{command: SKILLS_COMMANDS.INSTALL, label: '安装页'},
		{command: SKILLS_COMMANDS.UPDATE_ALL, label: '更新全部'},
		{command: SKILLS_COMMANDS.UNINSTALL, label: '卸载'},
		{command: SKILLS_COMMANDS.REFRESH, label: '刷新'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
		{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
	]);
}

function promptsShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	// view 态：只读渲染展示（本地 md 有内容；已有内容不展示「新建」避免误覆盖）
	if (subMode === 'view-render') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.EDIT_ENTRY, label: '编辑'},
			{command: PROMPTS_COMMANDS.PREVIEW_UP, label: '滚动'},
			{command: PROMPTS_COMMANDS.PREVIEW_DOWN, label: '滚动'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
		]);
	}

	// view 态：空状态（本地 md 不存在/空，仅此时 a 新建）
	if (subMode === 'view-empty') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.ADD, label: '新建'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
		]);
	}

	// edit 态：纯编辑器（默认）
	if (subMode === 'edit') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.TOGGLE_PANEL, label: '推荐边栏'},
			{command: PROMPTS_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: PROMPTS_COMMANDS.IMPORT, label: '导入推荐'},
			{command: PROMPTS_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	// edit 态：双栏 · 焦点在编辑器
	if (subMode === 'edit-split-editor') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.FOCUS_CYCLE, label: '切边栏'},
			{command: PROMPTS_COMMANDS.TOGGLE_PANEL, label: '收边栏'},
			{command: PROMPTS_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: PROMPTS_COMMANDS.IMPORT, label: '导入推荐'},
			{command: PROMPTS_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	// edit 态：双栏 · 焦点在推荐边栏（↑/↓ 滚动）
	if (subMode === 'edit-split-recommend') {
		return buildShortcuts([
			{command: PROMPTS_COMMANDS.PREVIEW_UP, label: '滚动'},
			{command: PROMPTS_COMMANDS.PREVIEW_DOWN, label: '滚动'},
			{command: PROMPTS_COMMANDS.FOCUS_CYCLE, label: '切编辑器'},
			{command: PROMPTS_COMMANDS.TOGGLE_PANEL, label: '收边栏'},
			{command: PROMPTS_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: PROMPTS_COMMANDS.IMPORT, label: '导入推荐'},
			{command: PROMPTS_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	// 确认浮层（import）
	return manualShortcuts([{key: 'Enter', label: '确认'}, {key: 'Esc', label: '取消'}]);
}

function configShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	// view 态：只读渲染展示当前 settings.json
	if (subMode === 'view-render') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.EDIT_ENTRY, label: '编辑'},
			{command: CONFIG_COMMANDS.PREVIEW_UP, label: '滚动'},
			{command: CONFIG_COMMANDS.PREVIEW_DOWN, label: '滚动'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
		]);
	}

	// view 态：空状态（settings.json 不存在/空，仅此时 a 新建）
	if (subMode === 'view-empty') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.ADD, label: '新建'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV, label: '返回菜单'},
			{command: VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT, label: '返回菜单'}
		]);
	}

	// edit 态：纯编辑器（默认）
	if (subMode === 'edit') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.TOGGLE_PANEL, label: '推荐边栏'},
			{command: CONFIG_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: CONFIG_COMMANDS.IMPORT, label: '补全推荐'},
			{command: CONFIG_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	// edit 态：双栏 · 焦点在编辑器
	if (subMode === 'edit-split-editor') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.FOCUS_CYCLE, label: '切边栏'},
			{command: CONFIG_COMMANDS.TOGGLE_PANEL, label: '收边栏'},
			{command: CONFIG_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: CONFIG_COMMANDS.IMPORT, label: '补全推荐'},
			{command: CONFIG_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	// edit 态：双栏 · 焦点在推荐边栏（↑/↓ 滚动）
	if (subMode === 'edit-split-recommend') {
		return buildShortcuts([
			{command: CONFIG_COMMANDS.PREVIEW_UP, label: '滚动'},
			{command: CONFIG_COMMANDS.PREVIEW_DOWN, label: '滚动'},
			{command: CONFIG_COMMANDS.FOCUS_CYCLE, label: '切编辑器'},
			{command: CONFIG_COMMANDS.TOGGLE_PANEL, label: '收边栏'},
			{command: CONFIG_COMMANDS.EDITOR_SAVE, label: '保存'},
			{command: CONFIG_COMMANDS.IMPORT, label: '补全推荐'},
			{command: CONFIG_COMMANDS.EDITOR_CANCEL, label: '取消'}
		]);
	}

	return [];
}

function toolsShortcuts(subMode: ViewSubMode): readonly Shortcut[] {
	if (subMode === 'busy') {
		return manualShortcuts([{key: '请稍候', label: '执行中'}]);
	}

	if (subMode === 'confirm-uninstall') {
		return manualShortcuts([{key: 'Enter', label: '确认卸载'}, {key: 'Esc', label: '取消'}]);
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
