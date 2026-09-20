import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readMcpSnapshot, restoreMcpSnapshot} from '../src/core/tools-install.ts';

// Phase 6 工具安装菜单门禁：守住两条核心不变量——
//   P-6 批量安装失败隔离：第 N 个工具失败时，第 N+1 个仍执行；
//   P-8(实为 6.11) CcgWorkflow mcpServers 快照保护：init 覆盖 mcpServers 后，快照恢复使其不变。
// 6.12 指纹对齐（P-4）作废：TUI Update 已收缩检测范围（HC-FU-08 不再检测 CcgWorkflow 指纹），
//   安装不写指纹种子，无需对齐（对齐 Phase 4/5 范围调整）。
//
// [P4b 切分] 纯段（installMultipleTools 失败隔离、registry command/kind 完整性、
// Pi 上下文 Enter 透传、安装结果 version）已迁 tests/core/tools-view.test.ts。
// [P4c 去重] registry 12 项定义顺序也已迁 tests/core/tools-view.test.ts（同上文件）。
// 本脚本保留需要真实落盘字节的段：`.claude.json` mcpServers 快照与恢复。

// ── registry 完整性：ClaudeCode 收编后 12 项齐备，含 Pi CLI / Pi Web ─────────────
// [P4b 迁走] 每项 command/versionArgs/kind 完整性 → tests/core/tools-view.test.ts「registry 完整性」
// [P4c 去重] 12 项 registry 定义顺序已迁 tests/core/tools-view.test.ts「12 项 registry 顺序固定」，
// 本段无独立断言，不再保留 [PASS] 行。

// ── CodeGraph 安装后按 agentContext 接入当前 Agent（非交互，命令来自 lifecycle resolver）────
// 注：本段两条已由 P1 tests/core/tools-lifecycle.test.ts 覆盖，保留不重复迁移。
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
