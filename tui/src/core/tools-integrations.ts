import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {claudeDir, claudeJsonPath, codexConfigPath, codexDir} from './paths.js';
import type {AgentContext} from '../state/manage-state.js';

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasClaudeCodeGraphIntegration(): boolean {
	const path = claudeJsonPath();
	if (!existsSync(path)) {
		return false;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
		return isObject(parsed) && isObject(parsed['mcpServers']) && isObject(parsed['mcpServers']['codegraph']);
	} catch {
		return false;
	}
}

function hasEnabledTomlTable(config: string, tableName: string): boolean {
	const tableHeader = `[${tableName}]`;
	const lines = config.split(/\r?\n/);
	let inTable = false;
	let found = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (/^\[[^\]]+\]$/.test(trimmed)) {
			inTable = trimmed === tableHeader;
			found ||= inTable;
			continue;
		}

		if (inTable && /^enabled\s*=\s*false(?:\s*(?:#.*)?)?$/i.test(trimmed)) {
			return false;
		}
	}

	return found;
}

export function hasCodexCodeGraphIntegration(): boolean {
	const configPath = codexConfigPath();
	if (!existsSync(configPath)) {
		return false;
	}

	try {
		const config = readFileSync(configPath, 'utf8');
		return hasEnabledTomlTable(config, 'mcp_servers.codegraph');
	} catch {
		return false;
	}
}

export function hasCodeGraphIntegration(context: AgentContext): boolean {
	return context === 'cx' ? hasCodexCodeGraphIntegration() : hasClaudeCodeGraphIntegration();
}

export function readCodexCcgWorkflowVersion(): string {
	const versionPath = join(codexDir(), '.ccg-version');
	if (!existsSync(versionPath)) {
		return '';
	}

	try {
		const content = readFileSync(versionPath, 'utf8').trim();
		return content.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0] ?? content;
	} catch {
		return '';
	}
}

export function installedCodeGraphContexts(): AgentContext[] {
	const contexts: AgentContext[] = [];
	if (hasClaudeCodeGraphIntegration()) {
		contexts.push('cc');
	}

	if (hasCodexCodeGraphIntegration()) {
		contexts.push('cx');
	}

	return contexts;
}

export function hasClaudeCcgWorkflowMode(): boolean {
	return existsSync(join(claudeDir(), '.ccg', 'config.toml'));
}

export function hasCodexCcgWorkflowMode(): boolean {
	return readCodexCcgWorkflowVersion() !== '';
}
