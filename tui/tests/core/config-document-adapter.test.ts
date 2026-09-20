import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from 'bun:test';

import type {ConfigTarget} from '../../src/services/config-service.js';
import {configFileExists, getConfigPath, loadRecommendationAnnotated, readCurrentConfigText} from '../../src/services/config-service.js';
import {createConfigDocumentAdapter} from '../../src/views/config/config-document-adapter.js';
import {createTempHome} from '../helpers/temp-home.js';

// 迁自 scripts/verify-config-view.mjs 的 A 类源码正则断言（P1-G2）。
// 原断言读 ConfigView + config-document-adapter + managed-document 源码文本；
// 这里改为调用 createConfigDocumentAdapter(target) 断言 adapter 描述符与真实读写路由。
// 其余 7 条静态合同（agentContext 必经路径、dirty 编辑、HC-EDITOR-PANEL-STABLE）见
// scripts/verify-view-architecture.mjs 的 P1-G2 段。

function withHome(run: () => void): void {
	const home = createTempHome('ccq-config-adapter-');
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

const TARGETS: readonly ConfigTarget[] = ['cc', 'cx', 'pi'];

test('Header 标题、副标题与排除域随 agentContext 切换，并包含真实目标路径', () => {
	withHome(() => {
		const excluded: Record<ConfigTarget, string> = {
			cc: '已排除供应商配置',
			cx: '已排除供应商/MCP配置',
			pi: '已排除凭据/模型/MCP/Skills/Extensions配置'
		};
		for (const target of TARGETS) {
			const adapter = createConfigDocumentAdapter(target);
			const configPath = getConfigPath(target);
			expect(adapter.title).toBe('配置文件管理');
			expect(adapter.subtitle.includes(configPath)).toBe(true);
			expect(adapter.subtitle.includes(excluded[target])).toBe(true);
			expect(adapter.emptyHintLabel.includes(configPath)).toBe(true);
		}
	});
});

test('编辑器/预览/推荐 filetype 与 editorIsJson 由 target 决定', () => {
	withHome(() => {
		const expected = {
			cc: {editorIsJson: true, editorFiletype: 'json', previewFiletype: 'json', recommendationFiletype: 'jsonc'},
			cx: {editorIsJson: false, editorFiletype: 'text', previewFiletype: 'toml', recommendationFiletype: 'toml'},
			pi: {editorIsJson: true, editorFiletype: 'json', previewFiletype: 'json', recommendationFiletype: 'jsonc'}
		} as const;
		for (const target of TARGETS) {
			const adapter = createConfigDocumentAdapter(target);
			expect(adapter.editorIsJson).toBe(expected[target].editorIsJson);
			expect(adapter.editorFiletype).toBe(expected[target].editorFiletype);
			expect(adapter.previewFiletype).toBe(expected[target].previewFiletype);
			expect(adapter.recommendationFiletype).toBe(expected[target].recommendationFiletype);
		}
	});
});

test('推荐配置按 target 从 loadRecommendationAnnotated 派生', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createConfigDocumentAdapter(target);
			expect(adapter.recommendationContent).toBe(loadRecommendationAnnotated(target) ?? '');
			expect((adapter.recommendationContent ?? '').length).toBeGreaterThan(0);
		}
	});
});

test('openExternal 指向 Config service，成功提示指向目标路径', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createConfigDocumentAdapter(target);
			expect(typeof adapter.openExternal).toBe('function');
			expect(adapter.openSuccessMessage?.includes(getConfigPath(target))).toBe(true);
		}
	});
});

test('load 按 target 读取 config service 的当前文本', () => {
	withHome(() => {
		writeFileSync(getConfigPath('cx'), 'model = "keep"\n', 'utf8');
		for (const target of TARGETS) {
			const adapter = createConfigDocumentAdapter(target);
			expect(adapter.load().content).toBe(readCurrentConfigText(target));
		}
	});
});

test('目标文件存在但过滤后为空时仍为预览态（hasContent 由 configFileExists 兜底）', () => {
	withHome(() => {
		// 仅含被过滤的 provider table：内容过滤后为空，但文件真实存在。
		writeFileSync(getConfigPath('cx'), '[model_providers.x]\nname = "x"\n', 'utf8');
		const cx = createConfigDocumentAdapter('cx');
		const snapshot = cx.load();
		expect(snapshot.content.trim()).toBe('');
		expect(configFileExists('cx')).toBe(true);
		expect(snapshot.hasContent).toBe(true);

		// 文件不存在且内容为空时必须区分（不得误报预览态）。
		const cc = createConfigDocumentAdapter('cc');
		expect(configFileExists('cc')).toBe(false);
		expect(cc.load().hasContent).toBe(false);
	});
});

test('importInto 的 fill-missing 按 target 路由（TOML vs JSON）', () => {
	withHome(() => {
		const cx = createConfigDocumentAdapter('cx');
		const codexResult = cx.importInto?.('');
		expect(codexResult?.ok).toBe(true);
		if (codexResult?.ok) {
			expect(codexResult.text).toContain('model_reasoning_effort');
		}

		const cc = createConfigDocumentAdapter('cc');
		const claudeResult = cc.importInto?.('{}');
		expect(claudeResult?.ok).toBe(true);
		if (claudeResult?.ok) {
			expect(claudeResult.text.trim().startsWith('{')).toBe(true);
		}
	});
});

test('save 按 target 写入对应配置文件', () => {
	withHome(() => {
		const cx = createConfigDocumentAdapter('cx');
		expect(cx.save('[hooks]\n').ok).toBe(true);
		expect(existsSync(getConfigPath('cx'))).toBe(true);
		expect(readFileSync(getConfigPath('cx'), 'utf8')).toContain('[hooks]');

		const cc = createConfigDocumentAdapter('cc');
		expect(cc.save('{"language":"简体中文"}').ok).toBe(true);
		expect(existsSync(getConfigPath('cc'))).toBe(true);
		expect(JSON.parse(readFileSync(getConfigPath('cc'), 'utf8')).language).toBe('简体中文');
	});
});
