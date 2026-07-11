import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 6.1 门禁：Tools 共享投影不变量（design D2/D6，shared-resource-injection-ui）。
//   - 列表 agentContext 不变性：不同 Header 上下文投影出的可见集合完全一致（投影不吃 context）；
//   - 双态独立：CodeGraph 仅注入 Claude Code 时，cc=已注入 / cx=未注入 同时成立，对侧不塌缩；
//   - 非 inject 类无 injectByAgent；
//   - 显式 target 解析：inject/eject lifecycle 命令随传入 target，不依赖全局上下文。

// CCQ_HOME 隔离：投影读取 ~/.claude.json / ~/.codex 真实落盘信号。
const home = mkdtempSync(join(tmpdir(), 'ccq-shared-proj-'));
process.env.CCQ_HOME = home;

const {projectSharedToolComponents, isInjectableComponent, COMPONENT_DEFINITIONS} = await import('../src/core/tools-manage.ts');
const {codeGraphInstallCommands, codeGraphUninstallCommands} = await import('../src/core/tools-lifecycle.ts');

const EXPECTED_IDS = ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'Ccline', 'OpenSpec', 'CcgWorkflow', 'CodeGraph'];

// detected 全集（模拟检测结果）。projectSharedToolComponents 不按 context 过滤。
const detected = COMPONENT_DEFINITIONS.map(def => ({
	...def,
	installed: def.id === 'CodeGraph',
	currentVersion: def.id === 'CodeGraph' ? '1.2.3' : '',
	latestVersion: '',
	hasUpdate: null
}));

// ── 列表 agentContext 不变性：投影不接受 context 参数，结果对 cc/cx 都相同 ──────
const projected = projectSharedToolComponents(detected);
const ids = projected.map(c => c.id);
assert.deepEqual(ids, EXPECTED_IDS, '共享投影返回全 7 组件并按分组顺序排列（含 Ccline）');
assert.ok(ids.includes('Ccline'), 'Ccline 常显');
// 投影为纯函数，输入不含 context —— 两次调用结果结构一致即证明与上下文无关。
const projectedAgain = projectSharedToolComponents(detected);
assert.deepEqual(projectedAgain.map(c => c.id), ids, '重复投影可见集合稳定（context-independent）');
console.log('[PASS] 6.1 列表 agentContext 不变性：共享投影全集常显含 Ccline');

// ── 双态独立：仅 Claude Code 注入 CodeGraph ────────────────────────────────────
mkdirSync(join(home, '.claude'), {recursive: true});
writeFileSync(
	join(home, '.claude.json'),
	JSON.stringify({mcpServers: {codegraph: {command: 'codegraph', args: ['mcp']}}, projects: {}}, null, 2),
	'utf8'
);
// 不写 ~/.codex/config.toml → Codex 未注入。
const dualProjected = projectSharedToolComponents(detected);
const codegraph = dualProjected.find(c => c.id === 'CodeGraph');
assert.ok(codegraph, 'CodeGraph 在投影中存在');
assert.equal(codegraph.sharingKind, 'shared-cli-per-agent-inject', 'CodeGraph 为 inject 类');
assert.equal(codegraph.injectByAgent.cc.integrated, true, 'Claude Code 侧已注入');
assert.equal(codegraph.injectByAgent.cx.integrated, false, 'Codex 侧未注入（对侧不塌缩）');
console.log('[PASS] 6.1 双态独立：CodeGraph 仅注入 Claude Code 时 cc=已注入/cx=未注入');

// ── 非 inject 类无 injectByAgent ──────────────────────────────────────────────
for (const id of ['OpenSpec', 'AntigravityCli', 'ClaudeCode', 'CodexCli', 'Ccline']) {
	const component = dualProjected.find(c => c.id === id);
	assert.ok(component, `${id} 在投影中存在`);
	assert.equal(component.injectByAgent, undefined, `${id}（非 inject 类）不得含 injectByAgent`);
	assert.equal(isInjectableComponent(id), false, `${id} 非 injectable`);
}
for (const id of ['CodeGraph', 'CcgWorkflow']) {
	assert.equal(isInjectableComponent(id), true, `${id} 为 injectable`);
	const component = dualProjected.find(c => c.id === id);
	assert.ok(component.injectByAgent, `${id} 应含 injectByAgent 双侧快照`);
}
console.log('[PASS] 6.1 非 inject 类无 injectByAgent；仅 CodeGraph/CcgWorkflow 携带双侧快照');

// ── 显式 target 解析：inject/eject 命令随传入 target，不依赖全局上下文 ──────────
assert.deepEqual(
	codeGraphInstallCommands('cx'),
	[{cmd: 'codegraph', args: ['install', '--target=codex', '--location=global', '--yes']}],
	'inject Codex 目标解析为 --target=codex'
);
assert.deepEqual(
	codeGraphUninstallCommands('cx'),
	codeGraphUninstallCommands('cx'),
	'eject 命令按 target 稳定解析'
);
const cxUninstall = codeGraphUninstallCommands('cx');
assert.ok(cxUninstall.some(cmd => cmd.args.includes('--target=codex')), 'eject Codex 目标解析为 --target=codex');
const ccInstall = codeGraphInstallCommands('cc');
assert.ok(ccInstall.some(cmd => cmd.args.includes('--target=claude')), 'inject Claude Code 目标解析为 --target=claude');
console.log('[PASS] 6.1 显式 target 解析：inject/eject 命令随 target 而非全局上下文');

// ── 开关草稿状态机：Enter 打开用实际态初始化草稿，空格切换草稿，Enter 前不落盘 ────
const {
	reduceToolsViewState,
	createInitialToolsViewState,
	initialInjectDraft
} = await import('../src/state/tools-view-state.ts');

// 光标落在 CodeGraph（cc 已注入 / cx 未注入），进入开关 Modal。
const gridState = {
	...createInitialToolsViewState(),
	components: dualProjected,
	loaded: true,
	cursor: dualProjected.findIndex(c => c.id === 'CodeGraph')
};
const draft = initialInjectDraft(dualProjected.find(c => c.id === 'CodeGraph'));
assert.deepEqual(draft, {cc: true, cx: false}, '草稿用组件实际 inject 态初始化（cc 开 / cx 关）');

let modal = reduceToolsViewState(gridState, {type: 'open-inject-target', draft});
assert.equal(modal.mode, 'select-inject-target', 'Enter 打开开关 Modal');
assert.deepEqual(modal.injectDraft, {cc: true, cx: false}, 'Modal 初始草稿=实际态');

// 空格切换当前焦点侧（injectTargetIndex=0 → cc）：cc 由开→关。
modal = reduceToolsViewState(modal, {type: 'inject-target-toggle'});
assert.deepEqual(modal.injectDraft, {cc: false, cx: false}, '空格切换 cc 草稿 true→false');
// 下移到 cx 再切换：cx 由关→开。
modal = reduceToolsViewState(modal, {type: 'inject-target-nav', delta: 1});
modal = reduceToolsViewState(modal, {type: 'inject-target-toggle'});
assert.deepEqual(modal.injectDraft, {cc: false, cx: true}, '空格切换 cx 草稿 false→true');

// 草稿切换期间组件实际 injectByAgent 未被改写（Enter 前不落盘）。
const codegraphDuringDraft = modal.components.find(c => c.id === 'CodeGraph');
assert.equal(codegraphDuringDraft.injectByAgent.cc.integrated, true, '草稿切换不落盘：cc 实际态仍为已注入');
assert.equal(codegraphDuringDraft.injectByAgent.cx.integrated, false, '草稿切换不落盘：cx 实际态仍为未注入');

// Esc 取消：回 grid 且清空草稿。
const cancelled = reduceToolsViewState(modal, {type: 'cancel'});
assert.equal(cancelled.mode, 'grid', 'Esc 取消回 grid');
assert.equal(cancelled.injectDraft, undefined, 'Esc 取消清空草稿');
console.log('[PASS] 空格切换草稿 + Enter 前不落盘 + Esc 取消清空草稿');

delete process.env.CCQ_HOME;
console.log('[PASS] Tools 共享投影不变量门禁全部通过');
