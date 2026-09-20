import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {piAuthJsonPath, piModelsJsonPath} from '../src/core/paths.ts';
import {commitPiDiscoveredModels, createPiModelCandidate, piModelDefinitionFor, savePiProvider} from '../src/core/pi-provider.ts';
import {replacePiProviderModels} from '../src/services/pi-provider-service.ts';
import {applyPiCandidateMatch, applyPiDiscovery, piEmptySelection, piSelectedDefinitions} from '../src/state/pi-model-selection-state.ts';

// [P5c 迁走] A–E / G / H 段的 186 条进程内行为断言 → tests/core/pi-model-catalog.test.ts
// （KnownApi strategy / 聚合目录解析与精确匹配冲突 / loader 缓存超时取消 / 字段优先级与跨 API 隔离 /
//   选择状态机 / 千级压力）。本文件保留 F 段：真实 CCQ_HOME 落盘字节断言
// （savePiProvider 写 ~/.pi/agent/models.json 与 auth.json、非破坏编辑、commit 不降级）。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

// 目录来源 fixture（原 B 段 `fableSources` 的 anthropic 条目，传输字段已剥离）。
const sourceA = {
	key: 'anthropic\u0000anthropic-messages',
	provider: 'anthropic',
	api: 'anthropic-messages',
	definition: {
		id: 'claude-fable-5',
		name: 'Fable 5',
		reasoning: true,
		thinkingLevelMap: {off: null, xhigh: 'xhigh', max: 'max'},
		compat: {supportsStrictMode: true},
		input: ['text', 'image'],
		cost: {input: 3, output: 15},
		contextWindow: 200000,
		maxTokens: 64000
	}
};

// ─────────────────────────────────────────────────────────────────────────────
// F. 持久化：完整定义写入 / 非破坏编辑 / commit 不降级
// ─────────────────────────────────────────────────────────────────────────────

const previousHome = process.env.CCQ_HOME;
const home = mkdtempSync(join(tmpdir(), 'ccq-pi-catalog-'));
process.env.CCQ_HOME = home;
mkdirSync(join(home, '.pi', 'agent'), {recursive: true});

try {
	const fullDefinition = piModelDefinitionFor(
		{
			...createPiModelCandidate({id: 'claude-fable-5'}),
			upstreamDefinition: {
				id: 'claude-fable-5',
				name: 'Fable 5',
				reasoning: true,
				input: ['text', 'image'],
				cost: {input: 3, output: 15},
				contextWindow: 200000,
				maxTokens: 64000,
				thinkingLevelMap: {off: null, xhigh: 'xhigh', max: 'max'},
				compat: {supportsStrictMode: true}
			}
		},
		sourceA
	);
	const addValues = replacePiProviderModels(
		{
			providerType: 'custom-api-key',
			api: 'anthropic-messages',
			provider: 'custom-acme',
			model: '',
			models: '',
			baseUrl: 'https://acme.example',
			apiKey: 'acme-secret'
		},
		[{id: 'claude-fable-5', definition: fullDefinition}]
	);
	const saved = savePiProvider(addValues, {mode: 'add'});
	assert.equal(saved.models[0].id, 'claude-fable-5');
	const written = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-acme'];
	const writtenModel = written.models.find(model => model.id === 'claude-fable-5');
	assert.deepEqual(writtenModel.input, ['text', 'image'], '新增必须写入 input');
	assert.equal(writtenModel.contextWindow, 200000, '新增必须写入真实 contextWindow');
	assert.equal(writtenModel.maxTokens, 64000, '新增必须写入真实 maxTokens');
	assert.equal(writtenModel.reasoning, true, '新增必须写入 reasoning');
	assert.deepEqual(writtenModel.thinkingLevelMap, {off: null, xhigh: 'xhigh', max: 'max'}, '新增必须写入 thinkingLevelMap');
	assert.deepEqual(writtenModel.compat, {supportsStrictMode: true}, '新增必须写入 compat');
	assert.deepEqual(writtenModel.cost, {input: 3, output: 15}, '新增必须写入 cost');
	for (const key of ['provider', 'baseUrl', 'headers', 'api']) {
		assert.equal(key in writtenModel, false, `写入模型不得包含目录传输字段 ${key}`);
	}
	assert.equal(written.api, 'anthropic-messages', 'Provider api 必须来自表单选择，不能被目录改写');

	// 旧式仅 ID 调用仍可保存 `{id}`。
	const legacyValues = {
		...addValues,
		provider: 'custom-legacy',
		baseUrl: 'https://legacy.example/v1',
		apiKey: 'legacy-secret',
		models: 'legacy-one',
		model: 'legacy-one',
		modelDefinitions: [{id: 'legacy-one'}]
	};
	savePiProvider(legacyValues, {mode: 'add'});
	const legacyWritten = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-legacy'];
	assert.deepEqual(legacyWritten.models, [{id: 'legacy-one'}], '仅 ID 模型必须原样保存');

	// 编辑：保留完整定义、真实删除取消勾选的模型、raw provider 未知字段保留。
	const modelsRoot = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
	modelsRoot.providers['custom-acme'].providersUnknownField = {keep: true};
	modelsRoot.providers['custom-acme'].models.push({
		id: 'removed-model',
		contextWindow: 4096,
		userModelField: 'preserve-me'
	});
	writeFileSync(piModelsJsonPath(), JSON.stringify(modelsRoot, null, 2), 'utf8');

	const editValues = replacePiProviderModels(
		{
			...addValues,
			models: 'claude-fable-5\nremoved-model',
			model: 'claude-fable-5'
		},
		[
			{id: 'claude-fable-5', definition: fullDefinition},
			{id: 'removed-model', definition: {id: 'removed-model', contextWindow: 4096, userModelField: 'preserve-me'}}
		]
	);
	// 用户取消勾选 removed-model。
	const reducedValues = replacePiProviderModels(editValues, [{id: 'claude-fable-5', definition: fullDefinition}]);
	savePiProvider(reducedValues, {mode: 'edit', profileKey: 'custom-acme'});
	const edited = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-acme'];
	assert.deepEqual(
		edited.models.map(model => model.id),
		['claude-fable-5'],
		'编辑取消勾选必须真实删除模型'
	);
	assert.equal(edited.models[0].contextWindow, 200000, '编辑保留模型完整定义');
	assert.deepEqual(edited.models[0].thinkingLevelMap, {off: null, xhigh: 'xhigh', max: 'max'});
	assert.deepEqual(edited.providersUnknownField, {keep: true}, 'provider 级未知字段必须原样保留');
	assert.equal(edited.api, 'anthropic-messages');

	// 编辑未触碰模型集合时，已存在的完整定义不得被 `{id}` 降级。
	savePiProvider({...reducedValues, provider: 'custom-acme', modelDefinitions: []}, {mode: 'edit', profileKey: 'custom-acme'});
	const untouched = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-acme'].models[0];
	assert.equal(untouched.contextWindow, 200000, '未重新选择的模型不得降级为 {id}');
	assert.deepEqual(untouched.thinkingLevelMap, {off: null, xhigh: 'xhigh', max: 'max'});

	// commitPiDiscoveredModels：只补缺不降级。
	const committed = commitPiDiscoveredModels('custom-acme', [
		{id: 'claude-fable-5', contextWindow: 1, maxTokens: 999, input: ['text'], samplingParams: {temperature: 0.5}}
	]);
	const committedModel = committed.find(model => model.id === 'claude-fable-5');
	assert.equal(committedModel.contextWindow, 200000, 'commit 不得用上游值覆盖用户已有字段');
	assert.equal(committedModel.maxTokens, 64000, 'commit 不得用上游值覆盖用户已有 maxTokens');
	assert.deepEqual(committedModel.input, ['text', 'image'], 'commit 不得用上游数组覆盖用户已有 input');
	assert.deepEqual(committedModel.samplingParams, {temperature: 0.5}, 'commit 必须补缺缺失字段');

	// 目录不可用时仍能保存仅 ID 模型。
	const degradedSelection = applyPiCandidateMatch(
		applyPiDiscovery(piEmptySelection(), [{id: 'ghost-model'}]),
		{
			...createPiModelCandidate({id: 'ghost-model'}),
			resolution: {kind: 'upstream-only'}
		},
		'Pi 官方模型目录不可用'
	);
	const degradedValues = replacePiProviderModels(
		{
			...addValues,
			provider: 'custom-degraded',
			baseUrl: 'https://degraded.example/v1',
			apiKey: 'degraded-secret'
		},
		piSelectedDefinitions(degradedSelection).map(definition => ({id: definition.id, definition}))
	);
	savePiProvider(degradedValues, {mode: 'add'});
	const degradedWritten = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-degraded'];
	assert.deepEqual(degradedWritten.models, [{id: 'ghost-model'}], '目录失败时必须仍可保存 {id}');
	assert.equal(readFileSync(piAuthJsonPath(), 'utf8').includes('degraded-secret'), true);
} finally {
	if (previousHome === undefined) delete process.env.CCQ_HOME;
	else process.env.CCQ_HOME = previousHome;
	rmSync(home, {recursive: true, force: true});
}

console.log(
	'[PASS] Pi 模型目录真实落盘：完整定义写入 / 非破坏编辑 / commit 不降级（进程内行为断言见 tests/core/pi-model-catalog.test.ts）'
);
