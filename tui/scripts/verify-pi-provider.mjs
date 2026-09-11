import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
	buildPiModelDiscoveryEndpoint,
	commitPiDiscoveredModels,
	deletePiProvider,
	discoverPiModels,
	loadPiProviderDisplay,
	loadPiProviderProfile,
	parsePiProviderKey,
	savePiProvider,
	switchPiProvider
} from '../src/core/pi-provider.ts';
import {piAuthJsonPath, piModelsJsonPath, piSettingsPath} from '../src/core/paths.ts';
import {createProviderViewAdapter} from '../src/views/provider/provider-view-adapter.ts';

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
		keep: {baseUrl: 'https://keep.example/v1', api: 'openai-completions', models: ['keep-model']}
	},
	userRootField: {keep: true}
};
const authBefore = {
	openai: {type: 'api_key', key: 'sk-live-secret-value', userAuthField: 'preserve-auth'},
	'openai-codex': {type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', expires: 1},
	xai: {type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: 1},
	keep: {type: 'api_key', key: 'keep-secret'}
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

const display = loadPiProviderDisplay();
const openaiRow = display.profiles.find(profile => profile.key === 'openai');
assert.ok(openaiRow);
assert.equal(openaiRow.isActive, true);
assert.equal(openaiRow.authKind, 'api_key');
assert.equal(openaiRow.modelCount, 3, '内置模型与 models.json 模型应按 ID 合并去重');
assert.equal(openaiRow.canDelete, false, '当前激活 provider 不得删除');
assert.doesNotMatch(JSON.stringify(display), /sk-live-secret-value|secret-access|xai-access/);
assert.equal(display.profiles.filter(profile => profile.key === 'openai-codex').length, 1);
assert.equal(display.profiles.filter(profile => profile.key === 'xai').length, 1);
assert.equal(loadPiProviderProfile('openai')?.apiKey, 'sk-live-secret-value');
assert.equal(createProviderViewAdapter('pi').toHomeRow(openaiRow).title, 'OpenAI · openai');
assert.equal(
	createProviderViewAdapter('pi').toHomeRow({...openaiRow, key: 'aether-cx', displayName: 'aether-cx'}).title,
	'aether-cx',
	'provider displayName 与 ID 相同时列表标题不得重复'
);
assert.equal(parsePiProviderKey('openai/gpt-4o'), null, 'Pi identity 必须是 provider ID');
assert.equal(parsePiProviderKey('openai')?.provider, 'openai');

const customInput = {
	providerType: 'custom-api-key',
	provider: 'custom-acme',
	api: 'openai-completions',
	model: 'acme-one',
	models: 'acme-one\nacme-two',
	baseUrl: 'https://acme.example/v1',
	apiKey: 'acme-secret',
	activateAfterSave: false
};
const added = savePiProvider(customInput, {mode: 'add'});
assert.equal(added.key, 'custom-acme');
let modelsAfterAdd = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
let authAfterAdd = JSON.parse(readFileSync(piAuthJsonPath(), 'utf8'));
let settingsAfterAdd = JSON.parse(readFileSync(piSettingsPath(), 'utf8'));
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
assert.throws(() => savePiProvider(customInput, {mode: 'add'}), /已存在/);

const activated = savePiProvider(
	{
		...customInput,
		provider: 'custom-active',
		model: 'active-model',
		models: 'active-model',
		apiKey: 'active-secret',
		activateAfterSave: true
	},
	{mode: 'add'}
);
assert.equal(activated.key, 'custom-active');
const settingsAfterExplicitActivation = JSON.parse(readFileSync(piSettingsPath(), 'utf8'));
assert.equal(settingsAfterExplicitActivation.defaultProvider, 'custom-active', '明确选择激活时应切换 defaultProvider');
assert.equal(settingsAfterExplicitActivation.defaultModel, 'sentinel-model', '激活 provider 不得维护 defaultModel');

const settingsBytesBeforeSwitch = readFileSync(piSettingsPath(), 'utf8');
assert.equal(switchPiProvider('xai').providerName, 'xAI (Grok/X subscription)');
const switchedSettings = JSON.parse(readFileSync(piSettingsPath(), 'utf8'));
assert.equal(switchedSettings.defaultProvider, 'xai');
assert.equal(switchedSettings.defaultModel, 'sentinel-model');
assert.equal(switchedSettings.userSetting.keep, true);
assert.notEqual(readFileSync(piSettingsPath(), 'utf8'), settingsBytesBeforeSwitch);
assert.throws(() => deletePiProvider('xai'), /当前激活/);

const customProfile = loadPiProviderProfile('custom-acme');
assert.ok(customProfile);
const edited = savePiProvider(
	{...customInput, models: 'acme-one\nacme-three', model: 'acme-one', apiKey: ''},
	{mode: 'edit', profileKey: 'custom-acme', profile: customProfile}
);
assert.equal(edited.key, 'custom-acme');
assert.deepEqual(
	JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers['custom-acme'].models.map(model => (typeof model === 'string' ? model : model.id)),
	['acme-one', 'acme-three'],
	'编辑表单取消勾选的模型不得在保存时被重新合并'
);
assert.equal(JSON.parse(readFileSync(piSettingsPath(), 'utf8')).defaultProvider, 'xai');
assert.equal(JSON.parse(readFileSync(piSettingsPath(), 'utf8')).defaultModel, 'sentinel-model');
assert.equal(JSON.parse(readFileSync(piAuthJsonPath(), 'utf8'))['custom-acme'].key, 'acme-secret');

assert.equal(deletePiProvider('keep').removedModels, true);
assert.equal(JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')).providers.keep, undefined);
assert.equal(JSON.parse(readFileSync(piAuthJsonPath(), 'utf8')).keep, undefined);

// 内置 provider 的 API Key 删除不能删除 Pi 内置模型或用户 override。
assert.equal(deletePiProvider('openai').removedAuth, true);
const afterBuiltinDelete = JSON.parse(readFileSync(piModelsJsonPath(), 'utf8'));
assert.ok(afterBuiltinDelete.providers.openai, '内置 provider 的 models.json override 必须保留');

const discoveryEndpoint = buildPiModelDiscoveryEndpoint('https://api.example.com/v1', 'openai-completions');
assert.equal(discoveryEndpoint, 'https://api.example.com/v1/models');
const discovery = await discoverPiModels({
	baseUrl: 'https://api.example.com/v1',
	api: 'openai-completions',
	apiKey: 'discovery-secret',
	options: {
		fetchImpl: async (_url, init) => {
			assert.equal(init.headers.Authorization, 'Bearer discovery-secret');
			return new Response(JSON.stringify({data: [{id: 'acme-four'}, {id: 'acme-four'}, {id: 'acme-five'}]}), {
				status: 200,
				headers: {'content-type': 'application/json'}
			});
		}
	}
});
assert.equal(discovery.ok, true);
if (discovery.ok) {
	assert.deepEqual(
		discovery.models.map(model => model.id),
		['acme-five', 'acme-four']
	);
	const merged = commitPiDiscoveredModels('custom-acme', [discovery.models[0]]);
	assert.ok(merged.some(model => model.id === 'acme-five'));
}

const modelsBytesBeforeFailure = readFileSync(piModelsJsonPath(), 'utf8');
const failedDiscovery = await discoverPiModels({
	baseUrl: 'https://api.example.com/v1',
	api: 'openai-responses',
	options: {fetchImpl: async () => new Response('{broken', {status: 500})}
});
assert.equal(failedDiscovery.ok, false);
assert.equal(readFileSync(piModelsJsonPath(), 'utf8'), modelsBytesBeforeFailure, 'discovery 失败不得写入 models.json');

const modelsBytesBeforeMalformed = readFileSync(piModelsJsonPath(), 'utf8');
writeFileSync(piAuthJsonPath(), '{broken auth', 'utf8');
const malformedDisplay = loadPiProviderDisplay();
assert.ok(malformedDisplay.loadFailures?.some(failure => failure.key === 'auth.json'));
assert.throws(() => savePiProvider(customInput, {mode: 'add'}), /auth\.json.*损坏|无法解析/, '损坏 auth.json 必须阻止写入');
assert.equal(readFileSync(piModelsJsonPath(), 'utf8'), modelsBytesBeforeMalformed, '损坏 auth 时不得部分写 models');

rmSync(home, {recursive: true, force: true});
delete process.env.CCQ_HOME;
console.log(
	'[PASS] Pi Provider：auth/models 聚合、OAuth 多 provider 共存、defaultProvider-only 切换、激活删除保护、API Key CRUD、模型 discovery 与损坏文件拒写门禁全部通过'
);
