#!/usr/bin/env bun
import {loadContract, loadTextContract} from '../src/core/contracts.js';

type JsonObject = Record<string, unknown>;

function assertObject(name: string, value: unknown): asserts value is JsonObject {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${name} 应加载为 JSON 对象`);
	}
}

function assertText(name: string, value: string, expectedSnippet: string): void {
	if (typeof value !== 'string' || value.length === 0) {
		throw new Error(`${name} 应加载为非空文本`);
	}

	if (/^(?:[A-Za-z]:[\\/]|\/|~BUN|B:[\\/])/u.test(value)) {
		throw new Error(`${name} 被加载为路径而不是文本内容: ${value.slice(0, 80)}`);
	}

	if (!value.includes(expectedSnippet)) {
		throw new Error(`${name} 未包含预期文本片段: ${expectedSnippet}`);
	}
}

function assertThrows(name: string, action: () => unknown): void {
	let threw = false;
	try {
		action();
	} catch {
		threw = true;
	}

	if (!threw) {
		throw new Error(`${name} 已清理出运行时内嵌 Map，不应加载成功`);
	}
}

try {
	const providers = loadContract('providers.json');
	assertObject('providers.json', providers);
	if (!('BuiltinProviders' in providers)) {
		throw new Error('providers.json 缺少 BuiltinProviders');
	}

	const mcpServers = loadContract('mcp-servers.json');
	assertObject('mcp-servers.json', mcpServers);

	const claudeConfig = loadContract('claude-config.json');
	assertObject('claude-config.json', claudeConfig);

	const claudeBaseTemplate = loadTextContract('templates/claude-md.base.md');
	assertText('templates/claude-md.base.md', claudeBaseTemplate, '# Claude Code 增强配置');

	const claudeWindowsTemplate = loadTextContract('templates/claude-md.platform-windows.md');
	assertText('templates/claude-md.platform-windows.md', claudeWindowsTemplate, 'Windows / PowerShell');

	const codexTemplate = loadTextContract('templates/codex-md.md');
	assertText('templates/codex-md.md', codexTemplate, '暂未内置推荐规则模板。');

	assertThrows('ccg-workflow.json', () => loadContract('ccg-workflow.json'));
	assertThrows('templates/index.json', () => loadContract('templates/index.json'));
	assertThrows('claude-config-drift.js', () => loadTextContract('claude-config-drift.js'));

	console.log(JSON.stringify({
		status: 'PROBE_PASS',
		providers: Object.keys((providers as JsonObject).BuiltinProviders as JsonObject).length,
		claudeBaseTemplateLength: claudeBaseTemplate.length,
		claudeWindowsTemplateLength: claudeWindowsTemplate.length,
		codexTemplateLength: codexTemplate.length
	}));
} catch (error) {
	console.error(`PROBE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
