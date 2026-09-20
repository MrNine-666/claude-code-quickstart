import {describe, expect, test} from 'bun:test';
import {groupInstalledSkillItems, type SkillsCliListRecord} from '../../src/core/skills-installed.js';
import {
	createInitialSkillsViewState,
	filteredInstalled,
	pendingBatchInstances,
	reduceSkillsViewState,
	searchInstallItems,
	selectedInstalled,
	uninstallTargets
} from '../../src/state/skills-view-state.js';

// 载体迁移（P3a）：原 scripts/verify-skills-instance-state.mjs（45 条静态断言）整体迁入。
//
// Checkpoint B 门禁（task 07-28-skills-multi-source-topology / design §6-§7）：
// reducer 的已装身份是 InstalledSkillItem.id，不再是 name。覆盖：
//   1) installed 为 Item[]，同名多来源各自成行且 cursor 可分别选中；
//   2) unknown 来源不能进入可提交的 Agent 管理，也不能单项更新；
//   3) 删除/管理意图快照 instance id，确认后不按 name 或 cursor 重查；
//   4) 搜索页已安装判断按来源 identity，冲突只在目标根发生；
//   5) 没有 name 级乐观删除，最终状态一律由刷新后的 Items 替换。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

const items = (...records: readonly SkillsCliListRecord[]) => groupInstalledSkillItems(records);

const rec = (over: Partial<SkillsCliListRecord> = {}): SkillsCliListRecord => ({
	name: 'pdf',
	path: '/h/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	source: 'owner/repo',
	...over
});

const listState = (installed: ReturnType<typeof items>, over: Record<string, unknown> = {}) => ({
	...createInitialSkillsViewState(),
	installed,
	...over
});

describe('Skills 逻辑实例 reducer（state/skills-view-state.ts）', () => {
	// ── 1) installed 是 Item[]，同名异源分别可选 ─────────────────────────────────
	test('B-1 installed 为 Item[]，同名异源可分别选中', () => {
		const installed = items(
			rec({source: 'owner/repo', path: '/h/.agents/skills/pdf'}),
			rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']})
		);
		expect(installed.length, '同名异源必须是两个 Item').toBe(2);

		const state = listState(installed);
		expect(filteredInstalled(state).length, '过滤视图保留两个同名 Item').toBe(2);

		const first = required(selectedInstalled(state), 'first');
		const second = required(selectedInstalled({...state, installedIndex: 1}), 'second');
		expect(first.id, 'cursor 必须能分别选中同名不同来源实例').not.toBe(second.id);
		expect(first.name, '两者同名').toBe(second.name);

		// 过滤按 name 仍匹配两条。
		expect(filteredInstalled({...state, filterText: 'pdf'}).length).toBe(2);
		expect(filteredInstalled({...state, filterText: 'zzz'}).length).toBe(0);
	});

	// ── 2) unknown 来源能力门禁 ─────────────────────────────────────────────────
	test('B-2 未知来源只可删除，已知来源保留完整能力', () => {
		const unknown = items(rec({source: undefined, sourceUrl: undefined}));
		expect(required(unknown[0], 'unknown[0]').provenance.kind).toBe('unknown');

		const state = listState(unknown);

		// Enter 不得进入可提交的管理流程。
		const managed = reduceSkillsViewState(state, {type: 'manage-inject'});
		expect(managed.mode, '未知来源不得打开可提交的 Agent 管理').not.toBe('manage-inject');
		expect(managed.errorText ?? '', '必须给出未知来源的明确原因').toMatch(/未知来源|仅支持删除/);

		// 单项更新不得进入 busy。
		const updated = reduceSkillsViewState(state, {type: 'request-update'});
		expect(updated.mode, '未知来源不得更新').not.toBe('busy');
		expect(updated.errorText ?? '', '必须给出诊断').toMatch(/\S/);

		// D 删除仍然可用。
		const removing = reduceSkillsViewState(state, {type: 'request-uninstall'});
		expect(removing.mode, '未知来源仍必须能删除').toBe('confirm-uninstall');

		// 已知来源不受影响。
		const known = listState(items(rec()));
		expect(reduceSkillsViewState(known, {type: 'manage-inject'}).mode).toBe('manage-inject');
		expect(reduceSkillsViewState(known, {type: 'request-update'}).mode).toBe('busy');
	});

	// ── 2b) 更新全部只在存在已知来源时启用 ──────────────────────────────────────
	test('B-2b 更新优先多选快照，unknown 不得单独启动', () => {
		const onlyUnknown = listState(items(rec({source: undefined})));
		expect(reduceSkillsViewState(onlyUnknown, {type: 'request-update'}).mode).not.toBe('busy');
		const mixed = items(rec(), rec({name: 'ghost', path: '/h/.agents/skills/ghost', source: undefined}));
		const picked = listState(mixed, {pickedInstalledIds: mixed.map(item => item.id)});
		const requested = reduceSkillsViewState(picked, {type: 'request-update'});
		expect(requested.mode).toBe('busy');
		expect(pendingBatchInstances(requested).map(item => item.id)).toEqual(mixed.map(item => item.id));
	});

	// ── 3) 意图快照 instance id，确认后不重查 ────────────────────────────────────
	test('B-3 Modal/确认态快照 instance id 并由 agents 派生草稿', () => {
		const installed = items(
			rec({source: 'owner/repo', path: '/h/.agents/skills/pdf'}),
			rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']})
		);
		const state = listState(installed, {installedIndex: 1});
		const target = required(selectedInstalled(state), 'target');

		const confirming = reduceSkillsViewState(state, {type: 'request-uninstall'});
		expect(confirming.mode).toBe('confirm-uninstall');
		expect(confirming.pendingBatchInstanceIds, '确认态必须快照 instance id 集合').toEqual([target.id]);
		expect(required(uninstallTargets(confirming)[0], 'uninstallTargets[0]').id, '删除目标来自批量快照，不是 cursor').toBe(target.id);

		// cursor 移动后，快照仍指向原实例。
		const moved = {...confirming, installedIndex: 0};
		expect(required(uninstallTargets(moved)[0], 'moved target').id, 'cursor 移动不得改变已确认的删除目标').toBe(target.id);

		// 管理态同样快照。
		const managing = reduceSkillsViewState(state, {type: 'manage-inject'});
		expect(managing.pendingInstanceId, '管理态必须快照 instance id').toBe(target.id);
		// 草稿由该 Item 的 agents 数组派生，不依赖列表排序位置或物理目录形态。
		expect(managing.installDraft, '草稿必须严格等于选中 Item 的 agents 投影').toEqual({
			cc: target.agents.includes('Claude Code'),
			cx: target.agents.includes('Codex'),
			pi: false
		});

		const codexItem = listState(items(rec({agents: ['Codex']})));
		expect(reduceSkillsViewState(codexItem, {type: 'manage-inject'}).installDraft, 'Codex 实例草稿为仅 Codex').toEqual({
			cc: false,
			cx: true,
			pi: false
		});

		const shared = listState(items(rec({agents: ['Claude Code', 'Codex']})));
		expect(reduceSkillsViewState(shared, {type: 'manage-inject'}).installDraft).toEqual({cc: true, cx: true, pi: false});

		// Pi 的管理状态与卡片状态都必须只由 skills list 的 agents 数组决定；
		// 即使 CLI projection path 仍指向共享根，也不能因为 Pi 使用实体目录而丢失 Pi 目标。
		const allAgents = listState(items(rec({agents: ['Claude Code', 'Codex', 'Pi']})));
		expect(
			reduceSkillsViewState(allAgents, {type: 'manage-inject'}).installDraft,
			'管理草稿必须按 agents 数组保留 Pi 目标，不得用存储根覆盖 Pi 状态'
		).toEqual({cc: true, cx: true, pi: true});
	});

	// ── 3b) .codex 实例确认仅 Codex 也不是 no-op ─────────────────────────────────
	test('B-3b .codex/Pi global 旧源确认迁移，受管根同侧为 no-op', () => {
		const codexRoot = listState(items(rec({path: '/h/.codex/skills/pdf', agents: ['Codex']})));
		const managing = reduceSkillsViewState(codexRoot, {type: 'manage-inject'});
		expect(managing.installDraft).toEqual({cc: false, cx: true, pi: false});

		const submitted = reduceSkillsViewState(managing, {type: 'request-topology-change'});
		expect(submitted.mode, '.codex 实例即使目标同侧也必须进入迁移确认').toBe('confirm-topology-change');

		// 受管根的同侧提交才是 no-op。
		const agentsRoot = listState(items(rec({path: '/h/.agents/skills/pdf', agents: ['Codex']})));
		const noop = reduceSkillsViewState(reduceSkillsViewState(agentsRoot, {type: 'manage-inject'}), {
			type: 'request-topology-change'
		});
		expect(noop.mode, '受管根同侧提交是 no-op').not.toBe('confirm-topology-change');

		// 零目标仍被阻止。
		const zero = reduceSkillsViewState(
			{...managing, installDraft: {cc: false, cx: false, pi: false}},
			{
				type: 'request-topology-change'
			}
		);
		expect(zero.mode).not.toBe('confirm-topology-change');
		expect(zero.errorText ?? '').toMatch(/至少保留一个/);

		const piRoot = listState(items(rec({path: '/h/.pi/agent/skills/pdf', agents: ['Pi']})));
		const piManaging = reduceSkillsViewState(piRoot, {type: 'manage-inject'});
		expect(piManaging.installDraft, 'Pi global-only 实例默认只进入 Pi global 独立目标').toEqual({
			cc: false,
			cx: false,
			pi: true
		});
		const piSubmitted = reduceSkillsViewState(piManaging, {type: 'request-topology-change'});
		expect(piSubmitted.mode, 'Pi global-only 实体目录保持 Pi 目标时应确认迁移为 canonical 软链接').toBe('confirm-topology-change');
		const piDisabled = reduceSkillsViewState(
			{...piManaging, installDraft: {cc: true, cx: false, pi: false}},
			{type: 'request-topology-change'}
		);
		expect(piDisabled.mode, 'Pi global-only 切换到 Claude Code 应进入独立目标确认').toBe('confirm-topology-change');
	});

	// ── 4) 搜索页来源感知 + 目标根冲突 ──────────────────────────────────────────
	test('B-4 搜索页按来源 identity 判定已安装与冲突', () => {
		const results = [
			{name: 'owner/repo@pdf', source: 'owner/repo', description: ''},
			{name: 'other/repo@pdf', source: 'other/repo', description: ''}
		];

		// 同名同来源 → 已安装不可选；同名异源 → 仍可选。
		const state = {
			...createInitialSkillsViewState(),
			mode: 'install' as const,
			results,
			installed: items(rec({source: 'https://github.com/owner/repo', path: '/h/.agents/skills/pdf'}))
		};
		const projected = searchInstallItems(state);
		expect(required(projected[0], 'projected[0]').status, '同名同来源（GitHub 等价）视为已安装').toBe('installed');
		expect(required(projected[0], 'projected[0]').selectable).toBe(false);
		expect(required(projected[1], 'projected[1]').selectable, '同名不同来源仍可选择').toBe(true);
		expect(required(projected[1], 'projected[1]').status).toMatch(/name-occupied|available|source-replacement/);

		// 未知来源已装实例不得让异源搜索项显示为已安装。
		const unknownInstalled = {...state, installed: items(rec({source: undefined, path: '/h/.agents/skills/pdf'}))};
		const unknownProjected = searchInstallItems(unknownInstalled);
		expect(required(unknownProjected[0], 'unknownProjected[0]').status, '未知来源不得与任何搜索来源判为同源已安装').not.toBe(
			'installed'
		);

		// 同批次仍不允许两个异源同名同时选中。
		const bothPicked = reduceSkillsViewState({...state, resultIndex: 1}, {type: 'toggle-result'});
		const afterFirst = reduceSkillsViewState({...bothPicked, resultIndex: 0}, {type: 'toggle-result'});
		const conflicting = searchInstallItems(afterFirst).filter(i => i.selected);
		expect(conflicting.length <= 1, '同一批次不得选中两个异源同名 Skill').toBe(true);
	});

	// ── 5) 无 name 级乐观删除，最终状态由刷新替换 ────────────────────────────────
	test('B-5 无 name 级乐观删除，最终状态由完整刷新替换', () => {
		const installed = items(
			rec({source: 'owner/repo', path: '/h/.agents/skills/pdf'}),
			rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']})
		);
		const busy = {
			...listState(installed, {installedIndex: 0}),
			mode: 'busy' as const,
			busyAction: 'uninstall' as const,
			busyReturnMode: 'list' as const
		};

		// lifecycle-reconciled 用刷新结果整体替换，同名其它来源由 CLI 事实决定是否保留。
		const remaining = items(rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']}));
		const done = reduceSkillsViewState(busy, {type: 'lifecycle-reconciled', installed: remaining});
		expect(done.installed.length, '最终列表来自刷新结果').toBe(1);
		const doneFirst = required(done.installed[0], 'done.installed[0]');
		expect(doneFirst.provenance.kind === 'known' ? doneFirst.provenance.identity : undefined, '保留的是同名其它来源实例').toBe(
			'github:other/repo'
		);
		expect(done.mode).toBe('list');
		expect(done.pendingInstanceId, '生命周期结束必须清理快照').toBe(undefined);
		expect(done.pendingBatchInstanceIds, '生命周期结束必须清理批量快照').toEqual([]);

		// reducer 不得暴露按 name 过滤的乐观删除动作、不得依赖物理 storage 分类或 inspection 拓扑：
		// 静态守卫已迁往 scripts/verify-view-architecture.mjs 的 P1-G3 段。
	});
});
