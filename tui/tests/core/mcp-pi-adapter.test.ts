import {existsSync} from 'node:fs';
import {describe, expect, test} from 'bun:test';
import {
	buildPiMcpServerEntry,
	currentPiMcpNativeFact,
	detectPiMcpNative,
	resetPiMcpNativeFact,
	piMcpUnsupportedReason,
	type PiMcpNativeFact,
	validatePiMcpServer,
	validatePiMcpServerIds,
	writePiMcpOverride
} from '../../src/core/pi-mcp-adapter.js';
import {piMcpConfigPath, piMcpAdapterOverridesPath} from '../../src/core/paths.js';
import {createTempHome} from '../helpers/temp-home.js';

describe('Pi 原生 MCP（历史载体名保留）', () => {
	test('仅执行 pi --version；正式版 >=1.0.0 支持，目录/adapter marker 不作能力事实', async () => {
		const home = createTempHome('ccq-native-detect-');
		try {
			resetPiMcpNativeFact();
			expect(currentPiMcpNativeFact().reason).toBe('pi-not-detected');
			for (const [version, supported] of [
				['1.0.0', true],
				['0.99.1', false],
				['1.0.0', true],
				['0.98.9', false],
				['', false],
				['1.0.0-rc.1', false],
				['unknown version (node v24.15.0)', false],
				['0.99.1.2', false]
			] as const) {
				const calls: string[][] = [];
				const fact = await detectPiMcpNative(async (command, args) => {
					calls.push([command, ...args]);
					return {code: 0, stdout: version, stderr: ''};
				});
				expect(fact.supported).toBe(supported);
				expect(calls).toEqual([['pi', '--version']]);
				if (!supported) expect(fact.reason).toBe('pi-version-unsupported');
			}
			expect((await detectPiMcpNative(async () => ({code: 1, stdout: '', stderr: 'not found'}))).reason).toBe('pi-not-installed');
		} finally {
			resetPiMcpNativeFact();
			home.restore();
			home.cleanup();
		}
	});

	test('原生 schema、ID、OAuth loopback 校验；不默默删除 adapter 安全语义', () => {
		const valid = [
			{command: 'npx', args: ['-y', 'pkg'], env: {KEY: `\${TOKEN}`}, cwd: '.', timeout: 60},
			{
				type: 'streamable-http',
				url: 'https://example.com/mcp',
				headers: {Authorization: '!get-token'},
				enabled: false,
				exposure: 'hidden',
				toolExposure: {'get_*': 'direct'}
			},
			{
				url: 'https://example.com/mcp',
				oauth: {
					clientId: 'id',
					clientSecret: `\${SECRET}`,
					callbackPort: 8080,
					callbackUrl: 'http://localhost:8080/callback',
					scope: 'read',
					clientName: 'ccq',
					authServerMetadataUrl: 'https://example.com/.well-known/oauth-authorization-server'
				}
			}
		];
		for (const config of valid) expect(validatePiMcpServer('server_1', config)).toBeUndefined();
		for (const config of [
			{type: 'sse', url: 'https://example.com/sse'},
			{command: 'npx', args: [1]},
			{command: 'npx', env: {KEY: 1}},
			{command: 'npx', enabled: 'false'},
			{command: 'npx', disabled: true},
			{url: 'file:///etc/passwd'},
			{command: 'npx', timeout: 0},
			{command: 'npx', timeout: Infinity},
			{command: 'npx', exposure: 'all'},
			{command: 'npx', exposure: {toString: 'direct'}},
			{command: 'npx', type: {toString: 'stdio'}},
			{command: 'npx', toolExposure: {tool: 'all'}},
			{command: 'npx', inheritEnv: false},
			{command: 'npx', approveTools: false},
			{command: 'npx', exposeResources: false},
			{command: 'npx', searchKeywords: {tool: ['tag']}},
			{command: 'npx', debug: true},
			{command: 'npx', trace: true},
			{command: 'npx', pluginDataDir: '/data'},
			{command: 'npx', protocolVersion: '2026-07-28'},
			{command: 'npx', tasks: false},
			{url: 'https://example.com', requestHeadersCommand: 'sign'},
			{socket: '/tmp/mcp'},
			{url: 'https://example.com', oauth: false},
			{url: 'https://example.com', oauth: {refreshToken: 'secret'}},
			{url: 'https://example.com', oauth: {callbackUrl: 'https://example.com/callback'}},
			{url: 'https://example.com', oauth: {callbackUrl: 'http://localhost:8080/callback', callbackPort: 8081}},
			{url: 'https://example.com', oauth: {callbackPort: 0}},
			{url: 'https://example.com', oauth: {callbackUrl: 'http://localhost/callback?secret=x'}}
		])
			expect(validatePiMcpServer('server', config)).toBeDefined();
		expect(validatePiMcpServer('server', {url: 'https://example.com', description: 1})).toBeDefined();
		expect(validatePiMcpServer('server', {url: 'https://example.com', auth: {provider: 'oauth'}})).toBeUndefined();
		expect(validatePiMcpServer('server', {url: 'http://example.com', auth: {provider: 'oauth'}})).toBeDefined();
		expect(validatePiMcpServerIds(['dev-radius', 'dev_radius'])).toContain('冲突');
	});

	test('原生 entry 不隐式转换 legacy 字段；共享跨 Agent 投影仍可转换', () => {
		const fact: PiMcpNativeFact = {piInstalled: true, version: '1.0.0', overrideReadable: true, configReadable: true, supported: true};
		for (const config of [
			{command: 'old', disabled: true},
			{url: 'https://example.com/mcp', http_headers: {Key: `\${TOKEN}`}},
			{url: 'https://example.com/mcp', auth: 'oauth'}
		]) {
			expect(piMcpUnsupportedReason(fact, null, config, 'server', 'pi-native')).toBe('definition-not-expressible');
			expect(piMcpUnsupportedReason(fact, null, config, 'server', 'shared')).toBeUndefined();
		}
		expect(piMcpUnsupportedReason(fact, null, {command: 'npx', enabled: false}, 'server', 'pi-native')).toBeUndefined();
	});

	test('共享别名非法类型或矛盾值不被规范化抹去，mutation 零写盘', async () => {
		const home = createTempHome('ccq-shared-schema-');
		try {
			resetPiMcpNativeFact();
			const fact = await detectPiMcpNative(async () => ({code: 0, stdout: '1.0.0', stderr: ''}));
			for (const config of [
				{command: 'npx', disabled: 'false'},
				{command: 'npx', disabled: null},
				{command: 'npx', disabled: true, enabled: true},
				{url: 'https://example.com', http_headers: {Key: 42}},
				{url: 'https://example.com', http_headers: null},
				{url: 'https://example.com', headers: {Key: 'new'}, http_headers: {Key: 'old'}}
			]) {
				for (const dialect of ['shared', 'pi-native'] as const) {
					expect(piMcpUnsupportedReason(fact, null, config, 'server', dialect)).toBe('definition-not-expressible');
				}
				expect(writePiMcpOverride('server', true, null, config).Success).toBe(false);
				expect(existsSync(piMcpConfigPath())).toBe(false);
				expect(existsSync(piMcpAdapterOverridesPath())).toBe(false);
			}
		} finally {
			resetPiMcpNativeFact();
			home.restore();
			home.cleanup();
		}
	});

	test('共享映射保留 type/args 原值；不得把 SSE 或坏 args 当作 HTTP 成功', () => {
		const entry = buildPiMcpServerEntry(null, {type: 'sse', url: 'https://example.com/sse', args: [1]});
		expect(entry.type).toBe('sse');
		expect(entry.args).toEqual([1]);
		expect(validatePiMcpServer('server', entry)).toBeDefined();
		const legacy = buildPiMcpServerEntry(null, {httpUrl: 'https://example.com/mcp', http_headers: {Key: `\${TOKEN}`}});
		expect(legacy).toEqual({httpUrl: 'https://example.com/mcp', headers: {Key: `\${TOKEN}`}});
		expect(validatePiMcpServer('server', legacy)).toBeDefined();
	});
});
