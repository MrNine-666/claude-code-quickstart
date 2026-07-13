import assert from 'node:assert/strict';
import {
	getMcpTemplateJson,
	configToJson,
	parseMcpJsonFormat,
	parseMcpFormInput
} from '../src/core/mcp-form.ts';
import {getServerDetail} from '../src/core/mcp.ts';
import {toCodexMcpConfig} from '../src/core/mcp-codex-schema.ts';
import {writeJsonAtomic} from '../src/core/fs-utils.ts';
import {vaultPath, claudeJsonPath, ccqDir} from '../src/core/paths.ts';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// MCP 表单门禁（统一 JSON 方言 + 编辑回显）：
// - 表单编辑统一 c/Claude JSON 方言（type + headers）；vault 存 JSON 定义体，
//   codex 落盘由 toCodexMcpConfig 降级（去 type、headers→http_headers）到 TOML。
// - getMcpTemplateJson：args-multi / args-token 类模板预填参数前缀（值留空占位，对齐 buildMcpConfig
//   的 args 拼装），选模板即带出要填的 --base-url / --token 等前缀，用户填值即可直接保存。
// - getServerDetail：Disabled MCP 编辑回显 vault(mcp-meta.json) config fallback
//   （disableServer 把 config 备份进 vault 并清 .claude.json，编辑须从 vault 回显，不能展示空 {}）。

// ── args-multi（ace-tool）：模板预填 [argName, ''] 对，按 ArgsCredentials 顺序 ──
const aceResult = getMcpTemplateJson('ace-tool');
assert.ok(aceResult, 'ace-tool 模板应存在');
assert.deepEqual(
	JSON.parse(aceResult.json).args,
	['-y', 'ace-tool@latest', '--base-url', '', '--token', ''],
	'ace-tool 预填 args 前缀（值留空）'
);

// ── args-token（mastergo）：模板预填 `${TokenArg}=` 空值 ──
const mgResult = getMcpTemplateJson('mastergo');
assert.ok(mgResult, 'mastergo 模板应存在');
assert.deepEqual(
	JSON.parse(mgResult.json).args,
	['-y', '@mastergo/magic-mcp', '--url=https://mastergo.com', '--token='],
	'mastergo 预填 --token= 前缀（值留空）'
);

console.log('[PASS] args-multi / args-token 模板预填参数前缀');

// ── http 可选 header 模板预填（context7/exa：统一 c JSON 带 headers 占位 + credHint）──
const c7Json = getMcpTemplateJson('context7');
assert.ok(c7Json, 'context7 模板应存在');
const c7Config = JSON.parse(c7Json.json);
assert.equal(c7Config.type, 'http', 'context7 模板为 http');
assert.equal(c7Config.url, 'https://mcp.context7.com/mcp', 'context7 url 为官方 endpoint');
assert.deepEqual(c7Config.headers, {CONTEXT7_API_KEY: ''}, 'context7 模板预填 headers 占位（值留空）');
assert.match(c7Json.credHint ?? '', /context7\.com\/dashboard/, 'context7 credHint 含 key 申请地址');

const exaJson = getMcpTemplateJson('exa');
assert.ok(exaJson, 'exa 模板应存在');
assert.deepEqual(JSON.parse(exaJson.json).headers, {'x-api-key': ''}, 'exa 模板预填 x-api-key 占位');
assert.match(exaJson.credHint ?? '', /dashboard\.exa\.ai/, 'exa credHint 含 key 申请地址');
console.log('[PASS] http 可选 header 模板预填（统一 JSON headers + credHint）');

// ── configToJson：config → pretty JSON 回显（原样保留 type/headers，不降级）──
const jsonEcho = configToJson({type: 'http', url: 'https://x', headers: {h: 'v'}});
assert.match(jsonEcho, /"type": "http"/, 'configToJson 保留 type');
assert.match(jsonEcho, /"url": "https:\/\/x"/, 'configToJson 保留 url');
assert.match(jsonEcho, /"h": "v"/, 'configToJson 保留 headers');
assert.equal(configToJson(null), '{}\n', 'configToJson 空 config 返回 {}');
console.log('[PASS] configToJson 编辑回显（原样保留 c 方言 type/headers）');

// ── toCodexMcpConfig 降级：c JSON 方言 → Codex TOML 字段集（去 type、headers→http_headers）──
// 自定义 http MCP 用 c 方言存 vault（type + headers），enable codex 侧落盘时降级。
const codexHttp = toCodexMcpConfig({type: 'http', url: 'https://x', headers: {'x-api-key': 'k'}});
assert.equal(codexHttp.type, undefined, 'codex 降级去 type');
assert.equal(codexHttp.url, 'https://x', 'codex 降级保留 url');
assert.equal(codexHttp.headers, undefined, 'codex 降级去 Claude 专有 headers');
assert.deepEqual(codexHttp.http_headers, {'x-api-key': 'k'}, 'codex 降级 headers→http_headers（凭据不丢）');

// 已是 http_headers（旧 cx 方言 vault）透传不重复。
const codexPassthrough = toCodexMcpConfig({url: 'https://x', http_headers: {'x-api-key': 'k'}});
assert.deepEqual(codexPassthrough.http_headers, {'x-api-key': 'k'}, 'codex 已有 http_headers 透传');

// stdio 降级：保留 command/args/env，去 type。
const codexStdio = toCodexMcpConfig({command: 'npx', args: ['-y', 'x'], env: {K: 'v'}});
assert.equal(codexStdio.type, undefined, 'codex stdio 去 type');
assert.equal(codexStdio.command, 'npx', 'codex stdio 保留 command');
assert.deepEqual(codexStdio.env, {K: 'v'}, 'codex stdio 保留 env');
console.log('[PASS] toCodexMcpConfig 降级（去 type + headers→http_headers + stdio 保留 env）');

// ── parseMcpFormInput cc：headers 保留 / 空值丢弃（回归 header 丢失 bug）──
const ccWithHeader = parseMcpFormInput('my', '{"type":"http","url":"https://x","headers":{"x-api-key":"k"}}');
assert.ok(ccWithHeader.ok, 'http + headers 合法');
assert.deepEqual(ccWithHeader.payload.config.headers, {'x-api-key': 'k'}, '保留非空 headers');

const ccEmptyHeader = parseMcpFormInput('my', '{"type":"http","url":"https://x","headers":{"x-api-key":""}}');
assert.ok(ccEmptyHeader.ok, 'http + 空 header 合法（匿名可用）');
assert.equal(ccEmptyHeader.payload.config.headers, undefined, '空 header 丢弃，不写入空值');
console.log('[PASS] parseMcpFormInput headers 保留非空 / 丢弃空值');

// ── 端到端透传：用户填的额外 Codex/Claude 字段穿透解析层 + codex 降级（配置即真源）──
// http：cwd 不适用，取 startup_timeout_sec / enabled_tools / bearer_token_env_var。
const httpExtra = parseMcpFormInput('my', JSON.stringify({
	type: 'http',
	url: 'https://x',
	headers: {'x-api-key': 'k'},
	bearer_token_env_var: 'TOK',
	startup_timeout_sec: 30,
	enabled_tools: ['a', 'b']
}));
assert.ok(httpExtra.ok, 'http + 额外字段合法');
assert.equal(httpExtra.payload.config.bearer_token_env_var, 'TOK', '解析层透传 bearer_token_env_var');
assert.equal(httpExtra.payload.config.startup_timeout_sec, 30, '解析层透传 startup_timeout_sec');
assert.deepEqual(httpExtra.payload.config.enabled_tools, ['a', 'b'], '解析层透传 enabled_tools');
// 再经 codex 降级：去 type、headers→http_headers，额外字段透传落盘。
const httpExtraCodex = toCodexMcpConfig(httpExtra.payload.config);
assert.equal(httpExtraCodex.type, undefined, 'codex 降级去 type');
assert.deepEqual(httpExtraCodex.http_headers, {'x-api-key': 'k'}, 'codex headers→http_headers');
assert.equal(httpExtraCodex.bearer_token_env_var, 'TOK', 'codex 透传 bearer_token_env_var');
assert.deepEqual(httpExtraCodex.enabled_tools, ['a', 'b'], 'codex 透传 enabled_tools');

// stdio：cwd / env_vars 透传。
const stdioExtra = parseMcpFormInput('my', JSON.stringify({
	command: 'npx',
	args: ['-y', 'x'],
	env: {K: 'v'},
	cwd: '/tmp/wd',
	env_vars: ['FOO']
}));
assert.ok(stdioExtra.ok, 'stdio + 额外字段合法');
assert.equal(stdioExtra.payload.config.cwd, '/tmp/wd', '解析层透传 cwd');
assert.deepEqual(stdioExtra.payload.config.env_vars, ['FOO'], '解析层透传 env_vars');
const stdioExtraCodex = toCodexMcpConfig(stdioExtra.payload.config);
assert.equal(stdioExtraCodex.cwd, '/tmp/wd', 'codex 透传 cwd');
assert.deepEqual(stdioExtraCodex.env_vars, ['FOO'], 'codex 透传 env_vars');
console.log('[PASS] 端到端透传（额外 Codex/Claude 字段穿透解析层 + codex 降级）');

// ── getServerDetail Disabled fallback（CCQ_HOME 隔离临时目录）──
const home = join(tmpdir(), 'ccq-mcp-template-test');
process.env.CCQ_HOME = home;
rmSync(home, {recursive: true, force: true});
mkdirSync(ccqDir(), {recursive: true});

// vault 备份被禁用 MCP 的 config（对齐 disableServer 行为）
writeJsonAtomic(vaultPath(), {
	schemaVersion: 1,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	servers: {
		't-disabled': {
			disabled: true,
			config: {command: 'npx', args: ['-y', 'x']},
			credentials: {values: {TOKEN: 's'}},
			updatedAt: '2026-01-01T00:00:00.000Z'
		}
	}
});
// .claude.json 不含该 server（disabled 时已被清除）
writeJsonAtomic(claudeJsonPath(), {mcpServers: {}});
assert.deepEqual(
	getServerDetail('t-disabled').config,
	{command: 'npx', args: ['-y', 'x']},
	'disabled 回显 vault(mcp-meta.json) config'
);

// Active 优先 .claude.json，fallback 不影响活跃态
writeJsonAtomic(claudeJsonPath(), {mcpServers: {'t-disabled': {command: 'node', args: ['a.js']}}});
assert.deepEqual(
	getServerDetail('t-disabled').config,
	{command: 'node', args: ['a.js']},
	'active 优先 .claude.json'
);

rmSync(home, {recursive: true, force: true});
delete process.env.CCQ_HOME;
console.log('[PASS] Disabled 编辑回显 vault config / Active 优先 .claude.json');

// ── parseMcpJsonFormat：JSON 格式实时校验（合法对象 / 语法错误 / 非对象）──
assert.equal(parseMcpJsonFormat('{"command":"npx"}').ok, true, '合法 JSON 对象');
assert.deepEqual(parseMcpJsonFormat('{"a":1}').value, {a: 1}, '返回解析值');
assert.equal(parseMcpJsonFormat('{bad').ok, false, '语法错误应失败');
assert.match(parseMcpJsonFormat('{bad').error, /JSON 格式错误/, '语法错误提示');
assert.equal(parseMcpJsonFormat('[]').ok, false, '数组非对象');
assert.match(parseMcpJsonFormat('[]').error, /必须是 JSON 对象/, '数组提示');
assert.equal(parseMcpJsonFormat('"x"').ok, false, '字符串非对象');
console.log('[PASS] parseMcpJsonFormat 实时格式校验（语法 + 顶层对象）');

// ── parseMcpFormInput：stdio/http/格式错误/缺 command/serverId 回归 ──
const stdio = parseMcpFormInput('my', '{"command":"npx","args":["x"]}');
assert.ok(stdio.ok, '合法 stdio');
assert.equal(stdio.payload.serverId, 'my');
assert.equal(stdio.payload.config.command, 'npx');

const http = parseMcpFormInput('my', '{"type":"http","url":"https://x"}');
assert.ok(http.ok, '合法 http');
assert.equal(http.payload.config.type, 'http');

assert.equal(parseMcpFormInput('my', '{bad').ok, false, '语法错误仍拦截');
assert.match(parseMcpFormInput('my', '{bad').error, /JSON 格式错误/);
assert.equal(parseMcpFormInput('my', '{"type":"stdio"}').ok, false, 'stdio 缺 command');
assert.equal(parseMcpFormInput('', '{}').ok, false, '空 serverId 拦截');
console.log('[PASS] parseMcpFormInput 回归（stdio/http/格式错误/缺 command/serverId）');
