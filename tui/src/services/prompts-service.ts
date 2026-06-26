import type {ProgressCallback} from '../core/exec.js';
import {
	assembleRecommendation,
	claudeMdPath,
	importRecommendation,
	loadRecommendation,
	readInstalledClaudeMd,
	type ImportResult,
	type PromptsRecommendation
} from '../core/prompts.js';
import {atomicWrite} from '../core/fs-utils.js';
import {copyToClipboard, isClipboardSupported, type ClipboardResult} from '../core/clipboard.js';

// Prompts service：TUI 视图唯一入口，包装 core 并统一进度上报。
// Phase 5: 移除 external-editor 调用链，改用内嵌编辑器（OpenTUI textarea）

/** 加载推荐全局规则（供预览展示）。 */
export function loadRecommendationForPreview(): PromptsRecommendation {
	return loadRecommendation();
}

/** 读取当前已安装的 CLAUDE.md（不存在返回 null）。 */
export function readCurrentClaudeMd(): string | null {
	return readInstalledClaudeMd();
}

/** 导入推荐全局规则（整文件覆盖），带进度上报。 */
export async function importRecommendationWithProgress(onProgress?: ProgressCallback): Promise<ImportResult> {
	onProgress?.({level: 'info', message: '正在导入推荐全局规则...'});
	const result = importRecommendation();
	if (result.ok) {
		onProgress?.({level: 'success', message: `已导入 ${result.lineCount} 行推荐全局规则`});
	} else {
		onProgress?.({level: 'danger', message: `导入失败: ${result.error}`});
	}

	return result;
}

/** 复制推荐全局规则到剪贴板，带进度上报。 */
export async function copyRecommendationToClipboard(onProgress?: ProgressCallback): Promise<ClipboardResult> {
	const recommendation = assembleRecommendation();
	if (!recommendation) {
		const error = '推荐全局规则模板不可用';
		onProgress?.({level: 'danger', message: error});
		return {ok: false, error};
	}

	onProgress?.({level: 'info', message: '正在复制到剪贴板...'});
	const result = await copyToClipboard(recommendation);
	if (result.ok) {
		onProgress?.({level: 'success', message: '已复制到剪贴板'});
	} else {
		onProgress?.({level: 'danger', message: `复制失败: ${result.error}`});
	}

	return result;
}

/** 检测剪贴板是否可用（仅 Windows / macOS）。 */
export function checkClipboardSupport(): boolean {
	return isClipboardSupported();
}

/** 获取 CLAUDE.md 文件路径（供视图展示）。 */
export function getClaudeMdPath(): string {
	return claudeMdPath();
}

/** 内嵌编辑器保存：整文件覆盖写入 ~/.claude/CLAUDE.md（原子写）。 */
export function saveClaudeMd(content: string): {ok: boolean; error?: string} {
	try {
		atomicWrite(claudeMdPath(), content);
		return {ok: true};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}
