import {expect, test} from 'bun:test';

import {
	buildCodexProviderFormModel,
	codexProviderValuesFromToml,
	codexProviderValuesToToml,
	validateCodexProviderForm
} from '../../src/core/codex-provider-form.js';
import {loadProviderContract} from '../../src/core/provider-contract.js';
import {codexProviderFormAdapter, saveCodexProviderForm} from '../../src/services/codex-service.js';

// P5b 迁移自 scripts/verify-codex-provider-form.mjs 的**全部 79 条静态断言**（脚本已迁空删除）。
// 判据：原脚本的临时 HOME 目录只用于环境隔离，无任何断言依赖真实落盘字节——
//   - buildCodexProviderFormModel / codexProviderValuesToToml / codexProviderValuesFromToml /
//     validateCodexProviderForm 全为纯函数；
//   - saveCodexProviderForm 的 officialLogin 拒绝路径在 validateCodexProviderForm 即返回，
//     早于任何 fs 写入（见 src/services/codex-service.ts:146-150）；
//   - loadProviderContract 读取的是 contracts/providers.json 静态源数据（只读，非 mock）。
// 载体对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5b.md §1。

const CONTRACT_CODEX_KEYS = Object.entries(loadProviderContract().builtinProviders)
	.filter(([, provider]) => provider.codex)
	.map(([key]) => key);

function optionsOf(model: ReturnType<typeof buildCodexProviderFormModel>) {
	const field = model.fields.find(candidate => candidate.id === 'providerType');
	if (field?.type !== 'radio') throw new Error('providerType must be a radio field');
	return field.options;
}

test('5.4 Codex provider 类型：仅 API-key 供应商 + custom，无 official login / OpenAI-compatible', () => {
	const add = buildCodexProviderFormModel({mode: 'add'});
	const providerTypeField = add.fields.find(field => field.id === 'providerType');
	expect(providerTypeField?.type, '新增表单首字段为 providerType radio').toBe('radio');
	const options = optionsOf(add);
	expect(
		options.map(option => option.value),
		'Codex 表单供应商类型仅含 Codex 原生可接入的智谱 GLM/MiniMax/DeepSeek 与自定义'
	).toEqual(['glm', 'deepseek', 'minimax', 'custom']);
	expect(
		options.some(option => option.value === 'officialLogin'),
		'Codex 表单不得提供 official login 类型'
	).toBe(false);
	expect(
		options.some(option => option.value === 'glm' && /GLM/.test(option.label)),
		'Codex 内置智谱 GLM（GLM-5.3 支持 Responses）'
	).toBe(true);
	expect(
		options.some(option => option.value === 'minimax' && /MiniMax/.test(option.label)),
		'Codex 保留 MiniMax 内置类型'
	).toBe(true);
	expect(
		options.some(option => option.value === 'custom'),
		'Codex 保留自定义供应商类型'
	).toBe(true);
	expect(options.at(-1)?.value, 'custom 恒定排在选项末位（结构性条目，非契约 Codex 段派生）').toBe('custom');
	expect(
		options.some(option => /OpenAI-compatible/i.test(option.label)),
		'不得新增 OpenAI-compatible 标签'
	).toBe(false);
	expect(
		options.some(option => option.value === 'bailian'),
		'Codex 不再提供阿里云百炼类型'
	).toBe(false);
	expect(
		options.some(option => option.value === 'deepseek' && /DeepSeek/.test(option.label)),
		'Codex 内置 DeepSeek（V4 起原生 Responses）'
	).toBe(true);
	// Kimi 仍仅 Chat Completions，Codex 只认 Responses，直连不可用，故不内置一键模板。
	expect(
		options.some(option => ['moonshot', 'moonshot-256k'].includes(option.value)),
		'Codex 不内置仅 Chat Completions 的 Kimi'
	).toBe(false);
	expect(
		add.fields.some(field => field.id === 'codexProfileToml'),
		'表单字段区不得展示写死 TOML readonly 字段'
	).toBe(false);
	expect(add.values.providerType, 'Codex 新增表单默认使用 API-key custom 类型').toBe('custom');
	expect(
		add.fields.some(field => field.id === 'baseUrl'),
		'Codex 新增表单默认展示 Base URL'
	).toBe(true);
	expect(
		add.fields.some(field => field.id === 'authJson'),
		'Codex 表单不得展示 auth.json 编辑/预览字段'
	).toBe(false);
	// 文件名文案在真实供应商类型下校验。
	const customAdd = buildCodexProviderFormModel({mode: 'add', providerType: 'custom'});
	expect(customAdd.fields.find(field => field.id === 'profileKey')?.label, 'profile key 文案应面向用户显示为文件名').toBe('文件名');
	expect(
		() => buildCodexProviderFormModel({mode: 'add', providerType: 'officialLogin'}),
		'Codex 表单即使被外部传入 official login 也必须拒绝构造'
	).toThrow(/官方账号.*Codex 原生管理/);
});

test('Codex 内置供应商模板预填官方 Responses 兼容 base_url（智谱 GLM + MiniMax + DeepSeek）', () => {
	const codexGlm = buildCodexProviderFormModel({mode: 'add', providerType: 'glm'}).values;
	expect(codexGlm.profileKey).toBe('glm');
	expect(codexGlm.baseUrl).toBe('https://open.bigmodel.cn/api/v1');
	expect(codexGlm.model, 'GLM Codex 模板不预填模型').toBe('');
	expect(codexGlm.toml, '智谱 Responses base_url 写入 TOML').toMatch(/base_url\s*=\s*"https:\/\/open\.bigmodel\.cn\/api\/v1"/);
	expect(codexGlm.toml, '智谱模板省略 Codex 默认 wire_api').not.toMatch(/wire_api\s*=/);

	const minimax = buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).values;
	expect(minimax.profileKey).toBe('minimax');
	expect(minimax.baseUrl).toBe('https://api.minimax.io/v1');
	expect(minimax.model, 'MiniMax Codex 模板不预填模型').toBe('');

	const codexDeepseek = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).values;
	expect(codexDeepseek.profileKey).toBe('deepseek');
	expect(codexDeepseek.baseUrl).toBe('https://api.deepseek.com/');
	// Responses 端点为根域（非 /anthropic），模型留空由用户选择。
	expect(codexDeepseek.model, 'DeepSeek Codex 模板不预填模型').toBe('');
	expect(codexDeepseek.toml, 'base_url 落盘去尾斜杠').toMatch(/base_url\s*=\s*"https:\/\/api\.deepseek\.com"/);
});

test('Codex 模板唯一事实源为 providers.json Codex 段（与 Claude 侧统一管理）', () => {
	const {builtinProviders} = loadProviderContract();
	const options = optionsOf(buildCodexProviderFormModel({mode: 'add'}));
	// 类型选项集 = 声明 Codex 段的内置供应商（排除 custom 占位条目），顺序随契约。
	// 一键模板集 = 契约中声明 Codex 段的条目；officialLogin / custom 是结构性条目，不由契约声明可用性。
	expect(
		options.map(option => option.value).filter(value => value !== 'officialLogin' && value !== 'custom'),
		'Codex 一键模板集必须由契约 Codex 段派生，不得在代码里另立清单'
	).toEqual(CONTRACT_CODEX_KEYS);
	expect(builtinProviders.custom?.codex, 'custom 不是供应商，不得声明 Codex 段（其可用性与 Responses 支持无关）').toBeUndefined();
	// 每项 label 与模板值逐字取自契约，避免代码与契约双份维护漂移。
	for (const key of CONTRACT_CODEX_KEYS) {
		const {codex, name} = builtinProviders[key]!;
		expect(options.find(option => option.value === key)?.label, `${key} label 取自契约 Name`).toBe(name);
		const values = buildCodexProviderFormModel({mode: 'add', providerType: key}).values;
		expect(values.baseUrl, `${key} baseUrl 取自契约`).toBe(codex!.baseUrl);
		expect(values.model, `${key} model 取自契约`).toBe(codex!.model);
		expect(values.profileKey, `${key} profileKey 默认取契约 key`).toBe(key);
	}
	// cc/cx 两侧自定义供应商文案必须同源同值（契约 custom.Name 为唯一事实源）。
	expect(options.find(option => option.value === 'custom')?.label, 'Codex 侧 custom label 须取契约 custom.Name，与 Claude 侧同文案').toBe(
		builtinProviders.custom!.name
	);
	// custom 选中后不预填任何字段：profileKey 留空强制命名，避免多个自定义供应商落到同一文件。
	const customValues = buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values;
	expect(customValues.baseUrl, 'custom 不预填 baseUrl').toBe('');
	expect(customValues.model, 'custom 不预填 model').toBe('');
	expect(customValues.profileKey, 'custom profileKey 须留空强制用户命名').toBe('');
	// Codex 侧端点与 Claude 侧不同源：Responses 端点常与 Anthropic 兼容端点不一致，不得复用同一字段。
	expect(builtinProviders.glm!.codex!.baseUrl, '智谱 Codex baseUrl 独立于 Claude 侧 BaseUrl').not.toBe(builtinProviders.glm!.baseUrl);
	expect(builtinProviders.deepseek!.codex!.baseUrl, 'Codex baseUrl 独立于 Claude 侧 BaseUrl').not.toBe(
		builtinProviders.deepseek!.baseUrl
	);
	// 仅暴露 Chat Completions 的供应商不得有 Codex 段（直连 Codex 会 404/空流）。
	for (const key of ['moonshot', 'moonshot-256k']) {
		expect(builtinProviders[key]?.codex, `${key} 仅 Chat Completions，不得声明 Codex 段`).toBeUndefined();
	}
});

test('Codex 侧字段提示齐备（类型提示随契约 Note 变化 / Responses 端点 / 密钥落盘位置）', () => {
	const {builtinProviders} = loadProviderContract();
	for (const type of ['glm', 'minimax', 'deepseek', 'custom']) {
		for (const field of buildCodexProviderFormModel({mode: 'add', providerType: type}).fields) {
			expect(Boolean(field.helpText?.trim()), `add/${type} 的 ${field.id} 须有 helpText`).toBe(true);
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
	expect(editFields[editFields.findIndex(field => field.id === 'baseUrl') + 1]?.id, 'Codex 编辑表单 API Key 必须紧跟 Base URL').toBe(
		'apiKey'
	);
	for (const field of editFields) {
		expect(Boolean(field.helpText?.trim()), `edit 态的 ${field.id} 须有 helpText`).toBe(true);
	}
	const cxFields = buildCodexProviderFormModel({mode: 'add', providerType: 'deepseek'}).fields;
	expect(cxFields[cxFields.findIndex(field => field.id === 'baseUrl') + 1]?.id, 'Codex 表单 API Key 必须紧跟 Base URL').toBe('apiKey');
	expect(cxFields.find(field => field.id === 'model')?.type, 'Codex 默认模型必须使用模型单选字段').toBe('model-select');
	expect(
		buildCodexProviderFormModel({mode: 'add'}).fields.some(field => field.type === 'model-select'),
		'Codex 默认 API-key 表单应挂载模型发现字段'
	).toBe(true);
	const fieldHelp = (id: string) => cxFields.find(field => field.id === id)?.helpText ?? '';
	// baseUrl 提示须点明 Responses（与 Claude 侧 Anthropic 兼容端点不同源，是最常见误填点）。
	expect(fieldHelp('baseUrl'), 'baseUrl 提示须点明 Responses 端点').toMatch(/Responses/);
	// providerType 提示随类型变化（与 Claude 侧同构）：Codex.Note → Description。
	const typeHelpFor = (type: string) =>
		buildCodexProviderFormModel({mode: 'add', providerType: type}).fields.find(field => field.id === 'providerType')?.helpText ?? '';
	expect(typeHelpFor('glm'), '智谱展示契约 Codex.Note').toBe(builtinProviders.glm!.codex!.note!);
	expect(typeHelpFor('glm'), '智谱 Codex.Note 须说明 Responses 支持').toMatch(/Responses/);
	expect(typeHelpFor('deepseek'), '有 Codex.Note 的供应商展示该 Note').toBe(builtinProviders.deepseek!.codex!.note!);
	expect(typeHelpFor('deepseek'), 'DeepSeek 不得提示未明确要求的 models.json 额外配置').not.toMatch(/models\.json/);
	expect(typeHelpFor('minimax'), '无 Codex.Note 时回退 Description').toBe(builtinProviders.minimax!.description);
	expect(typeHelpFor('custom'), 'custom 展示契约 Description').toBe(builtinProviders.custom!.description);
	const distinctTypeHelps = new Set(['glm', 'minimax', 'deepseek', 'custom'].map(typeHelpFor));
	expect(distinctTypeHelps.size, '四种可编辑类型的提示须各不相同（随类型变化，非静态文案）').toBe(4);
	// 刻意不回退顶层 Note：那是 Claude 侧的接入限制（套餐档位等），串到 Codex 侧会误导。
	expect(
		typeHelpFor('deepseek').includes(builtinProviders.deepseek!.note!),
		'Codex 侧 providerType 提示不得串入 Claude 侧顶层 Note'
	).toBe(false);
	// model 提示只说字段自身语义，供应商级限制已归 providerType，不得重复出现同段文案。
	expect(fieldHelp('model'), 'model 提示须说明字段语义').toMatch(/model 键/);
	expect(fieldHelp('model').includes(builtinProviders.deepseek!.codex!.note!), 'Codex.Note 已归 providerType，model 不得重复').toBe(
		false
	);
	expect(fieldHelp('model'), 'model 提示与供应商无关，各类型应一致').toBe(
		buildCodexProviderFormModel({mode: 'add', providerType: 'minimax'}).fields.find(field => field.id === 'model')?.helpText ?? ''
	);
	// apiKey 提示须含契约 PlatformUrl，并点明 Codex 侧密钥明文落 TOML（与 Claude 侧 vault 语义不同）。
	expect(fieldHelp('apiKey').includes(builtinProviders.deepseek!.platformUrl!), 'apiKey 提示须含契约 PlatformUrl').toBe(true);
	expect(fieldHelp('apiKey'), 'apiKey 提示须点明写入 experimental_bearer_token').toMatch(/experimental_bearer_token/);
	// activateAfterSave 对所有表单类型都表示写入并激活该 profile。
	expect(fieldHelp('activateAfterSave'), '真实 provider 激活提示须说明写入并设为默认').toMatch(/设为默认/);
});

test('5.5/5.6 Codex provider 字段 + TOML 双向同步与 API key 策略', () => {
	const apiValues = {
		...buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values,
		profileKey: 'deepseek',
		providerType: 'custom',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: 'sk-secret-should-never-leak'
	};
	expect(validateCodexProviderForm('add', apiValues), 'API-key provider 字段应通过校验').toEqual([]);
	const toml = codexProviderValuesToToml(apiValues);
	expect(toml, '字段变更生成 TOML model_provider').toMatch(/model_provider\s*=\s*"deepseek"/);
	expect(toml, 'Base URL 规范化后写 TOML').toMatch(/base_url\s*=\s*"https:\/\/api\.deepseek\.com"/);
	expect(toml, 'API key 写 experimental_bearer_token').toMatch(/experimental_bearer_token\s*=\s*"sk-secret-should-never-leak"/);
	expect(
		/env_key\s*=|requires_openai_auth\s*=|\[model_providers\.deepseek\.auth\]/.test(toml),
		'认证字段互斥：不得含 env_key/auth/requires_openai_auth'
	).toBe(false);
	expect(codexProviderFormAdapter.isTextReadOnly?.(apiValues), 'API-key provider TOML textarea 应可编辑').toBe(false);
	const parsed = codexProviderValuesFromToml(apiValues, toml);
	expect(parsed.ok, 'TOML textarea 可解析回字段').toBe(true);
	if (parsed.ok) {
		expect(parsed.values.baseUrl).toBe('https://api.deepseek.com');
		expect(parsed.values.model).toBe('deepseek-chat');
		expect(parsed.values.providerType).toBe('custom');
	}
});

test('5.5b Codex edit 态 secret 字段回填明文 token（对齐 Claude 编辑回显）', () => {
	const apiValues = {
		...buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values,
		profileKey: 'deepseek',
		providerType: 'custom',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: 'sk-secret-should-never-leak'
	};
	const toml = codexProviderValuesToToml(apiValues);
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
	expect(editApiKeyField?.type === 'secret' ? editApiKeyField.value : undefined, 'edit 态 API Key 字段应回填 TOML 中的明文 token').toBe(
		'sk-secret-should-never-leak'
	);
	expect(editModel.values.apiKey, 'edit 态 values.apiKey 应为明文 token').toBe('sk-secret-should-never-leak');
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
	expect(editNoToml.values.apiKey, '无 rawToml 时 edit 态 apiKey 回退空串').toBe('');
});

test('5.5 无效 TOML 拒绝回填/保存', () => {
	const apiValues = {
		...buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values,
		profileKey: 'deepseek',
		providerType: 'custom',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: 'sk-secret-should-never-leak'
	};
	const invalid = codexProviderValuesFromToml(apiValues, 'not = [valid');
	expect(invalid.ok, '无效 TOML 应返回错误，不回填字段').toBe(false);
});

test('5.7 Codex official login 不进入表单，仅由 Codex 原生登录管理', () => {
	const apiValues = {
		...buildCodexProviderFormModel({mode: 'add', providerType: 'custom'}).values,
		profileKey: 'deepseek',
		providerType: 'custom',
		baseUrl: 'https://api.deepseek.com/',
		model: 'deepseek-chat',
		apiKey: 'sk-secret-should-never-leak'
	};
	// official login 仍是列表中的只读虚拟身份，任何旧调用都不得重新打开表单写入路径。
	const rejectedOfficial = saveCodexProviderForm(
		{mode: 'edit', profileKey: 'official', providerType: 'officialLogin'},
		{...apiValues, providerType: 'officialLogin'}
	);
	expect(rejectedOfficial.ok, 'official login 旧表单调用必须拒绝保存').toBe(false);
	expect(rejectedOfficial.ok ? '' : rejectedOfficial.error, '拒绝原因必须指向 Codex 原生官方登录').toMatch(/官方账号.*Codex 原生管理/);
});
