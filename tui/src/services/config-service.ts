import type {ProgressCallback} from '../core/exec.js';
import {
	assembleRecommendationJson,
	importFillMissing,
	loadRecommendation,
	readInstalledSettings,
	settingsFilePath,
	type ConfigRecommendation,
	type ImportResult
} from '../core/config-recommend.js';
import {copyToClipboard, isClipboardSupported, type ClipboardResult} from '../core/clipboard.js';
import {atomicWrite} from '../core/fs-utils.js';

// Config service：配置文件视图唯一入口，包装 core 并统一进度上报（对齐 prompts-service 结构）。
// Phase 5: 移除 external-editor 调用链，改用内嵌编辑器（OpenTUI textarea）

/** 加载推荐配置（供预览展示，含 description 介绍）。 */
export function loadRecommendationForPreview(): ConfigRecommendation {
	return loadRecommendation();
}

/** 读取当前已安装的 settings.json（不存在返回 null）。 */
export function readCurrentSettings(): Record<string, unknown> | null {
	return readInstalledSettings();
}

/** fill-missing 导入推荐配置（仅补缺失，不覆盖已有），带进度上报。 */
export async function importFillMissingWithProgress(onProgress?: ProgressCallback): Promise<ImportResult> {
	onProgress?.({level: 'info', message: '正在按缺失项补全配置...'});
	const result = importFillMissing();
	if (result.ok) {
		const summary = result.changed === 0 ? '配置已是最新，无需补全' : `已补全 ${result.changed} 项配置`;
		onProgress?.({level: 'success', message: summary});
	} else {
		onProgress?.({level: 'danger', message: `导入失败: ${result.error}`});
	}

	return result;
}

/** 复制推荐配置 JSON 到剪贴板，带进度上报。 */
export async function copyRecommendationToClipboard(onProgress?: ProgressCallback): Promise<ClipboardResult> {
	const json = assembleRecommendationJson();
	if (!json) {
		const error = '推荐配置契约不可用';
		onProgress?.({level: 'danger', message: error});
		return {ok: false, error};
	}

	onProgress?.({level: 'info', message: '正在复制到剪贴板...'});
	const result = await copyToClipboard(json);
	if (result.ok) {
		onProgress?.({level: 'success', message: '已复制推荐配置到剪贴板'});
	} else {
		onProgress?.({level: 'danger', message: `复制失败: ${result.error}`});
	}

	return result;
}

/** 检测剪贴板是否可用（仅 Windows / macOS）。 */
export function checkClipboardSupport(): boolean {
	return isClipboardSupported();
}

/** 获取 settings.json 文件路径（供视图展示）。 */
export function getSettingsPath(): string {
	return settingsFilePath();
}

/** 内嵌编辑器保存：JSON.parse 校验通过后整文件覆盖写入 settings.json（原子写）。 */
export function saveSettings(jsonContent: string): {ok: boolean; error?: string} {
	try {
		JSON.parse(jsonContent); // 校验合法 JSON，非法则拒绝写入。
	} catch (error) {
		return {ok: false, error: `JSON 格式错误: ${error instanceof Error ? error.message : String(error)}`};
	}

	try {
		atomicWrite(settingsFilePath(), jsonContent);
		return {ok: true};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
