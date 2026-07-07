import type {AgentContext} from '../state/manage-state.js';
import {skillsAgentOf} from './skills.js';
import {execCommand, removeAnsiSequences, type ProgressCallback, type ExecResult} from './exec.js';

// Skills 操作服务：install / update / uninstall，进度通过 onProgress(event) 上报，
// 不直接 console.log（design D11/D13；spec skills-tui "actions SHALL not print directly"）。
// exec 缝允许测试注入桩，避免真实 spawn；默认走 execCommand（向后兼容）。
export type SkillsExecFn = (command: string, args: readonly string[], options?: {timeout?: number}) => Promise<ExecResult>;

const INSTALL_TIMEOUT_MS = 600000;
const UPDATE_TIMEOUT_MS = 600000;
const UNINSTALL_TIMEOUT_MS = 300000;

export type SkillsActionResult = {
	readonly success: boolean;
	readonly error?: string;
	readonly noChange?: boolean;
};

export type InstallSkillInput = {
	readonly source: string;
	readonly displayName?: string;
	readonly skillName?: string;
	readonly copyMode?: boolean;
};

function emit(onProgress: ProgressCallback | undefined, event: Parameters<ProgressCallback>[0]): void {
	onProgress?.(event);
}

/** 友好错误消息（对齐旧 skills-manager.js getFriendlyError）。 */
export function getFriendlyError(exitCode: number, errorText: string, actionName: string): string {
	if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(errorText)) {
		return '无法访问 npm/GitHub，请检查网络连接或代理设置';
	}

	if (/EACCES|EPERM|permission|symlink/i.test(errorText)) {
		return '文件权限或 symlink 创建失败，可在安装时启用 copy 模式';
	}

	if (/not found|No matching|404/i.test(errorText)) {
		return 'Skills source 或指定 skill 可能已变更，请检查来源';
	}

	return `Skills ${actionName}失败 (ExitCode: ${exitCode})`;
}

/** 安装单个 Skill（`skills add`）。 */
function normalizeAgentAndExec(agentOrExec: AgentContext | SkillsExecFn | undefined, exec: SkillsExecFn | undefined): {agentContext: AgentContext; exec: SkillsExecFn} {
	return typeof agentOrExec === 'function'
		? {agentContext: 'cc', exec: agentOrExec}
		: {agentContext: agentOrExec ?? 'cc', exec: exec ?? execCommand};
}

export async function installSkill(
	input: InstallSkillInput,
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	const {agentContext, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	const args = ['--yes', 'skills', 'add', input.source, '--yes', '--agent', skillsAgentOf(agentContext), '-g'];
	if (input.skillName) {
		args.push('--skill', input.skillName);
	}

	if (input.copyMode) {
		args.push('--copy');
	}

	const label = input.displayName || input.source;
	emit(onProgress, {level: 'info', message: `正在安装 ${label}`, componentId: label});

	try {
		const {code, stdout, stderr} = await exec('npx', args, {timeout: INSTALL_TIMEOUT_MS});
		if (code === 0) {
			emit(onProgress, {level: 'success', message: `${label} 安装成功`, componentId: label});
			return {success: true};
		}

		const error = getFriendlyError(code, stderr || stdout || '未知错误', '安装');
		emit(onProgress, {level: 'warning', message: `${label} 安装失败: ${error}`, componentId: label});
		return {success: false, error};
	} catch (error) {
		const friendly = getFriendlyError(-1, error instanceof Error ? error.message : String(error), '安装');
		emit(onProgress, {level: 'warning', message: `${label} 安装失败: ${friendly}`, componentId: label});
		return {success: false, error: friendly};
	}
}

/** 更新 Skills（`skills update`，空名单更新全部）。 */
export async function updateSkills(
	skillNames: readonly string[] = [],
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	const {agentContext, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	const args = ['--yes', 'skills', 'update', ...skillNames, '-g', '-y', '--agent', skillsAgentOf(agentContext)];
	emit(onProgress, {level: 'info', message: '正在更新 Skills...'});

	try {
		const {code, stdout, stderr} = await exec('npx', args, {timeout: UPDATE_TIMEOUT_MS});
		const output = removeAnsiSequences(`${stdout}\n${stderr}`);

		if (code === 0) {
			const noChange = /no\s+updates|already\s+up\s+to\s+date|up\s+to\s+date|all\s+skills\s+.*latest|0\s+skills?\s+updated/i.test(output);
			if (noChange) {
				emit(onProgress, {level: 'info', message: 'Skills 已是最新'});
				return {success: true, noChange: true};
			}

			emit(onProgress, {level: 'success', message: 'Skills 更新完成'});
			return {success: true, noChange: false};
		}

		const error = getFriendlyError(code, stderr || stdout, '更新');
		emit(onProgress, {level: 'danger', message: `更新失败: ${error}`});
		return {success: false, error};
	} catch (error) {
		const friendly = getFriendlyError(-1, error instanceof Error ? error.message : String(error), '更新');
		emit(onProgress, {level: 'danger', message: `更新失败: ${friendly}`});
		return {success: false, error: friendly};
	}
}

/** 卸载 Skills（`skills remove`）。 */
export async function uninstallSkills(
	skillNames: readonly string[],
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	if (skillNames.length === 0) {
		return {success: false, error: '未选择要卸载的 Skill'};
	}

	const {agentContext, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	const args = ['--yes', 'skills', 'remove', ...skillNames, '-g', '--agent', skillsAgentOf(agentContext), '--yes'];
	emit(onProgress, {level: 'info', message: `正在卸载: ${skillNames.join(', ')}`});

	try {
		const {code, stdout, stderr} = await exec('npx', args, {timeout: UNINSTALL_TIMEOUT_MS});
		if (code === 0) {
			emit(onProgress, {level: 'success', message: '卸载完成'});
			return {success: true};
		}

		const error = getFriendlyError(code, stderr || stdout, '卸载');
		emit(onProgress, {level: 'danger', message: `卸载失败: ${error}`});
		return {success: false, error};
	} catch (error) {
		const friendly = getFriendlyError(-1, error instanceof Error ? error.message : String(error), '卸载');
		emit(onProgress, {level: 'danger', message: `卸载失败: ${friendly}`});
		return {success: false, error: friendly};
	}
}

/**
 * 批量安装某 repo 下多个 skill（需求③多选）。
 * 单次调用 `skills add <source> --skill a --skill b ...`（已验证 CLI 支持单次多 --skill，一次 fetch 装 N 个，远快于循环）。
 */
export async function installMultipleSkills(
	input: {readonly source: string; readonly skillNames: readonly string[]; readonly displayName?: string},
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	if (input.skillNames.length === 0) {
		return {success: false, error: '未选择要安装的 Skill'};
	}

	const {agentContext, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	const args = ['--yes', 'skills', 'add', input.source, '--yes', '--agent', skillsAgentOf(agentContext), '-g'];
	for (const name of input.skillNames) {
		args.push('--skill', name);
	}

	const label = input.displayName || `${input.source}（${input.skillNames.join(', ')}）`;
	emit(onProgress, {level: 'info', message: `正在安装 ${label}`, componentId: label});

	try {
		const {code, stdout, stderr} = await exec('npx', args, {timeout: INSTALL_TIMEOUT_MS});
		if (code === 0) {
			emit(onProgress, {level: 'success', message: `${label} 安装成功`, componentId: label});
			return {success: true};
		}

		const error = getFriendlyError(code, stderr || stdout || '未知错误', '安装');
		emit(onProgress, {level: 'warning', message: `${label} 安装失败: ${error}`, componentId: label});
		return {success: false, error};
	} catch (error) {
		const friendly = getFriendlyError(-1, error instanceof Error ? error.message : String(error), '安装');
		emit(onProgress, {level: 'warning', message: `${label} 安装失败: ${friendly}`, componentId: label});
		return {success: false, error: friendly};
	}
}
