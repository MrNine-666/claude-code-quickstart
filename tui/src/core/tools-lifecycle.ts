import {join} from 'node:path';
import type {AgentContext} from '../state/manage-state.js';
import {codexDir} from './paths.js';

// 工具生命周期命令解析层（design D3/D4/D5）：把「组件 + agentContext」解析为具体命令/文件边界。
// 纯函数、无副作用、无 IO —— 便于 verify 脚本对不变量做断言（PBT-4/PBT-5），执行由 tools-manage 负责。
//
// 覆盖范围：
//   - CodeGraph：CLI 安装与 per-Agent 集成分离（install 接入当前 Agent；默认 uninstall 只解除集成，
//     不 npm uninstall、不删 .codegraph/ 项目索引；移除 CLI 为独立高级动作）。
//   - CcgWorkflow：Codex Mode 无官方非交互入口，install 只给引导；Codex uninstall 只删 CCG-managed
//     文件/marker，绝不删 CODEX_HOME/config.toml。

/** 单条待执行命令（cmd + args），供 tools-manage 交给 execCommand 执行。 */
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

// ── CcgWorkflow Codex Mode 文件边界（design D5，PBT-5）─────────────────────────

/**
 * CcgWorkflow Codex Mode 受管文件清单（相对 CODEX_HOME）。
 * 对齐 DeepWiki Codex Mode 事实：agents/ccg-*.toml + hooks/ccg-workflow.py。
 * config.toml 绝不在内（受保护）；AGENTS.md 只处理 CCG marker 内容，不整文件删除。
 */
export const CODEX_CCG_MANAGED_FILES: readonly string[] = [
	'agents/ccg-implement.toml',
	'agents/ccg-review.toml',
	'agents/ccg-research.toml',
	'hooks/ccg-workflow.py'
];

/** Codex 用户配置：绝不由 CcgWorkflow 卸载删除。 */
export const CODEX_PROTECTED_FILES: readonly string[] = ['config.toml'];

/** CcgWorkflow Codex 受管文件绝对路径（CODEX_HOME 优先，默认 ~/.codex）。 */
export function codexCcgManagedPaths(): readonly string[] {
	const home = codexDir();
	return CODEX_CCG_MANAGED_FILES.map(rel => join(home, rel));
}

/** CcgWorkflow Codex install 引导文案（无官方非交互入口，只提示手动菜单）。 */
export function codexCcgInstallGuidance(): string {
	return 'Codex Mode 暂无官方非交互安装入口，请手动运行 `npx ccg-workflow` 并选择菜单 `X. Codex Mode` 完成安装。';
}
