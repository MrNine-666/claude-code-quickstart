import {
	applyFillMissingToText,
	assembleRecommendationAnnotated,
	mergeProviderEnvOnSave,
	readInstalledSettingsText,
	settingsFilePath,
	stripProviderEnvFromText
} from '../core/config-recommend.js';
import {
	applyCodexFillMissingToText,
	assembleCodexRecommendationAnnotated,
	readCodexConfigText,
	saveCodexConfigToml
} from '../core/codex-config.js';
import {existsSync} from 'node:fs';
import {atomicWrite} from '../core/fs-utils.js';
import {codexConfigPath} from '../core/paths.js';
import type {AgentContext} from '../state/manage-state.js';

// Config service：配置文件视图唯一入口，按 agentContext 切换目标文件。
// Claude target：~/.claude/settings.json（剥离供应商 env，保存合并保留）。
// Codex target：CODEX_HOME/config.toml（TOML 结构化校验，推荐 fill-missing 不管理 provider/MCP/hooks/Skills/AGENTS.md）。

export type ConfigTarget = AgentContext;

/** 读取当前配置，返回供 view/edit 展示的文本。 */
export function readCurrentConfigText(target: ConfigTarget = 'cc'): string {
	if (target === 'cx') {
		return readCodexConfigText() ?? '';
	}

	const raw = readInstalledSettingsText();
	if (!raw) {
		return '';
	}
	const result = stripProviderEnvFromText(raw);
	return result.ok ? result.text : raw;  // 解析失败退回原文（保留可读性，让用户看到原始内容）
}

/** 兼容旧调用：读取当前 settings.json，剥离供应商 env 字段后返回。 */
export function readCurrentSettingsTextStripped(): string {
	return readCurrentConfigText('cc');
}

/** 组装带注释的推荐配置文本。 */
export function loadRecommendationAnnotated(target: ConfigTarget = 'cc'): string | null {
	return target === 'cx' ? assembleCodexRecommendationAnnotated() : assembleRecommendationAnnotated();
}

/** 对编辑缓冲执行 fill-missing 合并。 */
export function fillMissingIntoText(jsonText: string, target: ConfigTarget = 'cc'):
	| {readonly ok: true; readonly text: string; readonly changed: number}
	| {readonly ok: false; readonly error: string} {
	return target === 'cx' ? applyCodexFillMissingToText(jsonText) : applyFillMissingToText(jsonText);
}

/** 获取配置目标路径（供视图展示）。 */
export function getConfigPath(target: ConfigTarget = 'cc'): string {
	return target === 'cx' ? codexConfigPath() : settingsFilePath();
}

/** 判断配置目标文件是否存在；用于区分“文件不存在”和“过滤后暂无本页管辖项”。 */
export function configFileExists(target: ConfigTarget = 'cc'): boolean {
	return existsSync(getConfigPath(target));
}

/** 兼容旧调用：获取 settings.json 文件路径。 */
export function getSettingsPath(): string {
	return getConfigPath('cc');
}

/** 保存配置文本。 */
export function saveConfigText(content: string, target: ConfigTarget = 'cc'): {ok: boolean; error?: string; warning?: string} {
	if (target === 'cx') {
		return saveCodexConfigToml(content);
	}

	try {
		JSON.parse(content);  // 校验 edited 合法 JSON
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	const merged = mergeProviderEnvOnSave(content, readInstalledSettingsText());
	if (!merged.ok) {
		return {ok: false, error: merged.error};
	}

	try {
		atomicWrite(settingsFilePath(), merged.text);
		return {ok: true};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/** 兼容旧调用：保存 settings.json。 */
export function saveSettingsMerged(jsonContent: string): {ok: boolean; error?: string} {
	return saveConfigText(jsonContent, 'cc');
}
