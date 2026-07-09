import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadTextContract} from './contracts.js';
import {atomicWrite} from './fs-utils.js';
import {claudeDir} from './paths.js';

// 全局规则菜单 core：推荐规则加载 + 整文件覆盖导入。
// Claude Code 保持既有 base + 平台段模板；Codex 维护独立 codex-md.md 模板，禁止
// 从 Claude 模板运行时替换生成 Codex 模板。
// Update 检测已收缩（HC-FU-08 不再检测 ClaudeMd），导入不写指纹种子。

export type PromptsPlatform = 'windows' | 'macos';
export type RulesRecommendationTarget = 'cc' | 'cx';

export type PromptsRecommendation = {
	readonly available: boolean;
	readonly content: string;
	readonly lineCount: number;
};

/** 读 templates 目录下任意文件；缺失或读取失败返回 null，不抛。 */
function readTemplateFile(fileName: string): string | null {
	try {
		return loadTextContract(`templates/${fileName}`);
	} catch {
		return null;
	}
}

function detectPlatform(): PromptsPlatform {
	return process.platform === 'darwin' ? 'macos' : 'windows';
}

function readClaudeTemplate(name: string): string | null {
	return readTemplateFile(`claude-md.${name}.md`);
}

/** 加载 Claude Code 推荐规则（base + 平台段，兼容旧调用）。 */
export function assembleRecommendation(platform: PromptsPlatform = detectPlatform()): string | null {
	const base = readClaudeTemplate('base');
	if (!base) {
		return null;
	}

	const platformContent = readClaudeTemplate(`platform-${platform}`);
	if (!platformContent) {
		return `${base.trimEnd()}\n`;
	}

	return `${base.trimEnd()}\n\n${platformContent.trimEnd()}\n`;
}

/** 按 Agent 目标加载推荐规则：cc 走 Claude 分段模板，cx 走独立 Codex 模板。 */
export function assembleRulesRecommendation(target: RulesRecommendationTarget = 'cc', platform: PromptsPlatform = detectPlatform()): string | null {
	if (target === 'cc') {
		return assembleRecommendation(platform);
	}

	const content = readTemplateFile('codex-md.md');
	return content === null ? null : `${content.trimEnd()}\n`;
}

/** 加载推荐全局规则（供视图预览）。 */
export function loadRecommendation(platform?: PromptsPlatform): PromptsRecommendation {
	const content = assembleRecommendation(platform);
	if (content === null) {
		return {available: false, content: '', lineCount: 0};
	}

	return {available: true, content, lineCount: content.split('\n').length};
}

/** 用户级 CLAUDE.md 路径（~/.claude/CLAUDE.md）。 */
export function claudeMdPath(): string {
	return join(claudeDir(), 'CLAUDE.md');
}

export type ImportResult = {readonly ok: true; readonly lineCount: number} | {readonly ok: false; readonly error: string};

/**
 * 整文件覆盖导入推荐 CLAUDE.md（原子写入）。
 * 与 installer 的 Install-ClaudeMd 一致：主文件为整文件覆盖（非 fill-missing）。
 */
export function importRecommendation(platform?: PromptsPlatform): ImportResult {
	const content = assembleRecommendation(platform);
	if (content === null) {
		return {ok: false, error: '推荐全局规则模板不可用（contracts/templates 缺失）'};
	}

	try {
		atomicWrite(claudeMdPath(), content);
		return {ok: true, lineCount: content.split('\n').length};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/** 读取当前用户级 CLAUDE.md（不存在或读取失败返回 null）。 */
export function readInstalledClaudeMd(): string | null {
	const path = claudeMdPath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}


/**
 * 工具注入的受管注释块标记对（Ctrl+O 导入推荐时保留，不被推荐正文覆盖）。
 * CODEGRAPH_* 由 ccq 工具管理注入；CCG-* 由 ccg-workflow 注入（fast-context / grok / codex-mode）。
 */
const MANAGED_MARKER_PAIRS: ReadonlyArray<readonly [start: string, end: string]> = [
	['<!-- CODEGRAPH_START -->', '<!-- CODEGRAPH_END -->'],
	['<!-- CCG-FAST-CONTEXT-START -->', '<!-- CCG-FAST-CONTEXT-END -->'],
	['<!-- CCG-GROK-SEARCH-PROMPT-START -->', '<!-- CCG-GROK-SEARCH-PROMPT-END -->'],
	['<!-- CCG:START -->', '<!-- CCG:END -->']
];

/** 从文本提取所有受管注释块（按原文出现顺序）；缺少成对标记的跳过。 */
export function extractManagedBlocks(text: string): string[] {
	const found: Array<{start: number; block: string}> = [];
	for (const [startMarker, endMarker] of MANAGED_MARKER_PAIRS) {
		let searchFrom = 0;
		for (;;) {
			const startIdx = text.indexOf(startMarker, searchFrom);
			if (startIdx === -1) {
				break;
			}
			const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
			if (endIdx === -1) {
				break;
			}
			const end = endIdx + endMarker.length;
			found.push({start: startIdx, block: text.slice(startIdx, end)});
			searchFrom = end;
		}
	}
	found.sort((a, b) => a.start - b.start);
	return found.map(item => item.block);
}

/**
 * 导入推荐时合并：推荐正文覆盖注释块以外的内容，工具注入的注释块原样保留并追加在后。
 * currentText 无受管块时直接返回推荐正文。
 */
export function mergeRecommendationPreservingManagedBlocks(recommendation: string, currentText: string): string {
	const blocks = extractManagedBlocks(currentText);
	if (blocks.length === 0) {
		return recommendation;
	}
	return `${recommendation.trimEnd()}\n\n${blocks.join('\n\n')}\n`;
}
