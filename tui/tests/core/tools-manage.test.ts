import {describe, expect, test} from 'bun:test';
import {
	COMPONENT_DEFINITIONS,
	installComponent,
	TOOL_GROUP_META,
	uninstallComponent,
	updateComponents,
	type ManagedComponent
} from '../../src/core/tools-manage.js';

// P4b 迁移自 scripts/verify-tools-manage.mjs（34 条静态断言，纯进程内）。
// 判据（R1）：去掉真实文件系统 / 真实子进程后仍成立的断言才迁入本文件。
// 保留在 verify 的 77 条为 fs 语义（真实 CCQ_HOME 落盘字节、`~/.codex`/`.claude.json`
// 集成信号、CcgWorkflow/Ccline/CodeGraph/Antigravity 真实文件事实与真实 npm 子进程）。
//
// R9 去重（本批前置）：COMPONENT_DEFINITIONS 顺序、TOOL_GROUP_ORDER、COMPONENT_META.group 归属
// 已由 P4a `tests/core/tools-context.test.ts` 覆盖；GitNexus/CodeGraph `sharingKind`、
// `uninstallImpactNotice` 已由 P1 `tests/core/tools-shared-projection.test.ts` 覆盖。
// 上述主题**不重复迁移**，对账清单标注「已由 P0/P1/P4a 覆盖」。

function withSavedPath<T>(run: () => T): T {
	const originalPath = process.env.PATH;
	const originalPathCase = process.env.Path;
	try {
		return run();
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalPathCase === undefined) delete process.env.Path;
		else process.env.Path = originalPathCase;
	}
}

describe('COMPONENT_DEFINITIONS registry 完整性', () => {
	test('12 组件均含 name + description / 检测命令 / kind，ClaudeCode 包名固定', () => {
		for (const definition of COMPONENT_DEFINITIONS) {
			expect(Boolean(definition.name && definition.description), `${definition.id} 有 name + description`).toBe(true);
			expect(Boolean(definition.command && definition.versionArgs.length > 0), `${definition.id} 有检测命令`).toBe(true);
			expect(Boolean(definition.kind), `${definition.id} 有 kind`).toBe(true);
		}

		const claude = COMPONENT_DEFINITIONS.find(definition => definition.id === 'ClaudeCode');
		expect(claude?.npmPackage, 'ClaudeCode npm 包名').toBe('@anthropic-ai/claude-code');
	});
});

describe('GitNexus registry 事实', () => {
	test('registry 定义固定：npm kind / gitnexus 命令 / -V / 无 dist-tag / 官方文档 / CLI 别名', () => {
		const gitnexus = COMPONENT_DEFINITIONS.find(definition => definition.id === 'GitNexus');
		expect(gitnexus, 'GitNexus 在 COMPONENT_DEFINITIONS 中').toBeDefined();
		if (!gitnexus) throw new Error('GitNexus 定义缺失');
		expect(gitnexus.kind, 'GitNexus 安装 kind 为 npm').toBe('npm');
		expect(gitnexus.command, 'GitNexus 检测命令为 gitnexus').toBe('gitnexus');
		expect(gitnexus.versionArgs, 'GitNexus 版本检测参数为 -V').toEqual(['-V']);
		expect(gitnexus.npmPackage, 'GitNexus registry 包名不得带 dist-tag（供 npm outdated/view 复用）').toBe('gitnexus');
		expect(gitnexus.docsUrl, 'GitNexus 文档指向官方仓库').toBe('https://github.com/abhigyanpatwari/GitNexus');
		expect(gitnexus.cliAliases, 'GitNexus CLI 别名固定').toEqual(['gitnexus', 'git-nexus']);
	});
});

describe('工具管理分组元数据', () => {
	test('TOOL_GROUP_META 四组 label 与 companion 描述固定', () => {
		expect(TOOL_GROUP_META.agent.label, 'agent 分组 label = Agent').toBe('Agent');
		expect(TOOL_GROUP_META.companion.label, 'companion 分组 label = 全局伴随工具').toBe('全局伴随工具');
		expect(TOOL_GROUP_META.companion.description, 'companion 分组描述使用全局伴随工具契约').toBe('通过 npm 全局安装的 Agent 伴随工具');
		expect(TOOL_GROUP_META.workflow.label, 'workflow 分组 label = 工作流').toBe('工作流');
		expect(TOOL_GROUP_META['knowledge-graph'].label, 'knowledge-graph 分组 label = 代码知识图谱').toBe('代码知识图谱');
	});
});

describe('CodexCli registry 事实', () => {
	test('CodexCli 使用 @openai/codex 与 codex --version', () => {
		const codex = COMPONENT_DEFINITIONS.find(definition => definition.id === 'CodexCli');
		expect(codex, 'CodexCli 在 COMPONENT_DEFINITIONS 中').toBeDefined();
		if (!codex) throw new Error('CodexCli 定义缺失');
		expect(codex.npmPackage, 'CodexCli npm 包名为 @openai/codex').toBe('@openai/codex');
		expect(codex.command, 'CodexCli 检测命令为 codex').toBe('codex');
		expect(codex.versionArgs, 'CodexCli 版本检测参数为 --version').toEqual(['--version']);
		expect(codex.kind, 'CodexCli 安装 kind 为 npm').toBe('npm');
	});
});

describe('installComponent ClaudeCode 安装路径', () => {
	test('npm install → 刷新 npm global bin PATH → claude --version 检测确认', async () => {
		const execCalls: {cmd: string; args: readonly string[]}[] = [];
		const exec = async (cmd: string, args: readonly string[]) => {
			execCalls.push({cmd, args});
			if (cmd === 'npm' && args.includes('install')) return {code: 0, stdout: '', stderr: ''};
			if (cmd === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-tools-manage-prefix\n', stderr: ''};
			if (cmd === 'claude' && args.includes('--version')) return {code: 0, stdout: '1.2.3\n', stderr: ''};
			return {code: 1, stdout: '', stderr: 'mock unknown'};
		};

		const outcome = await withSavedPath(() => installComponent('ClaudeCode', undefined, {exec}));
		expect(outcome.success, 'ClaudeCode 安装成功').toBe(true);
		expect(outcome.id, '返回 id 为 ClaudeCode').toBe('ClaudeCode');
		expect(
			execCalls.some(call => call.cmd === 'npm' && call.args.includes('@anthropic-ai/claude-code')),
			'调起 npm install -g @anthropic-ai/claude-code'
		).toBe(true);

		const npmInstallIndex = execCalls.findIndex(call => call.cmd === 'npm' && call.args.includes('@anthropic-ai/claude-code'));
		const npmPrefixIndex = execCalls.findIndex(call => call.cmd === 'npm' && call.args[0] === 'prefix');
		const claudeVersionIndex = execCalls.findIndex(call => call.cmd === 'claude' && call.args.includes('--version'));
		expect(npmInstallIndex >= 0, '调起 npm install -g @anthropic-ai/claude-code').toBe(true);
		expect(npmPrefixIndex > npmInstallIndex, 'ClaudeCode 安装后刷新 npm global bin PATH').toBe(true);
		expect(claudeVersionIndex > npmPrefixIndex, '刷新 PATH 后检测 claude --version').toBe(true);
	});
});

describe('installComponent 未知组件拒绝', () => {
	test('未知组件返回失败并带明确错误信息', async () => {
		const unknown = await installComponent('UnknownId' as never);
		expect(unknown.success, '未知组件返回失败').toBe(false);
		expect(unknown.error, '未知组件错误信息').toMatch(/未知组件/);
	});
});

describe('snapshot-before-write 门禁', () => {
	test('P-13 卸载路径快照失败 → exec 零调用', async () => {
		const execCalls: {cmd: string; args: readonly string[]}[] = [];
		const exec = async (cmd: string, args: readonly string[]) => {
			execCalls.push({cmd, args});
			return {code: 1, stdout: '', stderr: 'mock'};
		};
		const outcome = await uninstallComponent('OpenSpec', undefined, {
			exec,
			createSnapshotFn: () => {
				throw new Error('snapshot boom');
			}
		});
		expect(outcome.success, 'P-13 快照失败应中止卸载').toBe(false);
		expect(outcome.error, 'P-13 错误信息含快照失败').toMatch(/快照失败/);
		expect(execCalls.length, 'P-13 快照失败后 exec 零调用（snapshot-before-write）').toBe(0);
	});

	test('P-13 更新路径快照失败 → exec 零调用（applyUpdates snapshot-before-write）', async () => {
		const execCalls: {cmd: string; args: readonly string[]}[] = [];
		const exec = async (cmd: string, args: readonly string[]) => {
			execCalls.push({cmd, args});
			return {code: 0, stdout: '', stderr: ''};
		};
		const definition = COMPONENT_DEFINITIONS.find(entry => entry.id === 'OpenSpec');
		if (!definition) throw new Error('OpenSpec 定义缺失');
		const updatable: ManagedComponent = {
			...definition,
			installed: true,
			currentVersion: '1.0.0',
			latestVersion: '2.0.0',
			hasUpdate: true
		};

		const result = updateComponents([updatable], undefined, {
			exec,
			createSnapshotFn: () => {
				throw new Error('snapshot boom');
			}
		});
		await expect(result, 'P-13 更新快照失败应抛错').rejects.toThrow(/snapshot boom/);
		expect(execCalls.length, 'P-13 更新快照失败后 exec 零调用（snapshot-before-write）').toBe(0);
	});
});

// 保留在 verify-tools-manage.mjs 的 fs 语义段（不迁移）：
// - COMPONENT_DEFINITIONS 顺序 / TOOL_GROUP_ORDER / COMPONENT_META.group（已由 P4a 覆盖，未迁移）
// - uninstallImpactNotice / sharingKind（已由 P1 覆盖，未迁移）
// - detectComponents 12 项与 CcgWorkflow config.toml 版本（真实 CCQ_HOME 落盘）
// - Codex Header 集成态（真实 ~/.claude.json / ~/.codex/config.toml / .ccg-version）
// - CodeGraph 更新后重接入（真实集成信号）、CcgWorkflow/Ccline/CodeGraph/Antigravity 卸载文件事实
