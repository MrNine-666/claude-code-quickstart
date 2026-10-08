import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from 'bun:test';
import type {ConfigTarget} from '../../src/services/config-service.js';
import {configFileExists, getConfigPath, readCurrentConfigText} from '../../src/services/config-service.js';
import {createConfigDocumentAdapter} from '../../src/views/config/config-document-adapter.js';
import {createTempHome} from '../helpers/temp-home.js';

function withHome(run: () => void): void {
	const home = createTempHome('ccq-config-adapter-');
	try {
		for (const dir of ['.claude', '.codex', '.pi/agent']) mkdirSync(join(home.path, dir), {recursive: true});
		run();
	} finally {
		home.restore();
		home.cleanup();
	}
}

const TARGETS: readonly ConfigTarget[] = ['cc', 'cx', 'pi'];

test('配置 adapter 按 agentContext 投影路径和普通编辑属性', () => {
	withHome(() => {
		for (const target of TARGETS) {
			const adapter = createConfigDocumentAdapter(target);
			expect(adapter.subtitle.includes(getConfigPath(target))).toBe(true);
			expect(adapter.editorTitle).toBe('当前配置');
			expect(adapter.openSuccessMessage?.includes(getConfigPath(target))).toBe(true);
			expect('recommendationContent' in adapter).toBe(true);
			expect('importInto' in adapter).toBe(true);
		}
	});
});

test('配置文件存在但过滤后为空时仍进入查看态', () => {
	withHome(() => {
		writeFileSync(getConfigPath('cx'), '[model_providers.x]\nname = "x"\n', 'utf8');
		const adapter = createConfigDocumentAdapter('cx');
		expect(adapter.load().content.trim()).toBe('');
		expect(adapter.load().hasContent).toBe(true);
		expect(configFileExists('cc')).toBe(false);
	});
});

test('普通配置编辑保存仍按 target 路由', () => {
	withHome(() => {
		const cx = createConfigDocumentAdapter('cx');
		expect(cx.save('[hooks]\n').ok).toBe(true);
		expect(readFileSync(getConfigPath('cx'), 'utf8')).toContain('[hooks]');
		const cc = createConfigDocumentAdapter('cc');
		expect(cc.save('{"language":"简体中文"}').ok).toBe(true);
		expect(existsSync(getConfigPath('cc'))).toBe(true);
		expect(JSON.parse(readFileSync(getConfigPath('cc'), 'utf8')).language).toBe('简体中文');
		expect(readCurrentConfigText('cc')).toContain('language');
	});
});
