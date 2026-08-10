import assert from 'node:assert/strict';
import {
	COMPONENT_META,
	COMPONENT_DEFINITIONS,
	isComponentVisible,
	visibleComponentDefinitions,
	filterVisibleComponents,
	projectSharedToolComponents,
	TOOL_GROUP_ORDER
} from '../src/core/tools-manage.ts';

// Task 1.5 → Phase 3：工具分组与可见性（design D3/PBT-3），断言真实 COMPONENT_META。
// 本文件覆盖两条并存的 API：
//   1) legacy filterVisibleComponents / visibleComponentDefinitions —— 按 agentContext 过滤（CLI/门禁兼容路径）；
//   2) shared list projectSharedToolComponents —— Tools UI 主路径，不按上下文过滤，Ccline 常显。
// 双态独立/显式 target 的更强不变量见 verify-tools-shared-projection.mjs。

// ── 分组归属（唯一真理源 = COMPONENT_META）──────────────────────────────────
assert.equal(COMPONENT_META.ClaudeCode.group, 'agent', 'ClaudeCode 属 agent 组');
assert.equal(COMPONENT_META.CodexCli.group, 'agent', 'CodexCli 属 agent 组');
assert.equal(COMPONENT_META.AntigravityCli.group, 'agent', 'AntigravityCli 属 agent 组');
assert.equal(COMPONENT_META.Ccline.group, 'companion', 'Ccline 属 companion 组');
assert.equal(COMPONENT_META.OpenSpec.group, 'workflow', 'OpenSpec 属 workflow 组');
assert.equal(COMPONENT_META.CcgWorkflow.group, 'workflow', 'CcgWorkflow 属 workflow 组');
assert.equal(COMPONENT_META.CodeGraph.group, 'knowledge-graph', 'CodeGraph 属 knowledge-graph 组');
assert.equal(COMPONENT_META.GitNexus.group, 'knowledge-graph', 'GitNexus 属 knowledge-graph 组');

// 分组展示顺序：agent → companion → workflow → knowledge-graph
assert.deepEqual(TOOL_GROUP_ORDER, ['agent', 'companion', 'workflow', 'knowledge-graph'], '分组展示顺序固定');

// ── isComponentVisible / visibleComponentDefinitions ────────────────────────
// ClaudeCode/CodexCli/AntigravityCli 两种上下文都常显
for (const id of ['ClaudeCode', 'CodexCli', 'AntigravityCli']) {
	assert.equal(isComponentVisible(id, 'cc'), true, `${id} 在 Claude Code 上下文常显`);
	assert.equal(isComponentVisible(id, 'cx'), true, `${id} 在 Codex 上下文常显`);
}

// Ccline 仅 Claude Code
assert.equal(isComponentVisible('Ccline', 'cc'), true, 'Ccline 在 Claude Code 上下文显示');
assert.equal(isComponentVisible('Ccline', 'cx'), false, 'Ccline 不在 Codex 上下文显示');

// CodeGraph/CcgWorkflow/OpenSpec/GitNexus 两上下文都显示（生命周期按上下文分支，可见性不受限）
for (const id of ['OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph', 'GitNexus']) {
	assert.equal(isComponentVisible(id, 'cc'), true, `${id} 在 Claude Code 上下文可见`);
	assert.equal(isComponentVisible(id, 'cx'), true, `${id} 在 Codex 上下文可见`);
}

// ── visibleComponentDefinitions 数量与顺序 ─────────────────────────────────
const ccVisible = visibleComponentDefinitions('cc').map(d => d.id);
const cxVisible = visibleComponentDefinitions('cx').map(d => d.id);

// Claude Code：9 项（含 Ccline）
assert.equal(ccVisible.length, 9, 'Claude Code 上下文可见 9 项');
assert.ok(ccVisible.includes('Ccline'), 'Claude Code 上下文含 Ccline');
// Codex：8 项（不含 Ccline）
assert.equal(cxVisible.length, 8, 'Codex 上下文可见 8 项');
assert.equal(cxVisible.includes('Ccline'), false, 'Codex 上下文不含 Ccline');
// 两种上下文都含 ClaudeCode/CodexCli/AntigravityCli/OpenSpec/Trellis/CcgWorkflow/CodeGraph/GitNexus
for (const id of ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph', 'GitNexus']) {
	assert.ok(ccVisible.includes(id), `Claude Code 含 ${id}`);
	assert.ok(cxVisible.includes(id), `Codex 含 ${id}`);
}
// 可见列表按工具管理分组展示顺序排序（Agent → statusLine → 工作流 → 代码知识图谱）
assert.deepEqual(ccVisible, ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'Ccline', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph', 'GitNexus'], 'Claude Code 可见列表按分组展示顺序排序');
assert.deepEqual(cxVisible, ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph', 'GitNexus'], 'Codex 可见列表隐藏 Ccline 并保持分组展示顺序');
assert.deepEqual(COMPONENT_DEFINITIONS.map(d => d.id), ['ClaudeCode', 'Ccline', 'CcgWorkflow', 'OpenSpec', 'Trellis', 'CodeGraph', 'GitNexus', 'CodexCli', 'AntigravityCli'], '静态定义仍保留安装定义原始顺序');

// ── filterVisibleComponents（运行时组件过滤，供 ToolsView 消费）──────────────
const stub = (id, installed) => ({id, installed, currentVersion: '', latestVersion: '', hasUpdate: null});
const runtime = [
	stub('ClaudeCode', true),
	stub('Ccline', false),
	stub('CcgWorkflow', true),
	stub('CodexCli', false)
];
const ccFiltered = filterVisibleComponents(runtime, 'cc').map(c => c.id);
const cxFilted = filterVisibleComponents(runtime, 'cx').map(c => c.id);
assert.deepEqual(ccFiltered, ['ClaudeCode', 'CodexCli', 'Ccline', 'CcgWorkflow'], 'Claude Code 过滤保留 Ccline，并按分组展示顺序排序');
assert.deepEqual(cxFilted, ['ClaudeCode', 'CodexCli', 'CcgWorkflow'], 'Codex 过滤掉 Ccline，并按分组展示顺序排序');

console.log('[PASS] 1.5/3.1/3.2/3.3 legacy filterVisibleComponents（仅兼容门禁）：ClaudeCode/CodexCli 常显 + Ccline 仅 Claude Code + 分组顺序展示');

// ── shared list（Tools UI 主路径）：不按 agentContext 过滤，Ccline 常显 ──────────
// 与 legacy filterVisibleComponents 区分：projectSharedToolComponents 是 Tools UI 主模型，
// 双 Header 下列表全集恒定；不变量细节见 verify-tools-shared-projection.mjs。
const sharedIds = projectSharedToolComponents([]).map(c => c.id);
assert.ok(sharedIds.includes('Ccline'), 'shared list 常显 Ccline（不随 agentContext 过滤）');
assert.equal(sharedIds.length, COMPONENT_DEFINITIONS.length, 'shared list 展示组件全集');
console.log('[PASS] 6.2 shared list 与 legacy filter API 拆分：共享列表含 Ccline 且不按上下文过滤');
