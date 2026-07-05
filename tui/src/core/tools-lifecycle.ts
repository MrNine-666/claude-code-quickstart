import type {AgentContext} from '../state/manage-state.js';

// 工具生命周期命令解析层（design D3/D4/D5）：把「组件 + agentContext」解析为具体命令。
// 纯函数、无副作用、无 IO —— 便于 verify 脚本对不变量做断言（PBT-4/PBT-5），执行由 tools-manage/tools-install 负责。
//
// 覆盖范围：
//   - CodeGraph：CLI 安装与 per-Agent 集成分离（install 接入当前 Agent；默认 uninstall 只解除集成，
//     不 npm uninstall、不删 .codegraph/ 项目索引；移除 CLI 为独立高级动作）。
//   - CcgWorkflow：Claude Code 与 Codex Mode 均走官方非交互命令；ccq 不自行猜测删除 config.toml。

/** 单条待执行命令（cmd + args），供 tools-manage/tools-install 交给 execCommand 执行。 */
export type LifecycleCommand = {
	readonly cmd: string;
	readonly args: readonly string[];
};

/** agentContext 内部短名 → CodeGraph/官方 `--target` 全称。 */
export function agentTarget(context: AgentContext): 'claude' | 'codex' {
	return context === 'cx' ? 'codex' : 'claude';
}

// ── CodeGraph 生命周期（design D4，PBT-4）──────────────────────────────────────

/** CodeGraph 接入当前 Agent（CLI 就绪后执行；npm 安装单独在 tools-manage 完成）。 */
export function codeGraphInstallCommands(context: AgentContext): readonly LifecycleCommand[] {
	return [{cmd: 'codegraph', args: ['install', `--target=${agentTarget(context)}`, '--location=global', '--yes']}];
}

/**
 * CodeGraph 默认卸载：只解除当前 Agent 集成。
 * 不 npm uninstall、不删 .codegraph/ 项目索引（那些是独立的高级动作）。
 */
export function codeGraphUninstallCommands(context: AgentContext): readonly LifecycleCommand[] {
	return [{cmd: 'codegraph', args: ['uninstall', `--target=${agentTarget(context)}`, '--yes']}];
}

/** CodeGraph 高级动作：移除共享 CLI（影响所有 Agent 集成，需强确认后调用）。 */
export function codeGraphRemoveCliCommands(): readonly LifecycleCommand[] {
	return [{cmd: 'npm', args: ['uninstall', '-g', '@colbymchenry/codegraph']}];
}

// ── CcgWorkflow 生命周期（design D5，PBT-5）────────────────────────────────────

/** CcgWorkflow 官方非交互安装/接入命令。 */
export function ccgWorkflowInstallCommands(context: AgentContext, claudeInstallDir: string): readonly LifecycleCommand[] {
	if (context === 'cx') {
		return [{cmd: 'npx', args: ['--yes', 'ccg-workflow', 'codex-mode', 'install']}];
	}

	return [
		{
			cmd: 'npx',
			args: ['--yes', 'ccg-workflow@latest', 'init', '--skip-prompt', '--skip-mcp', '--lang', 'zh-CN', '--install-dir', claudeInstallDir]
		}
	];
}

/** CcgWorkflow 官方非交互卸载命令。 */
export function ccgWorkflowUninstallCommands(context: AgentContext): readonly LifecycleCommand[] {
	if (context === 'cx') {
		return [{cmd: 'npx', args: ['--yes', 'ccg-workflow', 'codex-mode', 'uninstall']}];
	}

	return [{cmd: 'npx', args: ['--yes', 'ccg-workflow', 'uninstall']}];
}
