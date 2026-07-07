export type FocusMode = 'nav' | 'header' | 'view' | 'form' | 'modal';

export type ManageModuleId = 'provider' | 'mcp' | 'skills' | 'prompts' | 'config' | 'tools' | 'update';

// 当前 Agent 上下文：内部键用短名（cc/cx），界面 Header 只展示全称（AGENT_CONTEXT_LABELS）。
export type AgentContext = 'cc' | 'cx';

export type ManageKeyName =
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'tab'
	| 'shift-tab'
	| 'enter'
	| 'escape'
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
	// 当前 Agent 上下文（cc=Claude Code / cx=Codex）：Header 切换，左侧 6 菜单顺序与选中不受影响。
	readonly agentContext: AgentContext;
	readonly eventLog: readonly string[];
	readonly shouldExit: boolean;
};

export const menuItems: readonly ManageMenuItem[] = [
	{id: 'tools', label: '工具管理', description: '管理 Claude Code 与 Ccline / CcgWorkflow / OpenSpec / CodexCli / AntigravityCli（安装 / 更新 / 卸载）'},
	{id: 'provider', label: '供应商', description: '管理 API 供应商、密钥与模型环境变量'},
	{id: 'config', label: '配置文件', description: '查看推荐 settings.json 配置、按缺失项补全或外部编辑器编辑'},
	{id: 'prompts', label: '全局规则', description: '查看、导入、复制推荐 CLAUDE.md 或外部编辑器编辑'},
	{id: 'mcp', label: 'MCP', description: '查看、启用、禁用和维护 MCP Server'},
	{id: 'skills', label: 'Skills', description: '搜索、安装、更新和卸载 Claude Code Skills'}
];

// 侧边栏底部固定的「检查更新」按钮（不在 menuItems 列表内，占第 menuItems.length 个导航位）。
// 下键从最后一个菜单可跳到此处选中；selectedMenuItem 在该位返回此按钮（id='update'）。
export const UPDATE_BUTTON: ManageMenuItem = {
	id: 'update',
	label: '检查更新',
	description: '检查并更新 ccq 可执行文件到最新版本'
};

// 导航位总数 = 菜单项 + 底部「检查更新」按钮；按钮占第 menuItems.length 个 index。
const navCount = menuItems.length + 1;
const maxMenuIndex = navCount - 1;

// Header 可见标签（全称，禁止展示 cc/cx 缩写）。单一数据源，供 App Header 与 verify 共用。
export const AGENT_CONTEXT_LABELS: Readonly<Record<AgentContext, string>> = {
	cc: 'Claude Code',
	cx: 'Codex'
};

// Header 切换顺序（左→右），toggle 在其间循环。
export const AGENT_CONTEXT_ORDER: readonly AgentContext[] = ['cc', 'cx'];

/** 切换到上一个 Agent 上下文（cc ↔ cx 循环）。 */
export function previousAgentContext(current: AgentContext): AgentContext {
	const index = AGENT_CONTEXT_ORDER.indexOf(current);
	return AGENT_CONTEXT_ORDER[(index - 1 + AGENT_CONTEXT_ORDER.length) % AGENT_CONTEXT_ORDER.length]!;
}

/** 切换到下一个 Agent 上下文（cc ↔ cx 循环）。 */
export function nextAgentContext(current: AgentContext): AgentContext {
	const index = AGENT_CONTEXT_ORDER.indexOf(current);
	return AGENT_CONTEXT_ORDER[(index + 1) % AGENT_CONTEXT_ORDER.length]!;
}

export function createInitialManageState(): ManageState {
	return {
		// 启动即聚焦右侧视图：首个菜单（工具管理）直接获焦，无需先按 enter 进入
		focus: 'view',
		selectedIndex: 0,
		// 默认 Claude Code（spec manage-tui-shell：初始 agentContext 默认 cc）
		agentContext: 'cc',
		eventLog: ['Manage TUI PoC 已启动'],
		shouldExit: false
	};
}

export function selectedMenuItem(state: ManageState): ManageMenuItem {
	const index = clampIndex(state.selectedIndex);
	// 末位（index === menuItems.length）为底部「检查更新」按钮
	return index < menuItems.length ? menuItems[index]! : UPDATE_BUTTON;
}

export function reduceManageState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (state.shouldExit) {
		return state;
	}

	if (keyName === 'q' && (state.focus === 'nav' || state.focus === 'header' || state.focus === 'view')) {
		return appendLog({...state, shouldExit: true}, 'q 退出');
	}

	switch (state.focus) {
		case 'nav':
			return reduceNavState(state, keyName);
		case 'header':
			return reduceHeaderState(state, keyName);
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

	// 在「检查更新」按钮位时，只有 Enter 键有效（由 App.tsx 处理打开浮窗），
	// right/tab 不触发任何操作，避免误进右侧视图。
	if (state.selectedIndex === menuItems.length) {
		if (keyName === 'escape') {
			return appendLog(state, 'Esc 保持导航焦点');
		}
		return state;
	}

	// 普通菜单项：enter/right/tab 都可以进入右侧视图
	if (keyName === 'enter' || keyName === 'right' || keyName === 'tab') {
		return appendLog({...state, focus: 'view'}, '进入右侧视图');
	}

	if (keyName === 'escape') {
		return appendLog(state, 'Esc 保持导航焦点');
	}

	return state;
}

function reduceHeaderState(state: ManageState, keyName: ManageKeyName): ManageState {
	if (keyName === 'left') {
		return switchAgentContext(state, previousAgentContext(state.agentContext));
	}

	if (keyName === 'right') {
		return switchAgentContext(state, nextAgentContext(state.agentContext));
	}

	if (keyName === 'down' || keyName === 'escape') {
		return appendLog({...state, focus: 'view'}, '返回右侧视图');
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
		return appendLog({...state, focus: 'header'}, '进入 Agent Header');
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

function switchAgentContext(state: ManageState, agentContext: AgentContext): ManageState {
	if (state.agentContext === agentContext) {
		return appendLog(state, `保持 Agent 上下文 → ${AGENT_CONTEXT_LABELS[agentContext]}`);
	}

	return appendLog({...state, agentContext}, `切换 Agent 上下文 → ${AGENT_CONTEXT_LABELS[agentContext]}`);
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
