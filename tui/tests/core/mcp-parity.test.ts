import {describe, expect, test} from 'bun:test';
import {buildMcpConfig, type BuildMcpConfigOk} from '../../src/core/mcp-config-builder.js';
import {loadMcpContract, type McpServerDefinition} from '../../src/core/mcp-contract.js';

// 载体迁移（P2a）：verify-mcp-parity.mjs（20 条断言）→ bun:test。
// 断言主题与文案语义保持原样，只换载体（纯函数 buildMcpConfig，无真实 HOME / vault 依赖）。
//
// 6.9 buildMcpConfig golden parity 门禁：对齐 Windows New-McpSettingsEntry
// （installer/windows/steps/Mcp.ps1）对各 CredentialType 的 command/args/env/url 输出。

function buildOk(id: string, definition: McpServerDefinition, values: Record<string, string>): BuildMcpConfigOk {
	const result = buildMcpConfig(id, definition, values);
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result;
}

describe('buildMcpConfig 与 New-McpSettingsEntry parity', () => {
	test('none（stdio，无凭据）：command+args，无 env', () => {
		const noneDef: McpServerDefinition = {
			Name: 'Context7',
			McpType: 'stdio',
			Command: 'npx',
			Args: ['-y', '@upstash/context7-mcp'],
			CredentialType: 'none'
		};
		const none = buildOk('context7', noneDef, {});
		expect(none.config).toEqual({command: 'npx', args: ['-y', '@upstash/context7-mcp']});
		expect(none.config.env).toBeUndefined();
		expect(none.permission).toBe('mcp__context7');
	});

	test('single-key（stdio，env 用契约 ApiKeyName）：缺凭据失败', () => {
		const singleDef: McpServerDefinition = {
			McpType: 'stdio',
			Command: 'npx',
			Args: ['-y', 'exa-mcp-server'],
			CredentialType: 'single-key',
			ApiKeyName: 'EXA_API_KEY'
		};
		const single = buildOk('exa', singleDef, {EXA_API_KEY: 'sk-exa-123'});
		expect(single.config.env).toEqual({EXA_API_KEY: 'sk-exa-123'});
		expect(single.config.command).toBe('npx');

		// 缺凭据 → 校验错误，不写文件
		const singleMissing = buildMcpConfig('exa', singleDef, {});
		expect(singleMissing.ok).toBe(false);
		expect(singleMissing.ok ? '' : singleMissing.error, '缺凭据错误必须说明缺少凭据').toMatch(/缺少凭据/);
	});

	test('url-embedded（http）：占位符替换 + encodeURIComponent，缺必填凭据失败', () => {
		const urlDef: McpServerDefinition = {
			McpType: 'http',
			CredentialType: 'url-embedded',
			UrlTemplate: 'https://mcp.tavily.com/mcp/?tavilyApiKey={TAVILY_API_KEY}',
			Credentials: [{Name: 'TAVILY_API_KEY', Required: true, Secret: true}]
		};
		const url = buildOk('tavily', urlDef, {TAVILY_API_KEY: 'tvly a/b'});
		expect(url.config.type).toBe('http');
		expect(url.config.url).toBe('https://mcp.tavily.com/mcp/?tavilyApiKey=tvly%20a%2Fb');

		// 未解析占位符 → 失败
		const urlMissing = buildMcpConfig('tavily', urlDef, {});
		expect(urlMissing.ok).toBe(false);
	});

	test('multi-field（stdio，多 env 键）：可选 env 留空不写', () => {
		const multiDef: McpServerDefinition = {
			McpType: 'stdio',
			Command: 'node',
			Args: ['server.js'],
			CredentialType: 'multi-field',
			Credentials: [
				{Name: 'A_KEY', Required: true},
				{Name: 'B_KEY', Required: false}
			]
		};
		const multi = buildOk('multi', multiDef, {A_KEY: 'a', B_KEY: 'b'});
		expect(multi.config.env).toEqual({A_KEY: 'a', B_KEY: 'b'});

		// 可选字段留空 → 不写空 env
		const multiPartial = buildMcpConfig('multi', multiDef, {A_KEY: 'a'});
		expect(multiPartial.ok && multiPartial.config.env && !('B_KEY' in multiPartial.config.env)).toBe(true);
	});

	test('args-multi（stdio）：按契约顺序追加 ArgName value', () => {
		const argsMultiDef: McpServerDefinition = {
			McpType: 'stdio',
			Command: 'npx',
			Args: ['-y', 'ace-tool@latest'],
			CredentialType: 'args-multi',
			ArgsCredentials: [
				{ArgName: '--base-url', Required: true},
				{ArgName: '--token', Required: true}
			]
		};
		const argsMulti = buildOk('ace-tool', argsMultiDef, {'--base-url': 'https://x', '--token': 't0'});
		expect(argsMulti.config.args).toEqual(['-y', 'ace-tool@latest', '--base-url', 'https://x', '--token', 't0']);
	});

	test('args-token（stdio）：追加 TokenArg=value', () => {
		const tokenDef: McpServerDefinition = {
			McpType: 'stdio',
			Command: 'npx',
			Args: ['-y', '@mastergo/magic-mcp', '--url=https://mastergo.com'],
			CredentialType: 'args-token',
			TokenArg: '--token'
		};
		const token = buildOk('mastergo', tokenDef, {token: 'mg-1'});
		expect(token.config.args).toEqual(['-y', '@mastergo/magic-mcp', '--url=https://mastergo.com', '--token=mg-1']);
	});

	test('env-file 拒绝', () => {
		const envFile = buildMcpConfig('x', {McpType: 'stdio', Command: 'npx', Args: [], CredentialType: 'env-file'}, {});
		expect(envFile.ok).toBe(false);
		expect(envFile.ok ? '' : envFile.error, 'env-file 错误必须点明 env-file').toMatch(/env-file/);
	});

	// P5e 去重补迁（verify-core-functions.mjs）：http + CredentialType none 组合（context7 官方 remote HTTP）。
	test('http/none（context7 官方 remote HTTP）：保留 type:http + url，无 env', () => {
		const contract = loadMcpContract();
		const context7 = contract.servers.context7;
		if (!context7) throw new Error('context7 契约缺失');
		const httpNone = buildOk('context7', context7, {});
		expect(httpNone.config.type).toBe('http');
		expect(httpNone.config.url).toBe('https://mcp.context7.com/mcp');
		expect(httpNone.config.env).toBeUndefined();
	});
});
