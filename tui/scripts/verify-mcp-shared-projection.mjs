import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

// shared-resource-injection-ui Section 13.1：MCP 双侧聚合投影门禁（core/mcp.ts computeSharedStatus）。
// 断言（对齐 specs/mcp-multitool/spec.md「MCP status SHALL be projected as an aggregated dual-Agent view」）：
//   1) 双侧聚合：一 Server ID 一行，injectByAgent.{cc,cx} 独立不塌缩；
//   2) 列表全集 = vault 定义 ∪ ~/.claude.json mcpServers ∪ ~/.codex config.toml [mcp_servers]，按 Id 去重；
//   3) vault 定义 ≠ 激活态（definition-only server 两侧均 not-active，但仍列出且 hasDefinition=true）；
//   4) 开关态实时从 runtime 文件派生：外部编辑 ~/.claude.json 后重投影立即反映；
//   5) Codex enabled=false 第三态在投影中归为 not-active，且投影不改写/删除该禁用块（纯读不物化）。

const home = mkdtempSync(join(tmpdir(), 'ccq-mcp-shared-proj-'));
const codexHome = join(home, '.codex');
process.env.CCQ_HOME = home;
process.env.HOME = home;

const {resetMcpContractCache} = await import('../src/core/mcp-contract.ts');
const {computeSharedStatus} = await import('../src/core/mcp.ts');
resetMcpContractCache();

const claudeJsonPath = join(home, '.claude.json');
const codexConfigPath = join(codexHome, 'config.toml');
const vaultPath = join(home, '.ccq', 'mcp-meta.json');

function writeJson(path, value) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(path, value) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, value, 'utf8');
}

function row(rows, id) {
	return rows.find(item => item.Id === id);
}

// ── 初始落盘：cc 激活 alpha；cx 激活 beta（enabled 默认）+ 禁用 gamma；vault-only 定义 delta ──
writeJson(claudeJsonPath, {mcpServers: {alpha: {type: 'http', url: 'https://alpha.example'}}});
writeText(
	codexConfigPath,
	[
		'[mcp_servers.beta]',
		'command = "beta-cli"',
		'',
		'[mcp_servers.gamma]',
		'command = "gamma-cli"',
		'enabled = false',
		''
	].join('\n')
);
writeJson(vaultPath, {
	schemaVersion: 1,
	createdAt: '2026-07-12T00:00:00.000Z',
	updatedAt: '2026-07-12T00:00:00.000Z',
	servers: {delta: {config: {command: 'delta-cli', args: ['serve']}}}
});

// ── 1) 双侧聚合 + 一行一 Id ─────────────────────────────────────────────
const rows = computeSharedStatus();
const ids = rows.map(r => r.Id);
assert.equal(new Set(ids).size, ids.length, '每个 Server ID 只出现一次（按 Id 去重）');
for (const r of rows) {
	assert.ok(r.injectByAgent && r.injectByAgent.cc && r.injectByAgent.cx, `${r.Id} 行携带 cc/cx 双侧开关态`);
	assert.equal(typeof r.injectByAgent.cc.active, 'boolean', `${r.Id}.cc.active 为布尔`);
	assert.equal(typeof r.injectByAgent.cx.active, 'boolean', `${r.Id}.cx.active 为布尔`);
}

// alpha：cc 激活 / cx 未激活（两侧独立不塌缩）。
const alpha = row(rows, 'alpha');
assert.ok(alpha, 'alpha 在共享列表中');
assert.equal(alpha.injectByAgent.cc.active, true, 'alpha cc 激活（.claude.json 存在）');
assert.equal(alpha.injectByAgent.cx.active, false, 'alpha cx 未激活（config.toml 无此块）');
console.log('[PASS] 13.1 双侧聚合：一行一 Id + cc/cx 独立不塌缩');

// ── 2) 列表全集 = 三源并集 ──────────────────────────────────────────────
for (const id of ['alpha', 'beta', 'gamma', 'delta']) {
	assert.ok(ids.includes(id), `列表全集含 ${id}（vault ∪ .claude.json ∪ config.toml 并集）`);
}
// beta：cx 激活 / cc 未激活。
const beta = row(rows, 'beta');
assert.equal(beta.injectByAgent.cx.active, true, 'beta cx 激活（config.toml 块存在且未禁用）');
assert.equal(beta.injectByAgent.cc.active, false, 'beta cc 未激活（.claude.json 无此块）');
console.log('[PASS] 13.1 列表全集 = vault 定义 ∪ 两侧 runtime 并集');

// ── 3) vault 定义 ≠ 激活态 ──────────────────────────────────────────────
const delta = row(rows, 'delta');
assert.ok(delta, 'vault-only 定义 delta 仍列出');
assert.equal(delta.injectByAgent.cc.active, false, 'delta cc 未激活（仅 vault 定义不算激活）');
assert.equal(delta.injectByAgent.cx.active, false, 'delta cx 未激活（仅 vault 定义不算激活）');
assert.equal(delta.hasDefinition, true, 'delta hasDefinition=true（共享定义体供开启复用）');
console.log('[PASS] 13.1 vault 定义 ≠ 激活态（definition-only 两侧 not-active 但仍列出）');

// ── 4) 开关态实时从 runtime 文件派生：外部删除 .claude.json 的 alpha ──────
writeJson(claudeJsonPath, {mcpServers: {}});
const rowsAfterEdit = computeSharedStatus();
const alphaAfter = row(rowsAfterEdit, 'alpha');
assert.ok(alphaAfter, 'alpha 仍列出（vault 已备份为共享定义）');
assert.equal(alphaAfter.injectByAgent.cc.active, false, '外部删除后 alpha cc 立即报告 not-active（实时读文件）');
console.log('[PASS] 13.1 开关态实时读 runtime 文件：外部编辑重投影即反映');

// ── 5) Codex enabled=false 第三态归 not-active，且投影不物化/删除禁用块 ────
const gamma = row(rowsAfterEdit, 'gamma');
assert.ok(gamma, 'gamma（Codex 禁用块）仍列出');
assert.equal(gamma.injectByAgent.cx.active, false, 'gamma cx 报告 not-active（enabled=false）');
const codexAfter = readFileSync(codexConfigPath, 'utf8');
assert.match(codexAfter, /\[mcp_servers\.gamma\]/, '投影后 [mcp_servers.gamma] 禁用块仍在（纯读不删）');
assert.match(codexAfter, /enabled = false/, '投影后 gamma enabled=false 保留（不被重写）');
console.log('[PASS] 13.1 Codex enabled=false 第三态归 not-active + 投影不物化/删除禁用块');

// ── 6) Modal 输入隔离：目标选择上下键不得移动背景列表 ────────────────
const React = (await import('react')).default;
const {act} = await import('react');
const {testRender} = await import('@opentui/react/test-utils');
const {default: McpView} = await import('../src/views/mcp/McpView.tsx');
const {MCP_GRID_COLUMNS, moveMcpGridCursor} = await import('../src/views/mcp/mcp-view-actions.ts');
assert.equal(MCP_GRID_COLUMNS, 2, 'MCP 网格固定为两列');
assert.equal(moveMcpGridCursor(0, 4, 'right'), 1, 'MCP 网格右移到同行第二列');
assert.equal(moveMcpGridCursor(1, 4, 'down'), 3, 'MCP 网格下移保持列位置');
assert.equal(moveMcpGridCursor(3, 4, 'down'), 1, 'MCP 网格末行下移循环到首行同列');
const mcpHomeSource = readFileSync(new URL('../src/views/mcp/McpHomeView.tsx', import.meta.url), 'utf8');
assert.match(
	mcpHomeSource,
	/<McpListInput[\s\S]{0,160}active=\{active && mode === 'list'\}/,
	'MCP 列表输入处理器只应在 list 模式挂载'
);
assert.match(
	mcpHomeSource,
	/<ToggleModalInput[\s\S]{0,160}active=\{active && mode === 'select-toggle-target'\}/,
	'MCP 目标 Modal 输入处理器只应在对应模式挂载'
);
const setup = await testRender(
	React.createElement(McpView, {active: true, onExitToNav() {}}),
	{width: 80, height: 24}
);

try {
	const press = async name => {
		await act(async () => {
			setup.renderer.keyInput.emit('keypress', {
				name,
				sequence: name === 'enter' ? '\r' : name,
				ctrl: false,
				shift: false,
				meta: false,
				option: false,
				eventType: 'press',
				repeated: false
			});
			await setup.renderOnce();
		});
	};

	const initialFrame = await setup.waitForFrame(frame => /\(1\/\d+\)/.test(frame));
	const initialGridRow = initialFrame
		.split('\n')
		.find(line => line.includes('alpha') && line.includes('beta'));
	assert.ok(initialGridRow, 'MCP 网格首行应并排显示两个 Server 卡片');
	await press('down');
	const selectedFrame = await setup.waitForFrame(frame => /\(3\/\d+\)/.test(frame));
	const selectedCounter = selectedFrame.match(/\(3\/\d+\)/)?.[0];
	assert.ok(selectedCounter, 'MCP 网格下键应移动到下一行同列');
	await press('enter');
	await setup.waitForFrame(frame => frame.includes('管理开关'));
	await press('down');
	const modalFrame = await setup.waitForFrame(frame => frame.includes('Codex'));
	assert.equal(modalFrame.includes(selectedCounter), true, 'Modal 上下键不得移动背景 MCP 列表');
	console.log('[PASS] MCP Modal 输入隔离：上下键只移动 Modal 目标，不穿透背景列表');
} finally {
	await act(async () => {
		setup.renderer.destroy();
	});
}

delete process.env.CCQ_HOME;
rmSync(home, {recursive: true, force: true});
console.log('[PASS] MCP 双侧聚合投影门禁全部通过');
