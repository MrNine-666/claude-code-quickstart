import {describe, expect, test} from 'bun:test';

import {PI_APIS, buildPiProviderFormModel, loadPiProviderRegistry, validatePiProviderForm} from '../../src/core/pi-provider.js';
import {mergePiProviderModels, piProviderFormAdapter, replacePiProviderModels} from '../../src/services/pi-provider-service.js';

// 迁自 scripts/verify-pi-provider-templates.mjs 的进程内纯断言（15 条）：registry OAuth 元数据、
// Pi Provider 表单模型（字段集 / api 单选 / 不写 defaultProvider）、模型列表合并去重、
// validatePiProviderForm。保留在 verify 的是真实 ~/.pi/agent/auth.json 字节与 display 投影断言。
// 主题对账见 .trellis/tasks/09-20-p5-platform-carrier-migration/research-reconciliation-P5c.md。

const form = buildPiProviderFormModel({mode: 'add'});

describe('Pi Provider registry', () => {
	test('暴露 openai-codex / xai 的 OAuth 元数据', () => {
		const registry = loadPiProviderRegistry();
		expect(registry.some(provider => provider.providerId === 'openai-codex' && provider.oauth)).toBe(true);
		expect(registry.some(provider => provider.providerId === 'xai' && provider.oauth)).toBe(true);
	});
});

describe('Pi Provider 表单模型', () => {
	test('字段集：请求头 textarea / 无 Provider 类型 / 无 models 字段 / 无 activateAfterSave', () => {
		expect(piProviderFormAdapter.showTextEditor, 'Pi 表单的 textarea 承载请求头 JSON').toBe(true);
		expect(piProviderFormAdapter.textLabel, 'Pi textarea 标签为请求头').toBe('请求头');
		expect(form.values.providerType).toBe('custom-api-key');
		expect(
			form.fields.some(field => field.id === 'providerType'),
			'Pi 表单不展示无用的 Provider 类型'
		).toBe(false);
		expect(form.fields.find(field => field.id === 'provider')?.type).toBe('text');
		expect(
			form.fields.some(field => field.id === 'models'),
			'模型列表由表单内嵌控件拥有，不再占用只读字段值列'
		).toBe(false);
		expect(form.fields.find(field => field.id === 'headerPreset')?.type, '请求头预设动作行恒出现（复用 radio 渲染）').toBe('radio');
		expect(
			form.fields.some(field => field.id === 'headers'),
			'请求头不再有独立的单行输入字段（编辑区是唯一真相源）'
		).toBe(false);
		expect(form.fields.find(field => field.id === 'api')?.type).toBe('radio');
		expect(
			form.fields.some(field => field.id === 'apiKey'),
			'API Key 必须保留在模型列表区域之前'
		).toBe(true);
		expect(
			form.fields.some(field => field.id === 'activateAfterSave'),
			'Pi Provider 表单不得提供保存后激活或 defaultProvider 写入'
		).toBe(false);
		const apiField = form.fields.find(field => field.id === 'api') as
			| {readonly type: string; readonly options?: readonly {readonly value: string}[]}
			| undefined;
		expect(apiField?.type === 'radio' ? apiField.options?.map(option => option.value) : []).toEqual([...PI_APIS]);
	});

	test('模型列表合并去重与勾选移除', () => {
		expect(
			mergePiProviderModels({...form.values, models: 'existing-model'}, ['manual-model', 'existing-model']).models.split('\n'),
			'手工添加的模型应进入模型列表并保持去重'
		).toEqual(['existing-model', 'manual-model']);
		expect(
			replacePiProviderModels({...form.values, models: 'existing-model\nremoved-model'}, ['existing-model']).models.split('\n'),
			'模型列表勾选结果应允许移除未选中的模型'
		).toEqual(['existing-model']);
	});

	test('validatePiProviderForm 接受完整表单并拒绝缺字段', () => {
		expect(
			validatePiProviderForm('add', {
				...form.values,
				provider: 'custom',
				baseUrl: 'https://api.example/v1',
				models: 'model-a',
				apiKey: 'secret'
			}).length
		).toBe(0);
		expect(validatePiProviderForm('add', {...form.values, provider: '', models: '', apiKey: ''}).length > 0).toBe(true);
	});
});
