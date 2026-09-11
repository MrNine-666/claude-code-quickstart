import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {
	PI_APIS,
	buildPiProviderFormModel,
	loadPiProviderDisplay,
	loadPiProviderRegistry,
	piChatGptStatus,
	validatePiProviderForm
} from '../src/core/pi-provider.ts';
import {mergePiProviderModels, piProviderFormAdapter, replacePiProviderModels} from '../src/services/pi-provider-service.ts';
import {piAgentDir, piAuthJsonPath} from '../src/core/paths.ts';

const previousHome = process.env.CCQ_HOME;
const home = mkdtempSync(join(tmpdir(), 'ccq-pi-provider-form-'));
process.env.CCQ_HOME = home;
try {
	mkdirSync(piAgentDir(), {recursive: true});
	const registry = loadPiProviderRegistry();
	assert.ok(registry.some(provider => provider.providerId === 'openai-codex' && provider.oauth));
	assert.ok(registry.some(provider => provider.providerId === 'xai' && provider.oauth));
	assert.equal(loadPiProviderDisplay().profiles.length, 0, '未登录/未配置的 registry provider 不应伪造列表项');

	const form = buildPiProviderFormModel({mode: 'add'});
	assert.equal(piProviderFormAdapter.showTextEditor, false, 'Pi 表单不显示最终 JSON textarea');
	assert.equal(form.values.providerType, 'custom-api-key');
	assert.equal(
		form.fields.some(field => field.id === 'providerType'),
		false,
		'Pi 表单不展示无用的 Provider 类型'
	);
	assert.equal(form.fields.find(field => field.id === 'provider')?.type, 'text');
	assert.equal(
		form.fields.some(field => field.id === 'models'),
		false,
		'模型列表由表单内嵌控件拥有，不再占用只读字段值列'
	);
	assert.deepEqual(
		mergePiProviderModels({...form.values, models: 'existing-model'}, ['manual-model', 'existing-model']).models.split('\n'),
		['existing-model', 'manual-model'],
		'手工添加的模型应进入模型列表并保持去重'
	);
	assert.deepEqual(
		replacePiProviderModels({...form.values, models: 'existing-model\nremoved-model'}, ['existing-model']).models.split('\n'),
		['existing-model'],
		'模型列表勾选结果应允许移除未选中的模型'
	);
	assert.equal(form.fields.find(field => field.id === 'api')?.type, 'radio');
	assert.ok(
		form.fields.some(field => field.id === 'apiKey'),
		'API Key 必须保留在模型列表区域之前'
	);
	assert.equal(form.fields.find(field => field.id === 'activateAfterSave')?.type, 'radio');
	assert.equal(form.values.activateAfterSave, true, '新增 Pi Provider 默认保存后激活');
	assert.deepEqual(
		form.fields.find(field => field.id === 'api')?.type === 'radio'
			? form.fields.find(field => field.id === 'api').options.map(option => option.value)
			: [],
		PI_APIS
	);
	assert.equal(
		validatePiProviderForm('add', {
			...form.values,
			provider: 'custom',
			baseUrl: 'https://api.example/v1',
			models: 'model-a',
			apiKey: 'secret'
		}).length,
		0
	);
	assert.ok(validatePiProviderForm('add', {...form.values, provider: '', models: '', apiKey: ''}).length > 0);

	writeFileSync(
		piAuthJsonPath(),
		JSON.stringify({
			'openai-codex': {type: 'oauth', access: 'secret-access', refresh: 'secret-refresh', expires: 1},
			xai: {type: 'oauth', access: 'xai-access', refresh: 'xai-refresh', expires: 1}
		}),
		'utf8'
	);
	assert.deepEqual(piChatGptStatus(), {loggedIn: true});
	const oauthDisplay = loadPiProviderDisplay();
	assert.equal(oauthDisplay.profiles.find(profile => profile.key === 'openai-codex')?.canEdit, false);
	assert.equal(oauthDisplay.profiles.find(profile => profile.key === 'xai')?.canDelete, false);
	assert.doesNotMatch(JSON.stringify(oauthDisplay), /secret-access|secret-refresh|xai-access/);

	writeFileSync(
		piAuthJsonPath(),
		JSON.stringify({
			'openai-codex': {type: 'oauth', access: 'only-access'},
			xai: {type: 'oauth', refresh: 'only-refresh'}
		}),
		'utf8'
	);
	assert.deepEqual(piChatGptStatus(), {loggedIn: false}, '缺少 access/refresh 的 OAuth 凭据不得显示为已登录');
	const incompleteOAuth = loadPiProviderDisplay();
	assert.equal(incompleteOAuth.profiles.find(profile => profile.key === 'openai-codex')?.authStatus, 'invalid');
	assert.equal(
		incompleteOAuth.profiles.find(profile => profile.key === 'openai-codex')?.maskedApiKey,
		'OAuth 凭据不完整，请通过 Pi 原生 /login 修复'
	);
	assert.doesNotMatch(JSON.stringify(incompleteOAuth), /only-access|only-refresh/);
	console.log('[PASS] Pi Provider 表单：仅 API Key 自定义新增、OAuth 只读、协议字段和 defaultProvider 边界通过');
} finally {
	if (previousHome === undefined) delete process.env.CCQ_HOME;
	else process.env.CCQ_HOME = previousHome;
	rmSync(home, {recursive: true, force: true});
}
