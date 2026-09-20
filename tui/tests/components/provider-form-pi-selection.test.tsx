import {act} from 'react';
import {expect, test} from 'bun:test';
import {testRender} from '@opentui/react/test-utils';
import type {FormField} from '../../src/components/form/field-types.js';
import {buildPiCatalogIndex} from '../../src/core/pi-model-catalog.js';
import {resolvePiModelCandidate} from '../../src/core/pi-provider.js';
import type {PiModelDefinition} from '../../src/core/pi-provider.js';
import type {ProviderFormAdapter} from '../../src/types/provider-form-adapter.js';
import {ProviderFormView} from '../../src/views/provider/ProviderFormView.js';
import type {DiscoveryMatchOutcome} from '../../src/views/provider/ProviderFormView.js';

// 回归：Pi 新增供应商时 Ctrl+D 获取上游模型后，Space 必须能选中模型。
// 之前 handleDiscover 的 Pi 路径没有复位 discovery.status，loading 守卫会静默吞掉 Space/Enter。

const catalogResult = buildPiCatalogIndex({
	openai: {
		'gpt-5': {
			id: 'gpt-5',
			api: 'openai-responses',
			provider: 'openai',
			contextWindow: 400000,
			maxTokens: 128000,
			reasoning: true
		}
	}
});
if (!catalogResult.ok) throw new Error('catalog fixture must parse');
const catalog = catalogResult.index;

type TestValues = {
	readonly baseUrl: string;
	readonly models: string;
	readonly modelDefinitions?: readonly PiModelDefinition[];
};
type TestModel = {readonly mode: string; readonly fields: readonly FormField[]; readonly values: TestValues};
type TestInput = {readonly mode: string};

const fields: readonly FormField[] = [{id: 'baseUrl', type: 'text', label: 'Base URL', value: 'https://example.test/v1'}];

const adapter: ProviderFormAdapter<TestInput, TestValues, TestModel> = {
	textLabel: 'Pi Provider 字段',
	showTextEditor: false,
	title: () => '添加 Pi Provider',
	savedMessage: () => '已添加',
	valuesToRecord: values => ({baseUrl: values.baseUrl, models: values.models}),
	recordToValues: (record, fallback) => ({...fallback, baseUrl: record.baseUrl ?? '', models: record.models ?? ''}),
	buildText: () => '',
	parseText: () => ({ok: true, values: {baseUrl: '', models: ''}}),
	makeProviderTypeInput: () => ({mode: 'add'}),
	makeSubmitInput: () => ({mode: 'add'}),
	isTextReadOnly: () => false
};

function createModel(): TestModel {
	return {mode: 'add', fields, values: {baseUrl: 'https://example.test/v1', models: ''}};
}

function automaticCandidate() {
	return resolvePiModelCandidate({
		id: 'gpt-5',
		api: 'openai-responses',
		upstreamDefinition: {id: 'gpt-5'},
		catalog
	});
}

async function renderPiForm(
	onMatchCandidate: () => Promise<DiscoveryMatchOutcome>,
	onDiscover: () => Promise<readonly PiModelDefinition[]> = async () => [{id: 'gpt-5'}]
) {
	return testRender(
		<ProviderFormView<TestInput, TestValues, TestModel>
			model={createModel()}
			active
			onCancel={() => undefined}
			onSaved={() => undefined}
			buildForm={() => createModel()}
			save={() => ({ok: true, data: undefined})}
			validate={() => []}
			adapter={adapter}
			onDiscover={onDiscover}
			onApplyDiscovered={values => values}
			onMatchCandidate={onMatchCandidate}
		/>,
		{width: 120, height: 40}
	);
}

async function pressAndSettle(setup: Awaited<ReturnType<typeof renderPiForm>>, action: () => void) {
	// 按键回调会同步 setDiscovery/setPiSelection/setModelFocus，派发本身必须在 act 内，
	// 否则 React 会为这些同步状态更新打印 act(...) 警告。
	// act 回调内 await 一次微任务，让 Pi 匹配的 promise 链在同一个 act 作用域内 flush，
	// 之后 setup.flush() 再等渲染器视觉空闲（不使用固定 sleep）。
	await act(async () => {
		action();
		await Promise.resolve();
	});
	await setup.flush();
}

async function discover(setup: Awaited<ReturnType<typeof renderPiForm>>) {
	await pressAndSettle(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
	await setup.waitForFrame(output => output.includes('gpt-5'));
}

test('Ctrl+D 获取候选后按 Space 能选中焦点模型', async () => {
	const setup = await renderPiForm(async () => ({ok: true, candidate: automaticCandidate()}));
	try {
		await discover(setup);
		await pressAndSettle(setup, () => setup.mockInput.pressKey(' '));
		const frame = await setup.waitForFrame(output => output.includes('[✓]'));
		expect(frame).toContain('[✓]');
		expect(frame).toContain('openai');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('Pi 模型列表行按 Enter 是 no-op，不触发匹配也不勾选', async () => {
	let matchCount = 0;
	const setup = await renderPiForm(async () => {
		matchCount += 1;
		return {ok: true, candidate: automaticCandidate()};
	});
	try {
		await discover(setup);
		await pressAndSettle(setup, () => setup.mockInput.pressEnter());
		expect(matchCount).toBe(0);
		const frame = await setup.waitForFrame(output => output.includes('gpt-5'));
		expect(frame).not.toContain('[✓]');
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('已勾选行按 Space 取消勾选并清除来源，再按 Space 重新匹配', async () => {
	let matchCount = 0;
	const setup = await renderPiForm(async () => {
		matchCount += 1;
		return {ok: true, candidate: automaticCandidate()};
	});
	try {
		await discover(setup);
		await pressAndSettle(setup, () => setup.mockInput.pressKey(' '));
		await setup.waitForFrame(output => output.includes('[✓]'));
		expect(matchCount).toBe(1);

		await pressAndSettle(setup, () => setup.mockInput.pressKey(' '));
		const deselected = await setup.waitForFrame(output => !output.includes('[✓]'));
		expect(deselected).not.toContain('[✓]');
		expect(deselected).not.toContain('openai');
		expect(matchCount).toBe(1);

		await pressAndSettle(setup, () => setup.mockInput.pressKey(' '));
		const reselected = await setup.waitForFrame(output => output.includes('[✓]'));
		expect(reselected).toContain('[✓]');
		expect(matchCount).toBe(2);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

// 回归：空结果/失败出口同样必须复位 discovery.status，否则第二次 Ctrl+D 会被重入守卫挡成 no-op。
test('上游空结果后再次 Ctrl+D 可重试并展示候选', async () => {
	let calls = 0;
	const setup = await renderPiForm(
		async () => ({ok: true, candidate: automaticCandidate()}),
		async () => {
			calls += 1;
			return calls === 1 ? [] : [{id: 'gpt-5'}];
		}
	);
	try {
		await pressAndSettle(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.flush();
		expect(calls).toBe(1);

		await pressAndSettle(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.waitForFrame(output => output.includes('gpt-5'));
		expect(calls).toBe(2);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});

test('上游发现失败后再次 Ctrl+D 可重试并展示候选', async () => {
	let calls = 0;
	const setup = await renderPiForm(
		async () => ({ok: true, candidate: automaticCandidate()}),
		async () => {
			calls += 1;
			if (calls === 1) throw new Error('上游不可用');
			return [{id: 'gpt-5'}];
		}
	);
	try {
		await pressAndSettle(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.flush();
		expect(calls).toBe(1);

		await pressAndSettle(setup, () => setup.mockInput.pressKey('d', {ctrl: true}));
		await setup.waitForFrame(output => output.includes('gpt-5'));
		expect(calls).toBe(2);
	} finally {
		await act(async () => {
			setup.renderer.destroy();
		});
	}
});
