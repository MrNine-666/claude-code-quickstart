import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {formatShortcutKey, hasShortcutModifier, isAppModifier, isEditingModifier} from '../src/utils/keyboard.ts';
import {
	CONFIG_COMMANDS,
	MCP_COMMANDS,
	PROMPTS_COMMANDS,
	configBindings,
	mcpBindings,
	promptsBindings
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

// ── 视图源码：页面内不硬编码快捷键提示 ───────────────────────────────
for (const file of ['src/views/ConfigView.tsx', 'src/views/PromptsView.tsx']) {
	const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
	assert.equal(/按\s*a|Ctrl\+|Cmd\+|\[[A-Za-z]\]/.test(source), false, `${file} 不应硬编码快捷键提示`);
}
console.log('[PASS] 视图源码：快捷键提示仅由 footer ShortcutBar 展示');

console.log('[PASS] macOS 快捷键混合策略门禁全部通过');
