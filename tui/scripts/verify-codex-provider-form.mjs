import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildCodexProviderFormModel,
	codexProviderValuesFromToml,
	codexProviderValuesToToml,
	validateCodexProviderForm
} from '../src/core/codex-provider-form.ts';
import {buildCodexForm, codexProviderFormAdapter, loadCodexProviderProfile, saveCodexProviderForm} from '../src/services/codex-service.ts';

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
		['officialLogin', 'minimax', 'custom'],
		'Codex 供应商类型仅含 official login、Codex 原生可接入的 MiniMax 与自定义'
	);
	assert.ok(options.some(option => option.value === 'officialLogin' && option.label === 'official login'), 'Codex 增加 official login 类型');
	assert.ok(options.some(option => option.value === 'minimax' && /MiniMax/.test(option.label)), 'Codex 保留 MiniMax 内置类型');
	assert.ok(options.some(option => option.value === 'custom' && /自定义 API 供应商/.test(option.label)), 'Codex 保留自定义 API 供应商语义');
	assert.equal(options.some(option => /OpenAI-compatible/i.test(option.label)), false, '不得新增 OpenAI-compatible 标签');
	assert.equal(options.some(option => option.value === 'bailian'), false, 'Codex 不再提供阿里云百炼类型');
	// GLM/Kimi/DeepSeek 仅 Chat Completions，Codex 只认 Responses，直连不可用，故移除内置一键模板。
	assert.equal(options.some(option => ['zhipu', 'moonshot', 'deepseek'].includes(option.value)), false, 'Codex 不再内置仅 Chat Completions 的 GLM/Kimi/DeepSeek');
	assert.equal(add.fields.some(field => field.id === 'codexProfileToml'), false, '表单字段区不得展示写死 TOML readonly 字段');
	// 默认 add 表单默认 official login（虚拟条目，无文件名字段）；文件名文案在真实供应商类型下校验。
	const customAdd = buildCodexProviderFormModel({mode: 'add', providerType: 'custom'});
	assert.equal(customAdd.fields.find(field => field.id === 'profileKey')?.label, '文件名', 'profile key 文案应面向用户显示为文件名');

	// official login 现为结构性单例的虚拟条目（不落盘、可幂等激活），类型选项恒定展示，不再按存在性隐藏。
	const officialAlwaysShown = buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'});
	const officialTypeField = officialAlwaysShown.fields.find(field => field.id === 'providerType');
	const officialTypeOptions = officialTypeField?.type === 'radio' ? officialTypeField.options : [];
	assert.equal(officialTypeOptions.some(option => option.value === 'officialLogin'), true, 'official login 类型恒定展示（虚拟条目结构性单例）');
	assert.equal(officialAlwaysShown.values.providerType, 'officialLogin', '显式请求 official login 时保留该类型');
	console.log('[PASS] 5.4 Codex provider 类型：official login 恒定展示 + 内置供应商 + custom，无 OpenAI-compatible');

	// ── 内置供应商模板：仅保留 Codex 原生可接入的 MiniMax，按官方 Responses 兼容 base_url 预填 ──
	const minimax = buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).values;
	assert.equal(minimax.profileKey, 'minimax');
	assert.equal(minimax.baseUrl, 'https://api.minimax.io/v1');
	assert.equal(minimax.model, 'MiniMax-M3');
	console.log('[PASS] Codex 内置供应商模板预填官方 Responses 兼容 base_url（仅 MiniMax）');

	// ── 5.7 official login：虚拟条目，无文件名/Base URL/model/API Key 字段，仅只读 auth.json + 激活开关 ──
	const official = buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'});
	const officialFieldIds = official.fields.map(field => field.id);
	assert.equal(official.values.providerType, 'officialLogin');
	assert.equal(official.values.profileKey, 'official', 'official login profileKey 固定为 sentinel');
	assert.equal(officialFieldIds.includes('profileKey'), false, 'official login 不展示文件名字段（虚拟条目）');
	assert.equal(officialFieldIds.includes('baseUrl'), false, 'official login 不展示 Base URL 字段');
	assert.equal(officialFieldIds.includes('model'), false, 'official login 不展示默认模型字段（归 Config 页管）');
	assert.equal(officialFieldIds.includes('apiKey'), false, 'official login 不展示 API Key 字段');
	assert.equal(officialFieldIds.includes('authJson'), true, 'official login 展示只读 auth.json 状态字段');
	assert.equal(officialFieldIds.includes('activateAfterSave'), true, 'official login 保留保存后激活开关');
	assert.match(official.values.authJson, /未检测到 ~\/\.codex\/auth\.json/, '无 auth.json 时应提示运行 codex login');
	assert.equal(validateCodexProviderForm('add', official.values).length, 0,
		'official login 不校验文件名/API key/Base URL');

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

	// ── official login 编辑态：auth.json 明文可编辑 + 空内容登出 ────────────────
	const authPath = join(process.env.CCQ_HOME, '.codex', 'auth.json');
	writeFileSync(authPath, '{"tokens":{"access_token":"eyJreal"}}', 'utf8');
	// edit 态回填明文原文（非脱敏），且 textarea 放开编辑。
	const officialEdit = buildCodexForm({mode: 'edit', profileKey: 'official', profile: loadCodexProviderProfile('official')});
	assert.equal(officialEdit.values.authEditable, true, 'official edit 态 authEditable=true');
	assert.match(officialEdit.values.authJson, /eyJreal/, 'edit 态回填明文 access_token（非脱敏 ***）');
	assert.equal(codexProviderFormAdapter.isTextReadOnly?.(officialEdit.values), false, 'official edit 态 textarea 可编辑');
	// add 态仍为脱敏只读（安全边界不回退）。
	const officialAdd = buildCodexForm({mode: 'add', providerType: 'officialLogin'});
	assert.equal(codexProviderFormAdapter.isTextReadOnly?.(officialAdd.values), true, 'official add 态 textarea 仍只读');
	// 保存改动后的明文 → 写回 auth.json。
	const edited = {...officialEdit.values, authJson: '{"tokens":{"access_token":"eyJnew"}}'};
	const saveOk = saveCodexProviderForm({mode: 'edit', profileKey: 'official', providerType: 'officialLogin'}, edited);
	assert.equal(saveOk.ok, true, 'official edit 保存应成功');
	assert.match(readFileSync(authPath, 'utf8'), /eyJnew/, '编辑后的明文写回 auth.json');
	// 空内容保存 = 登出（删除 auth.json）。
	const logout = saveCodexProviderForm({mode: 'edit', profileKey: 'official', providerType: 'officialLogin'}, {...officialEdit.values, authJson: '   '});
	assert.equal(logout.ok, true, '空内容保存应成功');
	assert.equal(existsSync(authPath), false, '空内容保存 = 登出，删除 auth.json');
	// 非法 JSON 拒绝写入（不产生半成品文件）。
	writeFileSync(authPath, '{"tokens":{"access_token":"eyJkeep"}}', 'utf8');
	const badJson = saveCodexProviderForm({mode: 'edit', profileKey: 'official', providerType: 'officialLogin'}, {...officialEdit.values, authJson: '{not json'});
	assert.equal(badJson.ok, false, '非法 JSON 应拒绝保存');
	assert.match(readFileSync(authPath, 'utf8'), /eyJkeep/, '非法 JSON 保存失败时不破坏原 auth.json');
	console.log('[PASS] 5.7b official login 编辑态：auth.json 明文可编辑 + 空内容登出 + 非法 JSON 拒绝');
} finally {
	rmSync(home, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
