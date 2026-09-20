import {describe, expect, test} from 'bun:test';
import {buildMcpConfig, type BuildMcpConfigOk} from '../../src/core/mcp-config-builder.js';
import {toCodexMcpConfig} from '../../src/core/mcp-codex-schema.js';
import {loadMcpContract, type McpServerDefinition, resolveEffectiveDefinition} from '../../src/core/mcp-contract.js';

// 载体迁移（P2a）：verify-mcp-official.mjs（40 条断言）→ bun:test。
// 断言主题与文案语义保持原样，只换载体（进程内纯函数 + 仓库内契约，无真实 HOME / vault 依赖）。
//
// MCP 官方推荐默认门禁：
// - Exa / Context7 默认使用官方 remote HTTP endpoint（免 key 匿名可用，key 可选）。
// - Claude Code HTTP MCP 输出保留 type:'http'（.claude.json mcpServers 语义）。
// - Codex HTTP MCP TOML 不含 type="http"（Codex 靠 url 字段判定 streamable HTTP）。
// - Codex stdio MCP TOML 不含 type，仅保留 command/args/env。
// - Playwright / Chrome / ACE / MasterGo 保持 stdio 官方 npx 形态。
// - effective definition：AgentConfigs 覆盖机制可按 agentContext 解析有效定义。

const servers = loadMcpContract().servers;

function server(id: string): McpServerDefinition {
	const definition = servers[id];
	if (!definition) {
		throw new Error(`契约缺少 MCP 定义: ${id}`);
	}
	return definition;
}

function buildOk(id: string, definition: McpServerDefinition, values: Record<string, string>): BuildMcpConfigOk {
	const result = buildMcpConfig(id, definition, values);
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result;
}

describe('MCP 官方推荐默认门禁', () => {
	test('Exa / Context7 官方 remote HTTP 默认', () => {
		const context7 = server('context7');
		expect(context7.McpType).toBe('http');
		expect(context7.Url).toBe('https://mcp.context7.com/mcp');
		expect(context7.CredentialType).toBe('none');

		const exa = server('exa');
		expect(exa.McpType).toBe('http');
		expect(exa.Url).toBe('https://mcp.exa.ai/mcp');
		expect(exa.CredentialType).toBe('none');
	});

	test('OptionalHeaders 仅 context7/exa 声明（CONTEXT7_API_KEY / x-api-key）', () => {
		const context7Headers = server('context7').OptionalHeaders;
		expect(Array.isArray(context7Headers) && context7Headers.length === 1).toBe(true);
		expect(context7Headers?.[0]?.HeaderName).toBe('CONTEXT7_API_KEY');

		const exaHeaders = server('exa').OptionalHeaders;
		expect(Array.isArray(exaHeaders) && exaHeaders.length === 1).toBe(true);
		expect(exaHeaders?.[0]?.HeaderName).toBe('x-api-key');

		// 其它 http MCP（deepwiki/figma）不应有 OptionalHeaders（仅 context7/exa 加占位）
		expect(server('deepwiki').OptionalHeaders).toBeUndefined();
		expect(server('figma').OptionalHeaders).toBeUndefined();
	});

	test('Playwright / Chrome / ACE / MasterGo 保持 stdio 官方形态', () => {
		const expected: ReadonlyArray<readonly [string, string]> = [
			['playwright', '@playwright/mcp@latest'],
			['chrome-devtools', 'chrome-devtools-mcp@latest'],
			['ace-tool', 'ace-tool@latest'],
			['mastergo', '@mastergo/magic-mcp']
		];

		for (const [id, expectedArg] of expected) {
			const definition = servers[id];
			expect(definition).toBeDefined();
			expect(definition?.McpType).toBe('stdio');
			expect(definition?.Command).toBe('npx');
			expect((definition?.Args ?? []).some(arg => arg.includes(expectedArg))).toBe(true);
		}
	});

	test('Claude Code HTTP MCP 输出保留 type:http', () => {
		const claudeHttp = buildOk('context7', server('context7'), {});
		expect(claudeHttp.config.type).toBe('http');
		expect(claudeHttp.config.url).toBe('https://mcp.context7.com/mcp');
	});

	test('Codex HTTP schema 转换：去 type + headers→http_headers + 透传官方字段', () => {
		const codexHttp = toCodexMcpConfig({type: 'http', url: 'https://mcp.exa.ai/mcp'});
		expect(codexHttp.type).toBeUndefined();
		expect(codexHttp.url).toBe('https://mcp.exa.ai/mcp');

		// 透传式（黑名单）：只去 type + headers→http_headers 归一化，其余 Codex 合法字段全透传。
		// cwd / env_vars / enabled_tools 等官方字段不再被白名单丢弃（回归「配置即真源」）。
		const codexHttpFull = toCodexMcpConfig({
			type: 'http',
			url: 'https://mcp.context7.com/mcp',
			bearer_token_env_var: 'CONTEXT7_API_KEY',
			http_headers: {'X-Extra': 'v'},
			startup_timeout_sec: 30,
			enabled: false,
			enabled_tools: ['a', 'b'],
			env_http_headers: {H: 'ENV_VAR'}
		});
		expect(codexHttpFull.type).toBeUndefined();
		expect(codexHttpFull.bearer_token_env_var).toBe('CONTEXT7_API_KEY');
		expect(codexHttpFull.http_headers).toEqual({'X-Extra': 'v'});
		expect(codexHttpFull.startup_timeout_sec).toBe(30);
		expect(codexHttpFull.enabled).toBe(false);
		expect(codexHttpFull.enabled_tools).toEqual(['a', 'b']);
		expect(codexHttpFull.env_http_headers).toEqual({H: 'ENV_VAR'});
	});

	test('Codex stdio schema 转换：去 type + 保留 command/args/env', () => {
		const codexStdio = toCodexMcpConfig({type: 'stdio', command: 'npx', args: ['-y', 'x'], env: {K: 'v'}});
		expect(codexStdio.type).toBeUndefined();
		expect(codexStdio.command).toBe('npx');
		expect(codexStdio.args).toEqual(['-y', 'x']);
		expect(codexStdio.env).toEqual({K: 'v'});
	});

	test('effective definition：AgentConfigs 按 agentContext 覆盖解析', () => {
		const baseDef: McpServerDefinition = {
			Name: 'Demo',
			McpType: 'stdio',
			Command: 'npx',
			Args: ['-y', 'demo'],
			AgentConfigs: {
				cx: {McpType: 'http', Url: 'https://demo.example/mcp'}
			}
		};

		const ccEff = resolveEffectiveDefinition(baseDef, 'cc');
		expect(ccEff.McpType).toBe('stdio');
		expect(ccEff.Command).toBe('npx');
		expect('AgentConfigs' in ccEff).toBe(false);

		const cxEff = resolveEffectiveDefinition(baseDef, 'cx');
		expect(cxEff.McpType).toBe('http');
		expect(cxEff.Url).toBe('https://demo.example/mcp');
		expect(cxEff.Command).toBe('npx');

		// 无 AgentConfigs 时 pass-through（不制造差异）
		const passthrough = resolveEffectiveDefinition({Name: 'Exa', McpType: 'http', Url: 'https://mcp.exa.ai/mcp'}, 'cx');
		expect(passthrough.McpType).toBe('http');
		expect(passthrough.Url).toBe('https://mcp.exa.ai/mcp');
	});
});
