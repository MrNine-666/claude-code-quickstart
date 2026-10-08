import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, test} from 'bun:test';

import {importCodexProvidersSection, parseCodexProvidersSection, snapshotCodexProvidersSection} from '../../src/core/codex.js';
import {planConfigTransferExport} from '../../src/core/config-transfer-plan.js';
import {parse as parseToml} from '../../src/core/toml-edit.js';
import {importPiProvidersSection, parsePiProvidersSection, snapshotPiProvidersSection} from '../../src/core/pi-provider.js';
import {importClaudeProvidersSection, parseClaudeProvidersSection, snapshotClaudeProvidersSection} from '../../src/core/provider.js';
import {createTempHome} from '../helpers/temp-home.js';

// Phase 2 Part A：Provider 快照/导入 seam。所有文件操作在临时 CCQ_HOME 下，绝不触碰真实 HOME。

const SENTINEL = 'SENTINEL-SECRET-c0ffee';

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

describe('Claude 供应商导入导出', () => {
	test('未选凭据时剥离 profile token 与 settings 投影，且不导出非 provider-owned env', () => {
		const home = createTempHome('ccq-transfer-cc-snapshot-');
		try {
			const providers = join(home.path, '.claude', 'providers');
			writeFile(
				join(providers, 'glm.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: 'https://glm.example'}})
			);
			writeFile(
				join(home.path, '.claude', 'settings.json'),
				JSON.stringify({
					env: {
						ANTHROPIC_AUTH_TOKEN: SENTINEL,
						ANTHROPIC_BASE_URL: 'https://glm.example',
						USER_FLAG: 'keep-out-of-provider-projection'
					},
					statusLine: {type: 'x'}
				})
			);

			const snapshot = snapshotClaudeProvidersSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;

			expect(JSON.stringify(snapshot.data)).not.toContain(SENTINEL);
			expect(snapshot.data.profiles).toHaveLength(1);
			expect(snapshot.data.profiles[0]?.profile.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(snapshot.data.settingsEnv.ANTHROPIC_BASE_URL).toBe('https://glm.example');
			expect(snapshot.data.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
			expect(snapshot.data.settingsEnv.USER_FLAG, '非 provider-owned env 不进供应商投影').toBeUndefined();

			const withCredentials = snapshotClaudeProvidersSection({includeCredentials: true});
			expect(withCredentials.ok).toBe(true);
			if (withCredentials.ok) {
				expect(withCredentials.data.profiles[0]?.profile.env?.ANTHROPIC_AUTH_TOKEN).toBe(SENTINEL);
				expect(withCredentials.data.settingsEnv.ANTHROPIC_AUTH_TOKEN).toBe(SENTINEL);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('roundtrip：同 key 覆盖、其他本机 profile 与 settings 字段保留', () => {
		const home = createTempHome('ccq-transfer-cc-roundtrip-');
		const sourceHome = join(home.path, 'source');
		const targetHome = join(home.path, 'target');
		try {
			process.env.CCQ_HOME = sourceHome;
			writeFile(
				join(sourceHome, '.claude', 'providers', 'glm.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: 'https://glm.example'}})
			);
			writeFile(
				join(sourceHome, '.claude', 'settings.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: 'https://glm.example'}})
			);
			const snapshot = snapshotClaudeProvidersSection({includeCredentials: true});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;

			process.env.CCQ_HOME = targetHome;
			writeFile(
				join(targetHome, '.claude', 'providers', 'glm.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_BASE_URL: 'https://old.example'}})
			);
			writeFile(
				join(targetHome, '.claude', 'providers', 'other.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'other-token', ANTHROPIC_BASE_URL: 'https://other.example'}})
			);
			writeFile(
				join(targetHome, '.claude', 'settings.json'),
				JSON.stringify({
					env: {ANTHROPIC_AUTH_TOKEN: 'old-token', ANTHROPIC_BASE_URL: 'https://old.example', USER_FLAG: '1'},
					statusLine: {type: 'keep'}
				})
			);

			const imported = importClaudeProvidersSection(snapshot.data, {containsCredentials: true});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.replaced).toEqual(['glm', 'settings']);

			const glm = JSON.parse(readText(join(targetHome, '.claude', 'providers', 'glm.json'))) as {
				env: Record<string, string>;
			};
			expect(glm.env.ANTHROPIC_AUTH_TOKEN).toBe(SENTINEL);
			expect(glm.env.ANTHROPIC_BASE_URL).toBe('https://glm.example');
			expect(JSON.parse(readText(join(targetHome, '.claude', 'providers', 'other.json'))).env.ANTHROPIC_AUTH_TOKEN).toBe(
				'other-token'
			);

			const settings = JSON.parse(readText(join(targetHome, '.claude', 'settings.json'))) as {
				env: Record<string, string>;
				statusLine: unknown;
			};
			expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://glm.example');
			expect(settings.env.USER_FLAG, '非 provider-owned env 必须保留').toBe('1');
			expect(settings.statusLine, '其他领域字段必须保留').toEqual({type: 'keep'});
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('不含凭据的包导入时保留本机 token，且 dryRun 零写盘', () => {
		const home = createTempHome('ccq-transfer-cc-preserve-');
		try {
			writeFile(
				join(home.path, '.claude', 'providers', 'glm.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'local-token', ANTHROPIC_BASE_URL: 'https://local.example'}})
			);
			writeFile(
				join(home.path, '.claude', 'settings.json'),
				JSON.stringify({env: {ANTHROPIC_AUTH_TOKEN: 'local-token', ANTHROPIC_BASE_URL: 'https://local.example'}})
			);

			const before = readText(join(home.path, '.claude', 'providers', 'glm.json'));
			const section = {
				profiles: [{key: 'glm', profile: {env: {ANTHROPIC_BASE_URL: 'https://bundle.example'}}}],
				settingsEnv: {ANTHROPIC_BASE_URL: 'https://bundle.example'}
			};

			const preview = importClaudeProvidersSection(section, {containsCredentials: false, dryRun: true});
			expect(preview.ok).toBe(true);
			if (!preview.ok) return;
			expect(preview.data.replaced).toEqual(['glm', 'settings']);
			expect(readText(join(home.path, '.claude', 'providers', 'glm.json')), 'dryRun 不得写盘').toBe(before);

			const imported = importClaudeProvidersSection(section, {containsCredentials: false});
			expect(imported.ok).toBe(true);
			const profile = JSON.parse(readText(join(home.path, '.claude', 'providers', 'glm.json'))) as {
				env: Record<string, string>;
			};
			expect(profile.env.ANTHROPIC_BASE_URL).toBe('https://bundle.example');
			expect(profile.env.ANTHROPIC_AUTH_TOKEN, '未含凭据的包不得清空本机 token').toBe('local-token');
			const settings = JSON.parse(readText(join(home.path, '.claude', 'settings.json'))) as {env: Record<string, string>};
			expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBe('local-token');
			expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://bundle.example');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('损坏本机 profile 阻断分类且字节不变；非法包内容在写盘前拒绝', () => {
		const home = createTempHome('ccq-transfer-cc-corrupt-');
		try {
			const brokenPath = join(home.path, '.claude', 'providers', 'broken.json');
			writeFile(brokenPath, '{not json');
			const before = readText(brokenPath);

			const blocked = importClaudeProvidersSection(
				{profiles: [{key: 'broken', profile: {env: {ANTHROPIC_BASE_URL: 'https://x.example'}}}], settingsEnv: {}},
				{containsCredentials: false}
			);
			expect(blocked).toEqual({ok: false, kind: 'conflict', error: '本机供应商配置损坏，已停止导入：broken'});
			expect(readText(brokenPath), '损坏目标必须保留原字节').toBe(before);

			for (const bad of [
				null,
				{},
				{profiles: 'x', settingsEnv: {}},
				{profiles: [{key: '../escape', profile: {env: {}}}], settingsEnv: {}},
				{profiles: [{key: 'a', profile: {env: {A: 1}}}], settingsEnv: {}},
				{
					profiles: [
						{key: 'a', profile: {env: {}}},
						{key: 'a', profile: {env: {}}}
					],
					settingsEnv: {}
				},
				{profiles: [], settingsEnv: {A: 1}}
			]) {
				expect(parseClaudeProvidersSection(bad).ok, `应拒绝非法分类 ${JSON.stringify(bad)}`).toBe(false);
			}

			expect(parseClaudeProvidersSection({profiles: [], settingsEnv: {}}).ok).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Codex 供应商导入导出', () => {
	test('快照过滤 projects 等本机绑定，摘要只报键名', () => {
		const home = createTempHome('ccq-transfer-cx-snapshot-');
		try {
			writeFile(
				join(home.path, '.codex', 'glm.config.toml'),
				[
					'model = "glm-4"',
					'model_provider = "glm"',
					'',
					'[model_providers.glm]',
					'name = "glm"',
					'base_url = "https://glm.example"'
				].join('\n')
			);
			writeFile(
				join(home.path, '.codex', 'config.toml'),
				[
					'model = "glm-4"',
					'model_provider = "glm"',
					'approval_policy = "never"',
					'',
					'[projects."/home/user/secret-project"]',
					'trust_level = "trusted"',
					'',
					'[model_providers.glm]',
					'name = "glm"',
					'base_url = "https://glm.example"'
				].join('\n')
			);

			const snapshot = snapshotCodexProvidersSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;

			expect(snapshot.data.configProjection.model).toBe('glm-4');
			expect(snapshot.data.configProjection.model_provider).toBe('glm');
			expect(snapshot.data.profiles.map(profile => profile.key)).toEqual(['glm']);
			expect(JSON.stringify(snapshot.data)).not.toContain('/home/user/secret-project');
			expect(snapshot.warnings.some(warning => warning.includes('projects'))).toBe(true);
			for (const warning of snapshot.warnings) {
				expect(warning).not.toContain('/home/user/secret-project');
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('投影保留 model，但未选凭据不导出 bearer token', () => {
		const home = createTempHome('ccq-transfer-cx-projection-credentials-');
		try {
			writeFile(
				join(home.path, '.codex', 'config.toml'),
				`model = "bundle-model"\nmodel_provider = "remote"\n[model_providers.remote]\nname = "remote"\nbase_url = "https://example.com"\nexperimental_bearer_token = "${SENTINEL}"\n`
			);
			const without = snapshotCodexProvidersSection({includeCredentials: false});
			expect(without.ok).toBe(true);
			if (!without.ok) return;
			expect(without.data.configProjection.model).toBe('bundle-model');
			expect(JSON.stringify(without.data)).not.toContain(SENTINEL);
			const withCredentials = snapshotCodexProvidersSection({includeCredentials: true});
			expect(withCredentials.ok).toBe(true);
			if (withCredentials.ok) expect(JSON.stringify(withCredentials.data)).toContain(SENTINEL);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('provider HTTP headers 在 profile/投影 opt-out 剥离，full plan 标记且导入保留本机密钥', async () => {
		const home = createTempHome('ccq-transfer-cx-header-credentials-');
		try {
			const configPath = join(home.path, '.codex', 'config.toml');
			const profilePath = join(home.path, '.codex', 'remote.config.toml');
			const toml = `model = "bundle-model"\nmodel_provider = "remote"\n[model_providers.remote]\nname = "remote"\nbase_url = "https://example.com"\n[model_providers.remote.http_headers]\nAuthorization = "${SENTINEL}"\n`;
			writeFile(configPath, toml);
			writeFile(profilePath, toml);
			const stripped = snapshotCodexProvidersSection({includeCredentials: false});
			expect(stripped.ok).toBe(true);
			if (!stripped.ok) return;
			expect(JSON.stringify(stripped.data)).not.toContain(SENTINEL);
			const full = await planConfigTransferExport({categories: [{tool: 'cx', category: 'providers'}], includeCredentials: true});
			expect(full.ok).toBe(true);
			if (!full.ok) return;
			expect(full.data.containsCredentials).toBe(true);
			expect(full.data.summaries[0]?.containsCredentials).toBe(true);
			writeFile(configPath, 'model = "plain"\n');
			const profileOnly = await planConfigTransferExport({
				categories: [{tool: 'cx', category: 'providers'}],
				includeCredentials: true
			});
			expect(profileOnly.ok && profileOnly.data.containsCredentials).toBe(true);
			writeFile(profilePath, 'model_provider = "remote"\n[model_providers.remote]\nname = "remote"\n');
			writeFile(configPath, toml);
			const projectionOnly = await planConfigTransferExport({
				categories: [{tool: 'cx', category: 'providers'}],
				includeCredentials: true
			});
			expect(projectionOnly.ok && projectionOnly.data.containsCredentials).toBe(true);
			writeFile(profilePath, toml);
			const incoming = snapshotCodexProvidersSection({includeCredentials: true});
			expect(incoming.ok).toBe(true);
			if (!incoming.ok) return;
			const local = toml.replaceAll(SENTINEL, 'LOCAL-FAKE-HEADER').replace('bundle-model', 'local-model');
			writeFile(configPath, local);
			writeFile(profilePath, local);
			expect(importCodexProvidersSection(incoming.data, {containsCredentials: false, dryRun: true}).ok).toBe(true);
			expect(readText(configPath)).toBe(local);
			expect(readText(profilePath)).toBe(local);
			expect(importCodexProvidersSection(incoming.data, {containsCredentials: false}).ok).toBe(true);
			for (const path of [configPath, profilePath]) {
				const document = parseToml(readText(path));
				expect(document.model).toBe('bundle-model');
				expect(readText(path)).toContain('LOCAL-FAKE-HEADER');
				expect(readText(path)).not.toContain(SENTINEL);
			}
			const postflight = importCodexProvidersSection(incoming.data, {containsCredentials: false, dryRun: true});
			expect(postflight.ok).toBe(true);
			if (postflight.ok) {
				expect(postflight.data.added).toEqual([]);
				expect(postflight.data.replaced).toEqual([]);
				expect(postflight.data.unchanged).toEqual(['remote', 'config']);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('仅 model 不同也预检 replace；合并保留 provider 未知字段且 postflight 幂等', () => {
		const home = createTempHome('ccq-transfer-cx-projection-preview-');
		try {
			const configPath = join(home.path, '.codex', 'config.toml');
			writeFile(
				configPath,
				'model = "local-model"\nmodel_provider = "remote"\n[model_providers.remote]\nname = "remote"\nbase_url = "https://example.com"\nunknown = true\nexperimental_bearer_token = "LOCAL-FAKE-KEY"\n[model_providers.local_only]\nname = "local_only"\n'
			);
			const before = readText(configPath);
			const section = {
				profiles: [],
				configProjection: {
					model: 'bundle-model',
					model_provider: 'remote',
					model_providers: {remote: {name: 'remote', base_url: 'https://example.com', experimental_bearer_token: SENTINEL}}
				}
			};
			const preview = importCodexProvidersSection(section, {containsCredentials: false, dryRun: true});
			expect(preview.ok).toBe(true);
			if (preview.ok) expect(preview.data.replaced).toEqual(['config']);
			expect(readText(configPath)).toBe(before);
			expect(importCodexProvidersSection(section, {containsCredentials: false}).ok).toBe(true);
			const post = importCodexProvidersSection(section, {containsCredentials: false, dryRun: true});
			expect(post.ok).toBe(true);
			if (post.ok) {
				expect(post.data.replaced).toEqual([]);
				expect(post.data.unchanged).toEqual(['config']);
			}
			const merged = readText(configPath);
			expect(merged).toContain('model = "bundle-model"');
			expect(merged).toContain('unknown = true');
			expect(merged).toContain('LOCAL-FAKE-KEY');
			expect(merged).not.toContain(SENTINEL);
			// Including credentials also must not delete local unknown provider fields.
			expect(importCodexProvidersSection(section, {containsCredentials: true}).ok).toBe(true);
			expect(readText(configPath)).toContain('unknown = true');
			expect(readText(configPath)).toContain(SENTINEL);
			expect(merged).toContain('[model_providers.local_only]');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('导入：同 key 覆盖 profile，本机其他 profile 与 config 未知 section 保留', () => {
		const home = createTempHome('ccq-transfer-cx-import-');
		try {
			writeFile(
				join(home.path, '.codex', 'glm.config.toml'),
				[
					'model = "old-model"',
					'model_provider = "glm"',
					'',
					'[model_providers.glm]',
					'name = "glm"',
					'base_url = "https://old.example"'
				].join('\n')
			);
			writeFile(
				join(home.path, '.codex', 'other.config.toml'),
				['model_provider = "other"', '', '[model_providers.other]', 'name = "other"', 'base_url = "https://other.example"'].join(
					'\n'
				)
			);
			writeFile(
				join(home.path, '.codex', 'config.toml'),
				[
					'model_provider = "other"',
					'approval_policy = "on-request"',
					'',
					'[model_providers.other]',
					'name = "other"',
					'base_url = "https://other.example"',
					'',
					'[hooks]',
					'on_start = "echo keep"',
					'',
					'[unknown_section]',
					'flag = true'
				].join('\n')
			);

			const section = {
				profiles: [
					{
						key: 'glm',
						toml: [
							'model = "glm-4"',
							'model_provider = "glm"',
							'',
							'[model_providers.glm]',
							'name = "glm"',
							'base_url = "https://glm.example"'
						].join('\n')
					}
				],
				configProjection: {
					model: 'glm-4',
					model_provider: 'glm',
					model_providers: {glm: {name: 'glm', base_url: 'https://glm.example'}}
				}
			};

			const imported = importCodexProvidersSection(section, {containsCredentials: false});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.replaced).toEqual(['glm', 'config']);

			const config = readText(join(home.path, '.codex', 'config.toml'));
			expect(config).toContain('approval_policy = "on-request"');
			expect(config).toContain('[hooks]');
			expect(config).toContain('[unknown_section]');
			expect(config).toContain('[model_providers.other]');
			expect(config).toContain('https://glm.example');
			expect(config).toContain('model_provider = "glm"');
			expect(existsSync(join(home.path, '.codex', 'other.config.toml')), '本机其他 profile 必须保留').toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('不含凭据的包保留本机 bearer token；dryRun 与损坏目标行为正确', () => {
		const home = createTempHome('ccq-transfer-cx-credentials-');
		try {
			const profilePath = join(home.path, '.codex', 'glm.config.toml');
			writeFile(
				profilePath,
				[
					'model = "old-model"',
					'model_provider = "glm"',
					'',
					'[model_providers.glm]',
					'name = "glm"',
					'base_url = "https://old.example"',
					`experimental_bearer_token = "${SENTINEL}"`
				].join('\n')
			);
			writeFile(join(home.path, '.codex', 'config.toml'), 'approval_policy = "never"\n');

			const section = {
				profiles: [
					{
						key: 'glm',
						toml: [
							'model = "glm-4"',
							'model_provider = "glm"',
							'',
							'[model_providers.glm]',
							'name = "glm"',
							'base_url = "https://glm.example"'
						].join('\n')
					}
				],
				configProjection: {}
			};

			const preview = importCodexProvidersSection(section, {containsCredentials: false, dryRun: true});
			expect(preview.ok).toBe(true);
			expect(readText(profilePath)).toContain(SENTINEL);

			const imported = importCodexProvidersSection(section, {containsCredentials: false});
			expect(imported.ok).toBe(true);
			const profile = readText(profilePath);
			expect(profile).toContain('https://glm.example');
			expect(profile, '未含凭据的包不得清空本机 token').toContain(SENTINEL);
			expect(readText(join(home.path, '.codex', 'config.toml'))).toBe('approval_policy = "never"\n');

			writeFile(profilePath, 'not = = toml');
			const before = readText(profilePath);
			const blocked = importCodexProvidersSection(section, {containsCredentials: false});
			expect(blocked).toEqual({ok: false, kind: 'conflict', error: '本机供应商配置损坏，已停止导入：glm'});
			expect(readText(profilePath)).toBe(before);

			expect(parseCodexProvidersSection({profiles: [{key: 'official', toml: 'x = 1'}], configProjection: {}}).ok).toBe(false);
			expect(parseCodexProvidersSection({profiles: [], configProjection: {}}).ok).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Pi 供应商导入导出', () => {
	const modelsDocument = {
		providers: {
			'custom-acme': {
				baseUrl: 'https://acme.example/v1',
				api: 'openai-completions',
				models: [{id: 'acme-one', contextWindow: 128000}],
				headers: {Authorization: `Bearer ${SENTINEL}`},
				authHeader: true
			}
		}
	};

	test('快照永不采集 OAuth；未选凭据时移除 auth 与 headers', () => {
		const home = createTempHome('ccq-transfer-pi-snapshot-');
		try {
			writeFile(join(home.path, '.pi', 'agent', 'models.json'), JSON.stringify(modelsDocument));
			writeFile(
				join(home.path, '.pi', 'agent', 'auth.json'),
				JSON.stringify({
					'custom-acme': {type: 'api_key', key: SENTINEL, unknownFlag: 1},
					'openai-codex': {type: 'oauth', access: 'access-token', refresh: 'refresh-token'}
				})
			);

			const full = snapshotPiProvidersSection({includeCredentials: true});
			expect(full.ok).toBe(true);
			if (!full.ok) return;
			expect(Object.keys(full.data.auth)).toEqual(['custom-acme']);
			expect(full.data.auth['custom-acme']?.unknownFlag).toBe(1);
			expect(full.data.models['custom-acme']?.headers).toEqual({Authorization: `Bearer ${SENTINEL}`});

			const stripped = snapshotPiProvidersSection({includeCredentials: false});
			expect(stripped.ok).toBe(true);
			if (!stripped.ok) return;
			expect(stripped.data.auth).toEqual({});
			expect(stripped.data.models['custom-acme']?.headers).toBeUndefined();
			expect(JSON.stringify(stripped.data)).not.toContain(SENTINEL);
			expect(JSON.stringify(stripped.data)).not.toContain('refresh-token');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('导入保留 OAuth 条目、本机 unknown fields 与其他本机项', () => {
		const home = createTempHome('ccq-transfer-pi-import-');
		try {
			const authPath = join(home.path, '.pi', 'agent', 'auth.json');
			const modelsPath = join(home.path, '.pi', 'agent', 'models.json');
			writeFile(
				authPath,
				JSON.stringify({
					'custom-acme': {type: 'api_key', key: 'local-key', unknownFlag: 1},
					'openai-codex': {type: 'oauth', access: 'access-token', refresh: 'refresh-token', expires: 100}
				})
			);
			writeFile(
				modelsPath,
				JSON.stringify({
					providers: {
						'custom-acme': {
							baseUrl: 'https://old.example/v1',
							api: 'openai-completions',
							models: [{id: 'acme-one', contextWindow: 1}, {id: 'local-only'}],
							localFlag: true
						},
						'local-provider': {baseUrl: 'https://local.example', api: 'openai-completions', models: [{id: 'local-model'}]}
					}
				})
			);
			writeFile(join(home.path, '.pi', 'agent', 'settings.json'), JSON.stringify({defaultProvider: 'local-provider', theme: 'dark'}));
			const settingsBefore = readText(join(home.path, '.pi', 'agent', 'settings.json'));

			const section = {
				models: {
					'custom-acme': {
						baseUrl: 'https://acme.example/v1',
						api: 'openai-completions',
						models: [{id: 'acme-one', contextWindow: 128000}, {id: 'acme-two'}]
					}
				},
				auth: {
					'custom-acme': {type: 'api_key', key: SENTINEL},
					'openai-codex': {type: 'api_key', key: 'must-not-overwrite-oauth'}
				}
			};

			const imported = importPiProvidersSection(section, {containsCredentials: true});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.replaced).toContain('custom-acme');
			expect(imported.data.skipped).toEqual(['oauth:openai-codex']);
			expect(imported.data.warnings.some(warning => warning.includes('openai-codex'))).toBe(true);

			const auth = JSON.parse(readText(authPath)) as Record<string, Record<string, unknown>>;
			expect(auth['custom-acme']?.key).toBe(SENTINEL);
			expect(auth['custom-acme']?.unknownFlag, 'unknown fields 必须保留').toBe(1);
			expect(auth['openai-codex'], 'OAuth 条目绝不被覆盖').toEqual({
				type: 'oauth',
				access: 'access-token',
				refresh: 'refresh-token',
				expires: 100
			});

			const models = JSON.parse(readText(modelsPath)) as {
				providers: Record<string, {baseUrl?: string; models: {id: string; contextWindow?: number}[]; localFlag?: boolean}>;
			};
			expect(models.providers['custom-acme']?.baseUrl).toBe('https://acme.example/v1');
			expect(models.providers['custom-acme']?.localFlag, 'provider 级 unknown fields 必须保留').toBe(true);
			expect(models.providers['custom-acme']?.models.map(model => model.id).sort()).toEqual(['acme-one', 'acme-two', 'local-only']);
			expect(models.providers['custom-acme']?.models.find(model => model.id === 'acme-one')?.contextWindow).toBe(128000);
			expect(models.providers['local-provider'], '本机其他 provider 必须保留').toBeDefined();
			expect(readText(join(home.path, '.pi', 'agent', 'settings.json')), '供应商分类不得写 settings.json').toBe(settingsBefore);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('不含凭据的包不写 auth；dryRun 零写盘；损坏目标阻断', () => {
		const home = createTempHome('ccq-transfer-pi-guard-');
		try {
			const authPath = join(home.path, '.pi', 'agent', 'auth.json');
			const modelsPath = join(home.path, '.pi', 'agent', 'models.json');
			writeFile(authPath, JSON.stringify({'custom-acme': {type: 'api_key', key: 'local-key'}}));
			writeFile(
				modelsPath,
				JSON.stringify({providers: {'custom-acme': {baseUrl: 'https://old.example', api: 'openai-completions'}}})
			);

			const section = {
				models: {'custom-acme': {baseUrl: 'https://acme.example', api: 'openai-completions'}},
				auth: {'custom-acme': {type: 'api_key', key: SENTINEL}}
			};

			const preview = importPiProvidersSection(section, {containsCredentials: false, dryRun: true});
			expect(preview.ok).toBe(true);
			expect(readText(authPath)).toContain('local-key');
			expect(readText(modelsPath)).toContain('https://old.example');

			const imported = importPiProvidersSection(section, {containsCredentials: false});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.warnings.some(warning => warning.includes('凭据'))).toBe(true);
			expect(JSON.parse(readText(authPath))['custom-acme'].key, '不含凭据的包不得改写 auth').toBe('local-key');
			expect(readText(modelsPath)).toContain('https://acme.example');

			writeFile(modelsPath, '{broken');
			const before = readText(modelsPath);
			const blocked = importPiProvidersSection(section, {containsCredentials: true});
			expect(blocked).toEqual({
				ok: false,
				kind: 'conflict',
				error: '本机 Pi models.json 或 auth.json 损坏，已停止导入供应商分类'
			});
			expect(readText(modelsPath)).toBe(before);
			expect(JSON.parse(readText(authPath))['custom-acme'].key).toBe('local-key');

			expect(parsePiProvidersSection({models: {}, auth: {'openai-codex': {type: 'oauth', access: 'a', refresh: 'r'}}}).ok).toBe(
				false
			);
			expect(parsePiProvidersSection({models: {}, auth: {'bad/id': {type: 'api_key', key: 'x'}}}).ok).toBe(false);
			expect(parsePiProvidersSection({models: {'custom-a': {api: 'openai-completions'}}, auth: {}}).ok).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('新目标写入原生 providers 根；API Key 缺失不等于模型 schema 损坏', () => {
		const home = createTempHome('ccq-transfer-pi-new-');
		try {
			const path = join(home.path, '.pi', 'agent', 'models.json');
			const section = {
				models: {'my-provider': {baseUrl: 'https://example.test/v1', api: 'openai-completions', models: [{id: 'm'}]}},
				auth: {}
			};
			const preview = importPiProvidersSection(section, {containsCredentials: false, dryRun: true});
			expect(preview.ok).toBe(true);
			expect(existsSync(path)).toBe(false);
			expect(importPiProvidersSection(section, {containsCredentials: false}).ok).toBe(true);
			expect(JSON.parse(readText(path))).toEqual({providers: section.models});
			expect(existsSync(join(home.path, '.pi', 'agent', 'auth.json'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('如提供 Pi 安装目录，以原生 loader 验证全新目标 models/auth（离线 oracle）', async () => {
		const nativeDir = process.env.PI_CODING_AGENT_PACKAGE_DIR;
		if (!nativeDir) return; // CI 未安装 Pi 时仍以本地 schema 回归为主。
		const home = createTempHome('ccq-transfer-pi-oracle-');
		try {
			const section = {
				models: {test: {baseUrl: 'https://example.test', api: 'openai-completions', models: [{id: 'test-model'}]}},
				auth: {test: {type: 'api_key', key: SENTINEL}}
			};
			expect(importPiProvidersSection(section, {containsCredentials: true}).ok).toBe(true);
			const root = join(home.path, '.pi', 'agent');
			const {ModelConfig} = await import(pathToFileURL(join(nativeDir, 'dist/core/model-config.js')).href);
			const {ReadOnlyAuthStorage} = await import(pathToFileURL(join(nativeDir, 'dist/core/auth-storage.js')).href);
			const models = await ModelConfig.load(join(root, 'models.json'));
			expect(models.getError()).toBeUndefined();
			expect(models.getProvider('test')?.models[0]?.id).toBe('test-model');
			expect(new ReadOnlyAuthStorage(join(root, 'auth.json')).load().test.type).toBe('api_key');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('包内模型与 auth 非法形态、损坏本机 schema 在 dryRun 即阻断且保留字节', () => {
		const home = createTempHome('ccq-transfer-pi-invalid-');
		try {
			const path = join(home.path, '.pi', 'agent', 'models.json');
			for (const model of ['m', {}, {id: ''}, {id: 'm', headers: {bad: 42}}, {id: 'm', contextWindow: 'big'}]) {
				expect(parsePiProvidersSection({models: {test: {models: [model]}}, auth: {}}).ok).toBe(false);
			}
			for (const auth of [
				{type: 'api_key', key: 123},
				{type: 'api_key', env: {REGION: 42}},
				{type: 'api_key', key: 'x', access: 'oauth'},
				{type: 'oauth', access: 'secret', refresh: 'secret'}
			]) {
				expect(parsePiProvidersSection({models: {}, auth: {test: auth}}).ok).toBe(false);
			}
			expect(parsePiProvidersSection({models: {}, auth: {test: {type: 'api_key', env: {REGION: 'west'}}}}).ok).toBe(true);
			expect(parsePiProvidersSection({models: {}, auth: {test: {type: 'api_key', key: ''}}}).ok).toBe(true);
			for (const broken of [
				{},
				{test: {baseUrl: 'https://old'}},
				{providers: {test: {models: ['m']}}},
				{providers: {test: {oauth: 'invalid'}}}
			]) {
				writeFile(path, JSON.stringify(broken));
				const before = readText(path);
				const result = importPiProvidersSection(
					{models: {test: {models: [{id: 'm'}]}}, auth: {}},
					{containsCredentials: false, dryRun: true}
				);
				expect(result.ok).toBe(false);
				expect(readText(path)).toBe(before);
			}
			writeFile(path, JSON.stringify({providers: {test: {models: [{id: 'm'}]}}}));
			const authPath = join(home.path, '.pi', 'agent', 'auth.json');
			writeFile(authPath, JSON.stringify({test: {type: 'api_key', env: {REGION: 42}}}));
			const beforeAuth = readText(authPath);
			expect(
				importPiProvidersSection({models: {test: {models: [{id: 'm'}]}}, auth: {}}, {containsCredentials: false, dryRun: true}).ok
			).toBe(false);
			expect(readText(authPath)).toBe(beforeAuth);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('顶层及模型级密钥正确标记、剥离；OAuth 不导出也不覆盖', () => {
		const home = createTempHome('ccq-transfer-pi-key-levels-');
		try {
			const root = join(home.path, '.pi', 'agent');
			writeFile(
				join(root, 'models.json'),
				JSON.stringify({providers: {test: {apiKey: SENTINEL, headers: {X: SENTINEL}, models: [{id: 'm', headers: {X: SENTINEL}}]}}})
			);
			writeFile(
				join(root, 'auth.json'),
				JSON.stringify({
					test: {type: 'api_key', key: SENTINEL},
					oauth: {type: 'oauth', access: SENTINEL, refresh: SENTINEL, expires: 100}
				})
			);
			const full = snapshotPiProvidersSection({includeCredentials: true});
			expect(full.ok).toBe(true);
			if (!full.ok) return;
			expect(full.data.auth.oauth).toBeUndefined();
			const stripped = snapshotPiProvidersSection({includeCredentials: false});
			expect(stripped.ok).toBe(true);
			if (!stripped.ok) return;
			expect(JSON.stringify(stripped.data)).not.toContain(SENTINEL);
			expect(stripped.data.models.test?.models).toEqual([{id: 'm'}]);
			const target = join(home.path, 'other');
			process.env.CCQ_HOME = target;
			const imported = importPiProvidersSection(full.data, {containsCredentials: true});
			expect(imported.ok).toBe(true);
			if (process.platform !== 'win32') expect(statSync(join(target, '.pi', 'agent', 'auth.json')).mode & 0o777).toBe(0o600);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
