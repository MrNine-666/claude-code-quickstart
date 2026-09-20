import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {expect, test} from 'bun:test';

import type {ProviderDisplayProfile} from '../../src/core/provider.js';
import {loadCodexProviderDisplay, removeCodexProvider, switchActiveCodexProvider} from '../../src/services/codex-service.js';
import {loadPiProviderDisplayData, removePiProvider} from '../../src/services/pi-provider-service.js';
import {loadProviderDisplay, removeProvider, switchActiveProvider} from '../../src/services/provider-service.js';
import {createProviderViewAdapter} from '../../src/views/provider/provider-view-adapter.js';
import {createTempHome} from '../helpers/temp-home.js';

// 迁自 scripts/verify-provider-tui.mjs 的 A 类源码正则断言（P1-G2）。
// 原断言读 ProviderView/adapter 源码文本；这里改为调用 createProviderViewAdapter(agentContext)
// 断言 adapter 的真实路由行为（数据源 / 切换 / 删除 / 卡片描述）。其余 16 条静态合同见
// scripts/verify-view-architecture.mjs 的 P1-G2 段。

function profile(overrides: Partial<ProviderDisplayProfile> = {}): ProviderDisplayProfile {
	return {
		key: 'dev',
		baseUrl: 'https://api.example.com',
		authToken: '',
		profilePath: 'dev',
		isActive: false,
		maskedApiKey: 'sk-a...z',
		...overrides
	};
}

test('adapter 身份由 agentContext 决定（kind / isCodex / isPi）', () => {
	const cc = createProviderViewAdapter('cc');
	expect(cc.kind).toBe('claude');
	expect(cc.isCodex).toBe(false);
	expect(cc.isPi).toBe(false);

	const cx = createProviderViewAdapter('cx');
	expect(cx.kind).toBe('codex');
	expect(cx.isCodex).toBe(true);
	expect(cx.isPi).toBe(false);

	const pi = createProviderViewAdapter('pi');
	expect(pi.kind).toBe('pi');
	expect(pi.isCodex).toBe(false);
	expect(pi.isPi).toBe(true);
});

test('loadDisplay 按 agentContext 路由到对应 service', () => {
	expect(createProviderViewAdapter('cc').loadDisplay).toBe(loadProviderDisplay);
	expect(createProviderViewAdapter('cx').loadDisplay).toBe(loadCodexProviderDisplay);
	expect(createProviderViewAdapter('pi').loadDisplay).toBe(loadPiProviderDisplayData);
});

test('loadDisplay 在空 home 下可被各 agentContext 调用且返回空列表', () => {
	const home = createTempHome('ccq-provider-view-adapter-');
	try {
		mkdirSync(join(home.path, '.claude', 'providers'), {recursive: true});
		mkdirSync(join(home.path, '.codex'), {recursive: true});
		mkdirSync(join(home.path, '.pi', 'agent'), {recursive: true});
		for (const target of ['cc', 'pi'] as const) {
			expect(createProviderViewAdapter(target).loadDisplay().profiles).toEqual([]);
		}
		// Codex 恒有一个 official 虚拟条目（不落盘）。
		expect(
			createProviderViewAdapter('cx')
				.loadDisplay()
				.profiles.map(profile => profile.key)
		).toEqual(['official']);
	} finally {
		home.restore();
		home.cleanup();
	}
});

test('switchActive 仅 Claude/Codex 暴露并按 agentContext 路由，Pi 不暴露', () => {
	expect(createProviderViewAdapter('cc').switchActive).toBe(switchActiveProvider);
	expect(createProviderViewAdapter('cx').switchActive).toBe(switchActiveCodexProvider);
	expect(createProviderViewAdapter('pi').switchActive).toBeUndefined();
});

test('remove 按 agentContext 路由到对应 service', () => {
	expect(createProviderViewAdapter('cc').remove).toBe(removeProvider);
	expect(createProviderViewAdapter('cx').remove).toBe(removeCodexProvider);
	expect(createProviderViewAdapter('pi').remove).toBe(removePiProvider);
});

test('toHomeRow 卡片描述只保留凭据事实，不再拼接模型摘要', () => {
	const cc = createProviderViewAdapter('cc');
	expect(cc.toHomeRow(profile()).summary).toBe('https://api.example.com · sk-a...z');
	expect(cc.toHomeRow(profile({baseUrl: '', maskedApiKey: '未配置'})).summary).toBe('未配置 Base URL · 未配置');

	const cx = createProviderViewAdapter('cx');
	const codexSummary = cx.toHomeRow(profile({key: 'deepseek', isActive: true, maskedApiKey: 'sk-****'})).summary;
	expect(codexSummary).toBe('https://api.example.com · sk-****');
	expect(codexSummary).not.toMatch(/个模型/);
	expect(codexSummary).not.toMatch(/modelSummary|api-key/);

	// Pi OAuth 行只展示登录状态文案，不拼 URL / 密钥 / 模型。
	const pi = createProviderViewAdapter('pi');
	expect(pi.toHomeRow(profile({key: 'pi-login', authKind: 'oauth', authStatus: 'configured', maskedApiKey: 'x'})).summary).toBe(
		'已授权登录'
	);
});
