import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from 'bun:test';

import {PROMPTS_COMMANDS} from '../../src/config/keybindings.js';
import {getRulesPath, readCurrentRules} from '../../src/services/prompts-service.js';
import {viewShortcuts} from '../../src/state/shortcuts.js';
import {createPromptsDocumentAdapter} from '../../src/views/prompts/prompts-document-adapter.js';
import {createTempHome} from '../helpers/temp-home.js';

// 迁自 scripts/verify-prompts-view.mjs 的 A 类源码正则断言（P1-G2）。
// 原断言读 PromptsView / prompts-document-adapter / core/prompts / keybindings / shortcuts 源码文本；
// 这里改为调用 createPromptsDocumentAdapter(target) 与 viewShortcuts/PROMPTS_COMMANDS 断言真实行为。
// B 类 2 条（PromptsView → adapter 必经路径、规则 core 无推荐模板）见
// scripts/verify-view-architecture.mjs 的 P1-G2 段。

function withHome(run: () => void): void {
	const home = createTempHome('ccq-prompts-adapter-');
	try {
		mkdirSync(join(home.path, '.claude'), {recursive: true});
		mkdirSync(join(home.path, '.codex'), {recursive: true});
		mkdirSync(join(home.path, '.pi', 'agent'), {recursive: true});
		run();
	} finally {
		home.restore();
		home.cleanup();
	}
}

const TARGETS = ['cc', 'cx', 'pi'] as const;

test('标题/副标题/openExternal 按 target 派生自 Prompts service', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createPromptsDocumentAdapter(target);
			const rulesPath = getRulesPath(target);
			expect(adapter.title).toBe('全局规则管理');
			expect(adapter.subtitle).toBe(rulesPath);
			expect(adapter.emptyHintLabel.includes(rulesPath)).toBe(true);
			expect(typeof adapter.openExternal).toBe('function');
			expect(adapter.openSuccessMessage?.includes(rulesPath)).toBe(true);
		}
	});
});

test('全局规则只提供预览与编辑：无「查看与编辑」与「当前规则」文案', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createPromptsDocumentAdapter(target);
			expect(adapter.subtitle.includes('查看与编辑')).toBe(false);
			expect(adapter.editorTitle).toBe('');
		}
	});
});

test('全局规则不加载也不导入推荐模板', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createPromptsDocumentAdapter(target);
			expect(adapter.recommendationContent).toBeUndefined();
			expect(adapter.importInto).toBeUndefined();
		}
	});
});

test('load/save 按 target 路由到 Prompts service', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createPromptsDocumentAdapter(target);
			expect(adapter.load().content).toBe(readCurrentRules(target) ?? '');
			expect(adapter.save(`${target} rules`).ok).toBe(true);
			expect(readCurrentRules(target)).toBe(`${target} rules`);
		}
	});
});

test('全局规则不得注册推荐边栏/导入/焦点切换命令与 footer 文案', () => {
	withHome(() => {
		// 命令 registry：不得出现 toggle-panel / import / focus-cycle。
		const commands = Object.values(PROMPTS_COMMANDS);
		expect(commands.some(command => /prompts:(?:toggle-panel|import|focus-cycle)/.test(command))).toBe(false);
		expect('TOGGLE_PANEL' in PROMPTS_COMMANDS).toBe(false);
		expect('IMPORT' in PROMPTS_COMMANDS).toBe(false);
		expect('FOCUS_CYCLE' in PROMPTS_COMMANDS).toBe(false);

		// footer：任何子模式都不得暴露推荐命令文案。
		for (const subMode of ['view-render', 'view-empty', 'edit']) {
			const labels = viewShortcuts('prompts', subMode).map(shortcut => shortcut.label);
			expect(labels.some(label => /推荐|补全/.test(label))).toBe(false);
		}
		expect(viewShortcuts('prompts', 'edit').map(shortcut => shortcut.label)).toEqual(['保存', '取消']);
	});
});
