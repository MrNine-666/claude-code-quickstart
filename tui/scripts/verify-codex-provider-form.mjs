import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildCodexProviderFormModel,
	codexProviderValuesFromToml,
	codexProviderValuesToToml,
	validateCodexProviderForm
} from '../src/core/codex-provider-form.ts';
import {codexProviderFormAdapter} from '../src/services/codex-service.ts';

const home = mkdtempSync(join(tmpdir(), 'ccq-codex-provider-form-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');

try {
	// ── 5.4 provider 类型：Codex 独立供应商类型 + official login + 内置模板 + custom，无 OpenAI-compatible 标签 ──
	const add = buildCodexProviderFormModel({mode: 'add'});
	const providerTypeField = add.fields.find(field => field.id === 'providerType');
	assert.equal(providerTypeField?.type, 'radio', '新增表单首字段为 providerType radio');
	const options = providerTypeField?.type === 'radio' ? providerTypeField.options : [];
	assert.deepEqual(
		options.map(option => option.value),
		['officialLogin', 'zhipu', 'minimax', 'moonshot', 'deepseek', 'bailian', 'custom'],
		'Codex 供应商类型应包含 official login、内置 API 供应商与自定义'
	);
	assert.ok(options.some(option => option.value === 'officialLogin' && option.label === 'official login'), 'Codex 增加 official login 类型');
	assert.ok(options.some(option => option.value === 'zhipu' && /智谱 GLM/.test(option.label)), 'Codex 还原智谱 GLM 类型');
	assert.ok(options.some(option => option.value === 'deepseek' && option.label === 'DeepSeek'), 'Codex 还原 DeepSeek 类型');
	assert.ok(options.some(option => option.value === 'custom' && /自定义 API 供应商/.test(option.label)), 'Codex 保留自定义 API 供应商语义');
	assert.equal(options.some(option => /OpenAI-compatible/i.test(option.label)), false, '不得新增 OpenAI-compatible 标签');
	assert.equal(add.fields.some(field => field.id === 'codexProfileToml'), false, '表单字段区不得展示写死 TOML readonly 字段');
	assert.equal(add.fields.find(field => field.id === 'profileKey')?.label, '文件名', 'profile key 文案应面向用户显示为文件名');

	const addAfterOfficialLogin = buildCodexProviderFormModel({
		mode: 'add',
		providerType: 'officialLogin',
		existingProfiles: [{key: 'official', providerType: 'officialLogin', baseUrl: '', model: '', hasApiKey: false, profilePath: join(process.env.CODEX_HOME, 'official.config.toml')}]
	});
	const singletonField = addAfterOfficialLogin.fields.find(field => field.id === 'providerType');
	const singletonOptions = singletonField?.type === 'radio' ? singletonField.options : [];
	assert.equal(singletonOptions.some(option => option.value === 'officialLogin'), false, 'official login 已存在时新增类型列表不再展示该类型');
	assert.equal(addAfterOfficialLogin.values.providerType, 'zhipu', '直接选择 official login 且已存在时应回退到可新增 API 类型并提示用户');
	assert.match(singletonField?.helpText ?? '', /已存在 official login profile/, '类型字段应提示 official login 单例原因');
	console.log('[PASS] 5.4 Codex provider 类型：official login + 内置供应商 + custom，无 OpenAI-compatible + login 单例过滤');

	// ── 内置供应商模板：按官方 OpenAI-compatible base_url 预填 ─────────────────────
	const zhipu = buildCodexProviderFormModel({mode: 'add', providerType: 'zhipu'}).values;
	assert.equal(zhipu.profileKey, 'zhipu');
	assert.equal(zhipu.baseUrl, 'https://open.bigmodel.cn/api/paas/v4/');
	assert.equal(zhipu.model, 'glm-5.2');

	const minimax = buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).values;
	assert.equal(minimax.profileKey, 'minimax');
	assert.equal(minimax.baseUrl, 'https://api.minimax.io/v1');
	assert.equal(minimax.model, 'MiniMax-M3');

	const moonshot = buildCodexProviderFormModel({mode: 'add', providerType: 'moonshot'}).values;
	assert.equal(moonshot.profileKey, 'moonshot');
	assert.equal(moonshot.baseUrl, 'https://api.moonshot.ai/v1');
	assert.equal(moonshot.model, 'kimi-k2.6');

	const deepseek = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).values;
	assert.equal(deepseek.profileKey, 'deepseek');
	assert.equal(deepseek.baseUrl, 'https://api.deepseek.com');
	assert.equal(deepseek.model, 'deepseek-v4-pro');

	const bailian = buildCodexProviderFormModel({mode: 'add', providerType: 'bailian'}).values;
	assert.equal(bailian.profileKey, 'bailian');
	assert.equal(bailian.baseUrl, 'https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
	assert.equal(bailian.model, 'qwen-plus');
	console.log('[PASS] Codex 内置供应商模板预填官方 OpenAI-compatible base_url');

	// ── 5.7 official login：不要求 API key / Base URL，移除 Auth 单行字段，textarea 只读展示 auth.json ─────────────
	const official = buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'});
	const officialFieldIds = official.fields.map(field => field.id);
	assert.equal(official.values.providerType, 'officialLogin');
	assert.equal(officialFieldIds.includes('baseUrl'), false, 'official login 不展示 Base URL 字段');
	assert.equal(officialFieldIds.includes('apiKey'), false, 'official login 不展示 API Key 字段');
	assert.equal(officialFieldIds.includes('authStatus'), false, 'official login 不再展示 Auth 单行状态字段');
	assert.match(official.values.authJson, /未检测到 CODEX_HOME\/auth\.json/, '无 auth.json 时 textarea 应提示运行 codex login');
	assert.equal(validateCodexProviderForm('add', {...official.values, profileKey: 'official'}).length, 0,
		'official login 不要求 API key/Base URL');
	const officialToml = codexProviderValuesToToml({...official.values, profileKey: 'official', model: 'gpt-5'});
	assert.match(officialToml, /model\s*=\s*"gpt-5"/, 'official login 可保存模型默认值');
	assert.equal(officialToml.includes('model_providers'), false, 'official login 不写 provider table');

	mkdirSync(process.env.CODEX_HOME, {recursive: true});
	writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({
		access_token: 'access-secret',
		refresh_token: 'refresh-secret',
		account: {email: 'user@example.com', api_key: 'key-secret'}
	}, null, 2));
	const officialWithAuth = buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'});
	const authPreview = codexProviderFormAdapter.buildText(officialWithAuth.values);
	assert.match(authPreview, /"access_token": "\*\*\*"/, 'auth.json textarea 应脱敏 access_token');
	assert.match(authPreview, /"api_key": "\*\*\*"/, 'auth.json textarea 应递归脱敏 api_key');
	assert.equal(authPreview.includes('access-secret'), false, 'auth.json textarea 不得泄漏 access token');
	assert.equal(authPreview.includes('key-secret'), false, 'auth.json textarea 不得泄漏 API key');
	const parsedAuthPreview = codexProviderFormAdapter.parseText(officialWithAuth.values, '用户误编辑 auth preview');
	assert.equal(parsedAuthPreview.ok, true, 'official login 的 auth.json textarea 不参与 TOML 解析');
	assert.equal(codexProviderFormAdapter.isTextReadOnly?.(officialWithAuth.values), true, 'official login 的 auth.json textarea 应只读');
	console.log('[PASS] 5.7 official login 使用只读脱敏 auth.json textarea');

	// ── 5.5/5.6 API-key provider：字段 → TOML，TOML → 字段 ─────────────────────
	const apiValues = {
		...buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values,
		profileKey: 'deepseek',
		providerType: 'custom',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: 'sk-secret-should-never-leak'
	};
	assert.deepEqual(validateCodexProviderForm('add', apiValues), [], 'API-key provider 字段应通过校验');
	const toml = codexProviderValuesToToml(apiValues);
	assert.match(toml, /model_provider\s*=\s*"deepseek"/, '字段变更生成 TOML model_provider');
	assert.match(toml, /base_url\s*=\s*"https:\/\/api\.deepseek\.com"/, 'Base URL 规范化后写 TOML');
	assert.match(toml, /experimental_bearer_token\s*=\s*"sk-secret-should-never-leak"/, 'API key 写 experimental_bearer_token');
	assert.equal(/env_key\s*=|requires_openai_auth\s*=|\[model_providers\.deepseek\.auth\]/.test(toml), false,
		'认证字段互斥：不得含 env_key/auth/requires_openai_auth');
	assert.equal(codexProviderFormAdapter.isTextReadOnly?.(apiValues), false, 'API-key provider TOML textarea 应可编辑');
	const parsed = codexProviderValuesFromToml(apiValues, toml);
	assert.equal(parsed.ok, true, 'TOML textarea 可解析回字段');
	if (parsed.ok) {
		assert.equal(parsed.values.baseUrl, 'https://api.deepseek.com');
		assert.equal(parsed.values.model, 'deepseek-chat');
		assert.equal(parsed.values.providerType, 'custom');
	}
	console.log('[PASS] 5.5/5.6 Codex provider 字段 + TOML 双向同步与 API key 策略');

	// ── parse error：不允许保存无效 TOML ────────────────────────────────────────
	const invalid = codexProviderValuesFromToml(apiValues, 'not = [valid');
	assert.equal(invalid.ok, false, '无效 TOML 应返回错误，不回填字段');
	console.log('[PASS] 5.5 无效 TOML 拒绝回填/保存');
} finally {
	rmSync(home, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
