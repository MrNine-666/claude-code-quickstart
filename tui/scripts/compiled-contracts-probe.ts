#!/usr/bin/env bun
import {loadContract, loadTextContract} from '../src/core/contracts.js';

type JsonObject = Record<string, unknown>;

function assertObject(name: string, value: unknown): asserts value is JsonObject {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`${name} 应加载为 JSON 对象`);
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

	assertThrows('ccg-workflow.json', () => loadContract('ccg-workflow.json'));
	assertThrows('templates/index.json', () => loadContract('templates/index.json'));
	for (const template of [
		'templates/claude-md.base.md',
		'templates/claude-md.platform-windows.md',
		'templates/codex-md.md',
		'templates/pi-md.md'
	]) {
		assertThrows(template, () => loadTextContract(template));
	}
	assertThrows('claude-config-drift.js', () => loadTextContract('claude-config-drift.js'));

	console.log(JSON.stringify({
		status: 'PROBE_PASS',
		providers: Object.keys((providers as JsonObject).BuiltinProviders as JsonObject).length
	}));
} catch (error) {
	console.error(`PROBE_FAIL: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}
