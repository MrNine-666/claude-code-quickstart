import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import type {BundlePayload, BundleSection} from '../../src/core/config-transfer.js';
import {applyConfigTransferImport, planConfigTransferExport, planConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {piAuthJsonPath, piModelsJsonPath, piSettingsPath} from '../../src/core/paths.js';
import {createTempHome} from '../helpers/temp-home.js';

let home: ReturnType<typeof createTempHome>;

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function payload(sections: readonly BundleSection[]): BundlePayload {
	return {
		createdAt: '2026-10-19T00:00:00.000Z',
		createdBy: {name: 'ccq', version: 'test', platform: 'test'},
		containsCredentials: true,
		sections
	};
}

async function planAndApply(sections: readonly BundleSection[]) {
	const bundle = payload(sections);
	const plan = await planConfigTransferImport(bundle);
	if (!plan.ok) throw new Error(plan.error);
	const outcome = await applyConfigTransferImport(bundle, plan.data);
	if (!outcome.ok) throw new Error(outcome.error);
	return {plan: plan.data, outcome: outcome.data};
}

const PROVIDERS: BundleSection = {
	tool: 'pi',
	category: 'providers',
	data: {
		models: {'my-api': {baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{id: 'm1'}]}},
		auth: {'my-api': {type: 'api_key', key: 'sk-new'}}
	}
};

beforeEach(() => {
	home = createTempHome('ccq-transfer-pi-');
});

afterEach(() => {
	home.restore();
	home.cleanup();
});

describe('Pi 通用设置迁移模型选择', () => {
	test('defaultModel/defaultThinkingLevel/modelThinkingLevels/enabledModels 随设置导出并导入', async () => {
		const selection = {
			defaultProvider: 'my-api',
			defaultModel: 'm1',
			defaultThinkingLevel: 'high',
			modelThinkingLevels: {'my-api/m1': 'max'},
			enabledModels: ['my-api/m1']
		};
		writeJson(piSettingsPath(), {...selection, deviceId: 'source-device', packages: ['npm:x']});
		const exported = await planConfigTransferExport({categories: [{tool: 'pi', category: 'settings'}], includeCredentials: true});
		if (!exported.ok) throw new Error(exported.error);

		writeJson(piSettingsPath(), {deviceId: 'target-device', modelThinkingLevels: {'local/x': 'low'}});
		const {outcome} = await planAndApply(exported.data.sections);
		expect(outcome.status).toBe('complete');
		expect(readJson(piSettingsPath())).toEqual({
			...selection,
			deviceId: 'target-device',
			modelThinkingLevels: {'local/x': 'low', 'my-api/m1': 'max'}
		});
	});

	test('包内模型选择字段类型无效时拒绝导入', async () => {
		const {outcome} = await planAndApply([
			{tool: 'pi', category: 'settings', data: {text: JSON.stringify({enabledModels: 'my-api/m1'})}}
		]);
		expect(outcome.status).toBe('failed');
		expect(outcome.blocked[0]?.reason).toContain('模型选择');
	});
});

describe('Pi 供应商导入只校验本次写入条目', () => {
	test('目标 models.json 为 {}、auth.json 含旧字符串格式与无关无效条目时仍可导入且原样保留', async () => {
		writeJson(piModelsJsonPath(), {});
		writeJson(piAuthJsonPath(), {legacy: 'sk-legacy', future: {type: 'future-auth'}});
		const {outcome} = await planAndApply([PROVIDERS]);
		expect(outcome.status).toBe('complete');
		expect(readJson(piModelsJsonPath()).providers['my-api'].baseUrl).toBe('https://example.test/v1');
		expect(readJson(piAuthJsonPath())).toEqual({
			legacy: 'sk-legacy',
			future: {type: 'future-auth'},
			'my-api': {type: 'api_key', key: 'sk-new'}
		});
	});

	test('同 id 的本机旧字符串凭据被替换为对象格式', async () => {
		writeJson(piAuthJsonPath(), {'my-api': 'sk-old'});
		const {outcome} = await planAndApply([PROVIDERS]);
		expect(outcome.status).toBe('complete');
		expect(readJson(piAuthJsonPath())['my-api']).toEqual({type: 'api_key', key: 'sk-new'});
	});

	test('导出时单个无效定义只跳过自身', async () => {
		writeJson(piModelsJsonPath(), {providers: {ok: {baseUrl: 'https://ok.test', models: [{id: 'a'}]}, bad: {baseUrl: 42}}});
		const exported = await planConfigTransferExport({categories: [{tool: 'pi', category: 'providers'}], includeCredentials: true});
		if (!exported.ok) throw new Error(exported.error);
		expect(Object.keys((exported.data.sections[0]!.data as {models: object}).models)).toEqual(['ok']);
	});
});

describe('导入结果状态', () => {
	test('预览阻断的分类使结果不再报 complete，并带回原因', async () => {
		writeJson(piModelsJsonPath(), {providers: []});
		const {outcome} = await planAndApply([PROVIDERS, {tool: 'pi', category: 'rules', data: {entries: []}}]);
		expect(outcome.status).toBe('partial');
		expect(outcome.blocked).toEqual([{tool: 'pi', category: 'providers', reason: expect.stringContaining('providers')}]);
		expect(outcome.completed).toEqual([{tool: 'pi', category: 'rules'}]);
	});
});
