import {describe, expect, test} from 'bun:test';
import {
	COMPONENT_DEFINITIONS,
	COMPONENT_META,
	filterVisibleComponents,
	groupComponentsByToolGroup,
	isInjectableComponent,
	projectSharedToolComponents,
	uninstallImpactNotice,
	type AgentInjectSnapshot,
	type ComponentId,
	type ManagedComponent,
	type SharedManagedComponent
} from '../../src/core/tools-manage.js';
import {
	createInitialToolsViewState,
	initialInjectDraft,
	latestActiveProgressTask,
	reduceToolsViewState,
	resolveToolsPrimaryAction,
	updatableComponents
} from '../../src/state/tools-view-state.js';
import type {AgentContext} from '../../src/state/manage-state.js';
import {
	dshLifecyclePatch,
	injectChangesAction,
	runInjectChanges,
	settleBatchUpdateComponents,
	successfulInstallPatch,
	successfulUpdatePatch,
	toolStatusDot,
	uninstallSuccessPatch,
	updateFailureMessage
} from '../../src/views/tools/tools-view-actions.js';
import {createTempHome} from '../helpers/temp-home.js';

// A 类改写（P1-G3）：tools 共享投影纯函数（groupToolsForHome 底层的
// groupComponentsByToolGroup / projectSharedToolComponents / filterVisibleComponents）。
// 对应 verify-tools-manage.mjs 的 registry 单一真理源与共享投影行为段。

function component(id: string, over: Partial<ManagedComponent> = {}): ManagedComponent {
	const def = COMPONENT_DEFINITIONS.find(entry => entry.id === id);
	if (!def) throw new Error(`未知组件 ${id}`);
	return {...def, installed: false, currentVersion: '', latestVersion: '', hasUpdate: null, ...over};
}

describe('tools 领域分组与共享投影', () => {
	test('groupComponentsByToolGroup 按 agent / companion / workflow / knowledge-graph 输出 label', () => {
		const sections = groupComponentsByToolGroup([
			component('CodeGraph'),
			component('ClaudeCode'),
			component('Ccline'),
			component('OpenSpec')
		]).map(section => section.label);
		expect(sections).toEqual(['Agent', '全局伴随工具', '工作流', '代码知识图谱']);
	});

	test('projectSharedToolComponents 为 CodeGraph/CcgWorkflow 注入双侧快照，GitNexus 保持整体共享', () => {
		const home = createTempHome('ccq-tools-projection-');
		try {
			const projected = projectSharedToolComponents([
				component('CodeGraph', {installed: true, currentVersion: '1.2.3', latestVersion: '2.0.0', hasUpdate: true}),
				component('CcgWorkflow', {installed: true, currentVersion: '3.1.6'}),
				component('GitNexus', {installed: true, currentVersion: '0.5.0'})
			]);
			const codegraph = projected.find(entry => entry.id === 'CodeGraph');
			expect(codegraph?.sharingKind).toBe('shared-cli-per-agent-inject');
			expect(codegraph?.injectByAgent?.cc.context).toBe('cc');
			expect(codegraph?.injectByAgent?.cx.context).toBe('cx');
			const gitnexus = projected.find(entry => entry.id === 'GitNexus');
			expect(gitnexus?.sharingKind).toBe('fully-shared-no-inject');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('filterVisibleComponents 按 agentContext 隐藏不支持组件并保持分组顺序', () => {
		const definitions = COMPONENT_DEFINITIONS.map(def => component(def.id, {installed: true, currentVersion: '1.0.0'}));
		const ccIds = filterVisibleComponents(definitions, 'cc').map(item => item.id);
		const cxIds = filterVisibleComponents(definitions, 'cx').map(item => item.id);
		expect(ccIds).toContain('Ccline');
		expect(cxIds).not.toContain('Ccline');
		expect(groupComponentsByToolGroup(definitions).map(section => section.group)).toEqual([
			'agent',
			'companion',
			'workflow',
			'knowledge-graph'
		]);
	});

	test('uninstallImpactNotice 区分共享工具与单 Agent 工具', () => {
		expect(uninstallImpactNotice('CodeGraph', {fullUninstall: true})).toMatch(/将在所有 Agent 中卸载/);
		expect(uninstallImpactNotice('CcgWorkflow', {fullUninstall: true})).toMatch(/将在所有 Agent 中卸载/);
		expect(uninstallImpactNotice('ClaudeCode')).not.toMatch(/所有 Agent/);
	});
});

// ── P4b 追加：迁移自 scripts/verify-tools-shared-projection.mjs（93 条静态断言）─────────
// 判据（R1）：去掉真实 fs / 子进程后仍成立——共享投影分类、Enter 主操作分派、DSH lifecycle
// 收敛、inject 草稿状态机、runInjectChanges 部分成功、patch 派生与批量结算。
//
// R9 去重（本批前置，不重复迁移，保留在 verify）：
// - 投影全集顺序 / Ccline 常显（已由 P4a `tools-context.test.ts` 覆盖）；
// - CodeGraph `sharingKind` / 显式 target 命令（已由 P1 覆盖）。
// 保留在 verify 的 fs 段：CodeGraph 仅 cc 注入的双态快照、Codex-only CCG（真实
// `.claude.json` / `~/.codex/.ccg-version`）。
//
// 输入保真说明：inject 草稿/单侧 patch 段的 `injectByAgent` 原值来自真实 `.claude.json`
// 投影（值 = cc:true / cx:false），此处以同一字面量输入复现（reducer/resolver 不读 fs，
// 代码路径与真实落盘一致）；fs→injectByAgent 的链路仍由 verify 的双态独立段与 P1 投影用例守护。

function sharedComponent(id: ComponentId, over: Partial<SharedManagedComponent> = {}): SharedManagedComponent {
	const definition = COMPONENT_DEFINITIONS.find(entry => entry.id === id);
	if (!definition) throw new Error(`未知组件 ${id}`);
	return {
		...definition,
		installed: false,
		currentVersion: '',
		latestVersion: '',
		hasUpdate: null,
		sharingKind: COMPONENT_META[id].sharingKind,
		applicableContexts: COMPONENT_META[id].contexts,
		sharedInstalled: false,
		sharedVersion: '',
		...over
	};
}

/** 真实 projectSharedToolComponents 投影（临时 home 隔离，不读用户真实 home）。 */
function projectedShared(): readonly SharedManagedComponent[] {
	const detected = COMPONENT_DEFINITIONS.map(definition => ({
		...definition,
		installed: definition.id === 'CodeGraph',
		currentVersion: definition.id === 'CodeGraph' ? '1.2.3' : '',
		latestVersion: '',
		hasUpdate: null as boolean | null
	}));
	const home = createTempHome('ccq-tools-projection-p4b-');
	try {
		return projectSharedToolComponents(detected);
	} finally {
		home.restore();
		home.cleanup();
	}
}

function dshLifecycle(state: string): NonNullable<ManagedComponent['lifecycle']> {
	const repairRequired = state === 'broken' || state === 'version-mismatch';
	return {
		owner: 'DeepSeekHarness',
		state,
		packageName: '@deepseek-ai/dsh',
		packageVersion: state === 'version-mismatch' ? '1.2.3' : '',
		commandVersion: state === 'version-mismatch' ? '1.2.2' : '',
		packagePresent: ['managed', 'broken', 'version-mismatch', 'path-conflict'].includes(state),
		commandPresent: !['not-installed', 'verification-unknown'].includes(state),
		canInstall: state === 'not-installed',
		canUpdate: state === 'managed' || repairRequired,
		canUninstall: state === 'managed' || repairRequired,
		repairRequired,
		diagnostic: `fixture: ${state}`
	} as NonNullable<ManagedComponent['lifecycle']>;
}

function asShared(component: ManagedComponent | undefined): SharedManagedComponent {
	if (!component) throw new Error('组件缺失');
	return component as SharedManagedComponent;
}

/** 构造与真实投影等价的 injectByAgent 值（cc/cx 双侧 + Pi 不可注入占位）。 */
function injectSnapshots(
	cc: boolean,
	cx: boolean,
	versions: {readonly cc?: string; readonly cx?: string} = {}
): Readonly<Record<AgentContext, AgentInjectSnapshot>> {
	return {
		cc: {context: 'cc', integrated: cc, ...(versions.cc ? {version: versions.cc} : {})},
		cx: {context: 'cx', integrated: cx, ...(versions.cx ? {version: versions.cx} : {})},
		pi: {context: 'pi', integrated: false}
	};
}

const codegraphWithCcInject = sharedComponent('CodeGraph', {
	installed: true,
	currentVersion: '1.2.3',
	sharedInstalled: true,
	sharedVersion: '1.2.3',
	injectByAgent: injectSnapshots(true, false)
});

describe('共享投影分类：仅 inject 类携带双侧快照', () => {
	test('非 inject 类不得含 injectByAgent，仅 CodeGraph/CcgWorkflow 为 injectable', () => {
		const projected = projectedShared();
		for (const id of [
			'OpenSpec',
			'Trellis',
			'AntigravityCli',
			'DeepSeekHarness',
			'ClaudeCode',
			'CodexCli',
			'PiCli',
			'PiWeb',
			'Ccline',
			'GitNexus'
		] as const) {
			const entry = projected.find(item => item.id === id);
			expect(entry, `${id} 在投影中存在`).toBeDefined();
			expect(entry?.injectByAgent, `${id}（非 inject 类）不得含 injectByAgent`).toBeUndefined();
			expect(isInjectableComponent(id), `${id} 非 injectable`).toBe(false);
		}

		for (const id of ['CodeGraph', 'CcgWorkflow'] as const) {
			expect(isInjectableComponent(id), `${id} 为 injectable`).toBe(true);
			const entry = projected.find(item => item.id === id);
			expect(entry?.injectByAgent, `${id} 应含 injectByAgent 双侧快照`).toBeDefined();
		}
	});
});

describe('Tools Enter 主操作优先级', () => {
	test('manage > install/update/latest，Pi Web 保持已安装文案', () => {
		const projected = projectedShared();
		const openSpec = projected.find(item => item.id === 'OpenSpec');
		expect(openSpec, 'OpenSpec 在共享投影中存在').toBeDefined();
		if (!openSpec) throw new Error('OpenSpec 缺失');
		expect(resolveToolsPrimaryAction({...openSpec, installed: false, hasUpdate: null}), '普通未安装工具 Enter 执行安装').toBe(
			'install'
		);
		expect(resolveToolsPrimaryAction({...openSpec, installed: true, hasUpdate: true}), '普通可更新工具 Enter 执行更新').toBe('update');
		expect(resolveToolsPrimaryAction({...openSpec, installed: true, hasUpdate: false}), '普通最新工具 Enter 只提示已是最新').toBe(
			'latest'
		);
		const codegraph = projected.find(item => item.id === 'CodeGraph');
		if (!codegraph) throw new Error('CodeGraph 缺失');
		expect(resolveToolsPrimaryAction({...codegraph, hasUpdate: true}), '管理型工具即使有更新，Enter 仍优先打开 Modal').toBe('manage');

		const piWeb = projected.find(item => item.id === 'PiWeb');
		expect(piWeb, 'PiWeb 在共享投影中存在').toBeDefined();
		if (!piWeb) throw new Error('PiWeb 缺失');
		expect(
			toolStatusDot({...piWeb, installed: true, currentVersion: '', latestVersion: '0.9.0', hasUpdate: true}, 'idle'),
			'Pi Web 卡片右上角保持正常已安装文案'
		).toEqual({kind: 'latest', label: '已安装'});
	});
});

describe('DSH repair/blocked 主操作与失败收敛', () => {
	test('broken/version-mismatch 进入修复，external/path-conflict/verification-unknown 只读阻断', () => {
		const dsh = sharedComponent('DeepSeekHarness');
		expect(dsh, 'DeepSeekHarness 在共享投影中存在').toBeDefined();
		expect(resolveToolsPrimaryAction({...dsh, lifecycle: dshLifecycle('broken')}), 'DSH broken Enter 进入修复').toBe('repair');
		expect(
			resolveToolsPrimaryAction({...dsh, lifecycle: dshLifecycle('version-mismatch')}),
			'DSH version-mismatch Enter 进入修复'
		).toBe('repair');
		expect(resolveToolsPrimaryAction({...dsh, lifecycle: dshLifecycle('external')}), 'DSH external Enter 只读阻断').toBe('blocked');
		expect(resolveToolsPrimaryAction({...dsh, lifecycle: dshLifecycle('path-conflict')}), 'DSH PATH 冲突 Enter 只读阻断').toBe(
			'blocked'
		);

		const verificationUnknown = dshLifecycle('verification-unknown');
		expect(verificationUnknown.canInstall, 'DSH verification-unknown 禁止安装').toBe(false);
		expect(verificationUnknown.canUpdate, 'DSH verification-unknown 禁止更新').toBe(false);
		expect(verificationUnknown.canUninstall, 'DSH verification-unknown 禁止卸载').toBe(false);
		expect(resolveToolsPrimaryAction({...dsh, lifecycle: verificationUnknown}), 'DSH verification-unknown Enter 只读阻断').toBe(
			'blocked'
		);
		expect(toolStatusDot({...dsh, lifecycle: verificationUnknown}, 'idle'), 'DSH verification-unknown 显示需验证状态').toEqual({
			kind: 'failed',
			label: '需验证'
		});
	});

	test('单项/批量失败保留最终 lifecycle、可修复事实与 core mutation 诊断', () => {
		const brokenDsh = sharedComponent('DeepSeekHarness', {
			installed: true,
			currentVersion: '1.2.3',
			hasUpdate: false,
			lifecycle: undefined
		});
		const failedState = reduceToolsViewState(
			{...createInitialToolsViewState(), components: [brokenDsh], loaded: true},
			{
				type: 'item-failed',
				id: 'DeepSeekHarness',
				error: 'DSH postflight 失败',
				patch: dshLifecyclePatch(brokenDsh, dshLifecycle('broken'))
			}
		);
		expect(failedState.components[0]?.lifecycle?.state, '单项 DSH 失败保留最终 broken lifecycle').toBe('broken');
		expect(failedState.components[0]?.installed, 'broken DSH 保留可修复安装事实').toBe(true);
		expect(failedState.components[0]?.hasUpdate, 'broken DSH 继续参加修复更新').toBe(true);
		expect(
			updatableComponents(failedState).map(item => item.id),
			'broken DSH 出现在全部更新目标中'
		).toEqual(['DeepSeekHarness']);
		expect(
			updateFailureMessage(
				['failed::DeepSeekHarness::npm 命令失败 (exit 23): fixture mutation failure'],
				'DeepSeekHarness',
				'fallback'
			),
			'DSH 单项更新错误必须保留 core mutation diagnostic'
		).toBe('npm 命令失败 (exit 23): fixture mutation failure');

		const batchFailed = settleBatchUpdateComponents(
			[brokenDsh],
			[brokenDsh],
			new Set(['DeepSeekHarness']),
			dshLifecycle('version-mismatch')
		)[0];
		expect(batchFailed?.lifecycle?.state, '批量 DSH 失败保留最终 version-mismatch lifecycle').toBe('version-mismatch');
		expect(batchFailed?.hasUpdate, '批量 DSH 版本不一致继续参加修复更新').toBe(true);
		expect(
			updatableComponents({...createInitialToolsViewState(), components: [batchFailed as ManagedComponent], loaded: true}).map(
				item => item.id
			),
			'version-mismatch DSH 出现在全部更新目标中'
		).toEqual(['DeepSeekHarness']);
	});
});

describe('GitNexus 整体接入模型', () => {
	test('无 Agent 开关 Modal，Enter 按安装/更新事实分派', () => {
		const gitnexus = sharedComponent('GitNexus');
		expect(gitnexus, 'GitNexus 在共享投影中存在').toBeDefined();
		expect(gitnexus.injectByAgent, 'GitNexus 不得携带双侧 inject 快照').toBeUndefined();
		expect(resolveToolsPrimaryAction({...gitnexus, installed: false, hasUpdate: null}), 'GitNexus 未安装 Enter 执行安装').toBe(
			'install'
		);
		expect(resolveToolsPrimaryAction({...gitnexus, installed: true, hasUpdate: true}), 'GitNexus 有更新 Enter 执行更新').toBe('update');
		expect(resolveToolsPrimaryAction({...gitnexus, installed: true, hasUpdate: false}), 'GitNexus 最新时 Enter 只提示已是最新').toBe(
			'latest'
		);
		expect(resolveToolsPrimaryAction({...gitnexus, installed: true, hasUpdate: true}), 'GitNexus 绝不打开 Agent 开关 Modal').not.toBe(
			'manage'
		);
	});
});

describe('开关草稿状态机', () => {
	test('空格切换草稿 + Enter 前不落盘 + Esc 取消清空草稿', () => {
		const gridState = {
			...createInitialToolsViewState(),
			components: [codegraphWithCcInject],
			loaded: true,
			cursor: 0
		};
		const draft = initialInjectDraft(codegraphWithCcInject);
		expect(draft, '草稿用组件实际 inject 态初始化（cc 开 / cx 关，Pi 不可注入）').toEqual({cc: true, cx: false, pi: false});

		let modal = reduceToolsViewState(gridState, {type: 'open-inject-target', draft});
		expect(modal.mode, 'Enter 打开开关 Modal').toBe('select-inject-target');
		expect(modal.injectDraft, 'Modal 初始草稿=实际态').toEqual({cc: true, cx: false, pi: false});
		const modalCursor = modal.cursor;

		modal = reduceToolsViewState(modal, {type: 'inject-target-toggle'});
		expect(modal.injectDraft, '空格切换 cc 草稿 true→false').toEqual({cc: false, cx: false, pi: false});
		modal = reduceToolsViewState(modal, {type: 'inject-target-nav', delta: 1});
		expect(modal.cursor, 'Tools Modal 上下键不得移动背景网格光标').toBe(modalCursor);
		modal = reduceToolsViewState(modal, {type: 'inject-target-toggle'});
		expect(modal.injectDraft, '空格切换 cx 草稿 false→true').toEqual({cc: false, cx: true, pi: false});

		const duringDraft = asShared(modal.components.find(item => item.id === 'CodeGraph'));
		expect(duringDraft.injectByAgent?.cc.integrated, '草稿切换不落盘：cc 实际态仍为已注入').toBe(true);
		expect(duringDraft.injectByAgent?.cx.integrated, '草稿切换不落盘：cx 实际态仍为未注入').toBe(false);

		const cancelled = reduceToolsViewState(modal, {type: 'cancel'});
		expect(cancelled.mode, 'Esc 取消回 grid').toBe('grid');
		expect(cancelled.injectDraft, 'Esc 取消清空草稿').toBeUndefined();
	});

	test('BusyOverlay 切到最后上报 progress 的组件，取消 busy 不误报失败', () => {
		const gridState = {
			...createInitialToolsViewState(),
			components: [codegraphWithCcInject, sharedComponent('OpenSpec')],
			loaded: true
		};
		let rolling = reduceToolsViewState(gridState, {type: 'batch-start', action: 'update', ids: ['CodeGraph', 'OpenSpec']});
		rolling = reduceToolsViewState(rolling, {type: 'progress', id: 'CodeGraph', message: 'codegraph update', level: 'info'});
		rolling = reduceToolsViewState(rolling, {
			type: 'progress',
			id: 'OpenSpec',
			message: 'npm install -g @fission-ai/openspec',
			level: 'info'
		});
		expect(latestActiveProgressTask(rolling)?.id, 'BusyOverlay 应切到最后上报 progress 的组件').toBe('OpenSpec');
		rolling = reduceToolsViewState(rolling, {
			type: 'progress',
			id: 'CodeGraph',
			message: 'codegraph install --target=codex',
			level: 'info'
		});
		expect(latestActiveProgressTask(rolling)?.message, '新 progress 应替换旧指令').toBe('codegraph install --target=codex');

		const busyCancelled = reduceToolsViewState(
			{
				...gridState,
				mode: 'busy',
				busyAction: 'update',
				itemStatus: {CodeGraph: 'updating'},
				progressByComponent: {CodeGraph: '下载中'},
				progressLevelByComponent: {CodeGraph: 'info'},
				errorText: '旧错误'
			},
			{type: 'cancel-busy'}
		);
		expect(busyCancelled.mode, '取消 busy 后回到工具网格').toBe('grid');
		expect(busyCancelled.busyAction, '取消 busy 后清空动作').toBeUndefined();
		expect(busyCancelled.itemStatus, '取消 busy 后清空进行中状态').toEqual({});
		expect(busyCancelled.errorText, '用户取消不得显示为失败').toBeUndefined();
	});
});

describe('CodeGraph 单侧 inject patch', () => {
	test('首次仅安装 Claude Code：安装结果版本立即进入共享 CLI 状态', async () => {
		const pending = sharedComponent('CodeGraph', {
			installed: false,
			currentVersion: '',
			sharedInstalled: false,
			sharedVersion: '',
			injectByAgent: injectSnapshots(false, false)
		});
		const injectResult = await runInjectChanges(
			pending,
			[{ctx: 'cc', desired: true}],
			{
				injectComponent: async (_id: string, target: string) => {
					expect(target, '首次单侧安装目标为 Claude Code').toBe('cc');
					return {id: 'CodeGraph', success: true, version: '1.4.1'};
				},
				ejectComponent: async () => {
					throw new Error('首次安装不应调用 eject');
				}
			} as never,
			() => {}
		);
		expect(injectResult.error, '首次单侧安装成功不返回错误').toBeUndefined();
		const patched = asShared(
			reduceToolsViewState(
				{...createInitialToolsViewState(), components: [pending], loaded: true},
				{type: 'item-patched', id: 'CodeGraph', patch: injectResult.patch}
			).components[0]
		);
		expect(patched.currentVersion, '安装结果版本立即写入 CodeGraph currentVersion').toBe('1.4.1');
		expect(patched.sharedInstalled, '首次单侧安装立即标记共享 CLI 已安装').toBe(true);
		expect(patched.injectByAgent?.cc.integrated, 'Claude Code 单侧状态立即置为已安装').toBe(true);
		expect(patched.injectByAgent?.cx.integrated, 'Codex 侧仍保持未安装').toBe(false);
		expect(toolStatusDot(patched, 'idle').label, '右上角立即显示 CLI 版本号而非「CLI 已装」').toBe('1.4.1');
	});

	test('逐 Agent 关闭最后一侧保留共享 CLI，双侧部分失败保留已完成侧', async () => {
		const patched = sharedComponent('CodeGraph', {
			installed: true,
			currentVersion: '1.4.1',
			sharedInstalled: true,
			sharedVersion: '1.4.1',
			injectByAgent: injectSnapshots(true, false)
		});

		const lastSide = await runInjectChanges(
			{...patched, injectByAgent: injectSnapshots(true, false)},
			[{ctx: 'cc', desired: false}],
			{
				injectComponent: async () => {
					throw new Error('最后一侧卸载不应调用 inject');
				},
				ejectComponent: async () => ({id: 'CodeGraph', success: true})
			} as never,
			() => {}
		);
		expect(lastSide.error, '最后一侧卸载成功不返回错误').toBeUndefined();
		expect(lastSide.patch.injectByAgent?.cc.integrated, '最后一侧关闭后 cc 集成解除').toBe(false);
		expect(lastSide.patch.installed, '逐 Agent 关闭不删 CLI：installed 保持 true').toBe(true);
		expect(lastSide.patch.sharedInstalled, '逐 Agent 关闭不删 CLI：sharedInstalled 保持 true').toBe(true);
		expect(lastSide.patch.currentVersion, '逐 Agent 关闭保留 CLI 版本号').toBe('1.4.1');
		expect(lastSide.patch.sharedVersion, '逐 Agent 关闭保留共享 CLI 版本号').toBe('1.4.1');

		const partial = await runInjectChanges(
			{...patched, injectByAgent: injectSnapshots(true, false)},
			[
				{ctx: 'cc', desired: false},
				{ctx: 'cx', desired: true}
			],
			{
				injectComponent: async () => ({id: 'CodeGraph', success: false, error: 'Codex 接入失败'}),
				ejectComponent: async () => ({id: 'CodeGraph', success: true})
			} as never,
			() => {}
		);
		expect(String(partial.error), '第二侧失败返回明确错误').toMatch(/Codex 接入失败/);
		expect(partial.patch.injectByAgent?.cc.integrated, '第一侧成功卸载写入部分 patch').toBe(false);
		expect(partial.patch.injectByAgent?.cx.integrated, '失败侧保持原始未安装状态').toBe(false);
		expect(partial.patch.sharedInstalled, '逐 Agent 关闭不删 CLI：部分 patch 仍反映 CLI 保留').toBe(true);

		const partialPatched = reduceToolsViewState(
			{...createInitialToolsViewState(), components: [patched], loaded: true},
			{type: 'item-patched', id: 'CodeGraph', patch: partial.patch}
		);
		const partialFailed = reduceToolsViewState(partialPatched, {
			type: 'item-failed',
			id: 'CodeGraph',
			error: partial.error ?? ''
		});
		expect(partialFailed.loaded, '局部失败不应把已加载列表改回未加载').toBe(true);
		expect(asShared(partialFailed.components[0]).injectByAgent?.cc.integrated, '错误展示不得覆盖部分成功 patch').toBe(false);
	});

	test('进度时态区分纯卸载与含安装的混合变更', () => {
		expect(injectChangesAction([{ctx: 'cc', desired: false}] as never), '纯 eject 使用卸载时态').toBe('uninstall');
		expect(
			injectChangesAction([
				{ctx: 'cc', desired: false},
				{ctx: 'cx', desired: true}
			] as never),
			'混合变更含安装时使用安装时态'
		).toBe('install');
	});
});

describe('卸载 / 更新 patch 派生', () => {
	const installedWithUpdate = sharedComponent('CodeGraph', {
		installed: true,
		currentVersion: '1.4.1',
		latestVersion: '1.5.0',
		hasUpdate: true,
		statusHint: '旧提示',
		sharedInstalled: true,
		sharedVersion: '1.4.1',
		injectByAgent: injectSnapshots(true, true)
	});

	test('全量卸载 patch 清空更新态、提示、共享版本与双侧状态', () => {
		const state = reduceToolsViewState(
			{...createInitialToolsViewState(), components: [installedWithUpdate], loaded: true},
			{type: 'item-patched', id: 'CodeGraph', patch: uninstallSuccessPatch(installedWithUpdate, true)}
		);
		const fully = asShared(state.components[0]);
		expect(fully.hasUpdate, '全量卸载允许 hasUpdate 显式写 null').toBeNull();
		expect(fully.statusHint, '全量卸载允许清空 statusHint').toBeUndefined();
		expect(fully.injectByAgent?.cc.integrated, '全量卸载清空 Claude Code 侧').toBe(false);
		expect(fully.injectByAgent?.cx.integrated, '全量卸载清空 Codex 侧').toBe(false);
		expect(fully.sharedVersion, '全量卸载清空共享版本').toBe('');
		expect(state.loaded, '局部 patch 不改变 loaded').toBe(true);
		expect(
			updatableComponents({...state, components: [{...fully, hasUpdate: true}]}).length,
			'未安装组件即使收到脏更新态也不得进入全部更新'
		).toBe(0);
	});

	test('单项安装/更新/卸载 patch 同步共享 CLI 与双侧版本', () => {
		const sharedInstall = successfulInstallPatch(sharedComponent('OpenSpec', {sharingKind: 'fully-shared-no-inject'}), '0.30.0');
		expect(sharedInstall.sharedInstalled, '共享 CLI 安装同步 sharedInstalled').toBe(true);
		expect(sharedInstall.sharedVersion, '共享 CLI 安装同步 sharedVersion').toBe('0.30.0');

		const codegraphUpdate = successfulUpdatePatch(installedWithUpdate);
		expect(codegraphUpdate.currentVersion, 'CodeGraph 更新推进 currentVersion').toBe('1.5.0');
		expect(codegraphUpdate.sharedVersion, 'CodeGraph 更新同步 sharedVersion').toBe('1.5.0');

		const ccgUpdate = successfulUpdatePatch(
			sharedComponent('CcgWorkflow', {
				installed: true,
				currentVersion: '1.4.1',
				latestVersion: '1.5.0',
				hasUpdate: true,
				injectByAgent: injectSnapshots(true, true, {cc: '3.1.0', cx: '3.0.0'})
			})
		);
		expect(ccgUpdate.injectByAgent?.cc.version, 'CCG 更新同步 Claude Code 侧版本').toBe('1.5.0');
		expect(ccgUpdate.injectByAgent?.cx.version, 'CCG 更新同步 Codex 侧版本').toBe('1.5.0');

		const sharedUpdate = successfulUpdatePatch(
			sharedComponent('OpenSpec', {
				installed: true,
				currentVersion: '1.4.1',
				latestVersion: '1.5.0',
				hasUpdate: true,
				sharingKind: 'fully-shared-no-inject'
			})
		);
		expect(sharedUpdate.sharedVersion, '共享 CLI 更新同步 sharedVersion').toBe('1.5.0');

		const sharedUninstall = uninstallSuccessPatch(sharedComponent('OpenSpec', {sharingKind: 'fully-shared-no-inject'}), false);
		expect(sharedUninstall.sharedInstalled, '共享 CLI 卸载同步 sharedInstalled').toBe(false);
		expect(sharedUninstall.sharedVersion, '共享 CLI 卸载清空 sharedVersion').toBe('');
	});

	test('配置残留但 CLI 缺失显示「CLI 不可用」', () => {
		const broken = sharedComponent('CodeGraph', {
			installed: false,
			sharedInstalled: false,
			currentVersion: '',
			sharedVersion: '',
			injectByAgent: injectSnapshots(true, false)
		});
		expect(toolStatusDot(broken, 'idle'), '配置残留但 CLI 缺失显示故障态').toEqual({kind: 'failed', label: 'CLI 不可用'});
	});

	test('批量更新先用本地结果结算状态', () => {
		const openSpec = sharedComponent('OpenSpec', {
			installed: true,
			currentVersion: '1.0.0',
			latestVersion: '1.1.0',
			hasUpdate: true
		});
		const settled = settleBatchUpdateComponents([installedWithUpdate, openSpec], [installedWithUpdate], new Set());
		expect(settled[0]?.hasUpdate, '批量更新成功项立即清空可更新状态').toBe(false);
		expect(settled[0]?.currentVersion, '批量更新成功项立即推进本地版本').toBe('1.5.0');
		expect(settled[1]?.hasUpdate, '非目标项保持原状态').toBe(true);
	});
});
