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
import {loadProviderContract} from '../src/core/provider-contract.ts';
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
		['officialLogin', 'glm', 'minimax', 'deepseek', 'custom'],
		'Codex 供应商类型仅含 official login、Codex 原生可接入的智谱 GLM/MiniMax/DeepSeek 与自定义'
	);
	assert.ok(options.some(option => option.value === 'officialLogin' && option.label === 'official login'), 'Codex 增加 official login 类型');
	assert.ok(options.some(option => option.value === 'glm' && /GLM/.test(option.label)), 'Codex 内置智谱 GLM（GLM-5.3 支持 Responses）');
	assert.ok(options.some(option => option.value === 'minimax' && /MiniMax/.test(option.label)), 'Codex 保留 MiniMax 内置类型');
	assert.ok(options.some(option => option.value === 'custom'), 'Codex 保留自定义供应商类型');
	assert.equal(options.at(-1)?.value, 'custom', 'custom 恒定排在选项末位（结构性条目，非契约 Codex 段派生）');
	assert.equal(options.some(option => /OpenAI-compatible/i.test(option.label)), false, '不得新增 OpenAI-compatible 标签');
	assert.equal(options.some(option => option.value === 'bailian'), false, 'Codex 不再提供阿里云百炼类型');
	assert.ok(options.some(option => option.value === 'deepseek' && /DeepSeek/.test(option.label)), 'Codex 内置 DeepSeek（V4 起原生 Responses）');
	// Kimi 仍仅 Chat Completions，Codex 只认 Responses，直连不可用，故不内置一键模板。
	assert.equal(options.some(option => ['moonshot', 'moonshot-256k'].includes(option.value)), false, 'Codex 不内置仅 Chat Completions 的 Kimi');
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

	// ── 内置供应商模板：仅保留 Codex 原生可接入者，按官方 Responses 兼容 base_url 预填 ──
	const codexGlm = buildCodexProviderFormModel({mode: 'add', providerType: 'glm'}).values;
	assert.equal(codexGlm.profileKey, 'glm');
	assert.equal(codexGlm.baseUrl, 'https://open.bigmodel.cn/api/v1');
	assert.equal(codexGlm.model, 'glm-5.3');
	assert.match(codexGlm.toml, /base_url\s*=\s*"https:\/\/open\.bigmodel\.cn\/api\/v1"/, '智谱 Responses base_url 写入 TOML');
	assert.doesNotMatch(codexGlm.toml, /wire_api\s*=/, '智谱模板省略 Codex 默认 wire_api');

	const minimax = buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).values;
	assert.equal(minimax.profileKey, 'minimax');
	assert.equal(minimax.baseUrl, 'https://api.minimax.io/v1');
	assert.equal(minimax.model, 'MiniMax-M3');

	const codexDeepseek = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).values;
	assert.equal(codexDeepseek.profileKey, 'deepseek');
	assert.equal(codexDeepseek.baseUrl, 'https://api.deepseek.com/');
	// Responses 端点为根域（非 /anthropic），默认使用 v4-pro。
	assert.equal(codexDeepseek.model, 'deepseek-v4-pro');
	assert.match(codexDeepseek.toml, /base_url\s*=\s*"https:\/\/api\.deepseek\.com"/, 'base_url 落盘去尾斜杠');
	console.log('[PASS] Codex 内置供应商模板预填官方 Responses 兼容 base_url（智谱 GLM + MiniMax + DeepSeek）');

	// ── Codex 模板唯一事实源 = providers.json 的 Codex 段（与 Claude 侧统一契约管理）──
	const {builtinProviders} = loadProviderContract();
	// 类型选项集 = 声明 Codex 段的内置供应商（排除 custom 占位条目），顺序随契约。
	// 一键模板集 = 契约中声明 Codex 段的条目；officialLogin / custom 是结构性条目，不由契约声明可用性。
	const contractCodexKeys = Object.entries(builtinProviders)
		.filter(([, provider]) => provider.codex)
		.map(([key]) => key);
	assert.deepEqual(
		options.map(option => option.value).filter(value => value !== 'officialLogin' && value !== 'custom'),
		contractCodexKeys,
		'Codex 一键模板集必须由契约 Codex 段派生，不得在代码里另立清单'
	);
	assert.equal(builtinProviders.custom?.codex, undefined, 'custom 不是供应商，不得声明 Codex 段（其可用性与 Responses 支持无关）');
	// 每项 label 与模板值逐字取自契约，避免代码与契约双份维护漂移。
	for (const key of contractCodexKeys) {
		const {codex, name} = builtinProviders[key];
		assert.equal(options.find(o => o.value === key)?.label, name, `${key} label 取自契约 Name`);
		const values = buildCodexProviderFormModel({mode: 'add', providerType: key}).values;
		assert.equal(values.baseUrl, codex.baseUrl, `${key} baseUrl 取自契约`);
		assert.equal(values.model, codex.model, `${key} model 取自契约`);
		assert.equal(values.profileKey, key, `${key} profileKey 默认取契约 key`);
	}
	// cc/cx 两侧自定义供应商文案必须同源同值（契约 custom.Name 为唯一事实源）。
	assert.equal(
		options.find(o => o.value === 'custom')?.label,
		builtinProviders.custom.name,
		'Codex 侧 custom label 须取契约 custom.Name，与 Claude 侧同文案'
	);
	// custom 选中后不预填任何字段：profileKey 留空强制命名，避免多个自定义供应商落到同一文件。
	const customValues = buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values;
	assert.equal(customValues.baseUrl, '', 'custom 不预填 baseUrl');
	assert.equal(customValues.model, '', 'custom 不预填 model');
	assert.equal(customValues.profileKey, '', 'custom profileKey 须留空强制用户命名');
	// Codex 侧端点与 Claude 侧不同源：Responses 端点常与 Anthropic 兼容端点不一致，不得复用同一字段。
	assert.notEqual(builtinProviders.glm.codex.baseUrl, builtinProviders.glm.baseUrl, '智谱 Codex baseUrl 独立于 Claude 侧 BaseUrl');
	assert.notEqual(builtinProviders.deepseek.codex.baseUrl, builtinProviders.deepseek.baseUrl, 'Codex baseUrl 独立于 Claude 侧 BaseUrl');
	// 仅暴露 Chat Completions 的供应商不得有 Codex 段（直连 Codex 会 404/空流）。
	for (const key of ['moonshot', 'moonshot-256k']) {
		assert.equal(builtinProviders[key]?.codex, undefined, `${key} 仅 Chat Completions，不得声明 Codex 段`);
	}
	console.log('[PASS] Codex 模板唯一事实源为 providers.json Codex 段（与 Claude 侧统一管理）');

	// ── 字段提示（helpText）：每个字段都须有说明，含 official login 与 custom 两个结构性条目 ──
	for (const type of ['officialLogin', 'glm', 'minimax', 'deepseek', 'custom']) {
		for (const field of buildCodexProviderFormModel({mode: 'add', providerType: type}).fields) {
			assert.ok(field.helpText?.trim(), `add/${type} 的 ${field.id} 须有 helpText`);
		}
	}
	const editFields = buildCodexProviderFormModel({
		mode: 'edit',
		providerType: 'deepseek',
		profile: {key: 'deepseek', providerType: 'apiKey', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', hasApiKey: true, profilePath: '/tmp/x.toml'}
	}).fields;
	for (const field of editFields) {
		assert.ok(field.helpText?.trim(), `edit 态的 ${field.id} 须有 helpText`);
	}
	const cxFields = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).fields;
	const fieldHelp = id => cxFields.find(f => f.id === id).helpText;
	// baseUrl 提示须点明 Responses（与 Claude 侧 Anthropic 兼容端点不同源，是最常见误填点）。
	assert.match(fieldHelp('baseUrl'), /Responses/, 'baseUrl 提示须点明 Responses 端点');
	// providerType 提示随类型变化（与 Claude 侧同构）：Codex.Note → Description，official login 用固定文案。
	const typeHelpFor = type =>
		buildCodexProviderFormModel({mode: 'add', providerType: type}).fields.find(f => f.id === 'providerType').helpText;
	assert.equal(typeHelpFor('glm'), builtinProviders.glm.codex.note, '智谱展示契约 Codex.Note');
	assert.match(typeHelpFor('glm'), /Responses/, '智谱 Codex.Note 须说明 Responses 支持');
	assert.equal(typeHelpFor('deepseek'), builtinProviders.deepseek.codex.note, '有 Codex.Note 的供应商展示该 Note');
	assert.doesNotMatch(typeHelpFor('deepseek'), /models\.json/, 'DeepSeek 不得提示未明确要求的 models.json 额外配置');
	assert.equal(typeHelpFor('minimax'), builtinProviders.minimax.description, '无 Codex.Note 时回退 Description');
	assert.equal(typeHelpFor('custom'), builtinProviders.custom.description, 'custom 展示契约 Description');
	assert.match(typeHelpFor('officialLogin'), /codex login/, 'official login 用固定文案（不在契约内）');
	const distinctTypeHelps = new Set(['officialLogin', 'glm', 'minimax', 'deepseek', 'custom'].map(typeHelpFor));
	assert.equal(distinctTypeHelps.size, 5, '五种类型的提示须各不相同（随类型变化，非静态文案）');
	// 刻意不回退顶层 Note：那是 Claude 侧的接入限制（套餐档位等），串到 Codex 侧会误导。
	assert.equal(
		typeHelpFor('deepseek').includes(builtinProviders.deepseek.note),
		false,
		'Codex 侧 providerType 提示不得串入 Claude 侧顶层 Note'
	);
	// model 提示只说字段自身语义，供应商级限制已归 providerType，不得重复出现同段文案。
	assert.match(fieldHelp('model'), /model 键/, 'model 提示须说明字段语义');
	assert.equal(fieldHelp('model').includes(builtinProviders.deepseek.codex.note), false, 'Codex.Note 已归 providerType，model 不得重复');
	assert.equal(
		fieldHelp('model'),
		buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).fields.find(f => f.id === 'model').helpText,
		'model 提示与供应商无关，各类型应一致'
	);
	// apiKey 提示须含契约 PlatformUrl，并点明 Codex 侧密钥明文落 TOML（与 Claude 侧 vault 语义不同）。
	assert.ok(fieldHelp('apiKey').includes(builtinProviders.deepseek.platformUrl), 'apiKey 提示须含契约 PlatformUrl');
	assert.match(fieldHelp('apiKey'), /experimental_bearer_token/, 'apiKey 提示须点明写入 experimental_bearer_token');
	// activateAfterSave 的激活语义按类型分流：official login 是清空供应商键，真实 provider 是写入。
	const officialActivateHelp = buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'}).fields.find(f => f.id === 'activateAfterSave').helpText;
	assert.match(officialActivateHelp, /清空/, 'official login 激活提示须说明清空供应商键');
	assert.match(fieldHelp('activateAfterSave'), /设为默认/, '真实 provider 激活提示须说明写入并设为默认');
	assert.notEqual(officialActivateHelp, fieldHelp('activateAfterSave'), '两类激活语义不同，提示不得共用');
	console.log('[PASS] Codex 侧字段提示齐备（类型提示随契约 Note 变化 / Responses 端点 / 密钥落盘位置 / 激活语义分流）');

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

	// ── edit 态回填：secret 字段应显示 TOML 中的明文 token（对齐 Claude 侧编辑回显）──
	const editModel = buildCodexProviderFormModel({
		mode: 'edit',
		providerType: 'custom',
		profile: {key: 'deepseek', providerType: 'apiKey', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hasApiKey: true, profilePath: ''},
		rawToml: toml
	});
	const editApiKeyField = editModel.fields.find(field => field.id === 'apiKey');
	assert.equal(editApiKeyField?.value, 'sk-secret-should-never-leak', 'edit 态 API Key 字段应回填 TOML 中的明文 token');
	assert.equal(editModel.values.apiKey, 'sk-secret-should-never-leak', 'edit 态 values.apiKey 应为明文 token');
	// 无 rawToml（无法提取）时回退空串，不崩溃。
	const editNoToml = buildCodexProviderFormModel({
		mode: 'edit',
		providerType: 'custom',
		profile: {key: 'deepseek', providerType: 'apiKey', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', hasApiKey: true, profilePath: ''}
	});
	assert.equal(editNoToml.values.apiKey, '', '无 rawToml 时 edit 态 apiKey 回退空串');
	console.log('[PASS] 5.5b Codex edit 态 secret 字段回填明文 token（对齐 Claude 编辑回显）');

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
