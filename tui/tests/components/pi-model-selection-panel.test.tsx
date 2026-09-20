import {act} from 'react';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import {buildPiCatalogIndex} from '../../src/core/pi-model-catalog.js';
import {piModelDefinitionFor, resolvePiModelCandidate} from '../../src/core/pi-provider.js';
import {
	applyPiCandidateMatch,
	applyPiDiscovery,
	piEmptySelection,
	piModelSelectionFromValues
} from '../../src/state/pi-model-selection-state.js';
import {PiModelSelectionPanel, PiSourceSelectionPanel} from '../../src/views/provider/pi-model-selection-panel.js';

const catalogResult = buildPiCatalogIndex({
	anthropic: {
		'claude-fable-5': {
			id: 'claude-fable-5',
			api: 'anthropic-messages',
			provider: 'anthropic',
			contextWindow: 200000,
			maxTokens: 64000,
			input: ['text', 'image'],
			cost: {input: 3, output: 15},
			reasoning: true,
			thinkingLevelMap: {off: null, xhigh: 'xhigh'}
		}
	},
	openai: {
		'gpt-5': {
			id: 'gpt-5',
			api: 'openai-responses',
			provider: 'openai',
			contextWindow: 400000,
			maxTokens: 128000,
			reasoning: true
		}
	},
	opencode: {
		'claude-fable-5': {
			id: 'claude-fable-5',
			api: 'anthropic-messages',
			provider: 'opencode',
			contextWindow: 100000,
			maxTokens: 32000,
			input: ['text'],
			cost: {input: 1, output: 4}
		}
	},
	'azure-openai-responses': {
		'claude-fable-5': {
			id: 'claude-fable-5',
			api: 'azure-openai-responses',
			provider: 'azure-openai-responses',
			contextWindow: 50000
		}
	}
});
if (!catalogResult.ok) throw new Error('catalog fixture must parse');
const catalog = catalogResult.index;

function uniqueSelection() {
	const candidate = resolvePiModelCandidate({
		id: 'gpt-5',
		api: 'openai-responses',
		upstreamDefinition: {id: 'gpt-5'},
		catalog
	});
	return applyPiCandidateMatch(applyPiDiscovery(piEmptySelection(), [{id: 'gpt-5'}]), candidate);
}

test('PiModelSelectionPanel 已解析来源只显示 provider，不拼状态后缀', async () => {
	const state = uniqueSelection();
	const setup = await testRender(
		<PiModelSelectionPanel
			state={state}
			focused
			active
			listFocused
			inputFocused={false}
			candidates={state.candidates}
			cursor={0}
			onManualModelChange={() => undefined}
			onManualModelSubmit={() => undefined}
			onManualModelFocus={() => undefined}
		/>,
		{width: 96, height: 24}
	);

	try {
		const frame = await setup.waitForFrame(output => output.includes('gpt-5'));
		expect(frame).toContain('openai');
		expect(frame).not.toContain('自动匹配');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('PiModelSelectionPanel 行尾只给参数状态，未配置时不显示', async () => {
	const configured = piModelSelectionFromValues({
		models: 'gpt-5',
		modelDefinitions: [
			{
				id: 'gpt-5',
				contextWindow: 400000,
				maxTokens: 128000,
				input: ['text', 'image'],
				cost: {input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0},
				reasoning: true,
				compat: {supportsStrictMode: true}
			}
		]
	});
	const setup = await testRender(
		<PiModelSelectionPanel
			state={configured}
			focused
			active
			listFocused
			inputFocused={false}
			candidates={configured.candidates}
			cursor={0}
			onManualModelChange={() => undefined}
			onManualModelSubmit={() => undefined}
			onManualModelFocus={() => undefined}
		/>,
		{width: 140, height: 24}
	);
	try {
		const frame = await setup.waitForFrame(output => output.includes('已配置模型参数'));
		expect(frame).toContain('已配置模型参数');
		expect(frame).not.toContain('400K');
		expect(frame).not.toContain('已配 ');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}

	const plain = piModelSelectionFromValues({models: 'gpt-5'});
	const plainSetup = await testRender(
		<PiModelSelectionPanel
			state={plain}
			focused
			active
			listFocused
			inputFocused={false}
			candidates={plain.candidates}
			cursor={0}
			onManualModelChange={() => undefined}
			onManualModelSubmit={() => undefined}
			onManualModelFocus={() => undefined}
		/>,
		{width: 140, height: 24}
	);
	try {
		const frame = await plainSetup.waitForFrame(output => output.includes('gpt-5'));
		expect(frame).not.toContain('已配置模型参数');
	} finally {
		await act(async () => {
			plainSetup.renderer.destroy();
		});
	}
});

test('PiSourceSelectionPanel 摘要展示焦点来源字段，JSON 视图只为焦点候选生成', async () => {
	const conflict = resolvePiModelCandidate({
		id: 'claude-fable-5',
		api: 'anthropic-messages',
		upstreamDefinition: {id: 'claude-fable-5'},
		catalog
	});
	const state = applyPiCandidateMatch(applyPiDiscovery(piEmptySelection(), [{id: 'claude-fable-5'}]), conflict);
	const candidate = state.candidates[0];
	expect(candidate).toBeDefined();
	if (!candidate) throw new Error('candidate must exist');
	expect(state.sourceMode?.modelId).toBe('claude-fable-5');

	const summarySetup = await testRender(<PiSourceSelectionPanel candidate={candidate} cursor={1} view="summary" active />, {
		width: 96,
		height: 24
	});
	try {
		const frame = await summarySetup.waitForFrame(output => output.includes('opencode'));
		expect(frame).toContain('opencode · anthropic-messages');
		expect(frame).toContain('上下文 100000');
		expect(frame).toContain('输入 text');
		expect(frame).toContain('其它 API 的同 ID 来源');
		// 来源是单选：不得出现 Card 的 ✅/⬜ 多选框标记，选中态只由 active 高亮表达。
		expect(frame).not.toContain('✅');
		expect(frame).not.toContain('⬜');
	} finally {
		await act(async () => {
			summarySetup.renderer.destroy();
		});
	}

	const jsonSetup = await testRender(<PiSourceSelectionPanel candidate={candidate} cursor={1} view="json" active />, {
		width: 96,
		height: 24
	});
	try {
		const frame = await jsonSetup.waitForFrame(output => output.includes('contextWindow'));
		expect(frame).toContain('100000');
		expect(frame).not.toContain('200000');
		expect(piModelDefinitionFor(candidate, candidate.sources[1]).contextWindow).toBe(100000);
	} finally {
		await act(async () => {
			jsonSetup.renderer.destroy();
		});
	}
});

// 迁自 scripts/verify-shortcuts.mjs 的 A 类源码正则断言：
// 手工模型输入常驻、绑定 state.manualValue，并按 Enter 走 input submit 回调。
test('PiModelSelectionPanel 手工模型输入显示占位提示并按 Enter 提交', async () => {
	let submitted: unknown;
	const setup = await testRender(
		<PiModelSelectionPanel
			state={piEmptySelection()}
			focused
			active
			listFocused={false}
			inputFocused
			candidates={[]}
			cursor={0}
			onManualModelChange={() => undefined}
			onManualModelSubmit={value => {
				submitted = value;
			}}
			onManualModelFocus={() => undefined}
		/>,
		{width: 96, height: 24}
	);
	try {
		const frame = await setup.waitForFrame(output => output.includes('输入模型 ID'));
		expect(frame).toContain('输入模型 ID，按 Enter 匹配来源');
		setup.mockInput.pressEnter();
		await setup.flush();
		expect(submitted).toBe('');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('PiModelSelectionPanel 手工模型输入绑定 state.manualValue', async () => {
	const setup = await testRender(
		<PiModelSelectionPanel
			state={{...piEmptySelection(), manualValue: 'custom-id'}}
			focused
			active
			listFocused={false}
			inputFocused
			candidates={[]}
			cursor={0}
			onManualModelChange={() => undefined}
			onManualModelSubmit={() => undefined}
			onManualModelFocus={() => undefined}
		/>,
		{width: 96, height: 24}
	);
	try {
		const frame = await setup.waitForFrame(output => output.includes('custom-id'));
		expect(frame).toContain('custom-id');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
