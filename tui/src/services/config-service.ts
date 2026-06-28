import {
	applyFillMissingToText,
	assembleRecommendationAnnotated,
	mergeProviderEnvOnSave,
	readInstalledSettingsText,
	settingsFilePath,
	stripProviderEnvFromText
} from '../core/config-recommend.js';
import {atomicWrite} from '../core/fs-utils.js';

// Config service：配置文件视图唯一入口，包装 core 并对齐 prompts-service 结构。
// view-first（对齐 PromptsView）+ 字段级（settings.json 多页共享）：
// view/edit 仅展示 ClaudeConfig 管辖字段（剥离供应商 env，HC-12 字段所有权），保存时合并保留供应商 env。
// 落盘版 fill-missing 仍由 core 提供（verify 守护）。

/** 读取当前 settings.json，剥离供应商 env 字段后返回（供 view/edit 展示，不暴露 token 等）。 */
export function readCurrentSettingsTextStripped(): string {
	const raw = readInstalledSettingsText();
	if (!raw) {
		return '';
	}
	const result = stripProviderEnvFromText(raw);
	return result.ok ? result.text : raw;  // 解析失败退回原文（保留可读性，让用户看到原始内容）
}

/** 组装带注释的推荐配置文本（JSONC 风格，每项 description 以 // 注释标注，供推荐边栏对照展示）。 */
export function loadRecommendationAnnotated(): string | null {
	return assembleRecommendationAnnotated();
}

/** 对编辑缓冲 JSON 文本执行 fill-missing 合并（仅补缺失，保留用户已有配置），供推荐边栏 Ctrl+O 灌缓冲。 */
export function fillMissingIntoText(jsonText: string):
	| {readonly ok: true; readonly text: string; readonly changed: number}
	| {readonly ok: false; readonly error: string} {
	return applyFillMissingToText(jsonText);
}

/** 获取 settings.json 文件路径（供视图展示）。 */
export function getSettingsPath(): string {
	return settingsFilePath();
}

/** 保存：edited 是用户编辑（不含供应商 env），校验合法 JSON 后合并原文件供应商 env，整文件原子写入。 */
export function saveSettingsMerged(jsonContent: string): {ok: boolean; error?: string} {
	try {
		JSON.parse(jsonContent);  // 校验 edited 合法 JSON
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	const merged = mergeProviderEnvOnSave(jsonContent, readInstalledSettingsText());
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
