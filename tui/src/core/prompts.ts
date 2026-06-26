import {existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveContractsDir} from './contracts.js';
import {atomicWrite} from './fs-utils.js';
import {claudeDir} from './paths.js';

// 全局规则菜单 core：推荐 CLAUDE.md 加载（base + 平台段）+ 整文件覆盖导入。
// 与 installer/windows/steps/ClaudeMd.ps1 / macos/steps/ClaudeMd.zsh 的拼装逻辑对齐：
//   base.TrimEnd() + "\n\n" + platform.TrimEnd() + "\n"
// Update 检测已收缩（HC-FU-08 不再检测 ClaudeMd），导入不写指纹种子。

export type PromptsPlatform = 'windows' | 'macos';

export type PromptsRecommendation = {
	readonly available: boolean;
	readonly content: string;
	readonly lineCount: number;
};

function templatePath(name: string): string {
	return join(resolveContractsDir(), 'templates', `claude-md.${name}.md`);
}

function readTemplate(name: string): string | null {
	const path = templatePath(name);
	if (!existsSync(path)) {
		return null;
	}

	return readFileSync(path, 'utf8');
}

/** 推断当前运行平台（Windows / macOS），决定拼装哪段平台模板。 */
function detectPlatform(): PromptsPlatform {
	return process.platform === 'darwin' ? 'macos' : 'windows';
}

/**
 * 拼装完整推荐 CLAUDE.md 内容（base + 平台段），与两端 installer 拼装规则一致。
 * 任一模板缺失则返回 null（视图据此提示契约不可用）。
 */
export function assembleRecommendation(platform: PromptsPlatform = detectPlatform()): string | null {
	const base = readTemplate('base');
	const platformContent = readTemplate(`platform-${platform}`);
	if (!base || !platformContent) {
		return null;
	}

	return `${base.trimEnd()}\n\n${platformContent.trimEnd()}\n`;
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
