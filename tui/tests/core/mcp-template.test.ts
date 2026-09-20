import {describe, expect, test} from 'bun:test';
import {toCodexMcpConfig} from '../../src/core/mcp-codex-schema.js';
import {
	configToJson,
	type McpFormPayload,
	type McpTemplateResult,
	getMcpTemplateJson,
	parseMcpFormInput,
	parseMcpJsonFormat
} from '../../src/core/mcp-form.js';

// 载体迁移（P2a）：verify-mcp-template.mjs 的纯函数段（75 条断言）→ bun:test。
// 原脚本保留真实文件段（Disabled 编辑回显 vault config / Active 优先 .claude.json）。
//
// MCP 表单门禁（统一 JSON 方言 + 编辑回显）：
// - 表单编辑统一 c/Claude JSON 方言（type + headers）；vault 存 JSON 定义体，
//   codex 落盘由 toCodexMcpConfig 降级（去 type、headers→http_headers）到 TOML。
// - getMcpTemplateJson：args-multi / args-token 类模板预填参数前缀（值留空占位，对齐 buildMcpConfig
//   的 args 拼装），选模板即带出要填的 --base-url / --token 等前缀，用户填值即可直接保存。

function templateOk(serverId: string): McpTemplateResult {
	const result = getMcpTemplateJson(serverId);
	expect(result).not.toBeNull();
	if (!result) {
		throw new Error(`${serverId} 模板应存在`);
	}
	return result;
}

function parseOk(serverId: string, json: string): McpFormPayload {
	const result = parseMcpFormInput(serverId, json);
	expect(result.ok).toBe(true);
	if (!result.ok) {
		throw new Error(result.error);
	}
	return result.payload;
}

describe('MCP 模板预填（getMcpTemplateJson）', () => {
	test('args-multi / args-token 模板预填参数前缀', () => {
		// args-multi（ace-tool）：模板预填 [argName, ''] 对，按 ArgsCredentials 顺序
		const aceResult = templateOk('ace-tool');
		expect(JSON.parse(aceResult.json).args).toEqual(['-y', 'ace-tool@latest', '--base-url', '', '--token', '']);

		// args-token（mastergo）：模板预填 `${TokenArg}=` 空值
		const mgResult = templateOk('mastergo');
		expect(JSON.parse(mgResult.json).args).toEqual(['-y', '@mastergo/magic-mcp', '--url=https://mastergo.com', '--token=']);
	});

	test('http 可选 header 模板预填（统一 JSON headers + credHint）', () => {
		// context7/exa：统一 c JSON 带 headers 占位 + credHint
		const c7Json = templateOk('context7');
		const c7Config = JSON.parse(c7Json.json);
		expect(c7Config.type).toBe('http');
		expect(c7Config.url).toBe('https://mcp.context7.com/mcp');
		expect(c7Config.headers).toEqual({CONTEXT7_API_KEY: ''});
		expect(c7Json.credHint ?? '').toMatch(/context7\.com\/dashboard/);

		const exaJson = templateOk('exa');
		expect(JSON.parse(exaJson.json).headers).toEqual({'x-api-key': ''});
		expect(exaJson.credHint ?? '').toMatch(/dashboard\.exa\.ai/);
	});

	test('url-embedded（tavily）模板：url 占位 + 无 env + credHint', () => {
		// URL 保留占位符、禁止 env 预填、credHint 提示替换
		const tavilyJson = templateOk('tavily');
		const tavilyConfig = JSON.parse(tavilyJson.json);
		expect(tavilyConfig.type).toBe('http');
		expect(tavilyConfig.url).toBe('https://mcp.tavily.com/mcp/?tavilyApiKey={TAVILY_API_KEY}');
		expect(tavilyConfig.env).toBeUndefined();
		expect(tavilyJson.credHint ?? '').toMatch(/\{TAVILY_API_KEY\}/);
		expect(tavilyJson.credHint ?? '').toMatch(/app\.tavily\.com/);
		// URL 必须独占一行（避免「标签: url」同行被窄终端软换行拆断导致跳转路径错）
		expect(tavilyJson.credHint ?? '').toMatch(/(^|\n)https:\/\/app\.tavily\.com\/home(\n|$)/);
		expect((tavilyJson.credHint ?? '').includes('；')).toBe(false);
	});
});

describe('parseMcpFormInput url-embedded（兼容 env / 未替换拦截 / 已替换透传）', () => {
	test('旧 env 形态兼容解析：encodeURIComponent 替换 + 剥离 env + 备份凭据', () => {
		const tavilyLegacy = parseOk(
			'tavily',
			JSON.stringify({
				type: 'http',
				url: 'https://mcp.tavily.com/mcp/?tavilyApiKey={TAVILY_API_KEY}',
				env: {TAVILY_API_KEY: 'tvly a/b'}
			})
		);
		expect(tavilyLegacy.config.url).toBe('https://mcp.tavily.com/mcp/?tavilyApiKey=tvly%20a%2Fb');
		expect(tavilyLegacy.config.env).toBeUndefined();
		expect(tavilyLegacy.credentials).toEqual({TAVILY_API_KEY: 'tvly a/b'});
	});

	test('未替换占位符拦截并提示具体占位符名', () => {
		const tavilyUnresolved = parseMcpFormInput(
			'tavily',
			JSON.stringify({
				type: 'http',
				url: 'https://mcp.tavily.com/mcp/?tavilyApiKey={TAVILY_API_KEY}'
			})
		);
		expect(tavilyUnresolved.ok).toBe(false);
		expect(tavilyUnresolved.ok ? '' : tavilyUnresolved.error).toMatch(/未替换占位符/);
		expect(tavilyUnresolved.ok ? '' : tavilyUnresolved.error).toMatch(/\{TAVILY_API_KEY\}/);
	});

	test('用户已替换 URL 原样保留，不额外提取 credentials', () => {
		const tavilyResolved = parseOk(
			'tavily',
			JSON.stringify({
				type: 'http',
				url: 'https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-real-key'
			})
		);
		expect(tavilyResolved.config.url).toBe('https://mcp.tavily.com/mcp/?tavilyApiKey=tvly-real-key');
		expect(tavilyResolved.credentials).toBeUndefined();
	});
});

describe('configToJson 编辑回显（原样保留 c 方言 type/headers）', () => {
	test('config → pretty JSON 回显，不降级；空 config 返回 {}', () => {
		const jsonEcho = configToJson({type: 'http', url: 'https://x', headers: {h: 'v'}});
		expect(jsonEcho).toMatch(/"type": "http"/);
		expect(jsonEcho).toMatch(/"url": "https:\/\/x"/);
		expect(jsonEcho).toMatch(/"h": "v"/);
		expect(configToJson(null)).toBe('{}\n');
	});
});

describe('toCodexMcpConfig 降级（去 type + headers→http_headers + stdio 保留 env）', () => {
	test('c JSON 方言 → Codex TOML 字段集', () => {
		// 自定义 http MCP 用 c 方言存 vault（type + headers），enable codex 侧落盘时降级。
		const codexHttp = toCodexMcpConfig({type: 'http', url: 'https://x', headers: {'x-api-key': 'k'}});
		expect(codexHttp.type).toBeUndefined();
		expect(codexHttp.url).toBe('https://x');
		expect(codexHttp.headers).toBeUndefined();
		expect(codexHttp.http_headers).toEqual({'x-api-key': 'k'});

		// 已是 http_headers（旧 cx 方言 vault）透传不重复。
		const codexPassthrough = toCodexMcpConfig({url: 'https://x', http_headers: {'x-api-key': 'k'}});
		expect(codexPassthrough.http_headers).toEqual({'x-api-key': 'k'});

		// stdio 降级：保留 command/args/env，去 type。
		const codexStdio = toCodexMcpConfig({command: 'npx', args: ['-y', 'x'], env: {K: 'v'}});
		expect(codexStdio.type).toBeUndefined();
		expect(codexStdio.command).toBe('npx');
		expect(codexStdio.env).toEqual({K: 'v'});
	});
});

describe('parseMcpFormInput headers 保留非空 / 丢弃空值', () => {
	test('回归 header 丢失 bug', () => {
		const ccWithHeader = parseOk('my', '{"type":"http","url":"https://x","headers":{"x-api-key":"k"}}');
		expect(ccWithHeader.config.headers).toEqual({'x-api-key': 'k'});

		const ccEmptyHeader = parseOk('my', '{"type":"http","url":"https://x","headers":{"x-api-key":""}}');
		expect(ccEmptyHeader.config.headers).toBeUndefined();
	});
});

describe('端到端透传（额外 Codex/Claude 字段穿透解析层 + codex 降级）', () => {
	test('http：startup_timeout_sec / enabled_tools / bearer_token_env_var 透传', () => {
		// http：cwd 不适用，取 startup_timeout_sec / enabled_tools / bearer_token_env_var。
		const httpExtra = parseOk(
			'my',
			JSON.stringify({
				type: 'http',
				url: 'https://x',
				headers: {'x-api-key': 'k'},
				bearer_token_env_var: 'TOK',
				startup_timeout_sec: 30,
				enabled_tools: ['a', 'b']
			})
		);
		expect(httpExtra.config.bearer_token_env_var).toBe('TOK');
		expect(httpExtra.config.startup_timeout_sec).toBe(30);
		expect(httpExtra.config.enabled_tools).toEqual(['a', 'b']);

		// 再经 codex 降级：去 type、headers→http_headers，额外字段透传落盘。
		const httpExtraCodex = toCodexMcpConfig(httpExtra.config);
		expect(httpExtraCodex.type).toBeUndefined();
		expect(httpExtraCodex.http_headers).toEqual({'x-api-key': 'k'});
		expect(httpExtraCodex.bearer_token_env_var).toBe('TOK');
		expect(httpExtraCodex.enabled_tools).toEqual(['a', 'b']);
	});

	test('stdio：cwd / env_vars 透传', () => {
		const stdioExtra = parseOk(
			'my',
			JSON.stringify({
				command: 'npx',
				args: ['-y', 'x'],
				env: {K: 'v'},
				cwd: '/tmp/wd',
				env_vars: ['FOO']
			})
		);
		expect(stdioExtra.config.cwd).toBe('/tmp/wd');
		expect(stdioExtra.config.env_vars).toEqual(['FOO']);

		const stdioExtraCodex = toCodexMcpConfig(stdioExtra.config);
		expect(stdioExtraCodex.cwd).toBe('/tmp/wd');
		expect(stdioExtraCodex.env_vars).toEqual(['FOO']);
	});
});

describe('parseMcpJsonFormat 实时格式校验（语法 + 顶层对象）', () => {
	test('合法对象 / 语法错误 / 非对象', () => {
		expect(parseMcpJsonFormat('{"command":"npx"}').ok).toBe(true);

		const parsedValue = parseMcpJsonFormat('{"a":1}');
		expect(parsedValue.ok ? parsedValue.value : undefined).toEqual({a: 1});

		expect(parseMcpJsonFormat('{bad').ok).toBe(false);
		const syntaxError = parseMcpJsonFormat('{bad');
		expect(syntaxError.ok ? '' : syntaxError.error).toMatch(/JSON 格式错误/);

		expect(parseMcpJsonFormat('[]').ok).toBe(false);
		const arrayError = parseMcpJsonFormat('[]');
		expect(arrayError.ok ? '' : arrayError.error).toMatch(/必须是 JSON 对象/);

		expect(parseMcpJsonFormat('"x"').ok).toBe(false);
	});
});

describe('parseMcpFormInput 回归（stdio/http/格式错误/缺 command/serverId）', () => {
	test('stdio / http / 格式错误 / 缺 command / 空 serverId', () => {
		const stdio = parseOk('my', '{"command":"npx","args":["x"]}');
		expect(stdio.serverId).toBe('my');
		expect(stdio.config.command).toBe('npx');

		const http = parseOk('my', '{"type":"http","url":"https://x"}');
		expect(http.config.type).toBe('http');

		expect(parseMcpFormInput('my', '{bad').ok).toBe(false);
		const bad = parseMcpFormInput('my', '{bad');
		expect(bad.ok ? '' : bad.error).toMatch(/JSON 格式错误/);
		expect(parseMcpFormInput('my', '{"type":"stdio"}').ok).toBe(false);
		expect(parseMcpFormInput('', '{}').ok).toBe(false);
	});
});
