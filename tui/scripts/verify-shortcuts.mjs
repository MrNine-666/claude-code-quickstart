import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {singleLineInputKeyBindings} from '../src/components/single-line-input.tsx';
import {formatShortcutKey, hasShortcutModifier, isAppModifier, isEditingModifier} from '../src/utils/keyboard.ts';
import {
	CONFIG_COMMANDS,
	MCP_COMMANDS,
	PROMPTS_COMMANDS,
	SKILLS_COMMANDS,
	TOOLS_COMMANDS,
	configBindings,
	mcpBindings,
	promptsBindings,
	skillsBindings,
	toolsBindings
} from '../src/config/keybindings.ts';
import {viewShortcuts} from '../src/state/shortcuts.ts';

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
console.log('[PASS] modifier helper：编辑语义 Command-first，应用功能 Control-first，文本输入过滤排除修饰键组合');

// ── binding 数据源：保存走编辑语义，推荐/导入走 Control ────────────────────
const expectedSaveKey = process.platform === 'darwin' ? 'super+s' : 'ctrl+s';
assert.equal(keyFor(promptsBindings, PROMPTS_COMMANDS.EDITOR_SAVE), expectedSaveKey, 'Prompts 保存应按平台编辑语义绑定');
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.EDITOR_SAVE), expectedSaveKey, 'Config 保存应按平台编辑语义绑定');
assert.equal(keyFor(mcpBindings, MCP_COMMANDS.FORM_SAVE), expectedSaveKey, 'MCP 表单保存应按平台编辑语义绑定');
assert.equal(keyFor(promptsBindings, PROMPTS_COMMANDS.TOGGLE_PANEL), 'ctrl+t', 'Prompts 推荐边栏保持 Ctrl+T');
assert.equal(keyFor(promptsBindings, PROMPTS_COMMANDS.IMPORT), 'ctrl+o', 'Prompts 导入保持 Ctrl+O');
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.TOGGLE_PANEL), 'ctrl+t', 'Config 推荐边栏保持 Ctrl+T');
assert.equal(keyFor(configBindings, CONFIG_COMMANDS.IMPORT), 'ctrl+o', 'Config 补全保持 Ctrl+O');
console.log('[PASS] keybindings：保存按编辑语义，推荐/导入按应用功能');

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
const skillsInstallLabels = viewShortcuts('skills', 'install').map(shortcut => shortcut.label);
assert.equal(skillsInstallLabels.includes('选择/取消'), true, 'Skills 安装页 footer 应展示选择切换');
assert.equal(skillsInstallLabels.includes('全选'), true, 'Skills 安装页 footer 应展示全选');
console.log('[PASS] Skills 多选快捷键与 footer 来自统一 registry');

// ── Skills 列表页键位：A 更新全部 / U 更新选中 / I 安装（大小写都触发，footer 显示大写） ──
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.UPDATE_ALL), 'a', 'Skills 列表页更新全部应绑定 a');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.UPDATE_ONE), 'u', 'Skills 列表页更新选中应绑定 u');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.INSTALL), 'i', 'Skills 列表页安装应绑定 i');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.LIST_LEFT), 'left', 'Skills 网格左移应绑定 ←');
assert.equal(keyFor(skillsBindings, SKILLS_COMMANDS.LIST_RIGHT), 'right', 'Skills 网格右移应绑定 →');
const skillsListShortcuts = viewShortcuts('skills', 'list');
const skillsListByLabel = Object.fromEntries(skillsListShortcuts.map(shortcut => [shortcut.label, shortcut.key]));
assert.equal(skillsListByLabel['选择'], '↑/↓/←/→', 'Skills 两列网格 footer 应展示四向选择');
assert.equal(skillsListByLabel['更新全部'], 'A', 'Skills 列表 footer 更新全部应显示大写 A');
assert.equal(skillsListByLabel['更新选中'], 'U', 'Skills 列表 footer 更新选中应显示大写 U');
assert.equal(skillsListByLabel['安装'], 'I', 'Skills 列表 footer 安装应显示大写 I');
console.log('[PASS] Skills 列表页 A 更新全部 / U 更新选中 / I 安装 键位与 footer 一致');

// ── Skills Modal：弹窗内提示与 footer 共用解析结果，不复制键位字面量 ────
const skillsAdoptShortcuts = viewShortcuts('skills', 'confirm-topology-change');

const defaultInputBindings = singleLineInputKeyBindings('default');
const inputAction = (name, {ctrl = false, shift = false} = {}) => defaultInputBindings.find(binding => binding.name === name && Boolean(binding.ctrl) === ctrl && Boolean(binding.shift) === shift)?.action;
assert.equal(inputAction('a', {ctrl: true}), 'select-all', 'Windows/Linux Ctrl+A 应全选输入内容');
assert.equal(inputAction('z', {ctrl: true}), 'undo', 'Windows/Linux Ctrl+Z 应撤销');
assert.equal(inputAction('z', {ctrl: true, shift: true}), 'redo', 'Windows/Linux Ctrl+Shift+Z 应重做');
assert.equal(inputAction('y', {ctrl: true}), 'redo', 'Windows/Linux Ctrl+Y 应重做');
assert.deepEqual(
	skillsAdoptShortcuts.map(shortcut => [shortcut.key, shortcut.label]),
	[['Enter', '确认执行'], ['Esc', '取消']],
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
assert.equal(toolsGridShortcuts.some(shortcut => ['i', 'm', 'u'].includes(shortcut.key.toLowerCase())), false, 'Tools 普通卡片 footer 不应保留 i/m/u 主操作');

const toolsInjectShortcuts = viewShortcuts('tools', 'grid-inject');
assert.deepEqual(
	toolsInjectShortcuts.filter(shortcut => shortcut.label === '管理开关' || shortcut.label === '更新').map(shortcut => [shortcut.key, shortcut.label]),
	[['Enter', '管理开关'], ['U', '更新']],
	'Tools 管理型卡片 footer 应显示 Enter 管理开关与 u 更新'
);
const toolsViewSource = readFileSync(new URL('../src/views/tools/ToolsView.tsx', import.meta.url), 'utf8');
const toolsInputSource = readFileSync(new URL('../src/views/tools/tools-view-input.ts', import.meta.url), 'utf8');
assert.match(toolsInputSource, /normalized === 'enter' \|\| normalized === 'return'\) return \{kind: 'primary'\}/, 'Tools input Enter 应解析为统一主操作意图');
assert.match(toolsInputSource, /normalized === 'u'\) return \{kind: 'update-one'\}/, 'Tools input u 应只解析为管理型工具更新意图');
assert.match(toolsViewSource, /case 'primary':\s*runPrimaryAction\(/, 'ToolsView 主操作意图必须调用统一分派');
assert.match(toolsViewSource, /case 'update-one':\s*updateInjectableCurrent\(/, 'ToolsView 更新意图必须调用管理型工具更新入口');
console.log('[PASS] Tools 普通/管理型卡片快捷键按上下文统一到 Enter 主操作');

// ── 卸载文案：统一使用简洁动作名，不在 footer 重复强调底层全量语义 ────────
const skillsListLabels = viewShortcuts('skills', 'list').map(shortcut => shortcut.label);
const skillsConfirmLabels = viewShortcuts('skills', 'confirm-uninstall').map(shortcut => shortcut.label);
const toolsGridLabels = viewShortcuts('tools', 'grid').map(shortcut => shortcut.label);
const toolsConfirmLabels = viewShortcuts('tools', 'confirm-uninstall').map(shortcut => shortcut.label);
assert.equal(skillsListLabels.includes('卸载'), true, 'Skills 列表 footer 应显示“卸载”');
assert.equal(skillsConfirmLabels.includes('确认卸载（所有 Agent）'), true, 'Skills 确认态应保留卸载范围提示');
assert.equal(toolsGridLabels.includes('卸载'), true, 'Tools footer 应显示“卸载”');
assert.equal(toolsConfirmLabels.includes('确认卸载'), true, 'Tools 确认态 footer 应显示“确认卸载”');
assert.equal([...skillsListLabels, ...skillsConfirmLabels, ...toolsGridLabels, ...toolsConfirmLabels].some(label => label.includes('全量卸载')), false, 'TUI footer 不应再显示“全量卸载”');

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
