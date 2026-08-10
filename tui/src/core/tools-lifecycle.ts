import type {AgentContext} from '../state/manage-state.js';

// 工具生命周期命令解析层（design D3/D4/D5）：把「组件 + agentContext」解析为具体命令。
// 纯函数、无副作用、无 IO —— 便于 verify 脚本对不变量做断言（PBT-4/PBT-5），执行由 tools-manage/tools-install 负责。
//
// 覆盖范围：
//   - CodeGraph：CLI 安装与 per-Agent 集成分离（install 接入当前 Agent；默认 uninstall 只解除集成，
//     不 npm uninstall、不删 .codegraph/ 项目索引；移除 CLI 为独立高级动作）。
//   - CcgWorkflow：Claude Code 与 Codex Mode 均走官方非交互命令；ccq 不自行猜测删除 config.toml。
//   - GitNexus：整体接入/整体卸载（上游无 per-Agent uninstall），setup 一次配置 claude+codex，
//     卸载先清理全部编辑器接入再交由通用 npm 生命周期移除 CLI；绝不 analyze/clean/serve/wiki。

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

// ── GitNexus 生命周期 ─────────────────────────────────────────────────────────
// 上游只支持 `setup --coding-agent <ids>` 选择性接入，不支持按 Agent 卸载：
// `gitnexus uninstall --force` 会清理所有检测到的编辑器接入。因此 GitNexus 采用
// 整体接入 / 整体卸载模型（COMPONENT_META 为 fully-shared-no-inject），不提供单侧开关。

/** GitNexus 首次安装使用的 npm 包 spec（registry 的 npmPackage 保持无 dist-tag，供 outdated/view 复用）。 */
export const GITNEXUS_INSTALL_PACKAGE_SPEC = 'gitnexus@latest';

/** GitNexus 非交互接入 Claude Code + Codex（npm 安装/更新后执行）。 */
export function gitNexusSetupCommands(): readonly LifecycleCommand[] {
	return [{cmd: 'gitnexus', args: ['setup', '--coding-agent', 'claude,codex']}];
}

/** 失败诊断上限：保留可操作尾部，避免超长 stack 淹没进度日志。 */
const GITNEXUS_DIAGNOSTIC_MAX = 400;

/**
 * GitNexus 生命周期失败信息：阶段 + exit code + 上游诊断尾部。
 * GitNexus 有 Node.js engine（`^22.18.0 || >=24.11.0`）与原生依赖约束（glibc / MSVC / OpenSSL 3），
 * 这些事实只出现在上游 stderr/stdout 里，通用 fallback 只识别网络/权限模式会吞掉它们，故此处显式保留。
 */
export function gitNexusFailureDiagnostic(stage: string, code: number, stderr: string, stdout = ''): string {
	const base = `${stage} (exit ${code})`;
	const raw = (stderr || stdout).replace(/\s+/g, ' ').trim();
	if (!raw) {
		return base;
	}

	const tail = raw.length > GITNEXUS_DIAGNOSTIC_MAX ? `...${raw.slice(-GITNEXUS_DIAGNOSTIC_MAX)}` : raw;
	return `${base}: ${tail}`;
}

/**
 * GitNexus 编辑器接入清理（整体卸载第一步）。
 * 上游无 target 筛选：会清理所有检测到的编辑器接入。绝不 `clean`，绝不触碰仓库 `.gitnexus/` 索引。
 */
export function gitNexusIntegrationCleanupCommands(): readonly LifecycleCommand[] {
	return [{cmd: 'gitnexus', args: ['uninstall', '--force']}];
}
