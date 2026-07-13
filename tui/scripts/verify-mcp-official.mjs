import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {buildMcpConfig} from '../src/core/mcp-config-builder.ts';
import {toCodexMcpConfig} from '../src/core/mcp-codex-schema.ts';
import {resolveEffectiveDefinition} from '../src/core/mcp-contract.ts';

// MCP 官方推荐默认门禁：
// - Exa / Context7 默认使用官方 remote HTTP endpoint（免 key 匿名可用，key 可选）。
// - Claude Code HTTP MCP 输出保留 type:'http'（.claude.json mcpServers 语义）。
// - Codex HTTP MCP TOML 不含 type="http"（Codex 靠 url 字段判定 streamable HTTP）。
// - Codex stdio MCP TOML 不含 type，仅保留 command/args/env。
// - Playwright / Chrome / ACE / MasterGo 保持 stdio 官方 npx 形态。
// - effective definition：AgentConfigs 覆盖机制可按 agentContext 解析有效定义。

const here = dirname(fileURLToPath(import.meta.url));
const contractPath = join(here, '..', 'contracts', 'mcp-servers.json');
const contract = JSON.parse(readFileSync(contractPath, 'utf8'));
const servers = contract.McpServers;

// ── 1. Exa / Context7 官方 remote HTTP 默认 ──────────────────────────────────
const context7 = servers.context7;
assert.equal(context7.McpType, 'http', 'Context7 默认走官方 remote HTTP');
assert.equal(context7.Url, 'https://mcp.context7.com/mcp', 'Context7 使用官方 endpoint');
assert.equal(context7.CredentialType, 'none', 'Context7 匿名可用，API key 可选不强制');

const exa = servers.exa;
assert.equal(exa.McpType, 'http', 'Exa 默认走官方 remote HTTP');
assert.equal(exa.Url, 'https://mcp.exa.ai/mcp', 'Exa 使用官方 endpoint');
assert.equal(exa.CredentialType, 'none', 'Exa 匿名可用，API key 可选不强制');

// ── 1b. OptionalHeaders 契约声明（可选 API key 走 HTTP header） ───────────────
assert.ok(Array.isArray(context7.OptionalHeaders) && context7.OptionalHeaders.length === 1, 'Context7 声明 1 个 OptionalHeaders');
assert.equal(context7.OptionalHeaders[0].HeaderName, 'CONTEXT7_API_KEY', 'Context7 可选 header 名 CONTEXT7_API_KEY');
assert.ok(Array.isArray(exa.OptionalHeaders) && exa.OptionalHeaders.length === 1, 'Exa 声明 1 个 OptionalHeaders');
assert.equal(exa.OptionalHeaders[0].HeaderName, 'x-api-key', 'Exa 可选 header 名 x-api-key');

// 其它 http MCP（deepwiki/figma）不应有 OptionalHeaders（仅 context7/exa 加占位）
assert.equal(servers.deepwiki.OptionalHeaders, undefined, 'deepwiki 不加 OptionalHeaders（不在本期范围）');
assert.equal(servers.figma.OptionalHeaders, undefined, 'figma 不加 OptionalHeaders（不在本期范围）');
console.log('[PASS] OptionalHeaders 仅 context7/exa 声明（CONTEXT7_API_KEY / x-api-key）');

// ── 2. stdio 官方工具保持不变 ────────────────────────────────────────────────
for (const [id, expectedArg] of [
	['playwright', '@playwright/mcp@latest'],
	['chrome-devtools', 'chrome-devtools-mcp@latest'],
	['ace-tool', 'ace-tool@latest'],
	['mastergo', '@mastergo/magic-mcp']
]) {
	const def = servers[id];
	assert.ok(def, `${id} 契约存在`);
	assert.equal(def.McpType, 'stdio', `${id} 保持 stdio`);
	assert.equal(def.Command, 'npx', `${id} 走 npx`);
	assert.ok((def.Args ?? []).some(arg => arg.includes(expectedArg)), `${id} 保留官方包参数 ${expectedArg}`);
}
console.log('[PASS] Playwright / Chrome / ACE / MasterGo 保持 stdio 官方形态');

// ── 3. Claude Code HTTP MCP 输出保留 type:'http' ─────────────────────────────
const claudeHttp = buildMcpConfig('context7', context7, {});
assert.ok(claudeHttp.ok, 'Context7 buildMcpConfig 应成功');
assert.equal(claudeHttp.config.type, 'http', 'Claude Code HTTP MCP 保留 type:http');
assert.equal(claudeHttp.config.url, 'https://mcp.context7.com/mcp', 'Claude Code HTTP MCP url 为官方 endpoint');
console.log('[PASS] Claude Code HTTP MCP 输出保留 type:http');

// ── 4. Codex schema 转换：HTTP 不写 type，仅保留 Codex 支持字段 ────────────────
const codexHttp = toCodexMcpConfig({type: 'http', url: 'https://mcp.exa.ai/mcp'});
assert.equal(codexHttp.type, undefined, 'Codex HTTP MCP 不含 type');
assert.equal(codexHttp.url, 'https://mcp.exa.ai/mcp', 'Codex HTTP MCP 保留 url');

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
assert.equal(codexHttpFull.type, undefined, 'Codex HTTP full 去 type');
assert.equal(codexHttpFull.bearer_token_env_var, 'CONTEXT7_API_KEY', 'Codex 保留 bearer_token_env_var');
assert.deepEqual(codexHttpFull.http_headers, {'X-Extra': 'v'}, 'Codex 保留 http_headers');
assert.equal(codexHttpFull.startup_timeout_sec, 30, 'Codex 保留 startup_timeout_sec');
assert.equal(codexHttpFull.enabled, false, 'Codex 保留 enabled 语义');
assert.deepEqual(codexHttpFull.enabled_tools, ['a', 'b'], 'Codex 透传 enabled_tools（官方字段）');
assert.deepEqual(codexHttpFull.env_http_headers, {H: 'ENV_VAR'}, 'Codex 透传 env_http_headers（官方字段）');
console.log('[PASS] Codex HTTP schema 转换：去 type + headers→http_headers + 透传官方字段');

// ── 5. Codex schema 转换：stdio 去 type，保留 command/args/env ─────────────────
const codexStdio = toCodexMcpConfig({type: 'stdio', command: 'npx', args: ['-y', 'x'], env: {K: 'v'}});
assert.equal(codexStdio.type, undefined, 'Codex stdio MCP 不含 type');
assert.equal(codexStdio.command, 'npx', 'Codex stdio 保留 command');
assert.deepEqual(codexStdio.args, ['-y', 'x'], 'Codex stdio 保留 args');
assert.deepEqual(codexStdio.env, {K: 'v'}, 'Codex stdio 保留 env');
console.log('[PASS] Codex stdio schema 转换：去 type + 保留 command/args/env');

// ── 6. effective definition：AgentConfigs 覆盖解析 ────────────────────────────
const baseDef = {
	Name: 'Demo',
	McpType: 'stdio',
	Command: 'npx',
	Args: ['-y', 'demo'],
	AgentConfigs: {
		cx: {McpType: 'http', Url: 'https://demo.example/mcp'}
	}
};
const ccEff = resolveEffectiveDefinition(baseDef, 'cc');
assert.equal(ccEff.McpType, 'stdio', 'cc 无覆盖时保持 base 定义');
assert.equal(ccEff.Command, 'npx', 'cc 保留 base command');
assert.equal('AgentConfigs' in ccEff, false, 'effective definition 剥离 AgentConfigs');

const cxEff = resolveEffectiveDefinition(baseDef, 'cx');
assert.equal(cxEff.McpType, 'http', 'cx 覆盖为 http');
assert.equal(cxEff.Url, 'https://demo.example/mcp', 'cx 覆盖 Url');
assert.equal(cxEff.Command, 'npx', 'cx 未覆盖字段继承 base');

// 无 AgentConfigs 时 pass-through（不制造差异）
const passthrough = resolveEffectiveDefinition({Name: 'Exa', McpType: 'http', Url: 'https://mcp.exa.ai/mcp'}, 'cx');
assert.equal(passthrough.McpType, 'http', '无 AgentConfigs 时 cx pass-through base');
assert.equal(passthrough.Url, 'https://mcp.exa.ai/mcp', '无 AgentConfigs 时保留 base Url');
console.log('[PASS] effective definition：AgentConfigs 按 agentContext 覆盖解析');

console.log('[PASS] MCP 官方推荐默认门禁全部通过');
