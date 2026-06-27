import {claudeMdPath, readInstalledClaudeMd} from '../core/prompts.js';
import {atomicWrite} from '../core/fs-utils.js';
import {isClipboardSupported} from '../core/clipboard.js';

// Prompts service：TUI 视图唯一入口，包装 core。
// 工作台（PromptsView）直接消费 core/prompts 的模板列表（listMenuTemplates / resolveMenuTemplateContent）
// 与 core/clipboard 的复制（copyToClipboard），交互层已下沉到视图；service 仅保留路径 / 读取 / 保存 / 剪贴板可用性检测。

/** 读取当前已安装的 CLAUDE.md（不存在返回 null）。 */
export function readCurrentClaudeMd(): string | null {
	return readInstalledClaudeMd();
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
