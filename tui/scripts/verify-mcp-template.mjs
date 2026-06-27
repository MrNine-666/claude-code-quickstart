import assert from 'node:assert/strict';
import {getMcpTemplateJson, parseMcpJsonFormat, parseMcpFormInput} from '../src/core/mcp-form.ts';
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
