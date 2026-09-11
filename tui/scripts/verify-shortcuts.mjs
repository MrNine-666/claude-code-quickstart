import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {singleLineInputKeyBindings} from '../src/components/single-line-input.tsx';
import {formatShortcutKey, hasShortcutModifier, isAppModifier, isEditingModifier, matchesKeyBinding} from '../src/utils/keyboard.ts';
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
} from '../src/config/keybindings.ts';
import {viewShortcuts} from '../src/state/shortcuts.ts';
import {createInitialExtensionsViewState, extensionsSubMode} from '../src/state/extensions-view-state.ts';
import {mapSkillsActionKey} from '../src/views/skills/skills-view-input.ts';
import {skillsSubModeOf} from '../src/views/skills/SkillsView.tsx';

function keyFor(bindings, command) {
	return bindings.find(binding => binding.cmd === command)?.key;
}

// ── formatter：macOS 符号 + 非 macOS fallback ───────────────────────────────
assert.equal(formatShortcutKey('super+s', 'darwin'), '⌘S', 'macOS Command 应显示为 ⌘');
assert.equal(formatShortcutKey('ctrl+t', 'darwin'), '⌃T', 'macOS Control 应显示为 ⌃');
assert.equal(formatShortcutKey('shift+super+z', 'darwin'), '⇧⌘Z', 'macOS Shift+Command 应显示为 ⇧⌘');
assert.equal(formatShortcutKey('ctrl+o', 'default'), 'Ctrl+O', '非 macOS Control 应显示为 Ctrl');
assert.equal(formatShortcutKey('super+s', 'default'), 'Super+S', '非 macOS Super 使用文字 fallback');
console.log('[PASS] 快捷键 formatter：macOS ⌘/⌃ 符号 + 非 macOS fallback');

// ── modifier helper：编辑语义与应用功能分离 ────────────────────────────────
assert.equal(isEditingModifier({name: 's', super: true}, 'darwin'), true, 'macOS 编辑语义使用 Cmd/Super');
assert.equal(isEditingModifier({name: 's', ctrl: true}, 'darwin'), false, 'macOS 编辑语义不做 Ctrl 兼容');
assert.equal(isEditingModifier({name: 's', ctrl: true}, 'default'), true, '非 macOS 编辑语义使用 Ctrl');
assert.equal(isAppModifier({name: 't', ctrl: true}), true, 'TUI 应用功能使用 Ctrl');
assert.equal(isAppModifier({name: 't', super: true}), false, 'TUI 应用功能不使用 Cmd/Super');
assert.equal(hasShortcutModifier({name: 's', super: true}), true, '文本输入过滤应识别 macOS Cmd/Super 修饰键');
assert.equal(hasShortcutModifier({name: 's', ctrl: true}), true, '文本输入过滤应识别 Ctrl 修饰键');
assert.equal(hasShortcutModifier({name: 's', meta: true}), true, '文本输入过滤应识别 Alt/Meta 修饰键');
assert.equal(hasShortcutModifier({name: 's'}), false, '普通字符输入不应被视为快捷键组合');
assert.equal(matchesKeyBinding({name: 'return'}, 'enter'), true, 'OpenTUI return 事件应匹配 Enter binding');
console.log('[PASS] modifier helper：编辑语义 Command-first，应用功能 Control-first，文本输入过滤排除修饰键组合');

// ── binding 数据源：保存走编辑语义；Config 推荐/补全走 Control ──────────────
const expectedSaveKey = process.platform === 'darwin' ? 'super+s' : 'ctrl+s';
assert.equal(keyFor(promptsBindings, PROMPTS_COMMANDS.EDITOR_SAVE), expectedSaveKey, 'Prompts 保存应按平台编辑语义绑定');
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.EDITOR_SAVE), expectedSaveKey, 'Config 保存应按平台编辑语义绑定');
assert.equal(keyFor(promptsBindings, PROMPTS_COMMANDS.OPEN_FILE), 'o', 'Prompts 应使用 o 打开全局规则文件');
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.OPEN_FILE), 'o', 'Config 应使用 o 打开配置文件');
assert.equal(keyFor(mcpBindings, MCP_COMMANDS.FORM_SAVE), expectedSaveKey, 'MCP 表单保存应按平台编辑语义绑定');
assert.equal(
	promptsBindings.some(binding => binding.key === 'ctrl+t'),
	false,
	'Prompts 不应绑定推荐边栏 Ctrl+T'
);
assert.equal(
	promptsBindings.some(binding => binding.key === 'ctrl+o'),
	false,
	'Prompts 不应绑定推荐导入 Ctrl+O'
);
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.TOGGLE_PANEL), 'ctrl+t', 'Config 推荐边栏保持 Ctrl+T');
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.IMPORT), 'ctrl+o', 'Config 补全保持 Ctrl+O');
assert.equal(
	Object.fromEntries(viewShortcuts('prompts', 'view-render').map(shortcut => [shortcut.label, shortcut.key]))['打开文件'],
	'O',
	'Prompts footer 应展示 O 打开全局规则文件'
);
assert.equal(
	Object.fromEntries(viewShortcuts('config', 'view-render').map(shortcut => [shortcut.label, shortcut.key]))['打开文件'],
	'O',
	'Config footer 应展示 O 打开配置文件'
);
console.log('[PASS] keybindings：全局规则仅保留编辑操作，Config 推荐/补全保持独立功能');

// ── Pi Provider 模型列表：获取/多选快捷键与 footer 共用 registry ────────
assert.equal(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_DISCOVER), 'ctrl+d', 'Pi Provider 模型发现应绑定 Ctrl+D');
assert.equal(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_OPTION_PREV), 'left', 'Provider 表单选项前移应绑定 Left');
assert.equal(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_OPTION_NEXT), 'right', 'Provider 表单选项后移应绑定 Right');
assert.equal(keyFor(providerBindings, PROVIDER_COMMANDS.FORM_MULTI_SELECT_TOGGLE), 'space', 'Pi Provider 模型多选应绑定 Space');
const piProviderFormShortcuts = Object.fromEntries(viewShortcuts('provider', 'form-pi').map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(piProviderFormShortcuts['获取上游模型'], 'Ctrl+D', 'Pi Provider footer 应展示获取上游模型');
assert.equal(piProviderFormShortcuts['切换选择'], 'Space', 'Pi Provider footer 应展示 Space 多选');
assert.equal(piProviderFormShortcuts['选项'], '←/→', 'Pi Provider footer 应展示 radio/select 选项切换');
assert.equal(piProviderFormShortcuts['添加自定义'], undefined, 'Pi Provider footer 不应再展示 A 添加自定义模型');
assert.equal(piProviderFormShortcuts['保存'], process.platform === 'darwin' ? '⌘S' : 'Ctrl+S', 'Pi Provider footer 应展示平台化保存');
assert.equal(piProviderFormShortcuts['应用选择'], undefined, 'Pi Provider footer 不应展示 Enter 应用选择');
assert.equal(
	viewShortcuts('provider', 'model-list').some(shortcut => shortcut.label === '应用选择'),
	false,
	'模型列表不应再作为独立 footer 子模式'
);
assert.equal(
	viewShortcuts('provider', 'model-manual').some(shortcut => shortcut.label === '添加模型'),
	false,
	'自定义模型不应再作为独立 footer 子模式'
);
const providerFormSource = readFileSync(new URL('../src/views/provider/ProviderFormView.tsx', import.meta.url), 'utf8');
const formPanelSource = readFileSync(new URL('../src/components/form/FormPanel.tsx', import.meta.url), 'utf8');
assert.doesNotMatch(providerFormSource, /Ctrl\+D|Space 多选|Ctrl\/Cmd\+S/, 'ProviderFormView 不应自行硬编码 Pi 快捷键提示');
assert.match(providerFormSource, /onDiscover \? \(/, '模型列表必须与 Pi Provider 表单共存');
assert.doesNotMatch(providerFormSource, /setDiscovery\(null\)/, 'Esc 不得通过清空 discovery 隐藏模型列表');
assert.doesNotMatch(
	providerFormSource,
	/ProviderModelDiscoveryModal|<Modal active title="模型列表"/,
	'Provider 表单不应再渲染模型列表弹窗'
);
assert.match(providerFormSource, /MODEL_DISCOVERY_LIST_HEIGHT/, '内嵌模型列表必须受控滚动，避免撑出表单视口');
assert.match(providerFormSource, /toast\.warning\('请先填写 Base URL，再获取上游模型'\)/, 'Base URL 为空时必须用 toast 提示先填写地址');
assert.doesNotMatch(providerFormSource, /toast\.info\('正在获取上游模型…'\)/, 'Ctrl+D 开始获取时不应弹 toast');
assert.doesNotMatch(providerFormSource, /toast\.success\(`已获取 \$\{candidates\.length\} 个上游模型`\)/, 'Ctrl+D 成功后不应弹 toast');
assert.match(providerFormSource, /<ListLoadingState message="正在获取上游模型"\s*\/>/, 'Ctrl+D 加载期间必须保留列表加载状态');
assert.match(providerFormSource, /toast\.error\(`获取上游模型失败：\$\{reason\}`\)/, 'Ctrl+D 失败后必须弹错误 toast');
assert.match(providerFormSource, /onKeyEvent=\{handleFormKey\}/, 'Ctrl+D 必须由表单控件在任意字段焦点下接收');
assert.match(
	providerFormSource,
	/if \(onDiscover && matchesProviderCommand\(keyEvent, PROVIDER_COMMANDS\.FORM_DISCOVER\)\)/,
	'Ctrl+D 必须由页面级监听覆盖 textarea 与模型输入焦点'
);
assert.match(providerFormSource, /value=\{discovery\.manualValue\}/, '自定义模型输入必须常驻模型列表区域');
assert.match(providerFormSource, /modelFocus|moveModelCursor/, '模型列表与自定义模型输入必须支持上下切换焦点');
assert.match(providerFormSource, /modelIdsForSubmit/, 'Ctrl+S 提交时必须带上模型列表草稿');
assert.match(
	providerFormSource,
	/filterModelCandidates[\s\S]*candidates\.filter\(candidate => candidate\.toLowerCase\(\)\.includes\(normalizedQuery\)\)/s,
	'手工模型输入必须按输入内容自动过滤候选模型'
);
assert.match(providerFormSource, /onSubmit=\{onManualModelSubmit\}/, '手工模型输入必须通过 input submit 回调处理 Enter');
assert.match(providerFormSource, /placeholder="输入模型名称筛选，按Enter添加"/, '手工模型输入必须同时提示筛选与 Enter 添加');
assert.doesNotMatch(
	providerFormSource,
	/if \(modelFocus === 'manual'\) \{\s*const name = keyEvent\.name\.toLowerCase\(\);\s*if \(name === 'enter' \|\| name === 'return'\)/s,
	'手工模型输入的 Enter 不应由页面级监听重复处理'
);
assert.doesNotMatch(providerFormSource, /FORM_ADD_CUSTOM_MODEL/, 'Pi Provider 不应再处理 A 添加自定义模型');
assert.doesNotMatch(providerFormSource, /FORM_DISCOVERY_CONFIRM|applyDiscovery|applyModelIds/, '模型列表不应再有 Enter 应用阶段');
assert.doesNotMatch(formPanelSource, /MultiSelectField|multi-select/, 'FormPanel 不应内置业务多选字段');
assert.match(formPanelSource, /readonly custom\?: ReactNode/, '业务自定义字段应由父组件通过 custom slot 传入');
assert.match(providerFormSource, /custom=\{/, 'Provider 模型列表应通过 FormPanel custom slot 注入');
console.log('[PASS] Pi Provider 模型列表快捷键与 footer 来自统一 registry');

// ── footer：从同一 binding source 派生，并按当前平台展示 ───────────────────
const configEdit = viewShortcuts('config', 'edit');
const shortcutByLabel = Object.fromEntries(configEdit.map(shortcut => [shortcut.label, shortcut.key]));
if (process.platform === 'darwin') {
	assert.equal(shortcutByLabel['保存'], '⌘S', 'macOS footer 保存应显示 ⌘S');
	assert.equal(shortcutByLabel['推荐边栏'], '⌃T', 'macOS footer 推荐边栏应显示 ⌃T');
	assert.equal(shortcutByLabel['补全推荐'], '⌃O', 'macOS footer 补全应显示 ⌃O');
} else {
	assert.equal(shortcutByLabel['保存'], 'Ctrl+S', '非 macOS footer 保存应显示 Ctrl+S');
	assert.equal(shortcutByLabel['推荐边栏'], 'Ctrl+T', '非 macOS footer 推荐边栏应显示 Ctrl+T');
	assert.equal(shortcutByLabel['补全推荐'], 'Ctrl+O', '非 macOS footer 补全应显示 Ctrl+O');
}
console.log('[PASS] footer：平台化符号展示来自单一 binding source');

// ── Skills 安装页多选：Space/全选键与 footer 共用 registry ────────────────
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_RESULT), 'space', 'Skills 当前项选择应绑定 Space');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.SELECT_ALL), 'a', 'Skills 安装页全选应绑定上下文内 a');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.SUBMIT_SEARCH), 'enter', 'Skills 搜索提交应绑定 Enter');
assert.equal(
	skillsSubModeOf({mode: 'install', homeLayout: 'flat', queryFocused: true}),
	'install-search',
	'Skills 安装页搜索框焦点必须上报 install-search'
);
assert.equal(
	skillsSubModeOf({mode: 'install', homeLayout: 'flat', queryFocused: false}),
	'install-list',
	'Skills 安装页列表焦点必须上报 install-list'
);
assert.equal(
	skillsSubModeOf({mode: 'list', homeLayout: 'flat', filterFocused: true}),
	'list-filter',
	'Skills 已安装页过滤框焦点必须上报 list-filter'
);
const skillsInstallSearch = Object.fromEntries(viewShortcuts('skills', 'install-search').map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(skillsInstallSearch['搜索'], 'Enter', 'Skills 搜索框 footer 应展示 Enter 搜索');
assert.equal(skillsInstallSearch['切换焦点'], 'Tab', 'Skills 搜索框 footer 应统一展示 Tab 切换焦点');
assert.equal(skillsInstallSearch['返回列表页'], undefined, 'Skills 搜索框 footer 不应展示 Esc 返回列表页');
assert.equal(skillsInstallSearch['选择 skill'], undefined, 'Skills 搜索框 footer 不应展示列表上下选择');
const skillsListFilter = Object.fromEntries(viewShortcuts('skills', 'list-filter').map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(skillsListFilter['切换焦点'], 'Tab', 'Skills 过滤框 footer 应统一展示 Tab 切换焦点');
assert.equal(skillsListFilter['清空过滤'], undefined, 'Skills 过滤框 footer 不应展示 Esc 清空过滤');
assert.equal(skillsListFilter['选择'], undefined, 'Skills 过滤框 footer 不应展示列表上下选择');
const skillsInstallLabels = viewShortcuts('skills', 'install-list').map(shortcut => shortcut.label);
assert.equal(skillsInstallLabels.includes('选择/取消'), true, 'Skills 安装页 footer 应展示选择切换');
assert.equal(skillsInstallLabels.includes('全选'), true, 'Skills 安装页 footer 应展示全选');
assert.equal(skillsInstallLabels.includes('返回菜单'), true, 'Skills 安装页首项 footer 应展示 ← 返回菜单');
console.log('[PASS] Skills 多选快捷键与 footer 来自统一 registry');

// ── Skills 列表页键位：单列选择、布局切换、来源链接与批量动作 ──
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_INSTALLED), 'space', 'Skills 已安装项选择应绑定 Space');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.SELECT_ALL), 'a', 'Skills 列表页全选/全部取消应绑定 a');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.UPDATE_SELECTED), 'u', 'Skills 列表页更新选中应绑定 u');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_LAYOUT), 'v', 'Skills 列表页布局切换应绑定 v');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.TOGGLE_ALL_GROUPS), 'e', 'Skills 分组全部展开/收起应绑定 e');
assert.equal(mapSkillsActionKey('e'), 'toggle-all-groups', 'Skills 输入层应把 e 解析为全部展开/收起');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.OPEN_SOURCE), 'o', 'Skills 列表页打开来源应绑定 o');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.INSTALL), 'i', 'Skills 列表页安装应绑定 i');
assert.equal(skillsSubModeOf({mode: 'list', homeLayout: 'flat'}), 'list-flat');
assert.equal(skillsSubModeOf({mode: 'list', homeLayout: 'grouped'}), 'list-grouped');
const skillsListShortcuts = viewShortcuts('skills', 'list-flat');
const skillsGroupedShortcuts = viewShortcuts('skills', 'list-grouped');
const skillsListByLabel = Object.fromEntries(skillsListShortcuts.map(shortcut => [shortcut.label, shortcut.key]));
const skillsGroupedByLabel = Object.fromEntries(skillsGroupedShortcuts.map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(skillsListByLabel['选择'], '↑/↓', 'Skills 单列 footer 应只展示上下选择');
assert.equal(skillsListByLabel['选择/展开'], 'Space', 'Skills 列表 footer 应展示 Item 选择/组展开的上下文语义');
assert.equal(skillsListByLabel['全选/取消'], 'A', 'Skills 列表 footer 应展示 a 批量选择');
assert.equal(skillsListByLabel['切换布局'], 'V', 'Skills 列表 footer 应展示 v 切换布局');
assert.equal(skillsListByLabel['全部展开/收起'], undefined, 'Skills 平铺 footer 不应展示 e');
assert.equal(skillsGroupedByLabel['全部展开/收起'], 'E', 'Skills 分组 footer 应展示 e 全部展开/收起');
const skillsListFilterByLabel = Object.fromEntries(viewShortcuts('skills', 'list-filter').map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(skillsListFilterByLabel['切换焦点'], 'Tab', 'Skills 过滤焦点 footer 应统一展示 Tab 切换焦点');
assert.equal(skillsListByLabel['打开来源'], 'O', 'Skills 列表 footer 应展示 o 打开来源');
assert.equal(skillsListByLabel['更新'], 'U', 'Skills 列表 footer 批量/当前回退更新应显示大写 U');
assert.equal(skillsListByLabel['安装'], 'I', 'Skills 列表 footer 安装应显示大写 I');
assert.equal(
	skillsListShortcuts.some(shortcut => shortcut.label === '更新全部'),
	false,
	'Skills 列表不得再暴露更新全部'
);
console.log('[PASS] Skills 列表页单列、布局、来源链接与批量键位同 footer 一致');

// ── 扩展管理：搜索框与结果 Grid 使用不同 footer 上下文 ───────────────────
assert.equal(keyFor(extensionsBindings, EXTENSIONS_COMMANDS.FOCUS_CYCLE), 'tab', '扩展管理焦点切换应绑定 Tab');
assert.equal(keyFor(extensionsBindings, EXTENSIONS_COMMANDS.PRIMARY_ACTION), 'enter', '扩展管理主操作应绑定 Enter');
assert.equal(keyFor(extensionsBindings, EXTENSIONS_COMMANDS.UPDATE_ALL), 'a', '扩展管理全部更新应绑定 A');
const extensionSubModeState = overrides => ({...createInitialExtensionsViewState(), loading: false, ...overrides});
assert.equal(extensionsSubMode(extensionSubModeState({mode: 'search', focus: 'search'})), 'search');
assert.equal(extensionsSubMode(extensionSubModeState({mode: 'search', focus: 'grid', query: 'tool'})), 'grid');
assert.equal(extensionsSubMode(extensionSubModeState({mode: 'installed', focus: 'grid'})), 'installed-grid');
assert.equal(
	extensionsSubMode(
		extensionSubModeState({
			mode: 'search',
			focus: 'grid',
			query: 'tool',
			searchResults: [{name: 'tool', source: 'npm:tool', installed: false}],
			installed: []
		})
	),
	'grid-uninstalled'
);
const extensionsSearch = Object.fromEntries(viewShortcuts('extensions', 'search').map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(extensionsSearch['搜索'], 'Enter', '扩展搜索框 footer 应展示 Enter 搜索');
assert.equal(extensionsSearch['切换焦点'], 'Tab', '扩展搜索框 footer 应统一展示 Tab 切换焦点');
assert.equal(extensionsSearch['返回菜单'], undefined, '扩展搜索框 footer 不应展示 Esc 返回菜单');
assert.equal(extensionsSearch['选择'], undefined, '扩展搜索框 footer 不应展示 Grid 方向选择');
const extensionsGrid = Object.fromEntries(viewShortcuts('extensions', 'grid').map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(extensionsGrid['切换焦点'], 'Tab', '扩展 Grid footer 应统一展示 Tab 切换焦点');
assert.equal(extensionsGrid['安装/更新'], 'Enter', '扩展 Grid footer 应展示 Enter 安装/更新');
assert.equal(extensionsGrid['全部更新'], 'A', '扩展 Grid footer 应展示 A 全部更新');
assert.equal(extensionsGrid['查看详情'], 'O', '扩展 Grid footer 应展示 O 查看详情');
assert.equal(extensionsGrid['选择/返回菜单'], '←', '扩展 Grid footer 应提示首项 ← 返回菜单');
assert.equal(extensionsGrid['卸载'], 'D', '已安装扩展 Grid footer 应展示 D 卸载');
assert.equal(extensionsGrid['搜索'], undefined, '扩展 Grid footer 不应继续展示搜索语义');
const extensionsInstalledGrid = Object.fromEntries(
	viewShortcuts('extensions', 'installed-grid').map(shortcut => [shortcut.label, shortcut.key])
);
assert.equal(extensionsInstalledGrid['翻页'], undefined, '已安装扩展列表 footer 不应展示分页快捷键');
const extensionsUninstalledGrid = Object.fromEntries(
	viewShortcuts('extensions', 'grid-uninstalled').map(shortcut => [shortcut.label, shortcut.key])
);
assert.equal(extensionsUninstalledGrid['卸载'], undefined, '商店未安装扩展 footer 不应展示 D 卸载');
assert.equal(viewShortcuts('extensions', 'searching')[0]?.label, '搜索中', '扩展搜索执行中 footer 应只展示等待状态');
console.log('[PASS] 扩展管理 footer 随搜索框/Grid 焦点动态切换');

// ── Skills Modal：弹窗内提示与 footer 共用解析结果，不复制键位字面量 ────
const skillsAdoptShortcuts = viewShortcuts('skills', 'confirm-topology-change');

const defaultInputBindings = singleLineInputKeyBindings('default');
const inputAction = (name, {ctrl = false, shift = false} = {}) =>
	defaultInputBindings.find(binding => binding.name === name && Boolean(binding.ctrl) === ctrl && Boolean(binding.shift) === shift)
		?.action;
assert.equal(inputAction('a', {ctrl: true}), 'select-all', 'Windows/Linux Ctrl+A 应全选输入内容');
assert.equal(inputAction('z', {ctrl: true}), 'undo', 'Windows/Linux Ctrl+Z 应撤销');
assert.equal(inputAction('z', {ctrl: true, shift: true}), 'redo', 'Windows/Linux Ctrl+Shift+Z 应重做');
assert.equal(inputAction('y', {ctrl: true}), 'redo', 'Windows/Linux Ctrl+Y 应重做');
assert.deepEqual(
	skillsAdoptShortcuts.map(shortcut => [shortcut.key, shortcut.label]),
	[
		['Enter', '确认执行'],
		['Esc', '取消']
	],
	'Skills 收编确认 Modal 应复用确认态快捷键'
);
const skillsViewSource = readFileSync(new URL('../src/views/skills/SkillsModals.tsx', import.meta.url), 'utf8');
assert.match(skillsViewSource, /viewShortcuts\('skills', mode\)/, 'Skills Modal hint 应从统一快捷键解析器生成');
assert.match(skillsViewSource, /hint=\{skillsModalHint\('confirm-topology-change'\)\}/, '拓扑切换确认 Modal 应展示统一快捷键提示');
console.log('[PASS] Skills Modal 快捷键提示与 footer 共用统一 registry');

// ── Tools 网格主操作：普通卡片统一 Enter，管理型卡片保留专用更新 ────
assert.equal(keyFor(toolsBindings, TOOLS_COMMANDS.PRIMARY_ACTION), 'enter', 'Tools 网格主操作应统一绑定 Enter');
assert.equal(keyFor(toolsBindings, TOOLS_COMMANDS.UPDATE_ONE), 'u', 'Tools 管理型卡片应保留 u 单项更新');

const toolsGridShortcuts = viewShortcuts('tools', 'grid');
assert.deepEqual(
	toolsGridShortcuts.filter(shortcut => shortcut.label === '安装/更新').map(shortcut => [shortcut.key, shortcut.label]),
	[['Enter', '安装/更新']],
	'Tools 普通卡片 footer 应只显示 Enter 安装/更新'
);
assert.equal(
	toolsGridShortcuts.some(shortcut => ['i', 'm', 'u'].includes(shortcut.key.toLowerCase())),
	false,
	'Tools 普通卡片 footer 不应保留 i/m/u 主操作'
);

const toolsInjectShortcuts = viewShortcuts('tools', 'grid-inject');
assert.deepEqual(
	toolsInjectShortcuts
		.filter(shortcut => shortcut.label === '管理开关' || shortcut.label === '更新')
		.map(shortcut => [shortcut.key, shortcut.label]),
	[
		['Enter', '管理开关'],
		['U', '更新']
	],
	'Tools 管理型卡片 footer 应显示 Enter 管理开关与 u 更新'
);
const toolsViewSource = readFileSync(new URL('../src/views/tools/ToolsView.tsx', import.meta.url), 'utf8');
const toolsInputSource = readFileSync(new URL('../src/views/tools/tools-view-input.ts', import.meta.url), 'utf8');
assert.match(
	toolsInputSource,
	/normalized === 'enter' \|\| normalized === 'return'\) return \{kind: 'primary'\}/,
	'Tools input Enter 应解析为统一主操作意图'
);
assert.match(toolsInputSource, /normalized === 'u'\) return \{kind: 'update-one'\}/, 'Tools input u 应只解析为管理型工具更新意图');
assert.match(toolsViewSource, /case 'primary':\s*runPrimaryAction\(/, 'ToolsView 主操作意图必须调用统一分派');
assert.match(toolsViewSource, /case 'update-one':\s*updateInjectableCurrent\(/, 'ToolsView 更新意图必须调用管理型工具更新入口');
console.log('[PASS] Tools 普通/管理型卡片快捷键按上下文统一到 Enter 主操作');

// ── 卸载文案：统一使用简洁动作名，不在 footer 重复强调底层全量语义 ────────
const skillsListLabels = viewShortcuts('skills', 'list-flat').map(shortcut => shortcut.label);
const skillsConfirmLabels = viewShortcuts('skills', 'confirm-uninstall').map(shortcut => shortcut.label);
const toolsGridLabels = viewShortcuts('tools', 'grid').map(shortcut => shortcut.label);
const toolsConfirmLabels = viewShortcuts('tools', 'confirm-uninstall').map(shortcut => shortcut.label);
assert.equal(skillsListLabels.includes('卸载'), true, 'Skills 列表 footer 应显示“卸载”');
assert.equal(skillsConfirmLabels.includes('确认批量卸载（所有 Agent）'), true, 'Skills 确认态应保留批量卸载范围提示');
assert.equal(toolsGridLabels.includes('卸载'), true, 'Tools footer 应显示“卸载”');
assert.equal(toolsConfirmLabels.includes('确认卸载'), true, 'Tools 确认态 footer 应显示“确认卸载”');
assert.equal(
	[...skillsListLabels, ...skillsConfirmLabels, ...toolsGridLabels, ...toolsConfirmLabels].some(label => label.includes('全量卸载')),
	false,
	'TUI footer 不应再显示“全量卸载”'
);

// ── 视图源码：页面内不硬编码快捷键提示 ───────────────────────────────
for (const file of [
	'src/views/config/ConfigView.tsx',
	'src/views/prompts/PromptsView.tsx',
	'src/components/managed-document/ManagedDocumentView.tsx',
	'src/components/managed-document/DocumentHomeView.tsx',
	'src/components/managed-document/DocumentFormView.tsx'
]) {
	const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	assert.equal(/按\s*a|Ctrl\+|Cmd\+|\[[A-Za-z]\]/.test(source), false, `${file} 不应硬编码快捷键提示`);
}
console.log('[PASS] 视图源码：快捷键提示由统一 registry 派生');

console.log('[PASS] macOS 快捷键混合策略门禁全部通过');
