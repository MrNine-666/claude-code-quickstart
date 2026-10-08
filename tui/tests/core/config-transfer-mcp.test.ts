import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';

import {
	importClaudeMcpSection,
	importCodexMcpSection,
	importMcpLibrarySection,
	importPiMcpSection,
	parseMcpLibrarySection,
	parsePiMcpSection,
	snapshotClaudeMcpSection,
	snapshotCodexMcpSection,
	snapshotMcpLibrarySection,
	snapshotPiMcpSection
} from '../../src/core/config-transfer-mcp.js';
import {createTempHome} from '../helpers/temp-home.js';

// Phase 2 Part B：MCP（CCQ vault + CC/CX/Pi runtime）导入导出 seam。全部使用临时 CCQ_HOME。

const SENTINEL = 'SENTINEL-MCP-SECRET-c0ffee';

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

describe('CCQ MCP 共享库', () => {
	test('定义与元数据 roundtrip；未选择凭据时 vault 值不进入快照', () => {
		const home = createTempHome('ccq-transfer-mcp-lib-');
		try {
			const vaultPath = join(home.path, '.ccq', 'mcp-meta.json');
			writeFile(
				vaultPath,
				JSON.stringify({
					schemaVersion: 1,
					createdAt: '2026-01-01T00:00:00.000Z',
					updatedAt: '2026-01-01T00:00:00.000Z',
					servers: {
						context7: {
							config: {type: 'http', url: 'https://mcp.context7.com/mcp', headers: {CONTEXT7_API_KEY: SENTINEL}},
							credentials: {values: {CONTEXT7_API_KEY: SENTINEL}},
							permissions: ['mcp__context7'],
							definitionHash: 'abcd1234',
							updatedAt: '2026-01-01T00:00:00.000Z'
						},
						local: {config: {command: 'npx', env: {LOCAL_KEY: SENTINEL}}}
					}
				})
			);
			// self-update 缓存必须永不被采集。
			writeFile(join(home.path, '.ccq', 'self-update', 'cache.bin'), `CACHE-${SENTINEL}`);
			const cacheBytes = readText(join(home.path, '.ccq', 'self-update', 'cache.bin'));

			const snapshot = snapshotMcpLibrarySection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(JSON.stringify(snapshot.data)).not.toContain(SENTINEL);
			expect(snapshot.data.containsCredentials).toBe(false);
			expect(snapshot.data.excludedCredentials).toEqual([
				{id: 'context7', keys: ['headers:CONTEXT7_API_KEY', 'credentials:CONTEXT7_API_KEY']},
				{id: 'local', keys: ['env:LOCAL_KEY']}
			]);
			const context7 = snapshot.data.servers.find(server => server.id === 'context7');
			expect(context7?.config).toEqual({type: 'http', url: 'https://mcp.context7.com/mcp'});
			expect(context7?.permissions).toEqual(['mcp__context7']);
			expect(context7?.definitionHash).toBe('abcd1234');
			expect(readText(join(home.path, '.ccq', 'self-update', 'cache.bin'))).toBe(cacheBytes);

			const withCredentials = snapshotMcpLibrarySection({includeCredentials: true});
			expect(withCredentials.ok).toBe(true);
			if (!withCredentials.ok) return;
			expect(withCredentials.data.containsCredentials).toBe(true);
			expect(JSON.stringify(withCredentials.data)).toContain(SENTINEL);

			rmSync(join(home.path, '.ccq'), {recursive: true, force: true});
			const imported = importMcpLibrarySection(snapshot.data, {containsCredentials: false});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['context7', 'local']);
			const vault = readJson(vaultPath) as {servers: Record<string, Record<string, unknown>>};
			expect(vault.servers.context7?.permissions).toEqual(['mcp__context7']);
			expect(vault.servers.context7?.definitionHash).toBe('abcd1234');
			expect(JSON.stringify(vault)).not.toContain(SENTINEL);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('含凭据快照导入后恢复 vault 凭据；未声明的凭据被拒绝', () => {
		const home = createTempHome('ccq-transfer-mcp-lib-cred-');
		try {
			writeFile(
				join(home.path, '.ccq', 'mcp-meta.json'),
				JSON.stringify({
					schemaVersion: 1,
					createdAt: 'x',
					updatedAt: 'x',
					servers: {context7: {config: {url: 'https://example.com'}, credentials: {values: {KEY: SENTINEL}}}}
				})
			);

			const snapshot = snapshotMcpLibrarySection({includeCredentials: true});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			rmSync(join(home.path, '.ccq'), {recursive: true, force: true});
			const imported = importMcpLibrarySection(snapshot.data, {containsCredentials: true});
			expect(imported.ok).toBe(true);
			const vault = readJson(join(home.path, '.ccq', 'mcp-meta.json')) as {servers: Record<string, {credentials?: unknown}>};
			expect(vault.servers.context7?.credentials).toEqual({values: {KEY: SENTINEL}});

			const rejected = importMcpLibrarySection(
				{schemaVersion: 1, containsCredentials: false, servers: [{id: 'x', config: {}, permissions: [], credentials: {KEY: 'v'}}]},
				{containsCredentials: false}
			);
			expect(rejected.ok).toBe(false);
			expect(parseMcpLibrarySection({schemaVersion: 99, containsCredentials: false, servers: []}).ok).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('损坏 vault 在导入前阻断且字节不变', () => {
		const home = createTempHome('ccq-transfer-mcp-lib-corrupt-');
		try {
			const vaultPath = join(home.path, '.ccq', 'mcp-meta.json');
			writeFile(vaultPath, '{broken');
			const imported = importMcpLibrarySection(
				{schemaVersion: 1, containsCredentials: false, servers: []},
				{containsCredentials: false}
			);
			expect(imported.ok).toBe(false);
			expect(readText(vaultPath)).toBe('{broken');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Claude MCP runtime', () => {
	test('同 server id 覆盖；.claude.json 无关键与本机 server 保留', () => {
		const home = createTempHome('ccq-transfer-mcp-cc-');
		try {
			const claudeJsonPath = join(home.path, '.claude.json');
			writeFile(
				claudeJsonPath,
				JSON.stringify({
					projects: {'/home/user/project': {trust_level: 'trusted'}},
					otherTopLevel: {keep: true},
					mcpServers: {local: {command: 'npx', args: ['local']}, shared: {command: 'old'}}
				})
			);
			writeFile(
				join(home.path, '.claude', 'settings.json'),
				JSON.stringify({theme: 'dark', permissions: {allow: ['Bash(ls)', 'mcp__local']}})
			);

			const imported = importClaudeMcpSection(
				{
					containsCredentials: false,
					servers: [
						{id: 'shared', config: {command: 'new'}},
						{id: 'added', config: {type: 'http', url: 'https://example.com/mcp'}}
					],
					permissions: ['mcp__shared', 'mcp__added']
				},
				{containsCredentials: false}
			);
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['added']);
			expect(imported.data.replaced).toEqual(['shared']);

			const document = readJson(claudeJsonPath) as Record<string, unknown> & {mcpServers: Record<string, unknown>};
			expect(document.projects).toEqual({'/home/user/project': {trust_level: 'trusted'}});
			expect(document.otherTopLevel).toEqual({keep: true});
			expect(document.mcpServers.local).toEqual({command: 'npx', args: ['local']});
			expect(document.mcpServers.shared).toEqual({command: 'new'});
			expect(document.mcpServers.added).toEqual({type: 'http', url: 'https://example.com/mcp'});

			const settings = readJson(join(home.path, '.claude', 'settings.json')) as {
				theme: string;
				permissions: {allow: string[]};
			};
			expect(settings.permissions.allow).toEqual(['Bash(ls)', 'mcp__local', 'mcp__shared', 'mcp__added']);
			expect(settings.theme).toBe('dark');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('明文包声称不含凭据时，包内 env 值不会写入本机', () => {
		const home = createTempHome('ccq-transfer-mcp-sanitize-');
		try {
			const claudeJsonPath = join(home.path, '.claude.json');
			writeFile(claudeJsonPath, JSON.stringify({mcpServers: {srv: {command: 'npx', env: {LOCAL: 'keep'}}}}));

			const imported = importClaudeMcpSection(
				{containsCredentials: false, servers: [{id: 'srv', config: {command: 'npx', env: {INJECTED: SENTINEL}}}], permissions: []},
				{containsCredentials: false}
			);
			expect(imported.ok).toBe(true);
			const document = readJson(claudeJsonPath) as {mcpServers: Record<string, {env?: Record<string, string>}>};
			expect(document.mcpServers.srv?.env).toEqual({LOCAL: 'keep'});
			expect(JSON.stringify(document)).not.toContain(SENTINEL);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('未选择凭据时 env/headers 值不出现在快照；损坏目标阻断导入', () => {
		const home = createTempHome('ccq-transfer-mcp-cc-cred-');
		try {
			const claudeJsonPath = join(home.path, '.claude.json');
			writeFile(
				claudeJsonPath,
				JSON.stringify({
					mcpServers: {srv: {command: 'npx', env: {API_KEY: SENTINEL}, headers: {Authorization: SENTINEL}}}
				})
			);

			const snapshot = snapshotClaudeMcpSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(JSON.stringify(snapshot.data)).not.toContain(SENTINEL);
			expect(snapshot.data.containsCredentials).toBe(false);
			expect(snapshot.data.excludedCredentials).toEqual([{id: 'srv', keys: ['env:API_KEY', 'headers:Authorization']}]);
			expect(snapshot.data.servers[0]?.config).toEqual({command: 'npx'});

			const withCredentials = snapshotClaudeMcpSection({includeCredentials: true});
			expect(withCredentials.ok).toBe(true);
			if (!withCredentials.ok) return;
			expect(withCredentials.data.containsCredentials).toBe(true);
			expect(JSON.stringify(withCredentials.data)).toContain(SENTINEL);

			writeFile(claudeJsonPath, '{broken');
			const blocked = importClaudeMcpSection(
				{containsCredentials: false, servers: [], permissions: []},
				{containsCredentials: false}
			);
			expect(blocked.ok).toBe(false);
			expect(readText(claudeJsonPath)).toBe('{broken');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Codex MCP runtime', () => {
	test('绝对 cwd 条目整条排除且只报告 id；本机 server 与其他 TOML section 保留', () => {
		const home = createTempHome('ccq-transfer-mcp-cx-');
		try {
			const configPath = join(home.path, '.codex', 'config.toml');
			writeFile(
				configPath,
				[
					'model = "gpt-5"',
					'',
					'[mcp_servers.portable]',
					'command = "npx"',
					'',
					'[mcp_servers.hostbound]',
					'command = "npx"',
					'cwd = "/home/user/project"',
					'',
					'[other_section]',
					'keep = true'
				].join('\n')
			);

			const snapshot = snapshotCodexMcpSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.servers.map(server => server.id)).toEqual(['portable']);
			expect(snapshot.data.excluded).toEqual(['hostbound']);
			expect(JSON.stringify(snapshot.data)).not.toContain('/home/user/project');

			const imported = importCodexMcpSection(
				{
					containsCredentials: false,
					servers: [
						{id: 'portable', config: {command: 'npx', args: ['-y', 'pkg']}},
						{id: 'fresh', config: {command: 'uvx'}},
						{id: 'blocked-host', config: {command: 'npx', cwd: '/home/user/other'}}
					]
				},
				{containsCredentials: false}
			);
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['fresh']);
			expect(imported.data.replaced).toEqual(['portable']);
			expect(imported.data.skipped).toEqual(['blocked-host']);

			const text = readText(configPath);
			expect(text).toContain('model = "gpt-5"');
			expect(text).toContain('[mcp_servers.hostbound]');
			expect(text).toContain('[other_section]');
			expect(text).toContain('[mcp_servers.fresh]');
			expect(text).toContain('args = [');
			expect(text).toContain('"pkg"');
			expect(text).not.toContain('blocked-host');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Codex 凭据剥离与损坏 config 阻断', () => {
		const home = createTempHome('ccq-transfer-mcp-cx-cred-');
		try {
			const configPath = join(home.path, '.codex', 'config.toml');
			writeFile(configPath, ['[mcp_servers.srv]', 'command = "npx"', 'env = {API_KEY = "SENTINEL-MCP-SECRET-c0ffee"}'].join('\n'));

			const snapshot = snapshotCodexMcpSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(JSON.stringify(snapshot.data)).not.toContain(SENTINEL);
			expect(snapshot.data.excludedCredentials).toEqual([{id: 'srv', keys: ['env:API_KEY']}]);

			writeFile(configPath, 'not = = toml');
			const blocked = importCodexMcpSection({containsCredentials: false, servers: []}, {containsCredentials: false});
			expect(blocked.ok).toBe(false);
			expect(readText(configPath)).toBe('not = = toml');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});

describe('Pi MCP runtime', () => {
	test('sidecar 未知字段与本机 server 保留；按 server id 合并', () => {
		const home = createTempHome('ccq-transfer-mcp-pi-');
		try {
			const nativePath = join(home.path, '.pi', 'agent', 'mcp.json');
			const overridePath = join(home.path, '.pi', 'agent', 'mcp-adapter-overrides.json');
			writeFile(
				nativePath,
				JSON.stringify({
					unknownTop: {keep: 1},
					mcpServers: {
						localOnly: {command: 'npx', args: ['local']},
						shared: {command: 'old', env: {API_KEY: SENTINEL}}
					}
				})
			);
			writeFile(
				overridePath,
				JSON.stringify({
					schemaVersion: 1,
					dialect: 'pi-native',
					unknownFlag: 'keep',
					managedServers: ['shared', 'localOnly'],
					servers: {shared: {enabled: true, custom: 'keep'}, localOnly: {enabled: false}}
				})
			);

			const snapshot = snapshotPiMcpSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(JSON.stringify(snapshot.data)).not.toContain(SENTINEL);
			expect(snapshot.data.excludedCredentials).toEqual([{id: 'shared', keys: ['env:API_KEY']}]);
			expect(snapshot.data.overrides).toEqual([
				{id: 'localOnly', config: {enabled: true}},
				{id: 'shared', config: {enabled: true}}
			]);

			const imported = importPiMcpSection(
				{
					dialect: 'pi-native',
					containsCredentials: false,
					servers: [
						{id: 'shared', config: {command: 'new'}},
						{id: 'added', config: {command: 'uvx'}}
					],
					overrides: [{id: 'added', config: {enabled: true}}]
				},
				{containsCredentials: false}
			);
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['added']);
			expect(imported.data.replaced).toEqual(['shared', 'ownership']);

			const native = readJson(nativePath) as Record<string, unknown> & {mcpServers: Record<string, unknown>};
			expect(native.unknownTop).toEqual({keep: 1});
			expect(native.mcpServers.localOnly).toEqual({command: 'npx', args: ['local']});
			expect(native.mcpServers.shared, '本机未出现在包中的凭据必须保留').toEqual({
				command: 'new',
				env: {API_KEY: SENTINEL}
			});
			expect(native.mcpServers.added).toEqual({command: 'uvx', enabled: false});

			const override = readJson(overridePath) as Record<string, unknown> & {
				managedServers: string[];
				servers: Record<string, unknown>;
			};
			expect(override.unknownFlag).toBe('keep');
			expect(override.managedServers).toEqual(['shared', 'localOnly', 'added']);
			expect(override.servers.shared).toEqual({enabled: true, custom: 'keep'});
			expect(override.servers.added).toEqual({enabled: false});

			expect(parsePiMcpSection({servers: [], overrides: [{id: 'x', config: {}}]}).ok).toBe(false);
			expect(existsSync(nativePath)).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Pi auth/oauth 登录字段永不进入快照', () => {
		const home = createTempHome('ccq-transfer-mcp-pi-auth-');
		try {
			writeFile(
				join(home.path, '.pi', 'agent', 'mcp.json'),
				JSON.stringify({
					mcpServers: {
						remote: {
							url: 'https://example.com/mcp',
							oauth: {refreshToken: SENTINEL},
							auth: {type: 'oauth', token: SENTINEL},
							bearerTokenStore: '/home/user/.pi/tokens.json'
						}
					}
				})
			);

			const snapshot = snapshotPiMcpSection({includeCredentials: true});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(JSON.stringify(snapshot.data)).not.toContain(SENTINEL);
			expect(JSON.stringify(snapshot.data)).not.toContain('/home/user/.pi/tokens.json');
			expect(snapshot.data.servers).toEqual([]);
			expect(snapshot.warnings).toContain('Pi MCP remote schema 不受支持，未导出');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
