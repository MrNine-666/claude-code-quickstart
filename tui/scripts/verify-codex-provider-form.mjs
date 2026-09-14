import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	buildCodexProviderFormModel,
	codexProviderValuesFromToml,
	codexProviderValuesToToml,
	validateCodexProviderForm
} from '../src/core/codex-provider-form.ts';
import {loadProviderContract} from '../src/core/provider-contract.ts';
import {codexProviderFormAdapter, saveCodexProviderForm} from '../src/services/codex-service.ts';

const home = mkdtempSync(join(tmpdir(), 'ccq-codex-provider-form-'));
process.env.CCQ_HOME = home;
process.env.CODEX_HOME = join(home, '.codex');

try {
	// ── 5.4 provider 类型：Codex 独立供应商类型 + 内置模板 + custom，无 official login / OpenAI-compatible 标签 ──
	const add = buildCodexProviderFormModel({mode: 'add'});
	const providerTypeField = add.fields.find(field => field.id === 'providerType');
	assert.equal(providerTypeField?.type, 'radio', '新增表单首字段为 providerType radio');
	const options = providerTypeField?.type === 'radio' ? providerTypeField.options : [];
	assert.deepEqual(
		options.map(option => option.value),
		['glm', 'deepseek', 'minimax', 'custom'],
		'Codex 表单供应商类型仅含 Codex 原生可接入的智谱 GLM/MiniMax/DeepSeek 与自定义'
	);
	assert.equal(options.some(option => option.value === 'officialLogin'), false, 'Codex 表单不得提供 official login 类型');
	assert.ok(
		options.some(option => option.value === 'glm' && /GLM/.test(option.label)),
		'Codex 内置智谱 GLM（GLM-5.3 支持 Responses）'
	);
	assert.ok(
		options.some(option => option.value === 'minimax' && /MiniMax/.test(option.label)),
		'Codex 保留 MiniMax 内置类型'
	);
	assert.ok(
		options.some(option => option.value === 'custom'),
		'Codex 保留自定义供应商类型'
	);
	assert.equal(options.at(-1)?.value, 'custom', 'custom 恒定排在选项末位（结构性条目，非契约 Codex 段派生）');
	assert.equal(
		options.some(option => /OpenAI-compatible/i.test(option.label)),
		false,
		'不得新增 OpenAI-compatible 标签'
	);
	assert.equal(
		options.some(option => option.value === 'bailian'),
		false,
		'Codex 不再提供阿里云百炼类型'
	);
	assert.ok(
		options.some(option => option.value === 'deepseek' && /DeepSeek/.test(option.label)),
		'Codex 内置 DeepSeek（V4 起原生 Responses）'
	);
	// Kimi 仍仅 Chat Completions，Codex 只认 Responses，直连不可用，故不内置一键模板。
	assert.equal(
		options.some(option => ['moonshot', 'moonshot-256k'].includes(option.value)),
		false,
		'Codex 不内置仅 Chat Completions 的 Kimi'
	);
	assert.equal(
		add.fields.some(field => field.id === 'codexProfileToml'),
		false,
		'表单字段区不得展示写死 TOML readonly 字段'
	);
	assert.equal(add.values.providerType, 'custom', 'Codex 新增表单默认使用 API-key custom 类型');
	assert.ok(add.fields.some(field => field.id === 'baseUrl'), 'Codex 新增表单默认展示 Base URL');
	assert.equal(add.fields.some(field => field.id === 'authJson'), false, 'Codex 表单不得展示 auth.json 编辑/预览字段');
	// 文件名文案在真实供应商类型下校验。
	const customAdd = buildCodexProviderFormModel({mode: 'add', providerType: 'custom'});
	assert.equal(customAdd.fields.find(field => field.id === 'profileKey')?.label, '文件名', 'profile key 文案应面向用户显示为文件名');
	assert.throws(
		() => buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'}),
		/官方账号.*Codex 原生管理/,
		'Codex 表单即使被外部传入 official login 也必须拒绝构造'
	);
	console.log('[PASS] 5.4 Codex provider 类型：仅 API-key 供应商 + custom，无 official login / OpenAI-compatible');

	// ── 内置供应商模板：仅保留 Codex 原生可接入者，按官方 Responses 兼容 base_url 预填 ──
	const codexGlm = buildCodexProviderFormModel({mode: 'add', providerType: 'glm'}).values;
	assert.equal(codexGlm.profileKey, 'glm');
	assert.equal(codexGlm.baseUrl, 'https://open.bigmodel.cn/api/v1');
	assert.equal(codexGlm.model, '', 'GLM Codex 模板不预填模型');
	assert.match(codexGlm.toml, /base_url\s*=\s*"https:\/\/open\.bigmodel\.cn\/api\/v1"/, '智谱 Responses base_url 写入 TOML');
	assert.doesNotMatch(codexGlm.toml, /wire_api\s*=/, '智谱模板省略 Codex 默认 wire_api');

	const minimax = buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).values;
	assert.equal(minimax.profileKey, 'minimax');
	assert.equal(minimax.baseUrl, 'https://api.minimax.io/v1');
	assert.equal(minimax.model, '', 'MiniMax Codex 模板不预填模型');

	const codexDeepseek = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).values;
	assert.equal(codexDeepseek.profileKey, 'deepseek');
	assert.equal(codexDeepseek.baseUrl, 'https://api.deepseek.com/');
	// Responses 端点为根域（非 /anthropic），模型留空由用户选择。
	assert.equal(codexDeepseek.model, '', 'DeepSeek Codex 模板不预填模型');
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

	// ── 字段提示（helpText）：每个可编辑类型的字段都须有说明 ──
	for (const type of ['glm', 'minimax', 'deepseek', 'custom']) {
		for (const field of buildCodexProviderFormModel({mode: 'add', providerType: type}).fields) {
			assert.ok(field.helpText?.trim(), `add/${type} 的 ${field.id} 须有 helpText`);
		}
	}
	const editFields = buildCodexProviderFormModel({
		mode: 'edit',
		providerType: 'deepseek',
		profile: {
			key: 'deepseek',
			providerType: 'apiKey',
			baseUrl: 'https://api.deepseek.com',
			model: 'deepseek-v4-flash',
			hasApiKey: true,
			profilePath: '/tmp/x.toml'
		}
	}).fields;
	assert.equal(
		editFields[editFields.findIndex(field => field.id === 'baseUrl') + 1]?.id,
		'apiKey',
		'Codex 编辑表单 API Key 必须紧跟 Base URL'
	);
	for (const field of editFields) {
		assert.ok(field.helpText?.trim(), `edit 态的 ${field.id} 须有 helpText`);
	}
	const cxFields = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).fields;
	assert.equal(
		cxFields[cxFields.findIndex(field => field.id === 'baseUrl') + 1]?.id,
		'apiKey',
		'Codex 表单 API Key 必须紧跟 Base URL'
	);
	assert.equal(cxFields.find(f => f.id === 'model')?.type, 'model-select', 'Codex 默认模型必须使用模型单选字段');
	assert.equal(buildCodexProviderFormModel({mode: 'add'}).fields.some(field => field.type === 'model-select'), true, 'Codex 默认 API-key 表单应挂载模型发现字段');
	const fieldHelp = id => cxFields.find(f => f.id === id).helpText;
	// baseUrl 提示须点明 Responses（与 Claude 侧 Anthropic 兼容端点不同源，是最常见误填点）。
	assert.match(fieldHelp('baseUrl'), /Responses/, 'baseUrl 提示须点明 Responses 端点');
	// providerType 提示随类型变化（与 Claude 侧同构）：Codex.Note → Description。
	const typeHelpFor = type =>
		buildCodexProviderFormModel({mode: 'add', providerType: type}).fields.find(f => f.id === 'providerType').helpText;
	assert.equal(typeHelpFor('glm'), builtinProviders.glm.codex.note, '智谱展示契约 Codex.Note');
	assert.match(typeHelpFor('glm'), /Responses/, '智谱 Codex.Note 须说明 Responses 支持');
	assert.equal(typeHelpFor('deepseek'), builtinProviders.deepseek.codex.note, '有 Codex.Note 的供应商展示该 Note');
	assert.doesNotMatch(typeHelpFor('deepseek'), /models\.json/, 'DeepSeek 不得提示未明确要求的 models.json 额外配置');
	assert.equal(typeHelpFor('minimax'), builtinProviders.minimax.description, '无 Codex.Note 时回退 Description');
	assert.equal(typeHelpFor('custom'), builtinProviders.custom.description, 'custom 展示契约 Description');
	const distinctTypeHelps = new Set(['glm', 'minimax', 'deepseek', 'custom'].map(typeHelpFor));
	assert.equal(distinctTypeHelps.size, 4, '四种可编辑类型的提示须各不相同（随类型变化，非静态文案）');
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
	// activateAfterSave 对所有表单类型都表示写入并激活该 profile。
	assert.match(fieldHelp('activateAfterSave'), /设为默认/, '真实 provider 激活提示须说明写入并设为默认');
	console.log('[PASS] Codex 侧字段提示齐备（类型提示随契约 Note 变化 / Responses 端点 / 密钥落盘位置）');

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
	assert.equal(
		/env_key\s*=|requires_openai_auth\s*=|\[model_providers\.deepseek\.auth\]/.test(toml),
		false,
		'认证字段互斥：不得含 env_key/auth/requires_openai_auth'
	);
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
		profile: {
			key: 'deepseek',
			providerType: 'apiKey',
			baseUrl: 'https://api.deepseek.com',
			model: 'deepseek-chat',
			hasApiKey: true,
			profilePath: ''
		},
		rawToml: toml
	});
	const editApiKeyField = editModel.fields.find(field => field.id === 'apiKey');
	assert.equal(editApiKeyField?.value, 'sk-secret-should-never-leak', 'edit 态 API Key 字段应回填 TOML 中的明文 token');
	assert.equal(editModel.values.apiKey, 'sk-secret-should-never-leak', 'edit 态 values.apiKey 应为明文 token');
	// 无 rawToml（无法提取）时回退空串，不崩溃。
	const editNoToml = buildCodexProviderFormModel({
		mode: 'edit',
		providerType: 'custom',
		profile: {
			key: 'deepseek',
			providerType: 'apiKey',
			baseUrl: 'https://api.deepseek.com',
			model: 'deepseek-chat',
			hasApiKey: true,
			profilePath: ''
		}
	});
	assert.equal(editNoToml.values.apiKey, '', '无 rawToml 时 edit 态 apiKey 回退空串');
	console.log('[PASS] 5.5b Codex edit 态 secret 字段回填明文 token（对齐 Claude 编辑回显）');

	// ── parse error：不允许保存无效 TOML ────────────────────────────────────────
	const invalid = codexProviderValuesFromToml(apiValues, 'not = [valid');
	assert.equal(invalid.ok, false, '无效 TOML 应返回错误，不回填字段');
	console.log('[PASS] 5.5 无效 TOML 拒绝回填/保存');

	// official login 仍是列表中的只读虚拟身份，任何旧调用都不得重新打开表单写入路径。
	const rejectedOfficial = saveCodexProviderForm(
		{mode: 'edit', profileKey: 'official', providerType: 'officialLogin'},
		{...apiValues, providerType: 'officialLogin'}
	);
	assert.equal(rejectedOfficial.ok, false, 'official login 旧表单调用必须拒绝保存');
	assert.match(rejectedOfficial.ok ? '' : rejectedOfficial.error, /官方账号.*Codex 原生管理/, '拒绝原因必须指向 Codex 原生官方登录');
	console.log('[PASS] 5.7 Codex official login 不进入表单，仅由 Codex 原生登录管理');
} finally {
	rmSync(home, {recursive: true, force: true});
	delete process.env.CCQ_HOME;
	delete process.env.CODEX_HOME;
}
