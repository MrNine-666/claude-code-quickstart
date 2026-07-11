import assert from 'node:assert/strict';
import {
	getMcpTemplateJson,
	getMcpTemplateToml,
	configToToml,
	parseMcpJsonFormat,
	parseMcpFormInput,
	parseMcpFormInputToml,
	readMcpServersTableId,
	rewriteMcpServersTableId
} from '../src/core/mcp-form.ts';
import {getServerDetail} from '../src/core/mcp.ts';
import {writeJsonAtomic} from '../src/core/fs-utils.ts';
import {vaultPath, claudeJsonPath, ccqDir} from '../src/core/paths.ts';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// MCP 表单门禁（模板预填 + 编辑回显）：
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

// ── http 可选 header 模板预填（context7/exa：cc JSON 带 headers 占位 + credHint）──
const c7Json = getMcpTemplateJson('context7');
assert.ok(c7Json, 'context7 模板应存在');
const c7Config = JSON.parse(c7Json.json);
assert.equal(c7Config.type, 'http', 'context7 cc 模板仍为 http');
assert.equal(c7Config.url, 'https://mcp.context7.com/mcp', 'context7 cc url 为官方 endpoint');
assert.deepEqual(c7Config.headers, {CONTEXT7_API_KEY: ''}, 'context7 cc 模板预填 headers 占位（值留空）');
assert.match(c7Json.credHint ?? '', /context7\.com\/dashboard/, 'context7 credHint 含 key 申请地址');

const exaJson = getMcpTemplateJson('exa');
assert.ok(exaJson, 'exa 模板应存在');
assert.deepEqual(JSON.parse(exaJson.json).headers, {'x-api-key': ''}, 'exa cc 模板预填 x-api-key 占位');
assert.match(exaJson.credHint ?? '', /dashboard\.exa\.ai/, 'exa credHint 含 key 申请地址');

// ── cx TOML 模板（Codex 心智：去 type、带 [mcp_servers.<id>] 头、http_headers 嵌套表占位）──
const c7Toml = getMcpTemplateToml('context7');
assert.ok(c7Toml, 'context7 cx 模板应存在');
assert.match(c7Toml.toml, /^\[mcp_servers\.context7\]/m, 'context7 cx TOML 带 [mcp_servers.<id>] table 头');
assert.match(c7Toml.toml, /^url = "https:\/\/mcp\.context7\.com\/mcp"/m, 'context7 cx TOML 含 url 顶层键');
assert.equal(/type\s*=/.test(c7Toml.toml), false, 'cx TOML 不写 type（Codex 靠 url 判定）');
assert.match(c7Toml.toml, /\[mcp_servers\.context7\.http_headers\]\s*\nCONTEXT7_API_KEY = ""/m, 'context7 cx TOML 含 [mcp_servers.<id>.http_headers] 占位');

const exaToml = getMcpTemplateToml('exa');
assert.ok(exaToml, 'exa cx 模板应存在');
assert.match(exaToml.toml, /^\[mcp_servers\.exa\]/m, 'exa cx TOML 带 [mcp_servers.<id>] table 头');
assert.match(exaToml.toml, /\[mcp_servers\.exa\.http_headers\]\s*\nx-api-key = ""/m, 'exa cx TOML 含 [mcp_servers.<id>.http_headers] x-api-key 占位');
assert.equal(c7Toml.credHint, c7Json.credHint, 'cx 模板 credHint 与 cc 一致');
console.log('[PASS] http 可选 header 模板预填（cc JSON headers + cx TOML [mcp_servers.<id>] 头 + http_headers + credHint）');

// ── configToToml：config → Codex TOML 回显（去 type / 白名单 / 嵌套表）──
// 不传 serverId：裸字段（向后兼容），供不需 table 头的场景。
const stdioToml = configToToml({command: 'npx', args: ['-y', 'x'], env: {K: 'v'}});
assert.match(stdioToml, /^command = "npx"/m, 'configToToml 保留 command');
assert.match(stdioToml, /\[env\]\s*\nK = "v"/m, 'configToToml env 输出为嵌套表');
assert.equal(/type\s*=/.test(stdioToml), false, 'configToToml 去 type');
assert.equal(/\[mcp_servers/.test(stdioToml), false, '不传 serverId 时不包 table 头');

const httpToml = configToToml({type: 'http', url: 'https://x', headers: {h: 'v'}});
assert.match(httpToml, /^url = "https:\/\/x"/m, 'configToToml http 保留 url');
assert.equal(/type\s*=/.test(httpToml), false, 'configToToml http 去 type');
assert.equal(/headers\s*=/.test(httpToml), false, 'configToToml 不输出 Claude 专有 headers（cx 用 http_headers）');

// 传 serverId：包 [mcp_servers.<id>] table 头，与真实 config.toml 片段一致，嵌套 env 为子表。
const stdioWithId = configToToml({command: 'npx', args: ['-y', 'x'], env: {K: 'v'}}, 'codegraph');
assert.match(stdioWithId, /^\[mcp_servers\.codegraph\]/m, 'configToToml 传 id 时包 table 头');
assert.match(stdioWithId, /^command = "npx"/m, 'table 头下保留 command');
assert.match(stdioWithId, /\[mcp_servers\.codegraph\.env\]\s*\nK = "v"/m, 'env 输出为 [mcp_servers.<id>.env] 子表');
// 往返：带 table 头的文本解析回同一 config（parseMcpTomlFormat 剥壳）。
const roundTrip = parseMcpFormInputToml('codegraph', stdioWithId);
assert.ok(roundTrip.ok, '带 table 头的 TOML 可往返解析');
assert.equal(roundTrip.payload.config.command, 'npx', '往返保留 command');
assert.deepEqual(roundTrip.payload.config.env, {K: 'v'}, '往返保留 env');

assert.equal(configToToml(null), '', 'configToToml 空 config 返回空串');
assert.equal(configToToml({type: 'http'}), '', 'configToToml 仅 type（被白名单清空）返回空串');
assert.equal(configToToml({type: 'http'}, 'x'), '', 'configToToml 仅 type 传 id 也返回空串（白名单清空后不包头）');
console.log('[PASS] configToToml 编辑回显（去 type + env/http_headers 嵌套表 + [mcp_servers.<id>] 头 + 往返 + 空对象空串）');

// ── parseMcpFormInput cc：headers 保留 / 空值丢弃（回归 header 丢失 bug）──
const ccWithHeader = parseMcpFormInput('my', '{"type":"http","url":"https://x","headers":{"x-api-key":"k"}}');
assert.ok(ccWithHeader.ok, 'cc http + headers 合法');
assert.deepEqual(ccWithHeader.payload.config.headers, {'x-api-key': 'k'}, 'cc 保留非空 headers');

const ccEmptyHeader = parseMcpFormInput('my', '{"type":"http","url":"https://x","headers":{"x-api-key":""}}');
assert.ok(ccEmptyHeader.ok, 'cc http + 空 header 合法（匿名可用）');
assert.equal(ccEmptyHeader.payload.config.headers, undefined, 'cc 空 header 丢弃，不写入空值');
console.log('[PASS] parseMcpFormInput cc headers 保留非空 / 丢弃空值');

// ── parseMcpFormInputToml cx：TOML 解析 + http_headers 保留 / 空值丢弃 ──
const cxRound = parseMcpFormInputToml('exa', exaToml.toml);
assert.ok(cxRound.ok, 'cx exa 模板可往返解析');
assert.equal(cxRound.payload.config.url, 'https://mcp.exa.ai/mcp', 'cx 解析保留 url');
assert.equal(cxRound.payload.config.type, undefined, 'cx 解析不写 type');
assert.equal(cxRound.payload.config.http_headers, undefined, 'cx 空 http_headers 丢弃（匿名可用）');

const cxFilled = parseMcpFormInputToml('exa', exaToml.toml.replace('x-api-key = ""', 'x-api-key = "mykey"'));
assert.ok(cxFilled.ok, 'cx 填值后可解析');
assert.deepEqual(cxFilled.payload.config.http_headers, {'x-api-key': 'mykey'}, 'cx 保留非空 http_headers');

const cxStdio = parseMcpFormInputToml('my', 'command = "npx"\nargs = ["-y", "x"]');
assert.ok(cxStdio.ok, 'cx stdio 合法');
assert.equal(cxStdio.payload.config.command, 'npx', 'cx stdio 保留 command');

assert.equal(parseMcpFormInputToml('my', '').ok, false, 'cx 空 TOML 报需 command/url');
assert.match(parseMcpFormInputToml('my', '').error, /必须提供/, 'cx 空文本错误提示');
assert.equal(parseMcpFormInputToml('my', 'url = "').ok, false, 'cx TOML 语法错误拦截');
assert.match(parseMcpFormInputToml('my', 'url = "').error, /TOML 格式错误/, 'cx 语法错误提示');
console.log('[PASS] parseMcpFormInputToml cx 往返 + http_headers + stdio + 空/语法错误');


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

// ── Server ID ↔ [mcp_servers.<id>] table 头双向联动（cx add）──
// 正向：改 Server ID → 改写 table 头，保留正文 + 嵌套子表后缀（.env）。
const linkBase = '[mcp_servers.old-id]\ncommand = "npx"\n\n[mcp_servers.old-id.env]\nK = "v"\n';
const rewritten = rewriteMcpServersTableId(linkBase, 'new-id');
assert.match(rewritten, /^\[mcp_servers\.new-id\]/m, 'rewriteMcpServersTableId 改写主 table 头');
assert.match(rewritten, /^\[mcp_servers\.new-id\.env\]/m, 'rewriteMcpServersTableId 同步改写子表后缀');
assert.equal(/old-id/.test(rewritten), false, '改写后不残留旧 id');
assert.match(rewritten, /command = "npx"/, '改写只动 table 头，正文保留');
assert.equal(rewriteMcpServersTableId(linkBase, '   '), linkBase, '空 id 不改写（避免写出非法头）');
assert.equal(rewriteMcpServersTableId('command = "npx"\n', 'x'), 'command = "npx"\n', '无 table 头（裸字段）原样返回');
// 反向：从 table 头读回 id 回填字段。
assert.equal(readMcpServersTableId(linkBase), 'old-id', 'readMcpServersTableId 读出首个 table id');
assert.equal(readMcpServersTableId('command = "npx"\n'), undefined, '无 table 头返回 undefined');
// 往返：改写后仍可解析回同一 config（table 名交由传入 serverId 权威）。
const linkRound = parseMcpFormInputToml('new-id', rewritten);
assert.ok(linkRound.ok, '改写后 TOML 可解析');
assert.equal(linkRound.payload.config.command, 'npx', '往返保留 command');
assert.deepEqual(linkRound.payload.config.env, {K: 'v'}, '往返保留 env');
console.log('[PASS] Server ID ↔ [mcp_servers.<id>] table 头双向联动（正向改写 + 反向读取 + 往返）');

// ── parseMcpFormInput：重构复用 parseMcpJsonFormat 后回归 ──
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
console.log('[PASS] parseMcpFormInput 重构回归（stdio/http/格式错误/缺 command/serverId）');
