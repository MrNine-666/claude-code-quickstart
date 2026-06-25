import assert from 'node:assert/strict';
import {buildMcpConfig} from '../dist/core/mcp-config-builder.js';

// 6.9 buildMcpConfig golden parity 门禁：对齐 Windows New-McpSettingsEntry
// （installer/windows/steps/Mcp.ps1）对各 CredentialType 的 command/args/env/url 输出。

// ── none（stdio，无凭据） ──
const noneDef = {Name: 'Context7', McpType: 'stdio', Command: 'npx', Args: ['-y', '@upstash/context7-mcp'], CredentialType: 'none'};
const none = buildMcpConfig('context7', noneDef, {});
assert.ok(none.ok, 'none 应成功');
assert.deepEqual(none.config, {command: 'npx', args: ['-y', '@upstash/context7-mcp']}, 'none：command+args，无 env');
assert.equal(none.config.env, undefined, 'none 不应有 env');
assert.equal(none.permission, 'mcp__context7');

// ── single-key（stdio，env 用契约 ApiKeyName） ──
const singleDef = {McpType: 'stdio', Command: 'npx', Args: ['-y', 'exa-mcp-server'], CredentialType: 'single-key', ApiKeyName: 'EXA_API_KEY'};
const single = buildMcpConfig('exa', singleDef, {EXA_API_KEY: 'sk-exa-123'});
assert.ok(single.ok, 'single-key 应成功');
assert.deepEqual(single.config.env, {EXA_API_KEY: 'sk-exa-123'}, 'single-key：env 用 ApiKeyName');
assert.equal(single.config.command, 'npx');
// 缺凭据 → 校验错误，不写文件
const singleMissing = buildMcpConfig('exa', singleDef, {});
assert.equal(singleMissing.ok, false, 'single-key 缺凭据应失败');

// ── url-embedded（http，占位符替换 + encodeURIComponent） ──
const urlDef = {
	McpType: 'http',
	CredentialType: 'url-embedded',
	UrlTemplate: 'https://mcp.tavily.com/mcp/?tavilyApiKey={TAVILY_API_KEY}',
	Credentials: [{Name: 'TAVILY_API_KEY', Required: true, Secret: true}]
};
const url = buildMcpConfig('tavily', urlDef, {TAVILY_API_KEY: 'tvly a/b'});
assert.ok(url.ok, 'url-embedded 应成功');
assert.equal(url.config.type, 'http');
assert.equal(url.config.url, 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly%20a%2Fb', 'url-embedded：encodeURIComponent 替换');
// 未解析占位符 → 失败
const urlMissing = buildMcpConfig('tavily', urlDef, {});
assert.equal(urlMissing.ok, false, 'url-embedded 缺必填凭据应失败');

// ── multi-field（stdio，多 env 键） ──
const multiDef = {
	McpType: 'stdio',
	Command: 'node',
	Args: ['server.js'],
	CredentialType: 'multi-field',
	Credentials: [{Name: 'A_KEY', Required: true}, {Name: 'B_KEY', Required: false}]
};
const multi = buildMcpConfig('multi', multiDef, {A_KEY: 'a', B_KEY: 'b'});
assert.ok(multi.ok, 'multi-field 应成功');
assert.deepEqual(multi.config.env, {A_KEY: 'a', B_KEY: 'b'}, 'multi-field：所有非空 env');
// 可选字段留空 → 不写空 env
const multiPartial = buildMcpConfig('multi', multiDef, {A_KEY: 'a'});
assert.ok(multiPartial.ok && multiPartial.config.env && !('B_KEY' in multiPartial.config.env), '可选 env 留空不写');

// ── args-multi（stdio，按契约顺序追加 ArgName value） ──
const argsMultiDef = {
	McpType: 'stdio',
	Command: 'npx',
	Args: ['-y', 'ace-tool@latest'],
	CredentialType: 'args-multi',
	ArgsCredentials: [{ArgName: '--base-url', Required: true}, {ArgName: '--token', Required: true}]
};
const argsMulti = buildMcpConfig('ace-tool', argsMultiDef, {'--base-url': 'https://x', '--token': 't0'});
assert.ok(argsMulti.ok, 'args-multi 应成功');
assert.deepEqual(argsMulti.config.args, ['-y', 'ace-tool@latest', '--base-url', 'https://x', '--token', 't0'], 'args-multi：按序追加');

// ── args-token（stdio，追加 TokenArg=value） ──
const tokenDef = {
	McpType: 'stdio',
	Command: 'npx',
	Args: ['-y', '@mastergo/magic-mcp', '--url=https://mastergo.com'],
	CredentialType: 'args-token',
	TokenArg: '--token'
};
const token = buildMcpConfig('mastergo', tokenDef, {token: 'mg-1'});
assert.ok(token.ok, 'args-token 应成功');
assert.deepEqual(
	token.config.args,
	['-y', '@mastergo/magic-mcp', '--url=https://mastergo.com', '--token=mg-1'],
	'args-token：追加 TokenArg=value'
);

// ── env-file 拒绝 ──
const envFile = buildMcpConfig('x', {McpType: 'stdio', Command: 'npx', Args: [], CredentialType: 'env-file'}, {});
assert.equal(envFile.ok, false, 'env-file 必须拒绝');

console.log('[PASS] 6.9 buildMcpConfig 与 New-McpSettingsEntry parity 通过');
