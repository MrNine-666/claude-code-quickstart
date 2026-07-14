import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {claudeDir, claudeJsonPath, codexConfigPath, codexDir, settingsPath} from './paths.js';
import {writeJsonAtomic} from './fs-utils.js';
import {atomicWrite as writeTomlAtomic, deletePath, parse as parseToml, type TomlDocument} from './toml-edit.js';
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

// ── CodeGraph 单侧集成的直删兜底（不经官方 codegraph CLI）─────────────────────────
// 实测：`codegraph uninstall --target=xxx` 会连带卸掉共享 CLI（与其文档描述不符），
// 因此逐 Agent 关闭一律走这里直接改配置文件，只解除单侧 MCP 集成，绝不触碰 CLI。
// Claude Code 删 `~/.claude.json` 的 `mcpServers.codegraph`；Codex 删 `~/.codex/config.toml` 的 `[mcp_servers.codegraph]`。

/** 直接从 ~/.claude.json 删除 codegraph MCP 集成（不动 CLI）。已无该键则 no-op。 */
export function removeClaudeCodeGraphIntegration(): void {
	const path = claudeJsonPath();
	if (!existsSync(path)) {
		return;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'));
	} catch {
		return;
	}

	if (!isObject(parsed) || !isObject(parsed['mcpServers']) || !('codegraph' in parsed['mcpServers'])) {
		return;
	}

	delete (parsed['mcpServers'] as JsonObject)['codegraph'];
	writeJsonAtomic(path, parsed);
}

/** 直接从 ~/.codex/config.toml 删除 [mcp_servers.codegraph] 表（不动 CLI）。已无该表则 no-op。 */
export function removeCodexCodeGraphIntegration(): void {
	const path = codexConfigPath();
	if (!existsSync(path)) {
		return;
	}

	let document: TomlDocument;
	try {
		document = parseToml(readFileSync(path, 'utf8'));
	} catch {
		return;
	}

	writeTomlAtomic(path, deletePath(document, ['mcp_servers', 'codegraph']));
}

/**
 * 从 Markdown 指令文件中删除 `<!-- CODEGRAPH_START -->` … `<!-- CODEGRAPH_END -->` 注释块。
 * 官方 install 会写入该块（Claude → ~/.claude/CLAUDE.md，Codex → ~/.codex/AGENTS.md）；
 * 逐 Agent 关闭走直删兜底时官方 uninstall 不再执行，需自行清理，否则块会残留。
 * 无文件 / 无块 / 解析失败均 no-op。
 */
function removeCodeGraphInstructionBlock(mdPath: string): void {
	if (!existsSync(mdPath)) {
		return;
	}

	let content: string;
	try {
		content = readFileSync(mdPath, 'utf8');
	} catch {
		return;
	}

	if (!content.includes('CODEGRAPH_START')) {
		return;
	}

	// 连同块前的空白行一起吃掉，避免留下多余空行；非贪婪到最近的 END 标记。
	const blockPattern = /\n*[^\n]*<!--\s*CODEGRAPH_START\s*-->[\s\S]*?<!--\s*CODEGRAPH_END\s*-->[^\n]*/g;
	const cleaned = content.replace(blockPattern, '').replace(/\n{3,}/g, '\n\n');
	if (cleaned === content) {
		return;
	}

	try {
		writeFileSync(mdPath, cleaned, 'utf8');
	} catch {
		// 写失败不阻断卸载主流程（集成配置已删除即达成解除目的）。
	}
}

/** 某 hook group 是否为 codegraph 注入（其内所有命令都以裸 `codegraph ` 开头）。 */
function isCodeGraphHookGroup(group: unknown): boolean {
	if (!isObject(group) || !Array.isArray(group['hooks'])) {
		return false;
	}

	const hooks = group['hooks'] as unknown[];
	if (hooks.length === 0) {
		return false;
	}

	// 仅当 group 内每一条命令都以裸 `codegraph` 开头才判为 codegraph 注入，
	// 避免误删用户/orca/ccg-workflow（node .../ccg/*.js、.orca 的 sh）等同事件 hook。
	return hooks.every(hook => {
		if (!isObject(hook)) {
			return false;
		}

		const command = hook['command'];
		return typeof command === 'string' && /^codegraph(\s|$)/.test(command.trim());
	});
}

/**
 * 从 ~/.claude/settings.json 清理 codegraph 残留（官方 install --target=claude 写入）：
 *   - permissions.allow 里以 `mcp__codegraph` 开头的项；
 *   - hooks 各事件里「命令以裸 codegraph 开头」的 group（版本不同事件名不定：
 *     UserPromptSubmit/SessionStart/PostToolUse 等，一律按命令识别，不按事件名）。
 * 严格保护用户 / orca / ccg-workflow 的同事件 hook（node .../ccg/*.js、.orca sh）。
 * 无文件 / 无残留 / 解析失败均 no-op；仅在确有改动时落盘。
 */
export function removeClaudeCodeGraphSettings(): void {
	const path = settingsPath();
	if (!existsSync(path)) {
		return;
	}

	let settings: JsonObject;
	try {
		const parsed = JSON.parse(readFileSync(path, 'utf8'));
		if (!isObject(parsed)) {
			return;
		}

		settings = parsed;
	} catch {
		return;
	}

	let changed = false;

	// permissions.allow：剔除 mcp__codegraph* 前缀项。
	const permissions = settings['permissions'];
	if (isObject(permissions) && Array.isArray(permissions['allow'])) {
		const allow = permissions['allow'] as unknown[];
		const filtered = allow.filter(item => !(typeof item === 'string' && item.startsWith('mcp__codegraph')));
		if (filtered.length !== allow.length) {
			permissions['allow'] = filtered;
			changed = true;
		}
	}

	// hooks：逐事件删除 codegraph 注入的 group；group 清空后移除事件键。
	const hooks = settings['hooks'];
	if (isObject(hooks)) {
		for (const event of Object.keys(hooks)) {
			const groups = hooks[event];
			if (!Array.isArray(groups)) {
				continue;
			}

			const kept = groups.filter(group => !isCodeGraphHookGroup(group));
			if (kept.length !== groups.length) {
				changed = true;
				if (kept.length === 0) {
					delete hooks[event];
				} else {
					hooks[event] = kept;
				}
			}
		}
	}

	if (!changed) {
		return;
	}

	writeJsonAtomic(path, settings);
}

/** 单侧解除 CodeGraph 集成（直改配置 + 清理指令块，绝不触碰共享 CLI）。 */
export function removeCodeGraphIntegration(context: AgentContext): void {
	if (context === 'cx') {
		removeCodexCodeGraphIntegration();
		removeCodeGraphInstructionBlock(join(codexDir(), 'AGENTS.md'));
		return;
	}

	removeClaudeCodeGraphIntegration();
	removeCodeGraphInstructionBlock(join(claudeDir(), 'CLAUDE.md'));
	removeClaudeCodeGraphSettings();
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
