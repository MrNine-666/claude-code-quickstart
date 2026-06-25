import type { Binding } from '@opentui/keymap';
import { commandBindings } from '@opentui/keymap/extras';

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
	ENTER_DETAIL: 'mcp:enter-detail',
	ADD: 'mcp:add',
	// detail 子模式
	DETAIL_EDIT: 'mcp:detail-edit',
	DETAIL_TOGGLE: 'mcp:detail-toggle',
	DETAIL_DELETE: 'mcp:detail-delete',
	DETAIL_BACK: 'mcp:detail-back'
} as const;

export const mcpBindings: Binding[] = commandBindings({
	[MCP_COMMANDS.LIST_UP]: 'up',
	[MCP_COMMANDS.LIST_DOWN]: 'down',
	[MCP_COMMANDS.ENTER_DETAIL]: 'enter',
	[MCP_COMMANDS.ADD]: 'a',
	[MCP_COMMANDS.DETAIL_EDIT]: 'e',
	[MCP_COMMANDS.DETAIL_TOGGLE]: 't',
	[MCP_COMMANDS.DETAIL_DELETE]: 'x',
	[MCP_COMMANDS.DETAIL_BACK]: 'escape'
});

// ------------------------------------------------------------
// Skills 视图 commands
// ------------------------------------------------------------
export const SKILLS_COMMANDS = {
	LIST_UP: 'skills:list-up',
	LIST_DOWN: 'skills:list-down',
	TOGGLE_SELECT: 'skills:toggle-select',
	SEARCH: 'skills:search',
	UPDATE_ALL: 'skills:update-all',
	UNINSTALL: 'skills:uninstall',
	REFRESH: 'skills:refresh'
} as const;

export const skillsBindings: Binding[] = commandBindings({
	[SKILLS_COMMANDS.LIST_UP]: 'up',
	[SKILLS_COMMANDS.LIST_DOWN]: 'down',
	[SKILLS_COMMANDS.TOGGLE_SELECT]: 'space',
	[SKILLS_COMMANDS.SEARCH]: '/',
	[SKILLS_COMMANDS.UPDATE_ALL]: 'u',
	[SKILLS_COMMANDS.UNINSTALL]: 'd',
	[SKILLS_COMMANDS.REFRESH]: 'r'
});

// ------------------------------------------------------------
// 提示词视图 commands
// ------------------------------------------------------------
export const PROMPTS_COMMANDS = {
	IMPORT: 'prompts:import',
	COPY: 'prompts:copy',
	EDIT: 'prompts:edit',
	// editor 子模式
	EDITOR_SAVE: 'prompts:editor-save',
	EDITOR_PREVIEW: 'prompts:editor-preview',
	EDITOR_PREVIEW_TAB: 'prompts:editor-preview-tab',
	EDITOR_CANCEL: 'prompts:editor-cancel',
	// preview 子模式
	PREVIEW_BACK: 'prompts:preview-back',
	PREVIEW_UP: 'prompts:preview-up',
	PREVIEW_DOWN: 'prompts:preview-down'
} as const;

export const promptsBindings: Binding[] = commandBindings({
	[PROMPTS_COMMANDS.IMPORT]: 'i',
	[PROMPTS_COMMANDS.COPY]: 'c',
	[PROMPTS_COMMANDS.EDIT]: 'e',
	[PROMPTS_COMMANDS.EDITOR_SAVE]: 'ctrl+s',
	[PROMPTS_COMMANDS.EDITOR_PREVIEW]: 'ctrl+p',
	[PROMPTS_COMMANDS.EDITOR_PREVIEW_TAB]: 'tab',
	[PROMPTS_COMMANDS.EDITOR_CANCEL]: 'escape',
	[PROMPTS_COMMANDS.PREVIEW_BACK]: 'escape',
	[PROMPTS_COMMANDS.PREVIEW_UP]: 'up',
	[PROMPTS_COMMANDS.PREVIEW_DOWN]: 'down'
});

// ------------------------------------------------------------
// 配置文件视图 commands
// ------------------------------------------------------------
export const CONFIG_COMMANDS = {
	IMPORT: 'config:import',
	COPY: 'config:copy',
	EDIT: 'config:edit',
	// editor 子模式
	EDITOR_SAVE: 'config:editor-save',
	EDITOR_PREVIEW: 'config:editor-preview',
	EDITOR_PREVIEW_TAB: 'config:editor-preview-tab',
	EDITOR_CANCEL: 'config:editor-cancel',
	// preview 子模式
	PREVIEW_BACK: 'config:preview-back',
	PREVIEW_UP: 'config:preview-up',
	PREVIEW_DOWN: 'config:preview-down'
} as const;

export const configBindings: Binding[] = commandBindings({
	[CONFIG_COMMANDS.IMPORT]: 'i',
	[CONFIG_COMMANDS.COPY]: 'c',
	[CONFIG_COMMANDS.EDIT]: 'e',
	[CONFIG_COMMANDS.EDITOR_SAVE]: 'ctrl+s',
	[CONFIG_COMMANDS.EDITOR_PREVIEW]: 'ctrl+p',
	[CONFIG_COMMANDS.EDITOR_PREVIEW_TAB]: 'tab',
	[CONFIG_COMMANDS.EDITOR_CANCEL]: 'escape',
	[CONFIG_COMMANDS.PREVIEW_BACK]: 'escape',
	[CONFIG_COMMANDS.PREVIEW_UP]: 'up',
	[CONFIG_COMMANDS.PREVIEW_DOWN]: 'down'
});

// ------------------------------------------------------------
// 工具管理视图 commands
// ------------------------------------------------------------
export const TOOLS_COMMANDS = {
	UP: 'tools:up',
	DOWN: 'tools:down',
	INSTALL_OR_UPDATE: 'tools:install-or-update',
	TOGGLE_SELECT: 'tools:toggle-select',
	UPDATE_ALL: 'tools:update-all',
	UNINSTALL: 'tools:uninstall',
	REFRESH: 'tools:refresh'
} as const;

export const toolsBindings: Binding[] = commandBindings({
	[TOOLS_COMMANDS.UP]: 'up',
	[TOOLS_COMMANDS.DOWN]: 'down',
	[TOOLS_COMMANDS.INSTALL_OR_UPDATE]: 'enter',
	[TOOLS_COMMANDS.TOGGLE_SELECT]: 'space',
	[TOOLS_COMMANDS.UPDATE_ALL]: 'a',
	[TOOLS_COMMANDS.UNINSTALL]: 'u',
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
