import {describe, expect, test} from 'bun:test';
import {toCodexMcpConfig} from '../../src/core/mcp-codex-schema.js';
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
