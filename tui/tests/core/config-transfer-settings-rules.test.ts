import {mkdirSync, readFileSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';

import {portableCodexConfig} from '../../src/core/codex-config.js';
import {
	importRulesSection,
	importSettingsSection,
	mergeTransferDocuments,
	parseRulesSection,
	parseSettingsSection,
	snapshotRulesSection,
	snapshotSettingsSection
} from '../../src/core/config-transfer-sections.js';
import {planConfigTransferExport} from '../../src/core/config-transfer-plan.js';
import {getPath, type TomlDocument} from '../../src/core/toml-edit.js';
import {createTempHome} from '../helpers/temp-home.js';

// Phase 2 Part A：Codex portable filter + 通用设置/全局规则 seam。全部使用临时 CCQ_HOME。

const SENTINEL = 'SENTINEL-SECRET-c0ffee';
const MACHINE_PATH = '/home/user/secret-project';

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function fileEntry(root: 'claude' | 'codex' | 'pi-agent', path: string, content: string): Record<string, unknown> {
	return {kind: 'file', root, path, contentBase64: Buffer.from(content, 'utf8').toString('base64'), mode: 0o644};
}

describe('Codex portable config filter', () => {
	const cases: readonly {
		readonly name: string;
		readonly document: TomlDocument;
		readonly excludedKey: string;
		readonly removedPath: readonly string[];
		readonly machinePath?: string;
	}[] = [
		{
			name: 'projects trust 状态',
			document: {projects: {[MACHINE_PATH]: {trust_level: 'trusted'}}},
			excludedKey: 'projects',
			removedPath: ['projects'],
			machinePath: MACHINE_PATH
		},
		{name: 'notice 运行时状态', document: {notice: 'update-available'}, excludedKey: 'notice', removedPath: ['notice']},
		{
			name: 'windows_wsl_setup_acknowledged',
			document: {windows_wsl_setup_acknowledged: true},
			excludedKey: 'windows_wsl_setup_acknowledged',
			removedPath: ['windows_wsl_setup_acknowledged']
		},
		{
			name: 'tui.model_availability_nux',
			document: {tui: {model_availability_nux: {seen: true}}},
			excludedKey: 'tui.model_availability_nux',
			removedPath: ['tui', 'model_availability_nux']
		},
		{
			name: 'tui.resume_cwd',
			document: {tui: {resume_cwd: MACHINE_PATH}},
			excludedKey: 'tui.resume_cwd',
			removedPath: ['tui', 'resume_cwd'],
			machinePath: MACHINE_PATH
		},
		{
			name: 'sqlite_home',
			document: {sqlite_home: '/home/user/.codex/db'},
			excludedKey: 'sqlite_home',
			removedPath: ['sqlite_home'],
			machinePath: '/home/user/.codex/db'
		},
		{
			name: 'log_dir',
			document: {log_dir: '/home/user/.codex/log'},
			excludedKey: 'log_dir',
			removedPath: ['log_dir'],
			machinePath: '/home/user/.codex/log'
		},
		{
			name: 'model_catalog_json',
			document: {model_catalog_json: '/home/user/catalog.json'},
			excludedKey: 'model_catalog_json',
			removedPath: ['model_catalog_json'],
			machinePath: '/home/user/catalog.json'
		},
		{
			name: 'model_instructions_file',
			document: {model_instructions_file: '/home/user/instructions.md'},
			excludedKey: 'model_instructions_file',
			removedPath: ['model_instructions_file'],
			machinePath: '/home/user/instructions.md'
		},
		{
			name: 'experimental_compact_prompt_file',
			document: {experimental_compact_prompt_file: '/home/user/compact.md'},
			excludedKey: 'experimental_compact_prompt_file',
			removedPath: ['experimental_compact_prompt_file'],
			machinePath: '/home/user/compact.md'
		},
		{
			name: 'skills.config 本地路径',
			document: {skills: {config: [{path: '/home/user/skills'}]}},
			excludedKey: 'skills.config',
			removedPath: ['skills', 'config'],
			machinePath: '/home/user/skills'
		},
		{
			name: 'agents.*.config_file',
			document: {agents: {reviewer: {config_file: '/home/user/agent.toml'}}},
			excludedKey: 'agents.reviewer.config_file',
			removedPath: ['agents', 'reviewer', 'config_file'],
			machinePath: '/home/user/agent.toml'
		},
		{
			name: 'desktop.custom_file_handlers',
			document: {desktop: {custom_file_handlers: {pdf: '/home/user/handler'}}},
			excludedKey: 'desktop.custom_file_handlers',
			removedPath: ['desktop', 'custom_file_handlers'],
			machinePath: '/home/user/handler'
		},
		{
			name: 'sandbox_workspace_write.writable_roots',
			document: {sandbox_workspace_write: {writable_roots: ['/home/user/extra']}},
			excludedKey: 'sandbox_workspace_write.writable_roots',
			removedPath: ['sandbox_workspace_write', 'writable_roots'],
			machinePath: '/home/user/extra'
		},
		{
			name: 'permissions.*.workspace_roots',
			document: {permissions: {default: {workspace_roots: [MACHINE_PATH]}}},
			excludedKey: 'permissions.default.workspace_roots',
			removedPath: ['permissions', 'default', 'workspace_roots'],
			machinePath: MACHINE_PATH
		},
		{
			name: 'permissions.*.filesystem 绝对路径 key',
			document: {permissions: {default: {filesystem: {[MACHINE_PATH]: 'read', 'relative-dir': 'read'}}}},
			excludedKey: 'permissions.default.filesystem',
			removedPath: ['permissions', 'default', 'filesystem', MACHINE_PATH],
			machinePath: MACHINE_PATH
		},
		{
			name: '本地 marketplace',
			document: {marketplaces: {'local-market': {source_type: 'local', path: '/home/user/market'}}},
			excludedKey: 'marketplaces.local-market',
			removedPath: ['marketplaces', 'local-market'],
			machinePath: '/home/user/market'
		},
		{
			name: 'mcp_servers 绝对 cwd（整条排除）',
			document: {mcp_servers: {'local-server': {command: 'npx', cwd: MACHINE_PATH}}},
			excludedKey: 'mcp_servers.local-server',
			removedPath: ['mcp_servers', 'local-server'],
			machinePath: MACHINE_PATH
		},
		{
			name: 'mcp_servers 绝对 command（整条排除）',
			document: {mcp_servers: {'abs-server': {command: 'C:\\bin\\server.exe'}, remote: {command: 'npx'}}},
			excludedKey: 'mcp_servers.abs-server',
			removedPath: ['mcp_servers', 'abs-server'],
			machinePath: 'C:\\bin\\server.exe'
		},
		{
			name: 'model_providers 绝对 auth.cwd（整条排除）',
			document: {model_providers: {abs: {name: 'abs', auth: {cwd: MACHINE_PATH}}}},
			excludedKey: 'model_providers.abs',
			removedPath: ['model_providers', 'abs'],
			machinePath: MACHINE_PATH
		},
		{
			name: 'model_providers 绝对 auth.command（整条排除）',
			document: {model_providers: {abs: {name: 'abs', auth: {command: 'C:\\bin\\auth.exe'}}}},
			excludedKey: 'model_providers.abs',
			removedPath: ['model_providers', 'abs'],
			machinePath: 'C:\\bin\\auth.exe'
		}
	];

	for (const testCase of cases) {
		test(`${testCase.name} 被移除且摘要只报键名`, () => {
			const result = portableCodexConfig(testCase.document);
			expect(getPath(result.config, testCase.removedPath), `${testCase.name} 必须从输出移除`).toBeUndefined();
			expect(result.excluded).toContainEqual({key: testCase.excludedKey});

			const serialized = JSON.stringify({config: result.config, excluded: result.excluded});
			if (testCase.machinePath) {
				expect(serialized, '输出与摘要都不得包含机器路径值').not.toContain(testCase.machinePath);
			}
		});
	}

	test('可迁移偏好、远程 provider/mcp 与相对 filesystem key 保留', () => {
		const document: TomlDocument = {
			model: 'portable-model',
			model_provider: 'remote',
			approval_policy: 'never',
			check_for_update_on_startup: true,
			analytics: {enabled: true},
			model_providers: {remote: {name: 'remote', base_url: 'https://remote.example'}},
			mcp_servers: {remote: {command: 'npx', args: ['-y']}},
			permissions: {default: {filesystem: {'relative-dir': 'read'}}}
		};

		const result = portableCodexConfig(document);
		expect(result.excluded).toEqual([]);
		expect(result.config).toEqual(document);
	});

	test('动态条目递归排除绝对 command/cwd，保留其余 provider/MCP 与未知偏好', () => {
		const document: TomlDocument = {
			model: 'portable-model',
			model_provider: 'remote',
			model_providers: {
				remote: {name: 'remote', auth: {command: 'get-token', cwd: '.'}},
				local: {name: 'local', auth: {nested: {command: 'C:\\bin\\auth.exe'}}}
			},
			mcp_servers: {remote: {command: 'npx'}, local: {command: 'npx', options: {cwd: MACHINE_PATH}}},
			tui: {theme: 'dark', resume_cwd: MACHINE_PATH},
			permissions: {default: {filesystem: {[MACHINE_PATH]: 'write', 'relative-dir': 'read'}, unknown: true}},
			unknown: {flag: true}
		};
		const before = structuredClone(document);
		const result = portableCodexConfig(document);
		expect(result.config).toEqual({
			model: 'portable-model',
			model_provider: 'remote',
			model_providers: {remote: document.model_providers && (document.model_providers as Record<string, unknown>).remote},
			mcp_servers: {remote: {command: 'npx'}},
			tui: {theme: 'dark'},
			permissions: {default: {filesystem: {'relative-dir': 'read'}, unknown: true}},
			unknown: {flag: true}
		});
		expect(result.excluded).toContainEqual({key: 'model_providers.local'});
		expect(result.excluded).toContainEqual({key: 'mcp_servers.local'});
		expect(JSON.stringify(result)).not.toContain(MACHINE_PATH);
		expect(document).toEqual(before);
	});

	test('原 document 不被修改（纯函数）', () => {
		const document: TomlDocument = {projects: {[MACHINE_PATH]: {trust_level: 'trusted'}}, approval_policy: 'never'};
		portableCodexConfig(document);
		expect(getPath(document, ['projects'])).toBeDefined();
	});
});

describe('通用设置导入导出', () => {
	test('Claude：快照剥离 provider env/model，导入保留本机未知字段与 token', () => {
		const home = createTempHome('ccq-transfer-cc-settings-');
		try {
			const settingsPath = join(home.path, '.claude', 'settings.json');
			writeFile(
				settingsPath,
				JSON.stringify({
					env: {ANTHROPIC_AUTH_TOKEN: SENTINEL, ANTHROPIC_BASE_URL: 'https://glm.example', USER_FLAG: 'u'},
					model: 'glm-4',
					hooks: {localHook: 'keep'},
					unknownField: {a: 1},
					permissions: {allow: ['local']}
				})
			);

			const snapshot = snapshotSettingsSection('cc');
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.text).not.toContain(SENTINEL);
			const projected = JSON.parse(snapshot.data.text) as Record<string, unknown>;
			expect(projected.model, 'provider-owned 顶层键不进设置分类').toBeUndefined();
			expect((projected.env as Record<string, string>).USER_FLAG).toBe('u');

			const bundleText = JSON.stringify({
				...projected,
				theme: 'bundle',
				hooks: {bundleHook: 'add'}
			});
			const imported = importSettingsSection('cc', {text: bundleText});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.replaced).toEqual(['settings']);

			const settings = JSON.parse(readText(settingsPath)) as {
				env: Record<string, string>;
				model: string;
				hooks: Record<string, string>;
				unknownField: Record<string, unknown>;
				theme: string;
			};
			expect(settings.env.ANTHROPIC_AUTH_TOKEN, '供应商凭据不得被设置分类改写').toBe(SENTINEL);
			expect(settings.env.USER_FLAG).toBe('u');
			expect(settings.model).toBe('glm-4');
			expect(settings.hooks).toEqual({localHook: 'keep', bundleHook: 'add'});
			expect(settings.unknownField).toEqual({a: 1});
			expect(settings.theme).toBe('bundle');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Claude：env 中的 API Key 未选凭据时被剥离并报告键名，选中时计入凭据并强制加密', async () => {
		const home = createTempHome('ccq-transfer-cc-settings-cred-');
		try {
			const settingsPath = join(home.path, '.claude', 'settings.json');
			writeFile(settingsPath, JSON.stringify({env: {ANTHROPIC_API_KEY: 'LOCAL-KEY', USER_FLAG: 'u'}, theme: 'dark'}));

			const noCreds = snapshotSettingsSection('cc');
			expect(noCreds.ok).toBe(true);
			if (!noCreds.ok) return;
			expect(noCreds.data.containsCredentials).toBe(false);
			expect(noCreds.data.credentialKeys).toEqual(['env.ANTHROPIC_API_KEY']);
			expect(noCreds.data.text).not.toContain('LOCAL-KEY');
			expect(noCreds.data.text).toContain('USER_FLAG');
			expect(noCreds.warnings.join('、'), '只报告键名').toContain('ANTHROPIC_API_KEY');

			const withCreds = snapshotSettingsSection('cc', {includeCredentials: true});
			expect(withCreds.ok).toBe(true);
			if (!withCreds.ok) return;
			expect(withCreds.data.containsCredentials, '选中凭据时必须标记为含凭据（导出强制加密）').toBe(true);
			expect(withCreds.data.text).toContain('LOCAL-KEY');
			// 导出计划层：未选凭据的包不得含该 key，且摘要列出被剥离的键名。
			const plainPlan = await planConfigTransferExport(
				{categories: [{tool: 'cc', category: 'settings'}], includeCredentials: false},
				{}
			);
			expect(plainPlan.ok).toBe(true);
			if (!plainPlan.ok) return;
			expect(plainPlan.data.containsCredentials).toBe(false);
			expect(JSON.stringify(plainPlan.data.sections)).not.toContain('LOCAL-KEY');
			expect(plainPlan.data.summaries[0]?.excludedCredentials, '导出摘要必须报告被剥离的凭据键名').toEqual(['env.ANTHROPIC_API_KEY']);

			const credentialPlan = await planConfigTransferExport(
				{categories: [{tool: 'cc', category: 'settings'}], includeCredentials: true},
				{}
			);
			expect(credentialPlan.ok).toBe(true);
			if (!credentialPlan.ok) return;
			expect(credentialPlan.data.containsCredentials, '含凭据导出必须要求密码').toBe(true);

			// 导入防御：包声称不含凭据时，夹带的凭据 env 键不写入本机。
			const smuggled = importSettingsSection('cc', {text: JSON.stringify({env: {ANTHROPIC_API_KEY: SENTINEL}})});
			expect(smuggled.ok).toBe(true);
			expect(readText(settingsPath), '本机原值必须保留，包内凭据不得写入').toContain('LOCAL-KEY');
			expect(readText(settingsPath)).not.toContain(SENTINEL);

			// 显式声明含凭据时才写入。
			const explicit = importSettingsSection(
				'cc',
				{text: JSON.stringify({env: {ANTHROPIC_API_KEY: SENTINEL}})},
				{containsCredentials: true}
			);
			expect(explicit.ok).toBe(true);
			expect(readText(settingsPath)).toContain(SENTINEL);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Pi：顶层凭据键同样按敏感选项处理，导入不写入未声明的凭据', () => {
		const home = createTempHome('ccq-transfer-pi-settings-cred-');
		try {
			const settingsPath = join(home.path, '.pi', 'agent', 'settings.json');
			writeFile(settingsPath, JSON.stringify({theme: 'dark', apiKey: 'PI-LOCAL-KEY'}));

			const noCreds = snapshotSettingsSection('pi');
			expect(noCreds.ok).toBe(true);
			if (!noCreds.ok) return;
			expect(noCreds.data.credentialKeys).toEqual(['apiKey']);
			expect(noCreds.data.text).not.toContain('PI-LOCAL-KEY');
			expect(noCreds.data.text).toContain('theme');

			const withCreds = snapshotSettingsSection('pi', {includeCredentials: true});
			expect(withCreds.ok).toBe(true);
			if (!withCreds.ok) return;
			expect(withCreds.data.containsCredentials).toBe(true);

			const smuggled = importSettingsSection('pi', {text: JSON.stringify({apiKey: SENTINEL, theme: 'light'})});
			expect(smuggled.ok).toBe(true);
			const after = readText(settingsPath);
			expect(after, '包内凭据不得写入').not.toContain(SENTINEL);
			expect(after).toContain('PI-LOCAL-KEY');
			expect(JSON.parse(after).theme, '非凭据字段仍按包值合并').toBe('light');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Pi：deviceId 不进入导出，导入不覆盖本机 deviceId', () => {
		const home = createTempHome('ccq-transfer-pi-device-');
		try {
			const settingsPath = join(home.path, '.pi', 'agent', 'settings.json');
			writeFile(settingsPath, JSON.stringify({deviceId: 'local-device', theme: 'dark'}));
			const snapshot = snapshotSettingsSection('pi');
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.text).not.toContain('deviceId');
			const imported = importSettingsSection('pi', {text: JSON.stringify({deviceId: 'foreign-device', theme: 'light'})});
			expect(imported.ok).toBe(true);
			expect(JSON.parse(readText(settingsPath))).toEqual({deviceId: 'local-device', theme: 'light'});
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Codex：快照过滤本机绑定，导入保留本机未知 section/mcp 并拒绝包内机器路径', () => {
		const home = createTempHome('ccq-transfer-cx-settings-');
		try {
			const configPath = join(home.path, '.codex', 'config.toml');
			writeFile(
				configPath,
				[
					'approval_policy = "never"',
					'',
					`[projects."${MACHINE_PATH}"]`,
					'trust_level = "trusted"',
					'',
					'[hooks]',
					'on_start = "local"',
					'',
					'[unknown_section]',
					'flag = true',
					'',
					'[mcp_servers.local]',
					'command = "npx"'
				].join('\n')
			);

			const snapshot = snapshotSettingsSection('cx');
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.text).not.toContain(MACHINE_PATH);
			expect(snapshot.warnings.some(warning => warning.includes('projects'))).toBe(true);

			const bundleText = [
				'approval_policy = "on-request"',
				'model_reasoning_effort = "high"',
				'',
				`[projects."/evil/foreign-path"]`,
				'trust_level = "trusted"',
				'',
				'[tui]',
				'theme = "dark"'
			].join('\n');
			const imported = importSettingsSection('cx', {text: bundleText});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;

			const config = readText(configPath);
			expect(config).toContain('approval_policy = "on-request"');
			expect(config).toContain('model_reasoning_effort = "high"');
			expect(config).toContain('[hooks]');
			expect(config).toContain('[unknown_section]');
			expect(config).toContain('[mcp_servers.local]');
			expect(config).not.toContain('/evil/foreign-path');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Pi：导入保留本机 auth/models/mcp 与其他未知字段', () => {
		const home = createTempHome('ccq-transfer-pi-settings-');
		try {
			const settingsPath = join(home.path, '.pi', 'agent', 'settings.json');
			writeFile(
				settingsPath,
				JSON.stringify({
					theme: 'dark',
					auth: {provider: {type: 'api_key', key: SENTINEL}},
					models: {provider: {api: 'openai-completions'}},
					mcp: {servers: {}},
					unknownFlag: 1
				})
			);

			const snapshot = snapshotSettingsSection('pi');
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.text).not.toContain(SENTINEL);

			const imported = importSettingsSection('pi', {
				text: JSON.stringify({theme: 'light', defaultProvider: 'custom-acme'})
			});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;

			const settings = JSON.parse(readText(settingsPath)) as Record<string, unknown>;
			expect(settings.theme).toBe('light');
			expect(settings.defaultProvider).toBe('custom-acme');
			expect(settings.auth, '其他模块受保护字段必须保留').toEqual({provider: {type: 'api_key', key: SENTINEL}});
			expect(settings.models).toEqual({provider: {api: 'openai-completions'}});
			expect(settings.mcp).toEqual({servers: {}});
			expect(settings.unknownFlag).toBe(1);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('损坏本机设置阻断对应分类且字节不变；dryRun 零写盘', () => {
		const home = createTempHome('ccq-transfer-settings-guard-');
		try {
			const targets = {
				cc: join(home.path, '.claude', 'settings.json'),
				cx: join(home.path, '.codex', 'config.toml'),
				pi: join(home.path, '.pi', 'agent', 'settings.json')
			} as const;
			const bundle = {cc: '{"theme":"bundle"}', cx: 'theme = "bundle"', pi: '{"theme":"bundle"}'} as const;

			for (const tool of ['cc', 'cx', 'pi'] as const) {
				writeFile(targets[tool], tool === 'cx' ? 'not = = toml' : '{broken');
				const before = readText(targets[tool]);
				const blocked = importSettingsSection(tool, {text: bundle[tool]});
				expect(blocked.ok, `${tool} 损坏目标必须阻断`).toBe(false);
				if (!blocked.ok) {
					expect(blocked.kind).toBe('conflict');
				}

				expect(readText(targets[tool])).toBe(before);
			}

			writeFile(targets.pi, JSON.stringify({theme: 'dark'}));
			const beforeDryRun = readText(targets.pi);
			const preview = importSettingsSection('pi', {text: bundle.pi}, {dryRun: true});
			expect(preview.ok).toBe(true);
			expect(readText(targets.pi)).toBe(beforeDryRun);

			expect(parseSettingsSection('cc', {text: '{bad'}).ok).toBe(false);
			expect(parseSettingsSection('cx', {text: 'not = = toml'}).ok).toBe(false);
			expect(parseSettingsSection('pi', {text: '[1,2]'}).ok).toBe(false);
			expect(parseSettingsSection('pi', {text: ''}).ok).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('全局规则导入导出', () => {
	test('Claude：采集 CLAUDE.md 与 rules/**，导入按路径合并且不删除本机文件', () => {
		const home = createTempHome('ccq-transfer-cc-rules-');
		try {
			writeFile(join(home.path, '.claude', 'CLAUDE.md'), '# main');
			writeFile(join(home.path, '.claude', 'rules', 'a.md'), 'A');
			writeFile(join(home.path, '.claude', 'rules', 'nested', 'b.md'), 'B');
			writeFile(join(home.path, '.claude', 'rules', 'local-only.md'), 'L');
			writeFile(join(home.path, '.claude', 'skills', 'keep.md'), 'S');

			const snapshot = snapshotRulesSection('cc');
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.entries.map(entry => entry.path).sort()).toEqual([
				'CLAUDE.md',
				'rules/a.md',
				'rules/local-only.md',
				'rules/nested/b.md'
			]);

			const imported = importRulesSection('cc', {
				entries: [
					fileEntry('claude', 'CLAUDE.md', '# changed'),
					fileEntry('claude', 'rules/a.md', 'A2'),
					fileEntry('claude', 'rules/new.md', 'N')
				]
			});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['rules/new.md']);
			expect(imported.data.replaced).toEqual(['CLAUDE.md', 'rules/a.md']);

			expect(readText(join(home.path, '.claude', 'CLAUDE.md'))).toBe('# changed');
			expect(readText(join(home.path, '.claude', 'rules', 'a.md'))).toBe('A2');
			expect(readText(join(home.path, '.claude', 'rules', 'new.md'))).toBe('N');
			expect(readText(join(home.path, '.claude', 'rules', 'local-only.md')), '包中未出现的本机规则不得删除').toBe('L');
			expect(readText(join(home.path, '.claude', 'rules', 'nested', 'b.md'))).toBe('B');
			expect(readText(join(home.path, '.claude', 'skills', 'keep.md')), '规则分类不得读取或改写 Skills').toBe('S');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Pi/Codex：只写全局 AGENTS.md，项目级文件不受影响', () => {
		const home = createTempHome('ccq-transfer-pi-rules-');
		const originalCwd = process.cwd();
		try {
			writeFile(join(home.path, '.pi', 'agent', 'AGENTS.md'), 'global-old');
			writeFile(join(home.path, '.pi', 'AGENTS.md'), 'project-keep');
			writeFile(join(home.path, '.codex', 'AGENTS.md'), 'codex-old');

			process.chdir(home.path);
			const piSnapshot = snapshotRulesSection('pi');
			expect(piSnapshot.ok).toBe(true);
			if (!piSnapshot.ok) return;
			expect(piSnapshot.data.entries.map(entry => entry.path)).toEqual(['AGENTS.md']);
			expect(piSnapshot.data.entries[0]?.root).toBe('pi-agent');

			const imported = importRulesSection('pi', {entries: [fileEntry('pi-agent', 'AGENTS.md', 'global-new')]});
			expect(imported.ok).toBe(true);
			expect(readText(join(home.path, '.pi', 'agent', 'AGENTS.md'))).toBe('global-new');
			expect(readText(join(home.path, '.pi', 'AGENTS.md')), '项目级规则不得被读取或修改').toBe('project-keep');

			const codexImported = importRulesSection('cx', {entries: [fileEntry('codex', 'AGENTS.md', 'codex-new')]});
			expect(codexImported.ok).toBe(true);
			expect(readText(join(home.path, '.codex', 'AGENTS.md'))).toBe('codex-new');
		} finally {
			process.chdir(originalCwd);
			home.restore();
			home.cleanup();
		}
	});

	test('规则分类只接受该工具受支持的相对路径；不安全符号链接被跳过', () => {
		expect(parseRulesSection('pi', {entries: [fileEntry('pi-agent', 'AGENTS.md', 'x')]}).ok).toBe(true);
		expect(parseRulesSection('pi', {entries: [fileEntry('pi-agent', 'settings.json', 'x')]}).ok).toBe(false);
		expect(parseRulesSection('cc', {entries: [fileEntry('codex', 'CLAUDE.md', 'x')]}).ok).toBe(false);
		expect(parseRulesSection('cc', {entries: [fileEntry('claude', 'rules/../../escape.md', 'x')]}).ok).toBe(false);
		expect(parseRulesSection('cc', {entries: [fileEntry('claude', '/abs.md', 'x')]}).ok).toBe(false);

		if (process.platform === 'win32') {
			return;
		}

		const home = createTempHome('ccq-transfer-rules-symlink-');
		try {
			writeFile(join(home.path, '.claude', 'rules', 'ok.md'), 'ok');
			writeFile(join(home.path, 'outside.md'), 'outside');
			symlinkSync(join(home.path, 'outside.md'), join(home.path, '.claude', 'rules', 'escape.md'));
			symlinkSync('../ok.md', join(home.path, '.claude', 'rules', 'inside-link.md'));

			const snapshot = snapshotRulesSection('cc');
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			const paths = snapshot.data.entries.map(entry => entry.path).sort();
			expect(paths).toContain('rules/inside-link.md');
			expect(paths, '逃出 root 的符号链接必须跳过').not.toContain('rules/escape.md');
			expect(snapshot.warnings.some(warning => warning.includes('escape.md'))).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('mergeTransferDocuments', () => {
	test('对象递归合并，包值覆盖，本机独有键与数组替换语义明确', () => {
		expect(
			mergeTransferDocuments({keep: 1, nested: {a: 1, b: 2}, list: [1, 2]}, {nested: {b: 3, c: 4}, list: [9], added: true})
		).toEqual({keep: 1, nested: {a: 1, b: 3, c: 4}, list: [9], added: true});
	});
});
