export type FocusMode = 'nav' | 'view' | 'form' | 'modal';

export type ManageModuleId = 'provider' | 'mcp' | 'skills' | 'prompts' | 'config' | 'tools';

export type ManageKeyName =
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'tab'
	| 'shift-tab'
	| 'enter'
	| 'escape'
	| 'ctrl-s'
	| 'ctrl-c'
	| 'q'
	| 'other';

export type ManageMenuItem = {
	readonly id: ManageModuleId;
	readonly label: string;
	readonly description: string;
};

export type ManageState = {
	readonly focus: FocusMode;
	readonly selectedIndex: number;
	readonly eventLog: readonly string[];
	readonly shouldExit: boolean;
};

export const menuItems: readonly ManageMenuItem[] = [
	{id: 'provider', label: '供应商', description: '管理 API 供应商、密钥与模型环境变量'},
	{id: 'mcp', label: 'MCP', description: '查看、启用、禁用和维护 MCP Server'},
	{id: 'skills', label: 'Skills', description: '搜索、安装、更新和卸载 Claude Code Skills'},
	{id: 'prompts', label: '提示词', description: '查看、导入、复制推荐 CLAUDE.md 或外部编辑器编辑'},
	{id: 'config', label: '配置文件', description: '查看推荐 settings.json 配置、按缺失项补全或外部编辑器编辑'},
	{id: 'tools', label: '工具管理', description: '管理 Claude Code 与 Ccline / CcgWorkflow / OpenSpec / CodexCli / AntigravityCli（安装 / 更新 / 卸载）'}
];

const maxMenuIndex = menuItems.length - 1;

export function createInitialManageState(): ManageState {
	return {
		focus: 'nav',
		selectedIndex: 0,
		eventLog: ['Manage TUI PoC 已启动'],
		shouldExit: false
	};
}

export function selectedMenuItem(state: ManageState): ManageMenuItem {
	return menuItems[clampIndex(state.selectedIndex)]!;
}

export function reduceManageState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (state.shouldExit) {
		return state;
	}

	if (keyName === 'ctrl-c') {
		return appendLog({...state, shouldExit: true}, 'Ctrl+C 退出');
	}

	if (keyName === 'q' && (state.focus === 'nav' || state.focus === 'view')) {
		return appendLog({...state, shouldExit: true}, 'q 退出');
	}

	switch (state.focus) {
		case 'nav':
			return reduceNavState(state, keyName);
		case 'view':
			return reduceViewState(state, keyName);
		case 'form':
			return reduceFormState(state, keyName);
		case 'modal':
			return reduceModalState(state, keyName);
	}
}

export function normalizeManageState(state: ManageState): ManageState {
	return {
		...state,
		selectedIndex: clampIndex(state.selectedIndex),
		eventLog: state.eventLog.slice(-6)
	};
}

function reduceNavState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (keyName === 'up') {
		return appendLog({...state, selectedIndex: wrapIndex(state.selectedIndex - 1)}, '↑ 菜单上移');
	}

	if (keyName === 'down') {
		return appendLog({...state, selectedIndex: wrapIndex(state.selectedIndex + 1)}, '↓ 菜单下移');
	}

	if (keyName === 'enter' || keyName === 'right' || keyName === 'tab') {
		return appendLog({...state, focus: 'view'}, '进入右侧视图');
	}

	if (keyName === 'escape') {
		return appendLog(state, 'Esc 保持导航焦点');
	}

	return state;
}

function reduceViewState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (keyName === 'escape' || keyName === 'left') {
		return appendLog({...state, focus: 'nav'}, '返回左侧菜单');
	}

	if (keyName === 'tab') {
		return appendLog({...state, focus: 'form'}, '进入表单焦点 PoC');
	}

	if (keyName === 'enter') {
		return appendLog({...state, focus: 'modal'}, '打开确认弹窗 PoC');
	}

	if (keyName === 'up') {
		return appendLog({...state, selectedIndex: wrapIndex(state.selectedIndex - 1)}, '视图快捷选择上一项');
	}

	if (keyName === 'down') {
		return appendLog({...state, selectedIndex: wrapIndex(state.selectedIndex + 1)}, '视图快捷选择下一项');
	}

	return state;
}

function reduceFormState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (keyName === 'escape') {
		return appendLog({...state, focus: 'view'}, '取消表单编辑 PoC');
	}

	if (keyName === 'ctrl-s') {
		return appendLog({...state, focus: 'view'}, 'Ctrl+S 保存 PoC 表单');
	}

	if (keyName === 'shift-tab') {
		return appendLog({...state, focus: 'view'}, 'Shift+Tab 返回视图');
	}

	return state;
}

function reduceModalState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (keyName === 'escape') {
		return appendLog({...state, focus: 'view'}, 'Esc 关闭弹窗');
	}

	if (keyName === 'enter') {
		return appendLog({...state, focus: 'view'}, 'Enter 确认弹窗');
	}

	return state;
}

function appendLog(state: ManageState, message: string): ManageState {
	return normalizeManageState({
		...state,
		eventLog: [...state.eventLog, message]
	});
}

function clampIndex(index: number): number {
	return Math.min(Math.max(index, 0), maxMenuIndex);
}

function wrapIndex(index: number): number {
	if (index < 0) {
		return maxMenuIndex;
	}

	if (index > maxMenuIndex) {
		return 0;
	}

	return index;
}
