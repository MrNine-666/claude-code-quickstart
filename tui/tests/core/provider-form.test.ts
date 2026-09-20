import {describe, expect, test} from 'bun:test';

import type {FormField} from '../../src/components/form/field-types.js';
import {
	buildProviderFormModel,
	type ProviderFormModel,
	type ProviderFormValues,
	toProviderSavePayload,
	validateProviderForm
} from '../../src/core/provider-form.js';
import {loadProviderContract} from '../../src/core/provider-contract.js';

// 迁自 scripts/verify-provider-form.mjs 的纯校验/纯解析段（试点批 implement Step 3）。
// 真实落盘与回读字节断言仍留在 scripts/verify-provider-form.mjs（见附录 A）。

const MODEL_KEYS = ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL'];
const contract = loadProviderContract();

function builtinProvider(key: string) {
	const provider = contract.builtinProviders[key];
	if (!provider) throw new Error(`missing builtin provider in contract: ${key}`);
	return provider;
}

function fieldById(model: ProviderFormModel, id: string): FormField {
	const field = model.fields.find(candidate => candidate.id === id);
	if (!field) throw new Error(`missing form field: ${id}`);
	return field;
}

function helpTextOf(model: ProviderFormModel, id: string): string {
	const help = fieldById(model, id).helpText;
	if (help === undefined) throw new Error(`missing helpText for field: ${id}`);
	return help;
}

function formValues(overrides: Partial<ProviderFormValues> = {}): ProviderFormValues {
	return {
		profileKey: '',
		baseUrl: 'https://x',
		apiKey: 'sk-x',
		modelEnv: {},
		env: {},
		activateAfterSave: false,
		...overrides
	};
}

describe('validateProviderForm file name rules', () => {
	test('accepts a legal english file name in add mode', () => {
		expect(validateProviderForm('add-builtin', formValues({profileKey: 'my-zhipu'}))).toEqual([]);
	});

	test('rejects traversal-style file names and empty file names', () => {
		const badName = validateProviderForm('add-custom', formValues({profileKey: '../evil', baseUrl: 'https://api.x/anthropic'}));
		expect(badName.some(error => /英文文件名/.test(error))).toBe(true);

		const emptyName = validateProviderForm('add-builtin', formValues({profileKey: ''}));
		expect(emptyName.some(error => /文件名不能为空/.test(error))).toBe(true);
	});

	test('exempts the readonly file name in edit mode', () => {
		expect(validateProviderForm('edit', formValues({profileKey: ''}))).toEqual([]);
	});
});

describe('toProviderSavePayload env JSON parsing', () => {
	test('keeps the user file name and drops empty env entries', () => {
		const payload = toProviderSavePayload(
			{mode: 'add-custom'},
			formValues({
				profileKey: 'my-custom',
				baseUrl: 'https://api.custom.test/anthropic',
				apiKey: 'sk-custom-xxxxxxxx',
				env: {FOO: 'bar', EMPTY_VAL: '', '': 'orphan-key', API_TIMEOUT_MS: '3000000'}
			})
		);
		expect(payload.action).toBe('add');
		if (payload.action !== 'add') throw new Error('expected an add payload');
		expect(payload.profileKey).toBe('my-custom');
		expect(payload.env).toEqual({FOO: 'bar', API_TIMEOUT_MS: '3000000'});
	});
});

describe('buildProviderFormModel builtin template structure', () => {
	const builtinForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'deepseek'});

	test('does not prefill managed models and exposes the expected editable fields', () => {
		expect(builtinForm.mode).toBe('add-builtin');
		expect(builtinForm.values.modelEnv).toEqual({});
		expect(Array.isArray(builtinForm.fields)).toBe(true);
		expect(builtinForm.fields[0]?.id).toBe('providerType');
		expect(builtinForm.fields[0]?.type).toBe('radio');
		expect(fieldById(builtinForm, 'profileKey').type).toBe('text');
		expect(fieldById(builtinForm, 'apiKey')).toBeDefined();
	});

	test('places API Key right after Base URL for both add and edit forms', () => {
		const baseIndex = builtinForm.fields.findIndex(field => field.id === 'baseUrl');
		expect(builtinForm.fields[baseIndex + 1]?.id).toBe('apiKey');

		const claudeEditFields = buildProviderFormModel({
			mode: 'edit',
			profileKey: 'deepseek',
			profile: {
				env: {
					ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
					ANTHROPIC_AUTH_TOKEN: 'sk-edit'
				}
			}
		}).fields;
		const editBaseIndex = claudeEditFields.findIndex(field => field.id === 'baseUrl');
		expect(claudeEditFields[editBaseIndex + 1]?.id).toBe('apiKey');
	});

	test('maps the three managed model keys to model-select fields', () => {
		for (const id of MODEL_KEYS) {
			expect(fieldById(builtinForm, id).type).toBe('model-select');
		}
	});

	test('keeps env in values instead of rendering it as a field and prefills template ExtraEnv', () => {
		expect(builtinForm.fields.find(field => field.id === 'env')).toBeUndefined();
		expect(typeof builtinForm.values.env).toBe('object');
		expect(builtinForm.values.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('786432');
		expect('ANTHROPIC_MODEL' in builtinForm.values.env).toBe(false);
		expect('API_TIMEOUT_MS' in builtinForm.values.env).toBe(false);
	});

	test('Kimi 1M and 256K templates share the endpoint but keep their own window and file name', () => {
		const kimi1m = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'moonshot'}).values;
		const kimi256k = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'moonshot-256k'}).values;
		expect(kimi1m.baseUrl).toBe(kimi256k.baseUrl);
		// 窗口值必须与模型档位一致：调小会过早压缩丢上下文，调大会触发上下文超限报错。
		expect(kimi1m.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
		expect(kimi1m.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1048576');
		expect(kimi256k.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('262144');
		expect(kimi256k.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('262144');
		expect(kimi1m.profileKey).toBe('moonshot');
		expect(kimi256k.profileKey).toBe('moonshot-256k');

		for (const key of ['glm', 'deepseek', 'moonshot', 'moonshot-256k', 'minimax']) {
			expect(buildProviderFormModel({mode: 'add-builtin', builtinKey: key}).values.modelEnv).toEqual({});
		}
	});
});

describe('providerType options derive from the contract', () => {
	const builtinForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'deepseek'});
	const contractKeys = Object.keys(contract.builtinProviders);

	test('keeps contract order and labels without hardcoding', () => {
		expect(contractKeys).toEqual(['glm', 'deepseek', 'moonshot', 'moonshot-256k', 'minimax', 'custom']);
		const typeField = fieldById(builtinForm, 'providerType');
		expect(typeField.type).toBe('radio');
		if (typeField.type !== 'radio') throw new Error('providerType must be a radio field');
		expect(typeField.options.map(option => option.value)).toEqual(contractKeys);
		for (const option of typeField.options) {
			expect(option.label).toBe(builtinProvider(option.value).name);
		}
	});

	test('keeps custom as an empty placeholder at the end of the contract', () => {
		expect(contractKeys[contractKeys.length - 1]).toBe('custom');
		expect(builtinProvider('custom').baseUrl).toBe('');
		expect(builtinProvider('custom').modelEnv).toBeUndefined();

		const customForm = buildProviderFormModel({mode: 'add-custom'}).values;
		expect(customForm.providerType).toBe('custom');
		expect(customForm.baseUrl).toBe('');
		expect(customForm.profileKey).toBe('');
		expect(customForm.modelEnv).toEqual({});
		expect(customForm.env).toEqual({});
	});
});

describe('field helpText has no gaps', () => {
	const kimiForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'moonshot'});

	test('every visible field carries a helpText', () => {
		for (const field of kimiForm.fields) {
			expect(field.helpText && field.helpText.trim().length > 0).toBe(true);
		}
	});

	test('file name help explains the conflict and no longer promises an auto suffix', () => {
		const profileKeyHelp = helpTextOf(kimiForm, 'profileKey');
		expect(profileKeyHelp).toMatch(/同名.*拒绝|已存在.*更换文件名/);
		expect(profileKeyHelp).not.toMatch(/自动.*后缀/);
	});

	test('providerType helpText takes the contract Note and falls back to Description', () => {
		const moonshotNote = builtinProvider('moonshot').note;
		if (!moonshotNote) throw new Error('moonshot must declare a contract Note');
		expect(helpTextOf(kimiForm, 'providerType')).toBe(moonshotNote);
		expect(helpTextOf(buildProviderFormModel({mode: 'add-custom'}), 'providerType')).toBe(builtinProvider('custom').description);
	});

	test('apiKey helpText inlines the contract PlatformUrl', () => {
		expect(helpTextOf(kimiForm, 'apiKey').includes(builtinProvider('moonshot').platformUrl)).toBe(true);
	});

	test('each managed model key names its own alias and they stay distinct', () => {
		for (const key of MODEL_KEYS) {
			const alias = key.replace('ANTHROPIC_DEFAULT_', '').replace('_MODEL', '').toLowerCase();
			expect(helpTextOf(kimiForm, key).includes(alias)).toBe(true);
		}
		const modelHelps = MODEL_KEYS.map(key => helpTextOf(kimiForm, key));
		expect(new Set(modelHelps).size).toBe(MODEL_KEYS.length);
	});

	test('Claude-side and Codex-side notes stay independent', () => {
		expect(builtinProvider('deepseek').note).not.toBe(builtinProvider('deepseek').codex?.note);
	});
});

// P5e 去重补迁：verify-core-functions.mjs 的 provider 表单纯段（原 6 条中的 5 条缺口，
// 其余 1 条 modelEnv 已由本文件既有用例覆盖）。补齐后 verify 侧该段整体删除。
describe('P5e 补迁：GLM 模板 baseUrl / 空值校验 / edit 载荷', () => {
	test('GLM 内置模板 baseUrl 取自契约，空 API Key 与空 baseUrl 报错，edit 载荷保留 key', () => {
		const glmForm = buildProviderFormModel({mode: 'add-builtin', builtinKey: 'glm'});
		expect(glmForm.values.baseUrl, 'GLM 内置模板 baseUrl 取自契约').toBe('https://open.bigmodel.cn/api/anthropic');
		expect(glmForm.values.modelEnv, 'GLM 内置模板不预填模型').toEqual({});
		expect(validateProviderForm('add-builtin', {...glmForm.values, apiKey: ''}), 'API Key 为空必须拒绝').toEqual(['API Key 不能为空']);

		const customForm = buildProviderFormModel({mode: 'add-custom'});
		expect(validateProviderForm('add-custom', customForm.values).length > 0, 'custom 空 baseUrl 应报错').toBe(true);

		const editPayload = toProviderSavePayload({mode: 'edit', profileKey: 'glm'}, {...glmForm.values, apiKey: 'sk-test'});
		expect(editPayload.action, 'edit 模式载荷 action 为 edit').toBe('edit');
		if (editPayload.action !== 'edit') throw new Error('期望 edit 载荷');
		expect(editPayload.key, 'edit 模式载荷保留 profileKey').toBe('glm');
	});
});
