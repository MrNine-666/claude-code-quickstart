import type { Binding } from '@opentui/keymap';
import { commandBindings } from '@opentui/keymap/extras';
import { appShortcutKey, editingShortcutKey } from '../utils/keyboard.js';

// ============================================================
// Phase 1B.2：声明式键绑定配置
// ============================================================
// 本文件定义 ccq 管理控制台的全局与视图级键绑定，供 keymap 注册。
// 结构：全局导航 commands + 6 个视图模块的 commands。
// commandBindings 接受 Record<command, key> 映射。

// ------------------------------------------------------------
// 全局导航 commands（nav 焦点时生效）
// ------------------------------------------------------------
export const NAV_COMMANDS = {
	NAV_UP: 'nav:up',
	NAV_DOWN: 'nav:down',
	NAV_ENTER: 'nav:enter',
	NAV_RIGHT: 'nav:right',
	QUIT: 'app:quit'
} as const;

export const navBindings: Binding[] = commandBindings({
	[NAV_COMMANDS.NAV_UP]: 'up',
	[NAV_COMMANDS.NAV_DOWN]: 'down',
	[NAV_COMMANDS.NAV_ENTER]: 'enter',
	[NAV_COMMANDS.NAV_RIGHT]: 'right',
	[NAV_COMMANDS.QUIT]: 'q'
});

// ------------------------------------------------------------
// 视图通用 commands（所有视图共享）
// ------------------------------------------------------------
export const VIEW_COMMON_COMMANDS = {
	EXIT_TO_NAV: 'view:exit-to-nav',
	EXIT_TO_NAV_LEFT: 'view:exit-to-nav-left'
} as const;

export const viewCommonBindings: Binding[] = commandBindings({
	[VIEW_COMMON_COMMANDS.EXIT_TO_NAV]: 'escape',
	[VIEW_COMMON_COMMANDS.EXIT_TO_NAV_LEFT]: 'left'
});

// ------------------------------------------------------------
// 供应商视图 commands
// ------------------------------------------------------------
export const PROVIDER_COMMANDS = {
	LIST_UP: 'provider:list-up',
	LIST_DOWN: 'provider:list-down',
	TOGGLE_ACTIVE: 'provider:toggle-active',
	ADD: 'provider:add',
	EDIT: 'provider:edit',
	DELETE: 'provider:delete',
	// form 子模式
	FORM_UP: 'provider:form-up',
	FORM_DOWN: 'provider:form-down',
	FORM_SAVE: 'provider:form-save',
	FORM_CANCEL: 'provider:form-cancel'
} as const;

export const providerBindings: Binding[] = commandBindings({
	[PROVIDER_COMMANDS.LIST_UP]: 'up',
	[PROVIDER_COMMANDS.LIST_DOWN]: 'down',
	[PROVIDER_COMMANDS.TOGGLE_ACTIVE]: 'enter',
	[PROVIDER_COMMANDS.ADD]: 'a',
	[PROVIDER_COMMANDS.EDIT]: 'e',
	[PROVIDER_COMMANDS.DELETE]: 'd',
	// form 子模式（与 list 模式复用按键，靠 layer active 控制生效时机）
	[PROVIDER_COMMANDS.FORM_UP]: 'up',
	[PROVIDER_COMMANDS.FORM_DOWN]: 'down',
	[PROVIDER_COMMANDS.FORM_SAVE]: 'enter',
	[PROVIDER_COMMANDS.FORM_CANCEL]: 'escape'
});

// ------------------------------------------------------------
// MCP 视图 commands
// ------------------------------------------------------------
export const MCP_COMMANDS = {
	LIST_UP: 'mcp:list-up',
	LIST_DOWN: 'mcp:list-down',
	TOGGLE: 'mcp:toggle',
	ADD: 'mcp:add',
	EDIT: 'mcp:edit',
	DELETE: 'mcp:delete',
	// form 子模式
	FORM_SAVE: 'mcp:form-save',
	FORM_CANCEL: 'mcp:form-cancel'
} as const;

export const mcpBindings: Binding[] = commandBindings({
	[MCP_COMMANDS.LIST_UP]: 'up',
	[MCP_COMMANDS.LIST_DOWN]: 'down',
	[MCP_COMMANDS.TOGGLE]: 'enter',
	[MCP_COMMANDS.ADD]: 'a',
	[MCP_COMMANDS.EDIT]: 'e',
	[MCP_COMMANDS.DELETE]: 'd',
	// form 子模式（与 list 复用按键，靠视图焦点/子模式控制生效时机）
	[MCP_COMMANDS.FORM_SAVE]: editingShortcutKey('s'),
	[MCP_COMMANDS.FORM_CANCEL]: 'escape'
});

// ------------------------------------------------------------
// Skills 视图 commands
// ------------------------------------------------------------
export const SKILLS_COMMANDS = {
	LIST_UP: 'skills:list-up',
	LIST_DOWN: 'skills:list-down',
	TOGGLE_FOCUS: 'skills:toggle-focus',
	INSTALL: 'skills:install',
	UPDATE_ALL: 'skills:update-all',
	UNINSTALL: 'skills:uninstall',
	REFRESH: 'skills:refresh'
} as const;

export const skillsBindings: Binding[] = commandBindings({
	[SKILLS_COMMANDS.LIST_UP]: 'up',
	[SKILLS_COMMANDS.LIST_DOWN]: 'down',
	[SKILLS_COMMANDS.TOGGLE_FOCUS]: 'tab',
	[SKILLS_COMMANDS.INSTALL]: 'a',
	[SKILLS_COMMANDS.UPDATE_ALL]: 'u',
	[SKILLS_COMMANDS.UNINSTALL]: 'd',
	[SKILLS_COMMANDS.REFRESH]: 'r'
});

// ------------------------------------------------------------
// 全局规则视图 commands（view-first：只读展示 ↔ a/e 编辑 ↔ 源码推荐边栏）
// ------------------------------------------------------------
export const PROMPTS_COMMANDS = {
	// view 态入口（只读展示 / 空状态）
	ADD: 'prompts:add',                          // a 新建（空白编辑器）
	EDIT_ENTRY: 'prompts:edit-entry',            // e 编辑现有（载入磁盘内容）
	// edit 态主操作
	TOGGLE_PANEL: 'prompts:toggle-panel',        // Ctrl+T 开/关推荐边栏（TUI 应用功能）
	IMPORT: 'prompts:import',                    // Ctrl+O 推荐灌入缓冲（TUI 应用功能）
	EDITOR_SAVE: 'prompts:editor-save',          // macOS Cmd+S / 其他平台 Ctrl+S 保存（编辑语义）
	EDITOR_CANCEL: 'prompts:editor-cancel',      // escape 取消编辑回 view
	// 双栏焦点切换
	FOCUS_CYCLE: 'prompts:focus-cycle',          // tab 编辑器↔推荐边栏
	// 滚动（view 展示 / 边栏）
	PREVIEW_UP: 'prompts:preview-up',            // up 滚动
	PREVIEW_DOWN: 'prompts:preview-down'         // down 滚动
} as const;

export const promptsBindings: Binding[] = commandBindings({
	[PROMPTS_COMMANDS.ADD]: 'a',
	[PROMPTS_COMMANDS.EDIT_ENTRY]: 'e',
	[PROMPTS_COMMANDS.TOGGLE_PANEL]: appShortcutKey('t'),
	[PROMPTS_COMMANDS.IMPORT]: appShortcutKey('o'),
	[PROMPTS_COMMANDS.EDITOR_SAVE]: editingShortcutKey('s'),
	[PROMPTS_COMMANDS.EDITOR_CANCEL]: 'escape',
	[PROMPTS_COMMANDS.FOCUS_CYCLE]: 'tab',
	[PROMPTS_COMMANDS.PREVIEW_UP]: 'up',
	[PROMPTS_COMMANDS.PREVIEW_DOWN]: 'down'
});

// ------------------------------------------------------------
// 配置文件视图 commands（view-first：只读展示 ↔ a/e 编辑 ↔ 推荐边栏，对齐 PROMPTS_COMMANDS）
// ------------------------------------------------------------
export const CONFIG_COMMANDS = {
	// view 态入口（只读展示 / 空状态）
	ADD: 'config:add',                          // a 新建（空白 {} 编辑器）
	EDIT_ENTRY: 'config:edit-entry',            // e 编辑现有（载入磁盘内容）
	// edit 态主操作
	TOGGLE_PANEL: 'config:toggle-panel',        // Ctrl+T 开/关推荐边栏（TUI 应用功能）
	IMPORT: 'config:import',                    // Ctrl+O fill-missing 灌入缓冲（TUI 应用功能，仅补缺失）
	EDITOR_SAVE: 'config:editor-save',          // macOS Cmd+S / 其他平台 Ctrl+S 保存（编辑语义）
	EDITOR_CANCEL: 'config:editor-cancel',      // escape 取消编辑回 view
	// 双栏焦点切换
	FOCUS_CYCLE: 'config:focus-cycle',          // tab 编辑器↔推荐边栏
	// 滚动（view 展示 / 边栏）
	PREVIEW_UP: 'config:preview-up',            // up 滚动
	PREVIEW_DOWN: 'config:preview-down'         // down 滚动
} as const;

export const configBindings: Binding[] = commandBindings({
	[CONFIG_COMMANDS.ADD]: 'a',
	[CONFIG_COMMANDS.EDIT_ENTRY]: 'e',
	[CONFIG_COMMANDS.TOGGLE_PANEL]: appShortcutKey('t'),
	[CONFIG_COMMANDS.IMPORT]: appShortcutKey('o'),
	[CONFIG_COMMANDS.EDITOR_SAVE]: editingShortcutKey('s'),
	[CONFIG_COMMANDS.EDITOR_CANCEL]: 'escape',
	[CONFIG_COMMANDS.FOCUS_CYCLE]: 'tab',
	[CONFIG_COMMANDS.PREVIEW_UP]: 'up',
	[CONFIG_COMMANDS.PREVIEW_DOWN]: 'down'
});

// ------------------------------------------------------------
// 工具管理视图 commands
// ------------------------------------------------------------
export const TOOLS_COMMANDS = {
	UP: 'tools:up',
	DOWN: 'tools:down',
	LEFT: 'tools:left',
	RIGHT: 'tools:right',
	INSTALL_OR_UPDATE: 'tools:install-or-update',
	UPDATE_ALL: 'tools:update-all',
	UNINSTALL: 'tools:uninstall',
	REFRESH: 'tools:refresh'
} as const;

export const toolsBindings: Binding[] = commandBindings({
	[TOOLS_COMMANDS.UP]: 'up',
	[TOOLS_COMMANDS.DOWN]: 'down',
	[TOOLS_COMMANDS.LEFT]: 'left',
	[TOOLS_COMMANDS.RIGHT]: 'right',
	[TOOLS_COMMANDS.INSTALL_OR_UPDATE]: 'enter',
	[TOOLS_COMMANDS.UPDATE_ALL]: 'a',
	[TOOLS_COMMANDS.UNINSTALL]: 'd',
	[TOOLS_COMMANDS.REFRESH]: 'r'
});

// ------------------------------------------------------------
// 全局 bindings 合集（供 App.tsx 注册）
// ------------------------------------------------------------
export const allBindings: Binding[] = [
	...navBindings,
	...viewCommonBindings,
	...providerBindings,
	...mcpBindings,
	...skillsBindings,
	...promptsBindings,
	...configBindings,
	...toolsBindings
];
