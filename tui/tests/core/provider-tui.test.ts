import {describe, expect, test} from 'bun:test';

import {buildCodexForm, codexProviderFormAdapter} from '../../src/services/codex-service.js';

// 迁自 scripts/verify-provider-tui.mjs 的进程内纯断言（12 条）：Codex TOML 表单 adapter
// （buildText / parseText / recordToValues 定点更新与旧 table 清理）+ buildCodexForm 字段契约。
// 保留在 verify 的是真实 ~/.claude/settings.json 字段所有权、幂等性、CODEX_HOME 落盘与 config.toml 同步断言。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

const codexModel = buildCodexForm({mode: 'add', providerType: 'custom'});
const codexValues = {
	...codexModel.values,
	profileKey: 'deepseek',
	providerType: 'custom',
	baseUrl: 'https://api.deepseek.com',
	model: 'deepseek-chat',
	apiKey: 'sk-codex-secret-never-log',
	activateAfterSave: true
};

describe('Codex TOML 表单 adapter', () => {
	test('buildText 生成真实 TOML 且省略默认 wire_api', () => {
		const toml = codexProviderFormAdapter.buildText(codexValues);
		expect(toml, 'Codex adapter 生成真实 TOML').toMatch(/experimental_bearer_token\s*=\s*"sk-codex-secret-never-log"/);
		expect(toml, 'Codex adapter 省略默认 wire_api').not.toMatch(/wire_api\s*=/);
	});

	test('parseText 可从 TOML 回填字段', () => {
		const toml = codexProviderFormAdapter.buildText(codexValues);
		const parsed = codexProviderFormAdapter.parseText(codexValues, toml);
		expect(parsed.ok, 'Codex adapter 可从 TOML 回填字段').toBe(true);
	});

	test('recordToValues 定点更新字段并保留未知字段与既有 token', () => {
		const toml = codexProviderFormAdapter.buildText(codexValues);
		const preservedValues = codexProviderFormAdapter.recordToValues(
			{...codexProviderFormAdapter.valuesToRecord({...codexValues, toml}), model: 'deepseek-reasoner', apiKey: ''},
			{...codexValues, toml: `${toml}\napproval_policy = "on-request"\n`}
		);
		expect(preservedValues.toml, '字段变化且 API Key 留空时必须保留 textarea 既有 token').toMatch(
			/experimental_bearer_token\s*=\s*"sk-codex-secret-never-log"/
		);
		expect(preservedValues.toml, '字段变化必须保留 textarea 未知字段').toMatch(/approval_policy\s*=\s*"on-request"/);
		expect(preservedValues.toml, '字段变化应定点更新 model').toMatch(/model\s*=\s*"deepseek-reasoner"/);
	});

	test('profileKey 变化后旧 model_providers table 必须清除', () => {
		const keyStepValues = codexProviderFormAdapter.recordToValues(
			{...codexProviderFormAdapter.valuesToRecord(codexValues), profileKey: '12'},
			{...codexValues, toml: 'model_provider = "1"\n\n[model_providers.1]\nname = "1"\n'}
		);
		expect(/\[model_providers\.1\]/.test(keyStepValues.toml), '文件名变化后旧 model_providers.<旧key> table 必须清除').toBe(false);
		expect(keyStepValues.toml, '文件名变化后只保留当前 key 的 provider table').toMatch(/\[model_providers\.12\]/);
		expect(keyStepValues.toml, 'model_provider 应指向当前 key').toMatch(/model_provider\s*=\s*"12"/);
	});
});

describe('Codex 表单字段契约', () => {
	test('默认新增表单使用 custom 类型且不暴露 auth.json / official login', () => {
		const defaultCodexForm = buildCodexForm({mode: 'add'});
		expect(defaultCodexForm.values.providerType, 'Codex 默认新增表单使用 API-key custom 类型').toBe('custom');
		expect(
			defaultCodexForm.fields.some(field => field.id === 'authJson'),
			'Codex 表单不得暴露 auth.json 字段'
		).toBe(false);
		expect(() => buildCodexForm({mode: 'add', providerType: 'officialLogin'}), 'Codex 表单不得构造 official login 类型').toThrow(
			/官方账号.*Codex 原生管理/
		);
	});
});
