import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {piAuthJsonPath, piModelsJsonPath, piModelsStorePath, piSettingsPath} from '../src/core/paths.ts';
import {createPiCatalogLoader} from '../src/core/pi-model-catalog.ts';
import {
	commitPiDiscoveredModels,
	deletePiProvider,
	discoverPiModels,
	loadPiProviderDisplay,
	loadPiProviderProfile,
	loadPiProviderRecords,
	piModelDefinitionFor,
	savePiProvider
} from '../src/core/pi-provider.ts';
import {matchPiProviderModel, replacePiProviderModels} from '../src/services/pi-provider-service.ts';

// [P5c 迁走] 进程内行为断言（Pi 卡片描述投影 / parsePiProviderKey / PI_APIS 与 KnownApi strategy /
// discovery endpoint 与去重 / unsupported + service discovery / 惰性匹配 resolution）共 27 条
// → tests/core/pi-provider.test.ts。本文件保留真实 ~/.pi 落盘字节与损坏文件拒写断言。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

const home = mkdtempSync(join(tmpdir(), 'ccq-pi-provider-'));
process.env.CCQ_HOME = home;
mkdirSync(join(home, '.pi', 'agent'), {recursive: true});

const modelsBefore = {
	providers: {
		openai: {
			baseUrl: 'https://api.openai.com/v1',
			models: [{id: 'gpt-4o', contextWindow: 128000, userField: 'preserve-me'}, 'gpt-4o-mini'],
			userProviderField: 'preserve-provider'
		},
		keep: {baseUrl: 'https://keep.example/v1', api: 'openai-completions', models: ['keep-model']},
		'store-override': {
			baseUrl: 'https://store-override.example/v1',
			api: 'openai-completions',
			models: [{id: 'store-model', contextWindow: 222, userModelField: 'keep-me'}]
		}
	},
	userRootField: {keep: true}
};
const authBefore = {
	openai: {type: 'api_key', key: 'sk-live-secret-value', userAuthField: 'preserve-auth'},
	'openai-codex': {type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', expires: 1},
	xai: {type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: 1},
	keep: {type: 'api_key', key: 'keep-secret'},
	'auth-login': {type: 'api_key', key: 'login-managed-secret'},
	// Pi 原生 /login 创建、且不在 ccq 快照中的内置 Provider。
	deepseek: {type: 'api_key', key: 'deepseek-managed-secret'}
};
const settingsBefore = {
	defaultProvider: 'openai',
	defaultModel: 'sentinel-model',
	defaultThinkingLevel: 'high',
	userSetting: {keep: true}
};
writeFileSync(piModelsJsonPath(), JSON.stringify(modelsBefore, null, 2), 'utf8');
writeFileSync(piAuthJsonPath(), JSON.stringify(authBefore, null, 2), 'utf8');
writeFileSync(piSettingsPath(), JSON.stringify(settingsBefore, null, 2), 'utf8');

// Pi runtime 刷新的 Provider 目录缓存：ccq 不拥有它，只读用于补全展示元数据。
const modelsStoreBefore = {
	deepseek: {
		models: [
			{
				id: 'deepseek-flash',
				name: 'DeepSeek V4.1 Flash',
				api: 'openai-completions',
				baseUrl: 'https://api.deepseek.com',
				provider: 'deepseek',
				headers: {'x-source': 'leak-me'},
				reasoning: true,
				contextWindow: 1000000,
				maxTokens: 384000
			},
			{
				id: 'deepseek-v4-pro',
				name: 'DeepSeek V4 Pro',
				api: 'openai-completions',
				baseUrl: 'https://api.deepseek.com',
				provider: 'deepseek',
				headers: {'x-source': 'leak-me'}
			}
		],
		checkedAt: 1
	},
	'store-override': {
		models: [
			{
				id: 'store-model',
				api: 'openai-responses',
				baseUrl: 'https://wrong.example/v1',
				provider: 'store-override',
				headers: {'x-source': 'leak-me'},
				contextWindow: 111,
				storeOnlyField: 'ignored'
			}
		],
		checkedAt: 1
	}
};
writeFileSync(piModelsStorePath(), JSON.stringify(modelsStoreBefore, null, 2), 'utf8');
const modelsStoreBytes = readFileSync(piModelsStorePath(), 'utf8');

const settingsBytesBeforeDisplay = readFileSync(piSettingsPath(), 'utf8');
const display = loadPiProviderDisplay();
assert.equal(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeDisplay, 'Provider 列表只读投影不得写 settings.json');
const openaiRow = display.profiles.find(profile => profile.key === 'openai');
assert.ok(openaiRow);
assert.equal(openaiRow.isActive, true);
assert.equal(openaiRow.authKind, 'api_key');
assert.equal(openaiRow.modelCount, 3, '内置模型与 models.json 模型应按 ID 合并去重');
assert.equal(openaiRow.canDelete, false, '当前激活 provider 不得删除');
assert.doesNotMatch(JSON.stringify(display), /sk-live-secret-value|secret-access|xai-access|login-managed-secret|deepseek-managed-secret/);
assert.equal(display.profiles.filter(profile => profile.key === 'openai-codex').length, 1);
assert.equal(display.profiles.filter(profile => profile.key === 'xai').length, 1);
assert.equal(loadPiProviderProfile('openai')?.apiKey, 'sk-live-secret-value');

// ── Pi runtime 目录缓存：最低优先级的展示元数据来源 ──────────────────────
// auth.json 里由 Pi 原生 /login 创建、且不在 ccq 快照中的内置 Provider 必须能正常展示。
const deepseekRow = display.profiles.find(profile => profile.key === 'deepseek');
assert.ok(deepseekRow, 'auth.json 中的 Pi 内置 Provider 必须出现在列表');
assert.equal(deepseekRow.source, 'builtin', 'Pi runtime 目录命中的 Provider 必须标记为内置而非 unknown');
assert.equal(deepseekRow.baseUrl, 'https://api.deepseek.com', 'ccq 快照缺失时必须从 Pi runtime 目录补全 Base URL');
assert.equal(deepseekRow.modelCount, 2, 'Pi runtime 目录的内置模型必须计入模型数');
assert.equal(deepseekRow.canEdit, false, '仅 auth.json 数据源的 Provider 不得编辑');
assert.equal(deepseekRow.canDelete, false, '仅 auth.json 数据源的 Provider 不得删除');
assert.doesNotMatch(JSON.stringify(display), /leak-me/, 'Provider 列表不得暴露目录传输头');
const deepseekRecord = loadPiProviderRecords().find(record => record.providerId === 'deepseek');
assert.equal(deepseekRecord?.api, 'openai-completions', 'Provider api 必须可从 Pi runtime 目录补全');
assert.deepEqual(
	deepseekRecord?.models.map(model => model.id),
	['deepseek-flash', 'deepseek-v4-pro'],
	'runtime 目录模型必须按 ID 合并'
);
for (const model of deepseekRecord?.models ?? []) {
	for (const key of ['provider', 'baseUrl', 'headers', 'api']) {
		assert.equal(key in model, false, `runtime 目录的传输字段 ${key} 不得进入模型定义`);
	}
}

// 用户 models.json 定义优先于 Pi runtime 目录，且目录传输字段仍被剥离。
const storeOverrideRecord = loadPiProviderRecords().find(record => record.providerId === 'store-override');
assert.equal(storeOverrideRecord?.source, 'builtin-override', 'runtime 目录命中 + models.json 定义必须标记为 builtin-override');
assert.equal(storeOverrideRecord?.baseUrl, 'https://store-override.example/v1', 'models.json Base URL 必须优先于 runtime 目录');
assert.equal(storeOverrideRecord?.api, 'openai-completions', 'models.json api 必须优先于 runtime 目录');
const storeOverrideModel = storeOverrideRecord?.models.find(model => model.id === 'store-model');
assert.equal(storeOverrideModel?.contextWindow, 222, 'models.json 模型字段必须优先于 runtime 目录');
assert.equal(storeOverrideModel?.userModelField, 'keep-me', 'models.json 未知字段必须保留');
for (const key of ['provider', 'baseUrl', 'headers', 'api']) {
	assert.equal(key in (storeOverrideModel ?? {}), false, `runtime 目录的传输字段 ${key} 不得进入模型定义`);
}
// [P5c 迁走] Pi 卡片描述投影（title / summary / OAuth 文案）+ parsePiProviderKey 共 9 条
// → tests/core/pi-provider.test.ts。此处保留真实 ~/.pi 字节聚合断言。

const customInput = {
	providerType: 'custom-api-key',
	provider: 'custom-acme',
	api: 'openai-completions',
	model: 'acme-one',
	models: 'acme-one\nacme-two',
	baseUrl: 'https://acme.example/v1',
	apiKey: 'acme-secret'
};
const settingsBytesBeforeAdd = readFileSync(piSettingsPath(), 'utf8');
const added = savePiProvider(customInput, {mode: 'add'});
assert.equal(added.key, 'custom-acme');
const modelsAfterAdd = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
const authAfterAdd = JSON.parse(readFileSync(piAuthJsonPath(), 'utf8'));
const settingsAfterAdd = JSON.parse(readFileSync(piSettingsPath(), 'utf8'));
assert.equal(modelsAfterAdd.userRootField.keep, true);
assert.equal(modelsAfterAdd.providers.openai.userProviderField, 'preserve-provider');
assert.equal(authAfterAdd.openai.userAuthField, 'preserve-auth');
assert.deepEqual(authAfterAdd['custom-acme'], {type: 'api_key', key: 'acme-secret'});
assert.deepEqual(
	modelsAfterAdd.providers['custom-acme'].models.map(model => (typeof model === 'string' ? model : model.id)),
	['acme-one', 'acme-two']
);
assert.equal(settingsAfterAdd.defaultProvider, 'openai', '新增 provider 不得隐式切换 defaultProvider');
assert.equal(settingsAfterAdd.defaultModel, 'sentinel-model', '新增 provider 不得维护 defaultModel');
assert.equal(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeAdd, 'Provider 新增不得写 settings.json');
assert.throws(() => savePiProvider(customInput, {mode: 'add'}), /已存在/);
// [P5e 去重] createProviderViewAdapter('pi').switchActive === undefined 已由 P1-G2 载体独占：
// tests/core/provider-view-adapter.test.ts > switchActive 仅 Claude/Codex 暴露并按 agentContext 路由，Pi 不暴露。
assert.throws(
	() => deletePiProvider('openai'),
	/当前默认 Pi Provider.*Pi 配置页修改 defaultProvider/,
	'当前 defaultProvider 仍受删除保护，但应提示从 Pi Config 修改'
);
assert.equal(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeAdd, '默认 Provider 删除被拒绝后不得写 settings.json');

// defaultProvider 由 Pi Config 所有；这里模拟 Config 保存后的只读投影。
writeFileSync(piSettingsPath(), JSON.stringify({...settingsBefore, defaultProvider: 'xai'}, null, 2), 'utf8');
assert.throws(() => deletePiProvider('xai'), /当前默认 Pi Provider/);

const customProfile = loadPiProviderProfile('custom-acme');
assert.ok(customProfile);
const settingsBytesBeforeEditAndDelete = readFileSync(piSettingsPath(), 'utf8');
const edited = savePiProvider(
	{...customInput, models: 'acme-one\nacme-three', model: 'acme-one', apiKey: ''},
	{mode: 'edit', profileKey: 'custom-acme', profile: customProfile}
);
assert.equal(edited.key, 'custom-acme');
assert.deepEqual(
	JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-acme'].models.map(model =>
		typeof model === 'string' ? model : model.id
	),
	['acme-one', 'acme-three'],
	'编辑表单取消勾选的模型不得在保存时被重新合并'
);
assert.equal(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeEditAndDelete, 'Provider 编辑不得写 settings.json');
assert.equal(JSON.parse(readFileSync(piSettingsPath(), 'utf8')).defaultProvider, 'xai');
assert.equal(JSON.parse(readFileSync(piSettingsPath(), 'utf8')).defaultModel, 'sentinel-model');
assert.equal(JSON.parse(readFileSync(piAuthJsonPath(), 'utf8'))['custom-acme'].key, 'acme-secret');

assert.equal(deletePiProvider('keep').removedModels, true);
assert.equal(JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers.keep, undefined);
assert.equal(JSON.parse(readFileSync(piAuthJsonPath(), 'utf8')).keep, undefined);
assert.equal(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeEditAndDelete, '自定义 Provider 删除不得写 settings.json');

// 内置 provider 的 API Key 删除不能删除 Pi 内置模型或用户 override。
assert.equal(deletePiProvider('openai').removedAuth, true);
assert.equal(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeEditAndDelete, '内置 Provider 删除不得写 settings.json');
const afterBuiltinDelete = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
assert.ok(afterBuiltinDelete.providers.openai, '内置 provider 的 models.json override 必须保留');

// auth.json 数据源（/login 创建）只读：models.json 无定义时既不可编辑也不可删除。
const authOnlyRow = loadPiProviderDisplay().profiles.find(profile => profile.key === 'auth-login');
assert.ok(authOnlyRow, 'auth.json 中的 provider 必须出现在列表');
assert.equal(authOnlyRow.canSwitch, undefined, 'Pi Provider 列表不得暴露切换能力');
assert.equal(authOnlyRow.canEdit, false, 'auth.json 数据源不得编辑');
assert.equal(authOnlyRow.canDelete, false, 'auth.json 数据源不得删除');
const authOnlyProfile = loadPiProviderProfile('auth-login');
assert.ok(authOnlyProfile, 'auth.json 数据源必须能加载 profile 供表单展示');
const modelsBytesBeforeAuthOnly = readFileSync(piModelsJsonPath(), 'utf8');
const authBytesBeforeAuthOnly = readFileSync(piAuthJsonPath(), 'utf8');
assert.throws(
	() =>
		savePiProvider(
			{...customInput, provider: 'auth-login', apiKey: 'auth-login-key'},
			{mode: 'edit', profileKey: 'auth-login', profile: authOnlyProfile}
		),
	/由 Pi 原生 \/login 管理/,
	'核心层必须拒绝编辑 auth.json 数据源'
);
assert.throws(() => deletePiProvider('auth-login'), /由 Pi 原生 \/login 管理/, '核心层必须拒绝删除 auth.json 数据源');
assert.equal(readFileSync(piModelsJsonPath(), 'utf8'), modelsBytesBeforeAuthOnly, '被拒绝的编辑不得写 models.json');
assert.equal(readFileSync(piAuthJsonPath(), 'utf8'), authBytesBeforeAuthOnly, '被拒绝的编辑/删除不得写 auth.json');

// [P5c 迁走] discovery endpoint / Bearer 头 / discovery.ok / 模型去重排序 共 4 条
// → tests/core/pi-provider.test.ts。此处保留 commit 的真实落盘断言。
const discovery = await discoverPiModels({
	baseUrl: 'https://api.example.com/v1',
	api: 'openai-completions',
	apiKey: 'discovery-secret',
	options: {
		fetchImpl: async () =>
			new Response(JSON.stringify({data: [{id: 'acme-four'}, {id: 'acme-four'}, {id: 'acme-five'}]}), {
				status: 200,
				headers: {'content-type': 'application/json'}
			})
	}
});
if (discovery.ok) {
	const merged = commitPiDiscoveredModels('custom-acme', [discovery.models[0]]);
	assert.ok(merged.some(model => model.id === 'acme-five'));
}

// [P5c 迁走] PI_APIS / PI_KNOWN_APIS / 降级 strategy / unsupported discovery /
// service discovery 完整对象 / 无列表接口 rejects 共 12 条 → tests/core/pi-provider.test.ts。

// 惰性匹配：唯一来源自动绑定，保存时写入完整元数据。
const catalogLoader = createPiCatalogLoader({
	fetchImpl: async () =>
		new Response(
			JSON.stringify({
				anthropic: {
					'claude-fable-5': {
						id: 'claude-fable-5',
						name: 'Fable 5',
						api: 'anthropic-messages',
						provider: 'anthropic',
						baseUrl: 'https://api.anthropic.com',
						headers: {'x-source': 'leak-me'},
						reasoning: true,
						input: ['text', 'image'],
						cost: {input: 3, output: 15},
						contextWindow: 200000,
						maxTokens: 64000,
						thinkingLevelMap: {off: null, xhigh: 'xhigh'},
						compat: {supportsStrictMode: true}
					}
				}
			}),
			{status: 200}
		)
});
const catalogValues = {
	...customInput,
	provider: 'custom-catalog',
	api: 'anthropic-messages',
	model: 'claude-fable-5',
	models: 'claude-fable-5',
	baseUrl: 'https://catalog.example',
	apiKey: 'catalog-secret'
};
const matched = await matchPiProviderModel(catalogValues, {id: 'claude-fable-5'}, undefined, {catalogLoader});
// [P5c 迁走] matched.ok / resolution.kind 2 条 → tests/core/pi-provider.test.ts；此处保留 matched 驱动真实落盘。
if (!matched.ok) throw new Error('expected a matched candidate');
savePiProvider(replacePiProviderModels(catalogValues, [{id: 'claude-fable-5', definition: piModelDefinitionFor(matched.candidate)}]), {
	mode: 'add'
});
const catalogStored = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-catalog'].models[0];
assert.equal(catalogStored.contextWindow, 200000, '保存必须写入目录补全的 contextWindow');
assert.equal(catalogStored.maxTokens, 64000);
assert.equal(catalogStored.reasoning, true);
assert.deepEqual(catalogStored.thinkingLevelMap, {off: null, xhigh: 'xhigh'});
assert.deepEqual(catalogStored.compat, {supportsStrictMode: true});
assert.deepEqual(catalogStored.input, ['text', 'image']);
assert.equal('provider' in catalogStored, false, '不得写入目录 provider 字段');
assert.equal('baseUrl' in catalogStored, false, '不得写入目录 baseUrl 字段');
assert.equal('headers' in catalogStored, false, '不得写入目录 headers 字段');
assert.equal('api' in catalogStored, false, 'Provider api 不能被目录改写');
assert.equal(JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-catalog'].api, 'anthropic-messages');

const modelsBytesBeforeFailure = readFileSync(piModelsJsonPath(), 'utf8');
// [P5c 迁走] `failedDiscovery.ok === false` → tests/core/pi-provider.test.ts；此处保留真实字节不变断言。
await discoverPiModels({
	baseUrl: 'https://api.example.com/v1',
	api: 'openai-responses',
	options: {fetchImpl: async () => new Response('{broken', {status: 500})}
});
assert.equal(readFileSync(piModelsJsonPath(), 'utf8'), modelsBytesBeforeFailure, 'discovery 失败不得写入 models.json');

const validSettingsBeforeMalformed = readFileSync(piSettingsPath(), 'utf8');
writeFileSync(piSettingsPath(), '{broken settings', 'utf8');
const savedWithoutSettingsOwnership = savePiProvider(
	{
		...customInput,
		provider: 'custom-settings-independent',
		model: 'settings-independent-model',
		models: 'settings-independent-model',
		apiKey: 'settings-independent-secret'
	},
	{mode: 'add'}
);
assert.equal(savedWithoutSettingsOwnership.key, 'custom-settings-independent');
assert.equal(readFileSync(piSettingsPath(), 'utf8'), '{broken settings', 'Provider 保存不得读取或修复损坏的 settings.json');
writeFileSync(piSettingsPath(), validSettingsBeforeMalformed, 'utf8');

const modelsBytesBeforeMalformed = readFileSync(piModelsJsonPath(), 'utf8');
writeFileSync(piAuthJsonPath(), '{broken auth', 'utf8');
const malformedDisplay = loadPiProviderDisplay();
assert.ok(malformedDisplay.loadFailures?.some(failure => failure.key === 'auth.json'));
assert.throws(() => savePiProvider(customInput, {mode: 'add'}), /auth\.json.*损坏|无法解析/, '损坏 auth.json 必须阻止写入');
assert.equal(readFileSync(piModelsJsonPath(), 'utf8'), modelsBytesBeforeMalformed, '损坏 auth 时不得部分写 models');

// 损坏的 runtime 目录缓存必须静默降级，不得阻断展示或 Provider 写入。
writeFileSync(piAuthJsonPath(), JSON.stringify(authBefore, null, 2), 'utf8');
writeFileSync(piModelsStorePath(), '{broken store', 'utf8');
const degradedStoreDisplay = loadPiProviderDisplay();
const degradedDeepseek = degradedStoreDisplay.profiles.find(profile => profile.key === 'deepseek');
assert.ok(degradedDeepseek, '损坏的 runtime 缓存不得让 Provider 从列表消失');
assert.equal(degradedDeepseek.source, 'unknown', '损坏的 runtime 缓存必须静默降级为 unknown');
assert.equal(degradedDeepseek.canEdit, false, '降级后仍必须保持只读');
assert.equal(
	savePiProvider({...customInput, provider: 'custom-degraded'}, {mode: 'add'}).key,
	'custom-degraded',
	'损坏的 runtime 缓存不得阻断 Provider 写入'
);
assert.equal(readFileSync(piModelsStorePath(), 'utf8'), '{broken store', 'ccq 不得改写 Pi runtime 目录缓存');
writeFileSync(piModelsStorePath(), modelsStoreBytes, 'utf8');
assert.equal(readFileSync(piModelsStorePath(), 'utf8'), modelsStoreBytes, 'Provider CRUD 必须保持 runtime 目录缓存字节不变');

rmSync(home, {recursive: true, force: true});
delete process.env.CCQ_HOME;
console.log(
	'[PASS] Pi Provider：auth/models 聚合、runtime 目录补全、auth.json 数据源只读、OAuth 多 provider 共存、defaultProvider 只读投影与删除保护、API Key CRUD 与损坏文件拒写门禁全部通过（进程内行为断言见 tests/core/pi-provider.test.ts）'
);
