import {claudeMdPath, readInstalledClaudeMd} from '../core/prompts.js';
import {atomicWrite} from '../core/fs-utils.js';
import {codexAgentsPath, piAgentsPath} from '../core/paths.js';
import {openExternalFile, type OpenExternalFileResult} from '../core/open-file.js';
import type {AgentContext} from '../state/manage-state.js';
import {existsSync, readFileSync} from 'node:fs';

// Prompts service：TUI 视图唯一入口，按 agentContext 切换全局规则目标文件。
// Claude Code → ~/.claude/CLAUDE.md；Codex → ~/.codex/AGENTS.md。
// Pi → ~/.pi/agent/AGENTS.md；本服务只负责现有规则文件。

export type PromptsTarget = AgentContext;

function targetPath(target: PromptsTarget): string {
	return target === 'cx' ? codexAgentsPath() : target === 'pi' ? piAgentsPath() : claudeMdPath();
}

/** 读取当前已安装的全局规则（不存在返回 null）。 */
export function readCurrentRules(target: PromptsTarget = 'cc'): string | null {
	if (target === 'cc') {
		return readInstalledClaudeMd();
	}

	const path = target === 'pi' ? piAgentsPath() : codexAgentsPath();
	if (!existsSync(path)) {
		return null;
	}

	try {
		return readFileSync(path, 'utf8');
	} catch {
		return null;
	}
}

/** 兼容旧调用：读取当前已安装的 CLAUDE.md（不存在返回 null）。 */
export function readCurrentClaudeMd(): string | null {
	return readCurrentRules('cc');
}

/** 获取全局规则文件路径（供视图展示）。 */
export function getRulesPath(target: PromptsTarget = 'cc'): string {
	return targetPath(target);
}

/** 通过系统默认关联应用打开全局规则文件。 */
export function openRulesFile(target: PromptsTarget = 'cc'): Promise<OpenExternalFileResult> {
	return openExternalFile(getRulesPath(target));
}

/** 兼容旧调用：获取 CLAUDE.md 文件路径。 */
export function getClaudeMdPath(): string {
	return getRulesPath('cc');
}

/** 内嵌编辑器保存：整文件覆盖写入目标规则文件（原子写）。 */
export function saveRules(content: string, target: PromptsTarget = 'cc'): {ok: boolean; error?: string} {
	try {
		atomicWrite(targetPath(target), content);
		return {ok: true};
	} catch (error) {
		return {ok: false, error: error instanceof Error ? error.message : String(error)};
	}
}

/** 兼容旧调用：保存 CLAUDE.md。 */
export function saveClaudeMd(content: string): {ok: boolean; error?: string} {
	return saveRules(content, 'cc');
}
