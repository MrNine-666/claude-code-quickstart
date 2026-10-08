import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, spyOn, test} from 'bun:test';
import {importMcpLibrarySection, importPiMcpSection, parsePiMcpSection, snapshotPiMcpSection} from '../../src/core/config-transfer-mcp.js';
import {applyConfigTransferImport, planConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {createBundlePayload} from '../../src/core/config-transfer.js';
import * as fsUtils from '../../src/core/fs-utils.js';
import {writePiMcpDocuments} from '../../src/core/pi-mcp-adapter.js';
import {createTempHome} from '../helpers/temp-home.js';

const SECRET = 'SENTINEL-NATIVE-OAUTH-SECRET';
function write(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
function read(path: string): string {
	return readFileSync(path, 'utf8');
}
function json(path: string): {
	mcpServers: {remote: Record<string, unknown>; old: Record<string, unknown>; local: Record<string, unknown>};
	autoEnableCodemode?: boolean;
	userRoot?: boolean;
} {
	return JSON.parse(read(path));
}
function section(servers: unknown[], extra = {}) {
	return {dialect: 'pi-native', containsCredentials: false, servers, overrides: [], managedServers: [], ...extra};
}

describe('Pi native MCP bundle dialect、安全与事务', () => {
	test('enabled/root/静态 OAuth 与完整 owned id roundtrip；secret 可选，登录态/旧 runtime 永不采集', () => {
		const home = createTempHome('ccq-transfer-native-');
		try {
			const dir = join(home.path, '.pi', 'agent');
			const path = join(dir, 'mcp.json');
			write(path, {
				autoEnableCodemode: false,
				mcpServers: {
					remote: {
						url: 'https://example.com/mcp',
						enabled: false,
						timeout: 12,
						exposure: 'deferred',
						oauth: {clientId: 'id', clientSecret: SECRET, callbackPort: 8765, scope: 'read'}
					}
				}
			});
			write(join(dir, 'mcp-adapter-overrides.json'), {
				schemaVersion: 1,
				dialect: 'pi-native',
				servers: {},
				managedServers: ['remote']
			});
			write(join(dir, 'mcp-auth.json'), {refreshToken: SECRET});
			write(join(dir, 'mcp-adapter.json'), {mcpServers: {old_only: {command: 'old', disabled: true}}});
			const snapshot = snapshotPiMcpSection({includeCredentials: false});
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.dialect).toBe('pi-native');
			expect(snapshot.data.autoEnableCodemode).toBe(false);
			expect(snapshot.data.managedServers).toEqual(['remote']);
			expect(snapshot.data.overrides).toEqual([{id: 'remote', config: {enabled: false}}]);
			expect(snapshot.data.excludedCredentials).toEqual([{id: 'remote', keys: ['oauth:clientSecret']}]);
			expect(snapshot.data.servers[0]?.config.oauth).toEqual({clientId: 'id', callbackPort: 8765, scope: 'read'});
			expect(JSON.stringify(snapshot)).not.toContain(SECRET);
			expect(JSON.stringify(snapshot)).not.toContain('old_only');
			const credentialSnapshot = snapshotPiMcpSection({includeCredentials: true});
			expect(credentialSnapshot.ok && credentialSnapshot.data.containsCredentials).toBe(true);
			expect(JSON.stringify(credentialSnapshot)).toContain(SECRET);
			rmSync(path);
			rmSync(join(dir, 'mcp-adapter-overrides.json'));
			expect(importPiMcpSection(snapshot.data, {containsCredentials: false}).ok).toBe(true);
			expect(json(path).mcpServers.remote.enabled).toBe(false);
			expect(json(path).autoEnableCodemode).toBe(false);
			expect(json(path).mcpServers.remote.oauth).toEqual({clientId: 'id', callbackPort: 8765, scope: 'read'});
			expect(read(join(dir, 'mcp-auth.json'))).toContain(SECRET);
			expect(read(join(dir, 'mcp-adapter.json'))).toContain('old_only');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('Pi 1.0.0 native dialect required；legacy bundle、冲突、SSE、安全字段与未知 dialect 拒绝', () => {
		const home = createTempHome('ccq-transfer-legacy-');
		try {
			const path = join(home.path, '.pi', 'agent', 'mcp.json');
			const legacy = {
				containsCredentials: false,
				servers: [{id: 'old', config: {command: 'npx', disabled: true}}],
				overrides: [{id: 'old', config: {enabled: true}}]
			};
			write(path, {mcpServers: {}});
			expect(importPiMcpSection(legacy, {containsCredentials: false}).ok).toBe(false);
			const before = read(path);
			for (const config of [
				{command: 'npx', disabled: true, enabled: true},
				{type: 'sse', url: 'https://example.com/sse'},
				{command: 'npx', inheritEnv: false},
				{url: 'https://example.com', oauth: {refreshToken: SECRET}}
			]) {
				const blocked = importPiMcpSection(section([{id: 'old', config}]), {containsCredentials: true});
				expect(blocked.ok).toBe(false);
				expect(JSON.stringify(blocked)).not.toContain(SECRET);
				expect(read(path)).toBe(before);
			}
			expect(parsePiMcpSection(section([], {dialect: 'future'})).ok).toBe(false);
			expect(parsePiMcpSection(section([{id: 'bad.id', config: {command: 'npx'}}])).ok).toBe(false);
			expect(parsePiMcpSection(section([], {managedServers: ['outside']})).ok).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('URL 改变清理旧 headers/oauth；不带凭据包不能注入 clientSecret，明确新凭据可用', () => {
		const home = createTempHome('ccq-transfer-url-');
		try {
			const path = join(home.path, '.pi', 'agent', 'mcp.json');
			write(path, {
				userRoot: true,
				mcpServers: {
					remote: {
						url: 'https://old.example/mcp',
						headers: {Authorization: SECRET},
						oauth: {clientId: 'old', clientSecret: SECRET},
						custom: 'keep'
					},
					local: {command: 'keep'}
				}
			});
			const incoming = section([
				{id: 'remote', config: {url: 'https://new.example/mcp', oauth: {clientId: 'new', clientSecret: 'INJECTED'}}}
			]);
			expect(importPiMcpSection(incoming, {containsCredentials: false}).ok).toBe(true);
			expect(json(path).mcpServers.remote).toEqual({url: 'https://new.example/mcp', oauth: {clientId: 'new'}, custom: 'keep'});
			expect(json(path).mcpServers.local).toEqual({command: 'keep'});
			expect(json(path).userRoot).toBe(true);
			expect(read(path)).not.toContain(SECRET);
			expect(read(path)).not.toContain('INJECTED');
			const explicit = section(
				[
					{
						id: 'remote',
						config: {url: 'https://next.example/mcp', headers: {Authorization: 'NEW'}, oauth: {clientSecret: 'NEW-OAUTH'}}
					}
				],
				{containsCredentials: true}
			);
			expect(importPiMcpSection(explicit, {containsCredentials: true}).ok).toBe(true);
			expect(json(path).mcpServers.remote.headers).toEqual({Authorization: 'NEW'});
			expect(json(path).mcpServers.remote.oauth).toEqual({clientSecret: 'NEW-OAUTH'});
			expect(importPiMcpSection(section([{id: 'remote', config: {command: 'npx'}}]), {containsCredentials: false}).ok).toBe(true);
			expect(json(path).mcpServers.remote).toEqual({command: 'npx', custom: 'keep'});
			expect(
				importPiMcpSection(section([{id: 'remote', config: {url: 'https://http.example/mcp'}}]), {containsCredentials: false}).ok
			).toBe(true);
			expect(json(path).mcpServers.remote).toEqual({url: 'https://http.example/mcp', custom: 'keep'});
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('共享库 URL 改变不能经 vault 凭据备份绕过原生凭据保护', () => {
		const home = createTempHome('ccq-transfer-vault-url-');
		try {
			const path = join(home.path, '.ccq', 'mcp-meta.json');
			write(path, {
				schemaVersion: 1,
				servers: {
					remote: {
						config: {url: 'https://old.example', headers: {Authorization: SECRET}, oauth: {clientSecret: SECRET}},
						credentials: {values: {Authorization: SECRET}}
					}
				}
			});
			const result = importMcpLibrarySection(
				{
					schemaVersion: 1,
					containsCredentials: false,
					servers: [{id: 'remote', config: {url: 'https://new.example', enabled: false}}]
				},
				{containsCredentials: false}
			);
			expect(result.ok).toBe(true);
			expect(read(path)).not.toContain(SECRET);
			expect(read(path)).not.toContain('enabled');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('回滚逐目标尝试并复核原始字节；无效恢复不得声称已回滚', () => {
		const home = createTempHome('ccq-native-rollback-verify-');
		try {
			const path = join(home.path, '.pi', 'agent', 'mcp.json');
			const sidecar = join(home.path, '.pi', 'agent', 'mcp-adapter-overrides.json');
			const nextOverride = {
				schemaVersion: 1,
				dialect: 'pi-native' as const,
				servers: {srv: {enabled: false}},
				managedServers: ['srv']
			};
			for (const failure of ['noop', 'throw']) {
				write(path, '{\n "mcpServers":{"srv":{"command":"old"}}\n}');
				write(sidecar, '{"schemaVersion":1,"dialect":"pi-native","servers":{},"managedServers":[]}');
				const before = [read(path), read(sidecar)] as const;
				const realWrite = fsUtils.writeJsonAtomic;
				const realAtomic = fsUtils.atomicWrite;
				const writeSpy = spyOn(fsUtils, 'writeJsonAtomic').mockImplementation((target, value, options) => {
					realWrite(target, value, options);
					if (target === sidecar) throw new Error(SECRET);
				});
				const restoreSpy = spyOn(fsUtils, 'atomicWrite').mockImplementation((target, bytes, options) => {
					if (target === path && Buffer.isBuffer(bytes)) {
						if (failure === 'throw') throw new Error(SECRET);
						return;
					}
					return realAtomic(target, bytes, options);
				});
				try {
					const result = writePiMcpDocuments({mcpServers: {srv: {command: 'new'}}}, nextOverride);
					expect(result.Success).toBe(false);
					expect(result.Status).toContain('回滚失败');
					expect(read(path)).not.toBe(before[0]);
					expect(read(sidecar)).toBe(before[1]);
					expect(JSON.stringify(result)).not.toContain(SECRET);
				} finally {
					restoreSpy.mockRestore();
					writeSpy.mockRestore();
				}
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('dryRun 零写；native 双文件失败恢复原始字节，分类事务仍报告失败', async () => {
		const home = createTempHome('ccq-transfer-native-tx-');
		try {
			const path = join(home.path, '.pi', 'agent', 'mcp.json');
			const sidecar = join(home.path, '.pi', 'agent', 'mcp-adapter-overrides.json');
			write(path, '{\n "mcpServers": {"srv": {"command":"old"}}, "user": true\n}');
			write(sidecar, '{"schemaVersion":1,"servers":{},"managedServers":["unrelated_old"]}');
			const before = [read(path), read(sidecar)];
			const data = section([{id: 'srv', config: {command: 'new', enabled: false}}], {managedServers: ['srv']});
			expect(importPiMcpSection(data, {containsCredentials: false, dryRun: true}).ok).toBe(true);
			expect([read(path), read(sidecar)]).toEqual(before);
			const payload = createBundlePayload({
				sections: [{tool: 'pi', category: 'mcp', data}],
				containsCredentials: false,
				version: 'test',
				platform: 'test'
			});
			expect(payload.ok).toBe(true);
			if (!payload.ok) return;
			const plan = await planConfigTransferImport(payload.data);
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			const realWrite = fsUtils.writeJsonAtomic;
			let blockedWrites = 0;
			const spy = spyOn(fsUtils, 'writeJsonAtomic').mockImplementation((target, value, options) => {
				if (target === sidecar) {
					blockedWrites++;
					throw new Error(SECRET);
				}
				return realWrite(target, value, options);
			});
			try {
				const result = await applyConfigTransferImport(payload.data, plan.data);
				expect(blockedWrites).toBe(1);
				expect(result.ok).toBe(true);
				if (result.ok) {
					expect(result.data.status).toBe('failed');
					expect(result.data.failed[0]?.restored).toBe(true);
				}
				expect(JSON.stringify(result)).not.toContain(SECRET);
				expect([read(path), read(sidecar)]).toEqual(before);
			} finally {
				spy.mockRestore();
			}
			write(path, '{broken');
			expect(importPiMcpSection(data, {containsCredentials: false}).ok).toBe(false);
			expect(read(path)).toBe('{broken');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
