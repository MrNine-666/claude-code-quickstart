import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	installMultipleTools,
	readMcpSnapshot,
	restoreMcpSnapshot,
	TOOL_DEFINITIONS
} from '../src/core/tools-install.ts';

// Phase 6 工具安装菜单门禁：守住两条核心不变量——
//   P-6 批量安装失败隔离：第 N 个工具失败时，第 N+1 个仍执行；
//   P-8(实为 6.11) CcgWorkflow mcpServers 快照保护：init 覆盖 mcpServers 后，快照恢复使其不变。
// 6.12 指纹对齐（P-4）作废：TUI Update 已收缩检测范围（HC-FU-08 不再检测 CcgWorkflow 指纹），
//   安装不写指纹种子，无需对齐（对齐 Phase 4/5 范围调整）。

// ── P-6 批量安装失败隔离 ─────────────────────────────────────────────────────
// 注入 mock installOne：第 2 个工具失败，其余成功。断言后续工具仍被执行。
const order = ['OpenSpec', 'CodexCli', 'Ccline'];
const calls = [];
const mockInstallOne = async (id, _onProgress) => {
	calls.push(id);
	if (id === 'CodexCli') {
		return {id, success: false, error: 'mock 失败'};
	}

	return {id, success: true};
};

const outcomes = await installMultipleTools(order, undefined, mockInstallOne);
assert.equal(calls.length, order.length, '失败隔离：全部工具均被调用（含失败项之后的）');
assert.deepEqual(calls, order, '失败隔离：按顺序执行，失败项不中断后续');
const failed = outcomes.filter(item => !item.success);
assert.equal(failed.length, 1, '仅 CodexCli 失败');
assert.equal(failed[0].id, 'CodexCli', '失败项为 CodexCli');
const succeeded = outcomes.filter(item => item.success);
assert.equal(succeeded.length, 2, '其余 2 项成功');
console.log('[PASS] 批量安装失败隔离 (P-6)');

// 安装结果允许携带版本号，ToolsView 局部 patch 依赖该字段避免安装后卡片版本为空。
const versionedOutcomes = await installMultipleTools(['CodexCli'], undefined, async id => ({id, success: true, version: '0.142.5'}));
assert.equal(versionedOutcomes[0].version, '0.142.5', '安装成功结果应保留 version 字段，供 UI patch 使用');
console.log('[PASS] 安装结果保留版本号用于卡片局部更新');

// ── 工具定义完整性：6 个工具齐备 ─────────────────────────────────────────────
const ids = TOOL_DEFINITIONS.map(item => item.id);
assert.deepEqual(ids, ['Ccline', 'CcgWorkflow', 'OpenSpec', 'CodeGraph', 'CodexCli', 'AntigravityCli'], '6 工具定义齐备且顺序固定');
for (const tool of TOOL_DEFINITIONS) {
	assert.ok(tool.command && tool.versionArgs.length > 0, `${tool.id} 有检测命令`);
	assert.ok(tool.kind, `${tool.id} 有安装 kind`);
}
console.log('[PASS] 工具定义完整性（6 工具齐备）');

// ── CodeGraph 安装后按 agentContext 接入当前 Agent（非交互，命令来自 lifecycle resolver）────
const {codeGraphInstallCommands} = await import('../src/core/tools-lifecycle.ts');
assert.deepEqual(
	codeGraphInstallCommands('cc'),
	[{cmd: 'codegraph', args: ['install', '--target=claude', '--location=global', '--yes']}],
	'Claude Code 上下文安装后接入 --target=claude'
);
assert.deepEqual(
	codeGraphInstallCommands('cx'),
	[{cmd: 'codegraph', args: ['install', '--target=codex', '--location=global', '--yes']}],
	'Codex 上下文安装后接入 --target=codex'
);
console.log('[PASS] CodeGraph 安装后按 agentContext 接入当前 Agent（非交互）');

// ── 6.11 CcgWorkflow mcpServers 快照保护（CCQ_HOME 隔离）──────────────────────
const home = mkdtempSync(join(tmpdir(), 'ccq-tools-test-'));
process.env.CCQ_HOME = home;
try {
	// 模拟安装前的 .claude.json：用户已有 2 个 MCP
	mkdirSync(join(home, '.claude'), {recursive: true});
	const claudeJsonPath = join(home, '.claude.json');
	const userMcp = {context7: {command: 'npx', args: ['context7']}, deepwiki: {command: 'npx', args: ['deepwiki']}};
	writeFileSync(claudeJsonPath, JSON.stringify({mcpServers: userMcp, projects: {}}, null, 2), 'utf8');

	// 安装前快照
	const before = readMcpSnapshot();
	assert.ok(before, '安装前能读到 mcpServers 快照');
	assert.equal(JSON.parse(before).context7.command, 'npx', '快照含 context7');

	// 模拟 CcgWorkflow init 覆盖了 mcpServers（清空或篡改）
	writeFileSync(claudeJsonPath, JSON.stringify({mcpServers: {}, projects: {}}, null, 2), 'utf8');
	const afterOverwrite = readMcpSnapshot();
	assert.equal(afterOverwrite, '{}', 'init 覆盖后 mcpServers 为空');

	// 恢复快照
	restoreMcpSnapshot(before);
	const restored = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
	assert.deepEqual(restored.mcpServers, userMcp, '快照恢复后 mcpServers 等于安装前（用户 MCP 不丢失）');
	console.log('[PASS] CcgWorkflow mcpServers 快照保护 (6.11)');

	// ── 6.11 边界：无 mcpServers 时快照为 null（不误恢复）──────────────────────
	writeFileSync(claudeJsonPath, JSON.stringify({projects: {}}, null, 2), 'utf8');
	assert.equal(readMcpSnapshot(), null, '无 mcpServers 字段时快照为 null');
	console.log('[PASS] 无 mcpServers 时快照为 null（不误恢复）');
} finally {
	delete process.env.CCQ_HOME;
	rmSync(home, {recursive: true, force: true});
}

console.log('[PASS] Phase 6 工具安装菜单门禁通过');
