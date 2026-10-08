import {describe, expect, test} from 'bun:test';
import {toCodexMcpConfig} from '../../src/core/mcp-codex-schema.js';
import type {McpConfigEntry} from '../../src/core/mcp-config-builder.js';
import {configToJson, getMcpTemplateJson, listBuiltinMcpOptions, parseMcpFormInput, parseMcpJsonFormat} from '../../src/core/mcp-form.js';

// A 类改写（P1-G3）：MCP 表单 core（JSON 即真源）行为入口。
// 覆盖 verify-mcp-shared-projection.mjs 所依赖的模板/格式/落盘前校验纯函数，
// 使 MCP 视图源码正则改写后的 tests/ 载体完整可用。

describe('MCP 表单 core', () => {
	test('listBuiltinMcpOptions 排除 software 且按 label 排序', () => {
		const options = listBuiltinMcpOptions();
		expect(options.length).toBeGreaterThan(0);
		expect(options.some(option => option.value === 'context7')).toBe(true);
		const labels = options.map(option => option.label);
		expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
	});

	test('configToJson 输出对象 JSON，非法输入回退空对象', () => {
		expect(JSON.parse(configToJson({command: 'npx', args: ['-y', 'x']}))).toEqual({command: 'npx', args: ['-y', 'x']});
		expect(configToJson(null)).toBe('{}\n');
		expect(configToJson([] as unknown as Record<string, unknown>)).toBe('{}\n');
	});

	test('getMcpTemplateJson 为内置 HTTP MCP 给出 type/url 模板，未知名返回 null', () => {
		const template = getMcpTemplateJson('context7');
		expect(template).not.toBeNull();
		const parsed = JSON.parse(template?.json ?? '{}');
		expect(parsed.type).toBe('http');
		expect(typeof parsed.url).toBe('string');
		expect(getMcpTemplateJson('not-a-real-server')).toBeNull();
	});

	test('parseMcpJsonFormat 只校验 JSON 对象，非对象报错', () => {
		expect(parseMcpJsonFormat('{"command":"npx"}')).toEqual({ok: true, value: {command: 'npx'}});
		expect(parseMcpJsonFormat('[]').ok).toBe(false);
		expect(parseMcpJsonFormat('{bad json').ok).toBe(false);
	});

	test('parseMcpFormInput 按内容判定 http/stdio 并规整字段', () => {
		const stdio = parseMcpFormInput('my-server', '{"command":"npx","args":["-y","pkg",3],"env":{"A":"1","B":null}}');
		expect(stdio.ok).toBe(true);
		if (stdio.ok) {
			expect(stdio.payload.config.command).toBe('npx');
			expect(stdio.payload.config.args).toEqual(['-y', 'pkg']);
			expect(stdio.payload.config.env).toEqual({A: '1'});
		}

		const http = parseMcpFormInput('my-http', '{"url":"https://example.com/mcp","headers":{"X":"1","Y":""}}');
		expect(http.ok).toBe(true);
		if (http.ok) {
			expect(http.payload.config.type).toBe('http');
			expect(http.payload.config.headers).toEqual({X: '1'});
		}

		expect(parseMcpFormInput('bad id', '{"command":"npx"}').ok).toBe(false);
		expect(parseMcpFormInput('my-http', '{"url":""}').ok).toBe(false);
	});
});

describe('Pi native 表单边界', () => {
	test('raw SSE/坏 args/env 在 Claude 规整前拒绝，其他 Agent 保留既有规整行为', () => {
		for (const config of [
			{type: 'sse', url: 'https://example.com/sse'},
			{command: 'npx', args: [1]},
			{command: 'npx', env: {KEY: 1}},
			{command: 'npx', headers: {Key: null}}
		])
			expect(parseMcpFormInput('server', JSON.stringify(config), true).ok).toBe(false);
		const native = parseMcpFormInput(
			'server',
			JSON.stringify({type: 'streamable-http', url: 'https://example.com/mcp', oauth: {clientId: 'id'}}),
			true
		);
		expect(native.ok && native.payload.config.type).toBe('streamable-http');
		expect(parseMcpFormInput('server', '{"command":"npx","args":[1]}').ok).toBe(true);
		const sse = parseMcpFormInput('server', '{"type":"sse","url":"https://example.com/sse"}');
		expect(sse.ok && sse.payload.config.type).toBe('sse');
	});
	test('原生合法空字段保持原值；空 Authorization 不得被删除而启用 OAuth', () => {
		const configs: readonly McpConfigEntry[] = [
			{url: 'https://example.com/mcp', headers: {Authorization: ''}, env: {}, custom: {keep: true}},
			{command: 'npx', args: [], env: {EMPTY: ''}, timeout: 12, exposure: 'hidden'}
		];
		for (const config of configs) {
			const parsed = parseMcpFormInput('server', JSON.stringify(config), true);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.payload.config).toEqual(config);
		}
	});
	test('JSON syntax diagnostics never expose OAuth/clientSecret or raw source', () => {
		const result = parseMcpJsonFormat('{"oauth":{"clientSecret":"SENTINEL-OAUTH"},broken');
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain('SENTINEL-OAUTH');
	});
});

describe('toCodexMcpConfig 降级', () => {
	test('去 type、headers → http_headers、显式 http_headers 优先、其余透传', () => {
		expect(toCodexMcpConfig({type: 'http', url: 'https://x', headers: {A: '1'}, cwd: '/tmp'})).toEqual({
			url: 'https://x',
			http_headers: {A: '1'},
			cwd: '/tmp'
		});
		expect(toCodexMcpConfig({headers: {A: '1'}, http_headers: {B: '2'}})).toEqual({http_headers: {B: '2'}});
		expect(toCodexMcpConfig({command: 'npx', env_vars: ['A'], undefinedKey: undefined})).toEqual({
			command: 'npx',
			env_vars: ['A']
		});
	});
});
