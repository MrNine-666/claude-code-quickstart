import type {AgentContext} from '../state/manage-state.js';
import {join} from 'node:path';
import {skillsAgentOf, type SkillsCliAgent} from './skills.js';
import {execCommand, removeAnsiSequences, type ExecOptions, type ProgressCallback, type ExecResult} from './exec.js';
import {resolveHome} from './paths.js';

// Skills 操作服务：install / update / uninstall，进度通过 onProgress(event) 上报，
// 不直接 console.log（design D11/D13；spec skills-tui "actions SHALL not print directly"）。
// exec 缝允许测试注入桩，避免真实 spawn；默认走 execCommand（向后兼容）。
export type SkillsExecFn = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

const INSTALL_TIMEOUT_MS = 600000;
const UPDATE_TIMEOUT_MS = 600000;
const UNINSTALL_TIMEOUT_MS = 300000;
export const SKILLS_CLI_PACKAGE = 'skills@1.5.19';

export type SkillsActionResult = {
	readonly success: boolean;
	readonly error?: string;
	readonly noChange?: boolean;
};

export type SkillsCommandDiagnostic = SkillsActionResult & ExecResult & {
	readonly spawned: boolean;
};

export type SkillsAddCommandInput = {
	readonly source: string;
	readonly skillNames: readonly string[];
	readonly agents: readonly AgentContext[];
	readonly copy?: boolean;
	readonly env?: NodeJS.ProcessEnv;
	readonly displayName?: string;
};

export type SkillsRemoveCommandInput = {
	readonly skillNames: readonly string[];
	readonly agents: readonly AgentContext[];
	readonly env?: NodeJS.ProcessEnv;
};

export type InstallSkillInput = {
	readonly source: string;
	readonly displayName?: string;
	readonly skillName?: string;
	readonly copy?: boolean;
	readonly env?: NodeJS.ProcessEnv;
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
		return '文件权限或 symlink/copy 安装失败，请检查目标目录权限或启用 Windows 开发者模式';
	}

	if (/not found|No matching|404/i.test(errorText)) {
		return 'Skills source 或指定 skill 可能已变更，请检查来源';
	}

	return `Skills ${actionName}失败 (ExitCode: ${exitCode})`;
}

/**
 * 归一 agent 目标（单值或数组）+ exec 缝。
 *
 * install 路径按「谁用归谁」传 `[cc, cx]` 双 agent 触发 symlink（skills CLI 单一 skillsDir 会强制 copy，
 * 双 agent 令 uniqueDirs.size==2 且不传 --copy → installMode 保持默认 symlink：本体落 `~/.agents/skills`，
 * `~/.claude/skills` 建软链指向本体）。单值向后兼容。
 */
function normalizeAgentAndExec(
	agentOrExec: AgentContext | readonly AgentContext[] | SkillsExecFn | undefined,
	exec: SkillsExecFn | undefined
): {agents: readonly AgentContext[]; exec: SkillsExecFn} {
	if (typeof agentOrExec === 'function') {
		return {agents: ['cc'], exec: agentOrExec};
	}

	const value = agentOrExec ?? 'cc';
	const agents: readonly AgentContext[] = Array.isArray(value) ? value : [value as AgentContext];
	return {agents, exec: exec ?? execCommand};
}

/** 把 agent 列表展开为 `--agent <cli-name>` 参数序列（每个 agent 一个 `--agent`）。 */
function agentArgs(agents: readonly AgentContext[]): string[] {
	return agents.flatMap(agent => ['--agent', skillsAgentOf(agent)]);
}

function execOptions(timeout: number, env?: NodeJS.ProcessEnv): ExecOptions {
	return {timeout, ...(env ? {env} : {})};
}

export function createSkillsChildEnv(homeDir = resolveHome(), includeCodex = false): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: homeDir,
		USERPROFILE: homeDir,
		CLAUDE_CONFIG_DIR: join(homeDir, '.claude'),
		...(includeCodex ? {CODEX_HOME: join(homeDir, '.agents')} : {})
	};
}

/** 低层官方 add 原语：保留完整命令诊断，文件事实由调用方另行对账。 */
export async function runSkillsAdd(
	input: SkillsAddCommandInput,
	onProgress?: ProgressCallback,
	exec: SkillsExecFn = execCommand
): Promise<SkillsCommandDiagnostic> {
	if (input.agents.length === 0) {
		return {success: false, spawned: false, code: -1, stdout: '', stderr: '', error: 'Skills add 缺少 Agent 目标'};
	}

	const args = ['--yes', SKILLS_CLI_PACKAGE, 'add', input.source, '--yes', ...agentArgs(input.agents), '-g'];
	if (input.copy) {
		args.push('--copy');
	}
	for (const name of input.skillNames) {
		args.push('--skill', name);
	}

	const label = input.displayName ?? (input.skillNames.join(', ') || input.source);
	emit(onProgress, {level: 'info', message: `正在安装 ${label}`, componentId: label});
	try {
		const result = await exec('npx', args, execOptions(INSTALL_TIMEOUT_MS, input.env));
		if (result.code === 0) {
			emit(onProgress, {level: 'success', message: `${label} 安装命令完成`, componentId: label});
			return {...result, success: true, spawned: true};
		}

		const error = getFriendlyError(result.code, result.stderr || result.stdout || '未知错误', '安装');
		emit(onProgress, {level: 'warning', message: `${label} 安装命令失败: ${error}`, componentId: label});
		return {...result, success: false, spawned: true, error};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const friendly = getFriendlyError(-1, detail, '安装');
		emit(onProgress, {level: 'warning', message: `${label} 安装命令失败: ${friendly}`, componentId: label});
		return {success: false, spawned: true, code: -1, stdout: '', stderr: detail, error: friendly};
	}
}

/** 低层 targeted remove 原语；agents 必须显式，避免拓扑迁移误用全量删除。 */
export async function runSkillsRemove(
	input: SkillsRemoveCommandInput,
	onProgress?: ProgressCallback,
	exec: SkillsExecFn = execCommand
): Promise<SkillsCommandDiagnostic> {
	if (input.skillNames.length === 0 || input.agents.length === 0) {
		return {success: false, spawned: false, code: -1, stdout: '', stderr: '', error: 'Skills remove 缺少 Skill 或 Agent 目标'};
	}

	const args = ['--yes', SKILLS_CLI_PACKAGE, 'remove', ...input.skillNames, '-g', ...agentArgs(input.agents), '--yes'];
	emit(onProgress, {level: 'info', message: `正在卸载: ${input.skillNames.join(', ')}`});
	try {
		const result = await exec('npx', args, execOptions(UNINSTALL_TIMEOUT_MS, input.env));
		if (result.code === 0) {
			emit(onProgress, {level: 'success', message: '卸载命令完成'});
			return {...result, success: true, spawned: true};
		}

		const error = getFriendlyError(result.code, result.stderr || result.stdout, '卸载');
		emit(onProgress, {level: 'danger', message: `卸载命令失败: ${error}`});
		return {...result, success: false, spawned: true, error};
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		const friendly = getFriendlyError(-1, detail, '卸载');
		emit(onProgress, {level: 'danger', message: `卸载命令失败: ${friendly}`});
		return {success: false, spawned: true, code: -1, stdout: '', stderr: detail, error: friendly};
	}
}

/**
 * 解析卸载目标：AgentContext → `claude-code`/`codex` 单侧；`'*'` → 全 Agent 全量删。
 *
 * 注意：skills CLI 1.5.16 的 `remove` **不接受 `--agent '*'`**（会报 `Invalid agents: *` 并 exit 1，
 * 通配展开只在 `install` 路径实现）。全量删的正解是**完全不传 `--agent`**——CLI 此时默认
 * `targetAgents = 所有 agent`，删完各侧投影后无人再用即清 canonical 本体。故 `'*'` → agentTarget=undefined。
 */
function normalizeRemoveTarget(
	agentOrExec: AgentContext | readonly AgentContext[] | '*' | SkillsExecFn | undefined,
	exec: SkillsExecFn | undefined
): {agentTargets: readonly SkillsCliAgent[] | undefined; exec: SkillsExecFn} {
	if (typeof agentOrExec === 'function') {
		return {agentTargets: [skillsAgentOf('cc')], exec: agentOrExec};
	}

	const target = agentOrExec ?? 'cc';
	if (target === '*') {
		return {agentTargets: undefined, exec: exec ?? execCommand};
	}
	const targets = Array.isArray(target) ? target : [target as AgentContext];
	return {agentTargets: targets.map(skillsAgentOf), exec: exec ?? execCommand};
}

export async function installSkill(
	input: InstallSkillInput,
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | readonly AgentContext[] | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	const {agents, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	const label = input.displayName || input.source;
	const result = await runSkillsAdd({
		source: input.source,
		skillNames: input.skillName ? [input.skillName] : [],
		agents,
		copy: input.copy,
		env: input.env,
		displayName: label
	}, onProgress, exec);
	return {success: result.success, ...(result.error ? {error: result.error} : {})};
}

/** 更新 Skills（`skills update`，空名单更新全部）。 */
export async function updateSkills(
	skillNames: readonly string[] = [],
	onProgress?: ProgressCallback,
	exec: SkillsExecFn = execCommand
): Promise<SkillsActionResult> {
	// 上游 update 只接受 scope/yes/skill names；它会按 lock 重装全部注入侧，不支持 --agent。
	const args = ['--yes', SKILLS_CLI_PACKAGE, 'update', ...skillNames, '-g', '-y'];
	emit(onProgress, {level: 'info', message: '正在更新 Skills（最长等待 10 分钟）...'});

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

/**
 * 卸载 Skills（`skills remove`）。
 *
 * agent 目标（shared-resource-injection-ui Section 17.4）：
 * - AgentContext（'cc'/'cx'）：`--agent claude-code`/`--agent codex`，单侧撤销（Claude Code 删 symlink，本体若他方仍用由 CLI 保留）。
 * - `'*'`：**不带 `--agent`**（CLI 默认全 agent + 无人再用则清 canonical 本体），供 d 键全量删除复用。
 *   注：CLI 1.5.16 的 `remove` 不接受 `--agent '*'`（报 `Invalid agents: *` 并 exit 1），故全量删靠省略 `--agent` 实现。
 *
 * 物理删除全部由官方 CLI 负责，ccq 绝不自删文件（skills-multitool 硬约束）。
 */
export async function uninstallSkills(
	skillNames: readonly string[],
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | '*' | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	if (skillNames.length === 0) {
		return {success: false, error: '未选择要卸载的 Skill'};
	}

	const {agentTargets, exec} = normalizeRemoveTarget(agentOrExec, execArg);
	// agentTarget 为 undefined（全量删）时省略 --agent，CLI 默认覆盖全部 agent 并在无人再用时清 canonical 本体。
	const args = ['--yes', SKILLS_CLI_PACKAGE, 'remove', ...skillNames, '-g'];
	if (agentTargets) {
		for (const agentTarget of agentTargets) {
			args.push('--agent', agentTarget);
		}
	}

	args.push('--yes');
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
	input: {
		readonly source: string;
		readonly skillNames: readonly string[];
		readonly displayName?: string;
		readonly copy?: boolean;
		readonly env?: NodeJS.ProcessEnv;
	},
	onProgress?: ProgressCallback,
	agentOrExec?: AgentContext | readonly AgentContext[] | SkillsExecFn,
	execArg?: SkillsExecFn
): Promise<SkillsActionResult> {
	if (input.skillNames.length === 0) {
		return {success: false, error: '未选择要安装的 Skill'};
	}

	const {agents, exec} = normalizeAgentAndExec(agentOrExec, execArg);
	const label = input.displayName || `${input.source}（${input.skillNames.join(', ')}）`;
	const result = await runSkillsAdd({
		source: input.source,
		skillNames: input.skillNames,
		agents,
		copy: input.copy,
		env: input.env,
		displayName: label
	}, onProgress, exec);
	return {success: result.success, ...(result.error ? {error: result.error} : {})};
}
