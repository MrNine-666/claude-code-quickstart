import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
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

const EXPECTED_IDS = ['ClaudeCode', 'CodexCli', 'AntigravityCli', 'Ccline', 'OpenSpec', 'Trellis', 'CcgWorkflow', 'CodeGraph'];

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
assert.deepEqual(ids, EXPECTED_IDS, '共享投影返回全 8 组件并按分组顺序排列（含 Ccline / Trellis）');
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
for (const id of ['OpenSpec', 'Trellis', 'AntigravityCli', 'ClaudeCode', 'CodexCli', 'Ccline']) {
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
	initialInjectDraft,
	resolveToolsPrimaryAction,
	updatableComponents
} = await import('../src/state/tools-view-state.ts');

// ── 网格 Enter 主操作：管理 Modal 优先，普通工具按安装/更新事实分派 ──────────
const openSpec = dualProjected.find(c => c.id === 'OpenSpec');
assert.ok(openSpec, 'OpenSpec 在共享投影中存在');
assert.equal(resolveToolsPrimaryAction({...openSpec, installed: false, hasUpdate: null}), 'install', '普通未安装工具 Enter 执行安装');
assert.equal(resolveToolsPrimaryAction({...openSpec, installed: true, hasUpdate: true}), 'update', '普通可更新工具 Enter 执行更新');
assert.equal(resolveToolsPrimaryAction({...openSpec, installed: true, hasUpdate: false}), 'latest', '普通最新工具 Enter 只提示已是最新');
assert.equal(resolveToolsPrimaryAction({...codegraph, hasUpdate: true}), 'manage', '管理型工具即使有更新，Enter 仍优先打开 Modal');
console.log('[PASS] Tools Enter 主操作优先级：manage > install/update/latest');

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
const modalCursor = modal.cursor;

// 空格切换当前焦点侧（injectTargetIndex=0 → cc）：cc 由开→关。
modal = reduceToolsViewState(modal, {type: 'inject-target-toggle'});
assert.deepEqual(modal.injectDraft, {cc: false, cx: false}, '空格切换 cc 草稿 true→false');
// 下移到 cx 再切换：cx 由关→开。
modal = reduceToolsViewState(modal, {type: 'inject-target-nav', delta: 1});
assert.equal(modal.cursor, modalCursor, 'Tools Modal 上下键不得移动背景网格光标');
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

const toolsModalViewSource = readFileSync(new URL('../src/views/ToolsView.tsx', import.meta.url), 'utf8');
assert.match(
	toolsModalViewSource,
	/renderGrid\(view, scrollRef, active && view\.mode === 'grid'\)/,
	'Tools Modal 打开时背景网格必须失焦'
);

// ── CodeGraph 首次单侧安装：安装结果版本必须立即进入共享 CLI 状态 ───────────────
// 首次仅开启 Claude Code 时，刷新检测完成前仍依赖本地 patch；若丢弃 install outcome.version，
// 右上角会退化成「CLI 已装」而不是版本号。
const pendingCodegraph = {
	...codegraph,
	installed: false,
	currentVersion: '',
	sharedInstalled: false,
	sharedVersion: '',
	injectByAgent: {
		cc: {context: 'cc', integrated: false},
		cx: {context: 'cx', integrated: false}
	}
};
const {
	injectChangesAction,
	settleBatchUpdateComponents,
	runInjectChanges,
	successfulInstallPatch,
	successfulUpdatePatch,
	toolStatusDot,
	uninstallSuccessPatch
} = await import('../src/views/ToolsView.tsx');
const injectResult = await runInjectChanges(
	pendingCodegraph,
	[{ctx: 'cc', desired: true}],
	{
		injectComponent: async (_id, target) => {
			assert.equal(target, 'cc', '首次单侧安装目标为 Claude Code');
			return {id: 'CodeGraph', success: true, version: '1.4.1'};
		},
		ejectComponent: async () => {
			throw new Error('首次安装不应调用 eject');
		}
	},
	() => {}
);
assert.equal(injectResult.error, undefined, '首次单侧安装成功不返回错误');
const patchedState = reduceToolsViewState(
	{...createInitialToolsViewState(), components: [pendingCodegraph], loaded: true},
	{type: 'item-patched', id: 'CodeGraph', patch: injectResult.patch}
);
const patchedCodegraph = patchedState.components[0];
assert.equal(patchedCodegraph.currentVersion, '1.4.1', '安装结果版本立即写入 CodeGraph currentVersion');
assert.equal(patchedCodegraph.sharedInstalled, true, '首次单侧安装立即标记共享 CLI 已安装');
assert.equal(patchedCodegraph.injectByAgent.cc.integrated, true, 'Claude Code 单侧状态立即置为已安装');
assert.equal(patchedCodegraph.injectByAgent.cx.integrated, false, 'Codex 侧仍保持未安装');
assert.equal(toolStatusDot(patchedCodegraph, 'idle').label, '1.4.1', '右上角立即显示 CLI 版本号而非「CLI 已装」');
console.log('[PASS] CodeGraph 首次仅安装 Claude Code 时右上角立即显示 CLI 版本号');

// ── CodeGraph 逐 Agent 关闭最后一侧：共享 CLI 必须保留（移除 CLI 仅整体卸载路径负责）─────
const lastSideEject = await runInjectChanges(
	{...patchedCodegraph, sharedInstalled: true, sharedVersion: '1.4.1', injectByAgent: {cc: {context: 'cc', integrated: true}, cx: {context: 'cx', integrated: false}}},
	[{ctx: 'cc', desired: false}],
	{
		injectComponent: async () => {
			throw new Error('最后一侧卸载不应调用 inject');
		},
		ejectComponent: async () => ({id: 'CodeGraph', success: true})
	},
	() => {}
);
assert.equal(lastSideEject.error, undefined, '最后一侧卸载成功不返回错误');
assert.equal(lastSideEject.patch.injectByAgent.cc.integrated, false, '最后一侧关闭后 cc 集成解除');
assert.equal(lastSideEject.patch.installed, true, '逐 Agent 关闭不删 CLI：installed 保持 true');
assert.equal(lastSideEject.patch.sharedInstalled, true, '逐 Agent 关闭不删 CLI：sharedInstalled 保持 true');
assert.equal(lastSideEject.patch.currentVersion, '1.4.1', '逐 Agent 关闭保留 CLI 版本号');
assert.equal(lastSideEject.patch.sharedVersion, '1.4.1', '逐 Agent 关闭保留共享 CLI 版本号');
console.log('[PASS] CodeGraph 逐 Agent 关闭最后一侧保留共享 CLI 状态');

// ── 双侧变更部分失败：保留已完成侧并返回错误，禁止丢弃磁盘真实状态 ───────────────
const partialResult = await runInjectChanges(
	{...patchedCodegraph, injectByAgent: {cc: {context: 'cc', integrated: true}, cx: {context: 'cx', integrated: false}}},
	[{ctx: 'cc', desired: false}, {ctx: 'cx', desired: true}],
	{
		injectComponent: async () => ({id: 'CodeGraph', success: false, error: 'Codex 接入失败'}),
		ejectComponent: async () => ({id: 'CodeGraph', success: true})
	},
	() => {}
);
assert.match(partialResult.error, /Codex 接入失败/, '第二侧失败返回明确错误');
assert.equal(partialResult.patch.injectByAgent.cc.integrated, false, '第一侧成功卸载写入部分 patch');
assert.equal(partialResult.patch.injectByAgent.cx.integrated, false, '失败侧保持原始未安装状态');
assert.equal(partialResult.patch.sharedInstalled, true, '逐 Agent 关闭不删 CLI：部分 patch 仍反映 CLI 保留');
const partialPatchedState = reduceToolsViewState(
	{...createInitialToolsViewState(), components: [patchedCodegraph], loaded: true},
	{type: 'item-patched', id: 'CodeGraph', patch: partialResult.patch}
);
const partialFailedState = reduceToolsViewState(partialPatchedState, {type: 'item-failed', id: 'CodeGraph', error: partialResult.error});
assert.equal(partialFailedState.loaded, true, '局部失败不应把已加载列表改回未加载');
assert.equal(partialFailedState.components[0].injectByAgent.cc.integrated, false, '错误展示不得覆盖部分成功 patch');
console.log('[PASS] 双侧变更部分失败保留已完成侧状态');

// ── 进度时态：纯卸载显示卸载中，含安装的混合操作显示安装中 ────────────────────
assert.equal(injectChangesAction([{ctx: 'cc', desired: false}]), 'uninstall', '纯 eject 使用卸载时态');
assert.equal(injectChangesAction([{ctx: 'cc', desired: false}, {ctx: 'cx', desired: true}]), 'install', '混合变更含安装时使用安装时态');
console.log('[PASS] 开关进度时态区分安装与纯卸载');

// ── 全量卸载 patch：null/undefined/双侧快照均须真实覆盖旧值 ────────────────────
const installedWithUpdate = {
	...patchedCodegraph,
	latestVersion: '1.5.0',
	hasUpdate: true,
	statusHint: '旧提示',
	injectByAgent: {cc: {context: 'cc', integrated: true}, cx: {context: 'cx', integrated: true}}
};
const fullyUninstalledState = reduceToolsViewState(
	{...createInitialToolsViewState(), components: [installedWithUpdate], loaded: true},
	{type: 'item-patched', id: 'CodeGraph', patch: uninstallSuccessPatch(installedWithUpdate, true)}
);
const fullyUninstalled = fullyUninstalledState.components[0];
assert.equal(fullyUninstalled.hasUpdate, null, '全量卸载允许 hasUpdate 显式写 null');
assert.equal(fullyUninstalled.statusHint, undefined, '全量卸载允许清空 statusHint');
assert.equal(fullyUninstalled.injectByAgent.cc.integrated, false, '全量卸载清空 Claude Code 侧');
assert.equal(fullyUninstalled.injectByAgent.cx.integrated, false, '全量卸载清空 Codex 侧');
assert.equal(fullyUninstalled.sharedVersion, '', '全量卸载清空共享版本');
assert.equal(fullyUninstalledState.loaded, true, '局部 patch 不改变 loaded');
assert.equal(updatableComponents({...fullyUninstalledState, components: [{...fullyUninstalled, hasUpdate: true}]}).length, 0, '未安装组件即使收到脏更新态也不得进入全部更新');
console.log('[PASS] 全量卸载 patch 清空更新态、提示、共享版本与双侧状态');

// ── 单项更新 patch：共享/双侧版本与 currentVersion 同步前进 ────────────────────
const sharedInstallPatch = successfulInstallPatch(
	{...pendingCodegraph, id: 'OpenSpec', name: 'OpenSpec CLI', sharingKind: 'fully-shared-no-inject'},
	'0.30.0'
);
assert.equal(sharedInstallPatch.sharedInstalled, true, '共享 CLI 安装同步 sharedInstalled');
assert.equal(sharedInstallPatch.sharedVersion, '0.30.0', '共享 CLI 安装同步 sharedVersion');
const codegraphUpdatePatch = successfulUpdatePatch(installedWithUpdate);
assert.equal(codegraphUpdatePatch.currentVersion, '1.5.0', 'CodeGraph 更新推进 currentVersion');
assert.equal(codegraphUpdatePatch.sharedVersion, '1.5.0', 'CodeGraph 更新同步 sharedVersion');
const ccgUpdatePatch = successfulUpdatePatch({
	...installedWithUpdate,
	id: 'CcgWorkflow',
	name: 'CCG Workflow',
	sharedInstalled: false,
	sharedVersion: '',
	injectByAgent: {
		cc: {context: 'cc', integrated: true, version: '3.1.0'},
		cx: {context: 'cx', integrated: true, version: '3.0.0'}
	}
});
assert.equal(ccgUpdatePatch.injectByAgent.cc.version, '1.5.0', 'CCG 更新同步 Claude Code 侧版本');
assert.equal(ccgUpdatePatch.injectByAgent.cx.version, '1.5.0', 'CCG 更新同步 Codex 侧版本');
const sharedUpdatePatch = successfulUpdatePatch({
	...installedWithUpdate,
	id: 'OpenSpec',
	name: 'OpenSpec CLI',
	sharingKind: 'fully-shared-no-inject'
});
assert.equal(sharedUpdatePatch.sharedVersion, '1.5.0', '共享 CLI 更新同步 sharedVersion');
const sharedUninstallPatch = uninstallSuccessPatch(
	{...installedWithUpdate, id: 'OpenSpec', name: 'OpenSpec CLI', sharingKind: 'fully-shared-no-inject'},
	false
);
assert.equal(sharedUninstallPatch.sharedInstalled, false, '共享 CLI 卸载同步 sharedInstalled');
assert.equal(sharedUninstallPatch.sharedVersion, '', '共享 CLI 卸载清空 sharedVersion');
console.log('[PASS] 单项更新 patch 同步共享 CLI 与双侧版本');

// ── Codex-only CCG：共享投影必须派生 installed/hasUpdate，允许 u 更新 ──────────
mkdirSync(join(home, '.codex'), {recursive: true});
writeFileSync(join(home, '.codex', '.ccg-version'), '3.1.0\n', 'utf8');
const codexOnlyDetected = detected.map(component => component.id === 'CcgWorkflow'
	? {...component, installed: false, currentVersion: '', latestVersion: '3.2.0', hasUpdate: null}
	: component);
const codexOnlyCcg = projectSharedToolComponents(codexOnlyDetected).find(component => component.id === 'CcgWorkflow');
assert.equal(codexOnlyCcg.injectByAgent.cc.integrated, false, 'Codex-only CCG 的 Claude Code 侧未安装');
assert.equal(codexOnlyCcg.injectByAgent.cx.integrated, true, 'Codex-only CCG 的 Codex 侧已安装');
assert.equal(codexOnlyCcg.installed, true, 'Codex-only CCG 聚合 installed=true');
assert.equal(codexOnlyCcg.currentVersion, '3.1.0', 'Codex-only CCG 聚合当前版本来自 Codex');
assert.equal(codexOnlyCcg.hasUpdate, true, 'Codex-only CCG 根据 Codex 版本判定可更新');
console.log('[PASS] Codex-only CCG 在共享列表中可检测并更新');

// ── CodeGraph 配置残留但 CLI 不可用：不得谎报「CLI 已装」 ─────────────────────
const brokenCodegraph = {...patchedCodegraph, installed: false, sharedInstalled: false, currentVersion: '', sharedVersion: ''};
assert.deepEqual(toolStatusDot(brokenCodegraph, 'idle'), {kind: 'failed', label: 'CLI 不可用'}, '配置残留但 CLI 缺失显示故障态');
console.log('[PASS] CodeGraph 配置残留但 CLI 缺失显示「CLI 不可用」');

// ── updateAll：成功/失败检测结果都必须先走共享投影，失败后仍刷新 ───────────────
const toolsViewSource = readFileSync(new URL('../src/views/ToolsView.tsx', import.meta.url), 'utf8');
const updateAllSource = toolsViewSource.slice(toolsViewSource.indexOf('function updateAll'), toolsViewSource.indexOf('// ── 卸载确认'));
const settledBatch = settleBatchUpdateComponents(
	[installedWithUpdate, {...openSpec, installed: true, currentVersion: '1.0.0', latestVersion: '1.1.0', hasUpdate: true}],
	[installedWithUpdate],
	new Set()
);
assert.equal(settledBatch[0].hasUpdate, false, '批量更新成功项立即清空可更新状态');
assert.equal(settledBatch[0].currentVersion, '1.5.0', '批量更新成功项立即推进本地版本');
assert.equal(settledBatch[1].hasUpdate, true, '非目标项保持原状态');
assert.doesNotMatch(updateAllSource, /services\.detectComponents\(/, '批量更新收尾不得等待二次全量检测');
assert.match(updateAllSource, /settleBatchUpdateComponents\(/, '批量更新先用本地结果结算状态');
assert.match(updateAllSource.slice(updateAllSource.indexOf('.catch')), /cache\.refresh\(\)/, '批量更新失败后刷新真实状态');
for (const [start, end, label] of [
	['function installOne', 'export function successfulInstallPatch', '安装'],
	['function updateOne', 'export function successfulUpdatePatch', '更新'],
	['function runUninstall', 'export function uninstallSuccessPatch', '卸载']
]) {
	const section = toolsViewSource.slice(toolsViewSource.indexOf(start), toolsViewSource.indexOf(end));
	assert.match(section.slice(section.indexOf('.catch')), /cache\.refresh\(\)/, `${label}异常后刷新真实状态`);
}
console.log('[PASS] 批量更新立即退出 busy，并在后台刷新真实状态');

delete process.env.CCQ_HOME;
console.log('[PASS] Tools 共享投影不变量门禁全部通过');
