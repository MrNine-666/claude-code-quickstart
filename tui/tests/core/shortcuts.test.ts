import {describe, expect, test} from 'bun:test';
import {singleLineInputKeyBindings} from '../../src/components/single-line-input.js';
import {
	CONFIG_COMMANDS,
	EXTENSIONS_COMMANDS,
	MCP_COMMANDS,
	PROMPTS_COMMANDS,
	PROVIDER_COMMANDS,
	SKILLS_COMMANDS,
	TOOLS_COMMANDS,
	configBindings,
	extensionsBindings,
	mcpBindings,
	promptsBindings,
	providerBindings,
	skillsBindings,
	toolsBindings
} from '../../src/config/keybindings.js';
import {viewShortcuts} from '../../src/state/shortcuts.js';
import {createInitialExtensionsViewState, extensionsSubMode} from '../../src/state/extensions-view-state.js';
import {formatShortcutKey, hasShortcutModifier, isAppModifier, isEditingModifier, matchesKeyBinding} from '../../src/utils/keyboard.js';
import {skillsSubModeOf} from '../../src/views/skills/SkillsView.js';
import {mapSkillsActionKey} from '../../src/views/skills/skills-view-input.js';

// P5d 迁移自 scripts/verify-shortcuts.mjs（125 条静态断言，整体迁移，脚本删除）。
// 判据：全部为 binding registry / footer 投影的纯函数返回值，无真实 fs / 子进程 / 渲染。
// 原脚本的 11 个 PASS 段拆为 11 个 describe。

type KeyLike = {name: string; ctrl?: boolean; shift?: boolean; super?: boolean; meta?: boolean};

function keyFor(bindings: readonly unknown[], command: string): string | undefined {
	return (bindings as readonly {cmd?: string; key?: string}[]).find(binding => binding.cmd === command)?.key;
}

function byLabel(shortcuts: readonly {label: string; key: string}[]): Record<string, string> {
	return Object.fromEntries(shortcuts.map(shortcut => [shortcut.label, shortcut.key]));
}

const expectedSaveKey = process.platform === 'darwin' ? 'super+s' : 'ctrl+s';
const platform = process.platform === 'darwin' ? 'darwin' : 'default';

describe('快捷键 formatter：macOS ⌘/⌃ 符号 + 非 macOS fallback', () => {
	test('macOS 使用符号，非 macOS 使用文字 fallback', () => {
		expect(formatShortcutKey('super+s', 'darwin'), 'macOS Command 应显示为 ⌘').toBe('⌘S');
		expect(formatShortcutKey('ctrl+t', 'darwin'), 'macOS Control 应显示为 ⌃').toBe('⌃T');
		expect(formatShortcutKey('shift+super+z', 'darwin'), 'macOS Shift+Command 应显示为 ⇧⌘').toBe('⇧⌘Z');
		expect(formatShortcutKey('ctrl+o', 'default'), '非 macOS Control 应显示为 Ctrl').toBe('Ctrl+O');
		expect(formatShortcutKey('super+s', 'default'), '非 macOS Super 使用文字 fallback').toBe('Super+S');
	});
});

describe('modifier helper：编辑语义 Command-first，应用功能 Control-first，文本输入过滤排除修饰键组合', () => {
	test('isEditingModifier / isAppModifier / hasShortcutModifier / matchesKeyBinding', () => {
		expect(isEditingModifier({name: 's', super: true} as KeyLike as never, 'darwin'), 'macOS 编辑语义使用 Cmd/Super').toBe(true);
		expect(isEditingModifier({name: 's', ctrl: true} as KeyLike as never, 'darwin'), 'macOS 编辑语义不做 Ctrl 兼容').toBe(false);
		expect(isEditingModifier({name: 's', ctrl: true} as KeyLike as never, 'default'), '非 macOS 编辑语义使用 Ctrl').toBe(true);
		expect(isAppModifier({name: 't', ctrl: true} as KeyLike as never), 'TUI 应用功能使用 Ctrl').toBe(true);
		expect(isAppModifier({name: 't', super: true} as KeyLike as never), 'TUI 应用功能不使用 Cmd/Super').toBe(false);
		expect(hasShortcutModifier({name: 's', super: true} as KeyLike as never), '文本输入过滤应识别 macOS Cmd/Super 修饰键').toBe(true);
		expect(hasShortcutModifier({name: 's', ctrl: true} as KeyLike as never), '文本输入过滤应识别 Ctrl 修饰键').toBe(true);
		expect(hasShortcutModifier({name: 's', meta: true} as KeyLike as never), '文本输入过滤应识别 Alt/Meta 修饰键').toBe(true);
		expect(hasShortcutModifier({name: 's'} as KeyLike as never), '普通字符输入不应被视为快捷键组合').toBe(false);
		expect(matchesKeyBinding({name: 'return'} as KeyLike as never, 'enter'), 'OpenTUI return 事件应匹配 Enter binding').toBe(true);
	});
});

describe('keybindings：全局规则仅保留编辑操作，Config 推荐/补全保持独立功能', () => {
	test('保存走编辑语义，打开文件走 o，推荐/补全保持独立功能', () => {
		expect(keyFor(promptsBindings, PROMPTS_COMMANDS.EDITOR_SAVE), 'Prompts 保存应按平台编辑语义绑定').toBe(expectedSaveKey);
		expect(keyFor(configBindings, CONFIG_COMMANDS.EDITOR_SAVE), 'Config 保存应按平台编辑语义绑定').toBe(expectedSaveKey);
		expect(keyFor(promptsBindings, PROMPTS_COMMANDS.OPEN_FILE), 'Prompts 应使用 o 打开全局规则文件').toBe('o');
		expect(keyFor(configBindings, CONFIG_COMMANDS.OPEN_FILE), 'Config 应使用 o 打开配置文件').toBe('o');
		expect(keyFor(mcpBindings, MCP_COMMANDS.FORM_SAVE), 'MCP 表单保存应按平台编辑语义绑定').toBe(expectedSaveKey);
		expect(
			promptsBindings.some(binding => binding.key === 'ctrl+t'),
			'Prompts 不应绑定推荐边栏 Ctrl+T'
		).toBe(false);
		expect(
			promptsBindings.some(binding => binding.key === 'ctrl+o'),
			'Prompts 不应绑定推荐导入 Ctrl+O'
		).toBe(false);
		expect(keyFor(configBindings, CONFIG_COMMANDS.TOGGLE_PANEL), 'Config 推荐边栏保持 Ctrl+T').toBe('ctrl+t');
		expect(keyFor(configBindings, CONFIG_COMMANDS.IMPORT), 'Config 补全保持 Ctrl+O').toBe('ctrl+o');
		expect(byLabel(viewShortcuts('prompts', 'view-render'))['打开文件'], 'Prompts footer 应展示 O 打开全局规则文件').toBe('O');
		expect(byLabel(viewShortcuts('config', 'view-render'))['打开文件'], 'Config footer 应展示 O 打开配置文件').toBe('O');
	});
});

describe('Pi Provider 模型列表快捷键与 footer 来自统一 registry', () => {
	test('provider bindings 与 form-pi / form-pi-source footer 投影一致', () => {
		expect(
			viewShortcuts('provider', 'list-pi').some(shortcut => shortcut.label === '切换活跃'),
			'Pi Provider 列表 footer 不得提供切换活跃'
		).toBe(false);
		expect(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_DISCOVER), 'Pi Provider 模型发现应绑定 Ctrl+D').toBe('ctrl+d');
		expect(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_OPTION_PREV), 'Provider 表单选项前移应绑定 Left').toBe('left');
		expect(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_OPTION_NEXT), 'Provider 表单选项后移应绑定 Right').toBe('right');
		expect(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_MULTI_SELECT_TOGGLE), 'Pi Provider 模型多选应绑定 Space').toBe('space');
		expect(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_CONFIRM), 'Pi Provider 模型选择/来源确认应绑定 Enter').toBe('enter');
		expect(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_SOURCE_VIEW), 'Pi 来源摘要/JSON 切换应绑定 Tab').toBe('tab');
		const piProviderFormShortcuts = byLabel(viewShortcuts('provider', 'form-pi'));
		expect(piProviderFormShortcuts['获取上游模型'], 'Pi Provider footer 应展示获取上游模型').toBe(
			formatShortcutKey('ctrl+d', platform)
		);
		expect(piProviderFormShortcuts['选中/取消/来源'], 'Pi Provider footer 应展示 Space 选中/取消/获取来源').toBe('Space');
		expect(piProviderFormShortcuts['选项'], 'Pi Provider footer 应展示 radio/select 选项切换').toBe('←/→');
		expect(piProviderFormShortcuts['添加自定义'], 'Pi Provider footer 不应再展示 A 添加自定义模型').toBeUndefined();
		expect(piProviderFormShortcuts['保存'], 'Pi Provider footer 应展示平台化保存').toBe(
			process.platform === 'darwin' ? '⌘S' : 'Ctrl+S'
		);
		expect(piProviderFormShortcuts['应用选择'], 'Pi Provider footer 不应展示 Enter 应用选择').toBeUndefined();
		expect(
			piProviderFormShortcuts['匹配/重选来源'],
			'Pi Provider footer 不应再展示 Enter 匹配/重选来源（列表行已无 Enter）'
		).toBeUndefined();
		const piSourceShortcuts = byLabel(viewShortcuts('provider', 'form-pi-source'));
		expect(piSourceShortcuts['摘要/JSON'], '来源选择 footer 应展示 Tab 摘要/JSON 切换').toBe('Tab');
		expect(piSourceShortcuts['确认来源'], '来源选择 footer 应展示 Enter 确认来源').toBe('Enter');
		expect(piSourceShortcuts['返回'], '来源选择 footer 应展示 Esc 返回').toBe('Esc');
		expect(
			viewShortcuts('provider', 'model-list').some(shortcut => shortcut.label === '应用选择'),
			'模型列表不应再作为独立 footer 子模式'
		).toBe(false);
		expect(
			viewShortcuts('provider', 'model-manual').some(shortcut => shortcut.label === '添加模型'),
			'自定义模型不应再作为独立 footer 子模式'
		).toBe(false);
		const singleModelFormShortcuts = byLabel(viewShortcuts('provider', 'form-model'));
		expect(singleModelFormShortcuts['获取/刷新模型'], 'CC/CX Provider footer 应展示 Ctrl+D 获取/刷新模型').toBe(
			formatShortcutKey('ctrl+d', platform)
		);
	});
});

describe('footer：平台化符号展示来自单一 binding source', () => {
	test('config edit footer 按平台展示保存/推荐/补全', () => {
		const shortcutByLabel = byLabel(viewShortcuts('config', 'edit'));
		if (process.platform === 'darwin') {
			expect(shortcutByLabel['保存'], 'macOS footer 保存应显示 ⌘S').toBe('⌘S');
			expect(shortcutByLabel['推荐边栏'], 'macOS footer 推荐边栏应显示 ⌃T').toBe('⌃T');
			expect(shortcutByLabel['补全推荐'], 'macOS footer 补全应显示 ⌃O').toBe('⌃O');
		} else {
			expect(shortcutByLabel['保存'], '非 macOS footer 保存应显示 Ctrl+S').toBe('Ctrl+S');
			expect(shortcutByLabel['推荐边栏'], '非 macOS footer 推荐边栏应显示 Ctrl+T').toBe('Ctrl+T');
			expect(shortcutByLabel['补全推荐'], '非 macOS footer 补全应显示 Ctrl+O').toBe('Ctrl+O');
		}
	});
});

describe('Skills 多选快捷键与 footer 来自统一 registry', () => {
	test('skills bindings、subMode 与 footer 投影一致', () => {
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_RESULT), 'Skills 当前项选择应绑定 Space').toBe('space');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.SELECT_ALL), 'Skills 安装页全选应绑定上下文内 a').toBe('a');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.SUBMIT_SEARCH), 'Skills 搜索提交应绑定 Enter').toBe('enter');
		expect(
			skillsSubModeOf({mode: 'install', homeLayout: 'flat', queryFocused: true} as never),
			'Skills 安装页搜索框焦点必须上报 install-search'
		).toBe('install-search');
		expect(
			skillsSubModeOf({mode: 'install', homeLayout: 'flat', queryFocused: false} as never),
			'Skills 安装页列表焦点必须上报 install-list'
		).toBe('install-list');
		expect(
			skillsSubModeOf({mode: 'list', homeLayout: 'flat', filterFocused: true} as never),
			'Skills 已安装页过滤框焦点必须上报 list-filter'
		).toBe('list-filter');
		const skillsInstallSearch = byLabel(viewShortcuts('skills', 'install-search'));
		expect(skillsInstallSearch['搜索'], 'Skills 搜索框 footer 应展示 Enter 搜索').toBe('Enter');
		expect(skillsInstallSearch['切换焦点'], 'Skills 搜索框 footer 应统一展示 Tab 切换焦点').toBe('Tab');
		expect(skillsInstallSearch['返回列表页'], 'Skills 搜索框 footer 不应展示 Esc 返回列表页').toBeUndefined();
		expect(skillsInstallSearch['选择 skill'], 'Skills 搜索框 footer 不应展示列表上下选择').toBeUndefined();
		const skillsListFilter = byLabel(viewShortcuts('skills', 'list-filter'));
		expect(skillsListFilter['切换焦点'], 'Skills 过滤框 footer 应统一展示 Tab 切换焦点').toBe('Tab');
		expect(skillsListFilter['清空过滤'], 'Skills 过滤框 footer 不应展示 Esc 清空过滤').toBeUndefined();
		expect(skillsListFilter['选择'], 'Skills 过滤框 footer 不应展示列表上下选择').toBeUndefined();
		const skillsInstallLabels = viewShortcuts('skills', 'install-list').map(shortcut => shortcut.label);
		expect(skillsInstallLabels.includes('选择/取消'), 'Skills 安装页 footer 应展示选择切换').toBe(true);
		expect(skillsInstallLabels.includes('全选'), 'Skills 安装页 footer 应展示全选').toBe(true);
		expect(skillsInstallLabels.includes('返回菜单'), 'Skills 安装页首项 footer 应展示 ← 返回菜单').toBe(true);
	});
});

describe('Skills 列表页单列、布局、来源链接与批量键位同 footer 一致', () => {
	test('skills 列表 bindings 与 list-flat / list-grouped footer 投影一致', () => {
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_INSTALLED), 'Skills 已安装项选择应绑定 Space').toBe('space');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.SELECT_ALL), 'Skills 列表页全选/全部取消应绑定 a').toBe('a');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.UPDATE_SELECTED), 'Skills 列表页更新选中应绑定 u').toBe('u');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_LAYOUT), 'Skills 列表页布局切换应绑定 v').toBe('v');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_ALL_GROUPS), 'Skills 分组全部展开/收起应绑定 e').toBe('e');
		expect(mapSkillsActionKey('e'), 'Skills 输入层应把 e 解析为全部展开/收起').toBe('toggle-all-groups');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.OPEN_SOURCE), 'Skills 列表页打开来源应绑定 o').toBe('o');
		expect(keyFor(skillsBindings, SKILLS_COMMANDS.INSTALL), 'Skills 列表页安装应绑定 i').toBe('i');
		expect(skillsSubModeOf({mode: 'list', homeLayout: 'flat'} as never)).toBe('list-flat');
		expect(skillsSubModeOf({mode: 'list', homeLayout: 'grouped'} as never)).toBe('list-grouped');
		const skillsListShortcuts = viewShortcuts('skills', 'list-flat');
		const skillsGroupedShortcuts = viewShortcuts('skills', 'list-grouped');
		const skillsListByLabel = byLabel(skillsListShortcuts);
		const skillsGroupedByLabel = byLabel(skillsGroupedShortcuts);
		expect(skillsListByLabel['选择'], 'Skills 单列 footer 应只展示上下选择').toBe('↑/↓');
		expect(skillsListByLabel['选择/展开'], 'Skills 列表 footer 应展示 Item 选择/组展开的上下文语义').toBe('Space');
		expect(skillsListByLabel['全选/取消'], 'Skills 列表 footer 应展示 a 批量选择').toBe('A');
		expect(skillsListByLabel['切换布局'], 'Skills 列表 footer 应展示 v 切换布局').toBe('V');
		expect(skillsListByLabel['全部展开/收起'], 'Skills 平铺 footer 不应展示 e').toBeUndefined();
		expect(skillsGroupedByLabel['全部展开/收起'], 'Skills 分组 footer 应展示 e 全部展开/收起').toBe('E');
		const skillsListFilterByLabel = byLabel(viewShortcuts('skills', 'list-filter'));
		expect(skillsListFilterByLabel['切换焦点'], 'Skills 过滤焦点 footer 应统一展示 Tab 切换焦点').toBe('Tab');
		expect(skillsListByLabel['打开来源'], 'Skills 列表 footer 应展示 o 打开来源').toBe('O');
		expect(skillsListByLabel['更新'], 'Skills 列表 footer 批量/当前回退更新应显示大写 U').toBe('U');
		expect(skillsListByLabel['安装'], 'Skills 列表 footer 安装应显示大写 I').toBe('I');
		expect(
			skillsListShortcuts.some(shortcut => shortcut.label === '更新全部'),
			'Skills 列表不得再暴露更新全部'
		).toBe(false);
	});
});

describe('扩展管理 footer 随搜索框/Grid 焦点动态切换', () => {
	test('extensions bindings、subMode 与 footer 投影一致', () => {
		expect(keyFor(extensionsBindings, EXTENSIONS_COMMANDS.FOCUS_CYCLE), '扩展管理焦点切换应绑定 Tab').toBe('tab');
		expect(keyFor(extensionsBindings, EXTENSIONS_COMMANDS.PRIMARY_ACTION), '扩展管理主操作应绑定 Enter').toBe('enter');
		expect(keyFor(extensionsBindings, EXTENSIONS_COMMANDS.UPDATE_ALL), '扩展管理全部更新应绑定 A').toBe('a');
		const extensionSubModeState = (overrides: Record<string, unknown>) => ({
			...createInitialExtensionsViewState(),
			loading: false,
			...overrides
		});
		expect(extensionsSubMode(extensionSubModeState({mode: 'search', focus: 'search'}) as never)).toBe('search');
		expect(extensionsSubMode(extensionSubModeState({mode: 'search', focus: 'grid', query: 'tool'}) as never)).toBe('grid');
		expect(extensionsSubMode(extensionSubModeState({mode: 'installed', focus: 'grid'}) as never)).toBe('installed-grid');
		expect(
			extensionsSubMode(
				extensionSubModeState({
					mode: 'search',
					focus: 'grid',
					query: 'tool',
					searchResults: [{name: 'tool', source: 'npm:tool', installed: false}],
					installed: []
				}) as never
			)
		).toBe('grid-uninstalled');
		const extensionsSearch = byLabel(viewShortcuts('extensions', 'search'));
		expect(extensionsSearch['搜索'], '扩展搜索框 footer 应展示 Enter 搜索').toBe('Enter');
		expect(extensionsSearch['切换焦点'], '扩展搜索框 footer 应统一展示 Tab 切换焦点').toBe('Tab');
		expect(extensionsSearch['返回菜单'], '扩展搜索框 footer 不应展示 Esc 返回菜单').toBeUndefined();
		expect(extensionsSearch['选择'], '扩展搜索框 footer 不应展示 Grid 方向选择').toBeUndefined();
		const extensionsGrid = byLabel(viewShortcuts('extensions', 'grid'));
		expect(extensionsGrid['切换焦点'], '扩展 Grid footer 应统一展示 Tab 切换焦点').toBe('Tab');
		expect(extensionsGrid['安装/更新'], '扩展 Grid footer 应展示 Enter 安装/更新').toBe('Enter');
		expect(extensionsGrid['全部更新'], '扩展 Grid footer 应展示 A 全部更新').toBe('A');
		expect(extensionsGrid['查看详情'], '扩展 Grid footer 应展示 O 查看详情').toBe('O');
		expect(extensionsGrid['选择/返回菜单'], '扩展 Grid footer 应提示首项 ← 返回菜单').toBe('←');
		expect(extensionsGrid['卸载'], '已安装扩展 Grid footer 应展示 D 卸载').toBe('D');
		expect(extensionsGrid['搜索'], '扩展 Grid footer 不应继续展示搜索语义').toBeUndefined();
		const extensionsInstalledGrid = byLabel(viewShortcuts('extensions', 'installed-grid'));
		expect(extensionsInstalledGrid['翻页'], '已安装扩展列表 footer 不应展示分页快捷键').toBeUndefined();
		const extensionsUninstalledGrid = byLabel(viewShortcuts('extensions', 'grid-uninstalled'));
		expect(extensionsUninstalledGrid['卸载'], '商店未安装扩展 footer 不应展示 D 卸载').toBeUndefined();
		expect(viewShortcuts('extensions', 'searching')[0]?.label, '扩展搜索执行中 footer 应只展示等待状态').toBe('搜索中');
	});
});

describe('Skills Modal 快捷键提示与 footer 共用统一 registry', () => {
	test('单行输入绑定与收编确认 Modal footer 一致', () => {
		const skillsAdoptShortcuts = viewShortcuts('skills', 'confirm-topology-change');
		const defaultInputBindings = singleLineInputKeyBindings('default');
		const inputAction = (name: string, {ctrl = false, shift = false}: {ctrl?: boolean; shift?: boolean} = {}) =>
			defaultInputBindings.find(
				binding => binding.name === name && Boolean(binding.ctrl) === ctrl && Boolean(binding.shift) === shift
			)?.action;
		expect(inputAction('a', {ctrl: true}), 'Windows/Linux Ctrl+A 应全选输入内容').toBe('select-all');
		expect(inputAction('z', {ctrl: true}), 'Windows/Linux Ctrl+Z 应撤销').toBe('undo');
		expect(inputAction('z', {ctrl: true, shift: true}), 'Windows/Linux Ctrl+Shift+Z 应重做').toBe('redo');
		expect(inputAction('y', {ctrl: true}), 'Windows/Linux Ctrl+Y 应重做').toBe('redo');
		expect(
			skillsAdoptShortcuts.map(shortcut => [shortcut.key, shortcut.label]),
			'Skills 收编确认 Modal 应复用确认态快捷键'
		).toEqual([
			['Enter', '确认执行'],
			['Esc', '取消']
		]);
	});
});

describe('Tools 普通/管理型卡片快捷键按上下文统一到 Enter 主操作', () => {
	test('tools bindings 与 grid / grid-inject footer 投影一致', () => {
		expect(keyFor(toolsBindings, TOOLS_COMMANDS.PRIMARY_ACTION), 'Tools 网格主操作应统一绑定 Enter').toBe('enter');
		expect(keyFor(toolsBindings, TOOLS_COMMANDS.UPDATE_ONE), 'Tools 管理型卡片应保留 u 单项更新').toBe('u');
		const toolsGridShortcuts = viewShortcuts('tools', 'grid');
		expect(
			toolsGridShortcuts.filter(shortcut => shortcut.label === '安装/更新').map(shortcut => [shortcut.key, shortcut.label]),
			'Tools 普通卡片 footer 应只显示 Enter 安装/更新'
		).toEqual([['Enter', '安装/更新']]);
		expect(
			toolsGridShortcuts.some(shortcut => ['i', 'm', 'u'].includes(shortcut.key.toLowerCase())),
			'Tools 普通卡片 footer 不应保留 i/m/u 主操作'
		).toBe(false);
		const toolsInjectShortcuts = viewShortcuts('tools', 'grid-inject');
		expect(
			toolsInjectShortcuts
				.filter(shortcut => shortcut.label === '管理开关' || shortcut.label === '更新')
				.map(shortcut => [shortcut.key, shortcut.label]),
			'Tools 管理型卡片 footer 应显示 Enter 管理开关与 u 更新'
		).toEqual([
			['Enter', '管理开关'],
			['U', '更新']
		]);
	});
});

describe('卸载文案：统一使用简洁动作名，不在 footer 重复强调底层全量语义', () => {
	test('Skills / Tools 列表与确认态 footer 文案', () => {
		const skillsListLabels = viewShortcuts('skills', 'list-flat').map(shortcut => shortcut.label);
		const skillsConfirmLabels = viewShortcuts('skills', 'confirm-uninstall').map(shortcut => shortcut.label);
		const toolsGridLabels = viewShortcuts('tools', 'grid').map(shortcut => shortcut.label);
		const toolsConfirmLabels = viewShortcuts('tools', 'confirm-uninstall').map(shortcut => shortcut.label);
		expect(skillsListLabels.includes('卸载'), 'Skills 列表 footer 应显示“卸载”').toBe(true);
		expect(skillsConfirmLabels.includes('确认批量卸载（所有 Agent）'), 'Skills 确认态应保留批量卸载范围提示').toBe(true);
		expect(toolsGridLabels.includes('卸载'), 'Tools footer 应显示“卸载”').toBe(true);
		expect(toolsConfirmLabels.includes('确认卸载'), 'Tools 确认态 footer 应显示“确认卸载”').toBe(true);
		expect(
			[...skillsListLabels, ...skillsConfirmLabels, ...toolsGridLabels, ...toolsConfirmLabels].some(label =>
				label.includes('全量卸载')
			),
			'TUI footer 不应再显示“全量卸载”'
		).toBe(false);
	});
});
