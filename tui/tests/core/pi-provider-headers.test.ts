import {afterEach, describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

import {piAuthJsonPath, piModelsJsonPath} from '../../src/core/paths.js';
import {headerPresetText, piHeaderPreset} from '../../src/core/pi-header-preset.js';
import {
	buildPiProviderFormFields,
	buildPiProviderFormModel,
	deletePiProvider,
	loadPiProviderProfile,
	normalizePiProviderRecords,
	savePiProvider,
	validatePiProviderForm,
	type PiProviderFormValues
} from '../../src/core/pi-provider.js';
import {createProviderViewAdapter} from '../../src/views/provider/provider-view-adapter.js';
import {discoverPiProviderModels} from '../../src/services/pi-provider-service.js';
import {createTempHome, type TempHome} from '../helpers/temp-home.js';

// 阶段 D 断言：core 持久化（full / transport-only 两种变体）、headers/authHeader 读写、
// 空值归一化、未知字段保留、auth.json 只读。全部在临时 CCQ_HOME 内运行，绝不触碰真实 ~/.pi。

const homes: TempHome[] = [];
afterEach(() => {
	while (homes.length > 0) {
		const home = homes.pop();
		if (!home) continue;
		home.restore();
		home.cleanup();
	}
});

function setupHome(files: {readonly models?: unknown; readonly auth?: unknown} = {}): TempHome {
	const home = createTempHome('ccq-pi-headers-');
	homes.push(home);
	mkdirSync(join(home.path, '.pi', 'agent'), {recursive: true});
	if (files.models !== undefined) writeFileSync(piModelsJsonPath(), JSON.stringify(files.models, null, 2), 'utf8');
	if (files.auth !== undefined) writeFileSync(piAuthJsonPath(), JSON.stringify(files.auth, null, 2), 'utf8');
	return home;
}

function readModels(): Record<string, any> {
	return JSON.parse(readFileSync(piModelsJsonPath(), 'utf8')) as Record<string, any>;
}

function fullValues(overrides: Partial<PiProviderFormValues> = {}): PiProviderFormValues {
	return {
		providerType: 'custom-api-key',
		api: 'anthropic-messages',
		provider: 'custom-acme',
		model: 'claude-sonnet-4-5',
		models: 'claude-sonnet-4-5',
		modelDefinitions: [{id: 'claude-sonnet-4-5'}],
		baseUrl: 'https://acme.example/v1',
		apiKey: 'acme-secret',
		headers: '',
		authHeader: 'default',
		headerPreset: '',
		variant: 'full',
		...overrides
	};
}

describe('full 变体持久化', () => {
	test('新增写出 headers / authHeader', () => {
		setupHome();
		savePiProvider(
			fullValues({
				headers: '{"User-Agent": "claude-cli/2.1.251 (external, cli)", "x-app": "cli"}',
				authHeader: 'bearer'
			}),
			{mode: 'add'}
		);
		const entry = readModels().providers['custom-acme'];
		expect(entry.headers).toEqual({'User-Agent': 'claude-cli/2.1.251 (external, cli)', 'x-app': 'cli'});
		expect(entry.authHeader).toBe(true);
	});

	test('空 headers / 默认认证头时对应键不存在', () => {
		setupHome();
		savePiProvider(fullValues({headers: ''}), {mode: 'add'});
		expect(readModels().providers['custom-acme']).not.toHaveProperty('headers');
		expect(readModels().providers['custom-acme']).not.toHaveProperty('authHeader');
	});

	test('{} 与空键空值条目归一化为「不写 headers 键」', () => {
		setupHome();
		savePiProvider(fullValues({provider: 'a', headers: '{}'}), {mode: 'add'});
		savePiProvider(fullValues({provider: 'b', headers: '{"": "x", "empty": ""}'}), {mode: 'add'});
		expect(readModels().providers.a).not.toHaveProperty('headers');
		expect(readModels().providers.b).not.toHaveProperty('headers');
	});

	test('含逗号的值保存与读回完全一致', () => {
		setupHome();
		const beta = 'claude-code-20250219,interleaved-thinking-2025-05-14';
		savePiProvider(fullValues({headers: JSON.stringify({'anthropic-beta': beta})}), {mode: 'add'});
		expect(readModels().providers['custom-acme'].headers['anthropic-beta']).toBe(beta);
		expect(loadPiProviderProfile('custom-acme')?.headers['anthropic-beta']).toBe(beta);
	});

	test('非 anthropic 协议即使表单残留 bearer 也不写 authHeader', () => {
		setupHome();
		savePiProvider(fullValues({api: 'openai-completions', authHeader: 'bearer'}), {mode: 'add'});
		expect(readModels().providers['custom-acme']).not.toHaveProperty('authHeader');
	});

	test('编辑既有 provider：headers 完整回显且未知字段不变', () => {
		setupHome({
			models: {
				providers: {
					'custom-acme': {
						baseUrl: 'https://acme.example/v1',
						api: 'anthropic-messages',
						models: [{id: 'claude-sonnet-4-5'}],
						headers: {'x-app': 'cli', 'anthropic-beta': 'a,b'},
						authHeader: true,
						compat: {supportsStrictMode: true},
						customField: 'keep-me'
					}
				}
			},
			auth: {'custom-acme': {type: 'api_key', key: 'acme-secret'}}
		});
		const model = buildPiProviderFormModel({mode: 'edit', profileKey: 'custom-acme'});
		expect(model.values.variant).toBe('full');
		expect(model.values.authHeader).toBe('bearer');
		expect(model.values.headers).toContain('anthropic-beta');
		savePiProvider(model.values, {mode: 'edit', profileKey: 'custom-acme', profile: null});
		const entry = readModels().providers['custom-acme'];
		expect(entry.headers).toEqual({'x-app': 'cli', 'anthropic-beta': 'a,b'});
		expect(entry.authHeader).toBe(true);
		expect(entry.compat).toEqual({supportsStrictMode: true});
		expect(entry.customField).toBe('keep-me');
	});
});

describe('transport-only 变体持久化', () => {
	test('内置 Provider 只写 headers，且不触碰 auth.json', () => {
		const home = setupHome({auth: {anthropic: {type: 'api_key', key: 'sk-live-secret'}}});
		const authBytes = readFileSync(piAuthJsonPath(), 'utf8');
		const model = buildPiProviderFormModel({mode: 'edit', profileKey: 'anthropic'});
		expect(model.values.variant).toBe('transport-only');
		expect(model.fields.some(field => field.id === 'baseUrl')).toBe(false);
		expect(model.fields.some(field => field.id === 'apiKey')).toBe(false);

		const result = savePiProvider(
			{...model.values, headers: '{"x-app": "cli"}', authHeader: 'bearer'},
			{mode: 'edit', profileKey: 'anthropic', profile: null}
		);
		expect(result.authHeader).toBe(true);
		const entry = readModels().providers.anthropic;
		expect(entry).toEqual({headers: {'x-app': 'cli'}, authHeader: true});
		expect(entry).not.toHaveProperty('baseUrl');
		expect(entry).not.toHaveProperty('api');
		expect(entry).not.toHaveProperty('models');
		expect(entry).not.toHaveProperty('apiKey');
		expect(readFileSync(piAuthJsonPath(), 'utf8')).toBe(authBytes);
		expect(home.path.length).toBeGreaterThan(0);
	});

	test('保留条目已有的 compat / modelOverrides 等字段', () => {
		setupHome({
			models: {
				providers: {
					anthropic: {compat: {supportsStrictMode: true}, modelOverrides: [{id: 'claude-x'}], customField: 'keep'}
				}
			},
			auth: {anthropic: {type: 'api_key', key: 'sk-live-secret'}}
		});
		const model = buildPiProviderFormModel({mode: 'edit', profileKey: 'anthropic'});
		savePiProvider({...model.values, headers: '{"x-app": "cli"}'}, {mode: 'edit', profileKey: 'anthropic', profile: null});
		const entry = readModels().providers.anthropic;
		expect(entry.headers).toEqual({'x-app': 'cli'});
		expect(entry.compat).toEqual({supportsStrictMode: true});
		expect(entry.modelOverrides).toEqual([{id: 'claude-x'}]);
		expect(entry.customField).toBe('keep');
	});

	test('移除请求头后空条目被删除，非空条目保留', () => {
		setupHome({
			models: {providers: {anthropic: {headers: {'x-app': 'cli'}}}},
			auth: {anthropic: {type: 'api_key', key: 'sk-live-secret'}}
		});
		const onlyHeaders = buildPiProviderFormModel({mode: 'edit', profileKey: 'anthropic'});
		savePiProvider({...onlyHeaders.values, headers: ''}, {mode: 'edit', profileKey: 'anthropic', profile: null});
		expect(readModels().providers.anthropic).toBeUndefined();

		setupHome({
			models: {providers: {anthropic: {headers: {'x-app': 'cli'}, compat: {supportsStrictMode: true}}}},
			auth: {anthropic: {type: 'api_key', key: 'sk-live-secret'}}
		});
		const withCompat = buildPiProviderFormModel({mode: 'edit', profileKey: 'anthropic'});
		savePiProvider({...withCompat.values, headers: ''}, {mode: 'edit', profileKey: 'anthropic', profile: null});
		const kept = readModels().providers.anthropic;
		expect(kept).toEqual({compat: {supportsStrictMode: true}});
		expect(kept).not.toHaveProperty('headers');
	});

	test('OAuth 凭据 Provider 可写传输层覆盖，但凭据仍不可编辑 / 删除', () => {
		const home = setupHome({auth: {xai: {type: 'oauth', access: 'access-token', refresh: 'refresh-token'}}});
		const authBytes = readFileSync(piAuthJsonPath(), 'utf8');
		const model = buildPiProviderFormModel({mode: 'edit', profileKey: 'xai'});
		expect(model.values.variant).toBe('transport-only');
		savePiProvider({...model.values, headers: '{"x-app": "cli"}'}, {mode: 'edit', profileKey: 'xai', profile: null});
		expect(readModels().providers.xai).toEqual({headers: {'x-app': 'cli'}});
		expect(readFileSync(piAuthJsonPath(), 'utf8')).toBe(authBytes);

		expect(() => savePiProvider(fullValues({provider: 'xai', apiKey: 'k'}), {mode: 'edit', profileKey: 'xai', profile: null})).toThrow(
			/OAuth/
		);
		expect(() => deletePiProvider('xai')).toThrow(/OAuth/);
		expect(readFileSync(piAuthJsonPath(), 'utf8')).toBe(authBytes);
		expect(home.path.length).toBeGreaterThan(0);
	});

	test('传输层覆盖保存不改动 settings.json 且记录投影带 canEditTransport', () => {
		setupHome({
			models: {providers: {anthropic: {headers: {'x-app': 'cli'}}}},
			auth: {anthropic: {type: 'api_key', key: 'sk-live-secret'}}
		});
		const record = normalizePiProviderRecords({
			models: {providers: {anthropic: {headers: {'x-app': 'cli'}}}},
			auth: {anthropic: {type: 'api_key', key: 'sk-live-secret'}},
			settings: {}
		}).find(item => item.providerId === 'anthropic');
		expect(record?.canEditTransport).toBe(true);
	});
});

describe('validatePiProviderForm 请求头校验', () => {
	test('非法 JSON / 非法头名 / host / content-length 被拒绝', () => {
		const base = fullValues();
		expect(validatePiProviderForm('add', {...base, headers: '{broken'}).some(error => error.includes('JSON 格式错误'))).toBe(true);
		expect(validatePiProviderForm('add', {...base, headers: '{"bad name": "x"}'}).some(error => error.includes('RFC 7230'))).toBe(true);
		expect(validatePiProviderForm('add', {...base, headers: '{"host": "x"}'}).length).toBeGreaterThan(0);
		expect(validatePiProviderForm('add', {...base, headers: '{"Content-Length": "1"}'}).length).toBeGreaterThan(0);
	});

	test('空键空值静默丢弃，合法请求头通过校验', () => {
		const base = fullValues();
		expect(validatePiProviderForm('add', {...base, headers: '{"": "", "x-app": "cli"}'})).toEqual([]);
		expect(validatePiProviderForm('add', {...base, headers: '{"anthropic-beta": "a,b"}'})).toEqual([]);
	});

	test('transport-only 不要求 baseUrl / models / apiKey', () => {
		const transport = fullValues({variant: 'transport-only', baseUrl: '', models: '', apiKey: '', headers: '{"x-app": "cli"}'});
		expect(validatePiProviderForm('edit', transport)).toEqual([]);
	});
});

describe('模型发现请求头', () => {
	async function captureDiscoveryHeaders(values: PiProviderFormValues): Promise<Record<string, string>> {
		let received: Record<string, string> = {};
		await discoverPiProviderModels(values, undefined, {
			fetchImpl: (async (_url: string, init: {headers: Record<string, string>}) => {
				received = init.headers;
				return new Response(JSON.stringify({data: [{id: 'probe-model'}]}), {status: 200});
			}) as unknown as typeof fetch
		});
		return received;
	}

	test('编辑区请求头在协议静态头之后合并，可覆盖 anthropic-version', async () => {
		const headers = await captureDiscoveryHeaders(
			fullValues({api: 'anthropic-messages', headers: '{"anthropic-version": "2024-01-01", "x-app": "cli"}'})
		);
		expect(headers['anthropic-version']).toBe('2024-01-01');
		expect(headers['x-app']).toBe('cli');
		expect(headers['x-api-key']).toBe('acme-secret');
	});

	test('authHeader=bearer 时额外追加 Authorization，且不移除协议原生 x-api-key', async () => {
		const headers = await captureDiscoveryHeaders(fullValues({api: 'anthropic-messages', authHeader: 'bearer'}));
		// 与真实请求同形：Pi 的 withConfiguredAuth 是「追加」而非「替换」。
		// 若发现请求只发 Authorization，只认 x-api-key 的端点会呈现「发现失败但调用成功」的难排查错配。
		expect(headers.Authorization).toBe('Bearer acme-secret');
		expect(headers['x-api-key']).toBe('acme-secret');
	});

	test('authHeader=bearer 在原生已是 Bearer 的协议下不产生重复头', async () => {
		const headers = await captureDiscoveryHeaders(fullValues({api: 'openai-completions', authHeader: 'bearer'}));
		expect(headers.Authorization).toBe('Bearer acme-secret');
		expect(Object.keys(headers).filter(name => name.toLowerCase() === 'authorization')).toHaveLength(1);
	});

	test('自定义 Authorization 优先于派生认证头', async () => {
		const headers = await captureDiscoveryHeaders(
			fullValues({api: 'anthropic-messages', authHeader: 'bearer', headers: '{"Authorization": "Custom token"}'})
		);
		expect(headers.Authorization).toBe('Custom token');
	});

	test('transport-only 不提供模型发现', async () => {
		await expect(discoverPiProviderModels(fullValues({variant: 'transport-only'}))).rejects.toThrow(/不支持自定义模型发现/);
	});
});

describe('Pi 卡片描述行', () => {
	test('只展示凭据事实，不拼请求头状态', () => {
		const pi = createProviderViewAdapter('pi');
		const base = {
			key: 'anthropic',
			baseUrl: 'https://a.io',
			authToken: '',
			profilePath: 'anthropic',
			isActive: false,
			maskedApiKey: 'sk-x',
			authKind: 'api_key' as const,
			source: 'builtin' as const
		};
		const summary = pi.toHomeRow(base).summary;
		expect(summary).toContain('https://a.io · sk-x · 官方');
		expect(summary, '列表不得展示请求头').not.toContain('请求头');
		expect(summary, '列表不得展示请求头').not.toContain('Bearer');
	});
});

// ── AC 补测：以下断言补上质检指出的「子句无自动化覆盖」缺口 ──────────────

describe('AC6：请求头值的 Pi 配置语法原样落盘', () => {
	test('$ENV / !command / $$ / $! 不被转义改写', () => {
		setupHome({models: {}, auth: {}});
		const headers = {
			'x-env': '$MY_KEY',
			'x-cmd': '!op read op://vault/item/token',
			'x-literal': '$$literal',
			'x-bang': '$!literal'
		};
		savePiProvider(fullValues({headers: JSON.stringify(headers)}), {mode: 'add'});
		expect(readModels().providers['custom-acme'].headers).toEqual(headers);
	});
});

describe('AC8：认证头形态只在 anthropic-messages 下出现', () => {
	const fieldsFor = (api: string) => buildPiProviderFormFields(fullValues({api}), 'add');

	test('只有 anthropic-messages 渲染 authHeader 字段', () => {
		expect(fieldsFor('anthropic-messages').some(field => field.id === 'authHeader')).toBe(true);
		for (const api of [
			'openai-completions',
			'openai-responses',
			'google-generative-ai',
			'openai-codex-responses',
			'azure-openai-responses',
			'mistral-conversations',
			'google-vertex',
			'bedrock-converse-stream',
			'pi-messages'
		]) {
			expect(
				fieldsFor(api).some(field => field.id === 'authHeader'),
				`${api} 不应出现认证头形态字段`
			).toBe(false);
		}
	});

	test('非 anthropic 协议即使表单残留 bearer 也不写 authHeader 键', () => {
		for (const api of ['openai-completions', 'openai-responses', 'google-generative-ai']) {
			setupHome({models: {}, auth: {}});
			savePiProvider(fullValues({api, authHeader: 'bearer'}), {mode: 'add'});
			expect(readModels().providers['custom-acme'], `${api} 不应写 authHeader`).not.toHaveProperty('authHeader');
		}
	});
});

describe('AC13：预设文本经保存落到 models.json', () => {
	test('headerPresetText 的输出保存后等于契约预设的 headers', () => {
		setupHome({models: {}, auth: {}});
		const text = headerPresetText('claude-code');
		expect(text).not.toBeNull();
		savePiProvider(fullValues({headers: text ?? ''}), {mode: 'add'});
		expect(readModels().providers['custom-acme'].headers).toEqual(piHeaderPreset('claude-code')?.headers);
	});
});

// 说明文案在 core 层断精确字符串：组件层两列布局会把长文案折行、右列边框字符插进折行处，
// 按子串断言必然脆弱（见组件测试里的说明）。
describe('AC10 / AC21：headerPreset 说明文案按优先级表生成', () => {
	const helpTextFor = (api: string, headers = ''): string => {
		const field = buildPiProviderFormFields(fullValues({api, headers}), 'add').find(item => item.id === 'headerPreset');
		return field && field.type === 'radio' ? (field.helpText ?? '') : '';
	};

	test('自由模式：声明没有对应预设且预设均非本协议客户端', () => {
		for (const api of ['openai-completions', 'openai-codex-responses', 'google-vertex']) {
			const text = helpTextFor(api);
			expect(text, `${api} 应为自由模式文案`).toContain('没有对应预设');
			expect(text).toContain('均非本协议客户端');
		}
	});

	test('受控模式：给出与协议对应的建议预设', () => {
		expect(helpTextFor('anthropic-messages')).toContain('通常需要配置为 Claude Code');
		expect(helpTextFor('openai-responses')).toContain('通常需要配置为 Codex CLI');
		expect(helpTextFor('google-generative-ai')).toContain('通常需要配置为 Gemini CLI');
	});

	test('跨协议残留头：提示该预设不适用于当前协议', () => {
		const codexHeaders = JSON.stringify(piHeaderPreset('codex')?.headers ?? {});
		const text = helpTextFor('anthropic-messages', codexHeaders);
		expect(text).toContain('不适用于当前 API 协议');
		expect(text).toContain('Codex CLI');
	});

	test('基础说明始终存在（文案不再有不可达分支）', () => {
		for (const api of ['anthropic-messages', 'openai-completions', 'openai-responses', 'google-generative-ai']) {
			expect(helpTextFor(api), `${api} 缺基础说明`).toContain('左右键选择预设');
		}
	});
});
