import assert from 'node:assert/strict';
import {groupInstalledSkillItems} from '../src/core/skills-installed.ts';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	filteredInstalled,
	selectedInstalled,
	searchInstallItems,
	pendingInstallResults,
	uninstallTargets,
	pendingBatchInstances
} from '../src/state/skills-view-state.ts';

// Checkpoint B 门禁（task 07-28-skills-multi-source-topology / design §6-§7）：
// reducer 的已装身份是 InstalledSkillItem.id，不再是 name。覆盖：
//   1) installed 为 Item[]，同名多来源各自成行且 cursor 可分别选中；
//   2) unknown 来源不能进入可提交的 Agent 管理，也不能单项更新；
//   3) 删除/管理意图快照 instance id，确认后不按 name 或 cursor 重查；
//   4) 搜索页已安装判断按来源 identity，冲突只在目标根发生；
//   5) 没有 name 级乐观删除，最终状态一律由刷新后的 Items 替换。

const items = (...records) => groupInstalledSkillItems(records);

const rec = (over = {}) => ({
	name: 'pdf',
	path: '/h/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	source: 'owner/repo',
	...over
});

const listState = (installed, over = {}) => ({
	...createInitialSkillsViewState(),
	installed,
	...over
});

// ── 1) installed 是 Item[]，同名异源分别可选 ─────────────────────────────────
{
	const installed = items(
		rec({source: 'owner/repo', path: '/h/.agents/skills/pdf'}),
		rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']})
	);
	assert.equal(installed.length, 2, '同名异源必须是两个 Item');

	const state = listState(installed);
	assert.equal(filteredInstalled(state).length, 2, '过滤视图保留两个同名 Item');

	const first = selectedInstalled(state);
	const second = selectedInstalled({...state, installedIndex: 1});
	assert.notEqual(first.id, second.id, 'cursor 必须能分别选中同名不同来源实例');
	assert.equal(first.name, second.name, '两者同名');

	// 过滤按 name 仍匹配两条。
	assert.equal(filteredInstalled({...state, filterText: 'pdf'}).length, 2);
	assert.equal(filteredInstalled({...state, filterText: 'zzz'}).length, 0);

	console.log('[PASS] B-1 installed 为 Item[]，同名异源可分别选中');
}

// ── 2) unknown 来源能力门禁 ─────────────────────────────────────────────────
{
	const unknown = items(rec({source: undefined, sourceUrl: undefined}));
	assert.equal(unknown[0].provenance.kind, 'unknown');

	const state = listState(unknown);

	// Enter 不得进入可提交的管理流程。
	const managed = reduceSkillsViewState(state, {type: 'manage-inject'});
	assert.notEqual(managed.mode, 'manage-inject', '未知来源不得打开可提交的 Agent 管理');
	assert.match(managed.errorText ?? '', /未知来源|仅支持删除/, '必须给出未知来源的明确原因');

	// 单项更新不得进入 busy。
	const updated = reduceSkillsViewState(state, {type: 'request-update'});
	assert.notEqual(updated.mode, 'busy', '未知来源不得更新');
	assert.match(updated.errorText ?? '', /\S/, '必须给出诊断');

	// D 删除仍然可用。
	const removing = reduceSkillsViewState(state, {type: 'request-uninstall'});
	assert.equal(removing.mode, 'confirm-uninstall', '未知来源仍必须能删除');

	// 已知来源不受影响。
	const known = listState(items(rec()));
	assert.equal(reduceSkillsViewState(known, {type: 'manage-inject'}).mode, 'manage-inject');
	assert.equal(reduceSkillsViewState(known, {type: 'request-update'}).mode, 'busy');

	console.log('[PASS] B-2 未知来源只可删除，已知来源保留完整能力');
}

// ── 2b) 更新全部只在存在已知来源时启用 ──────────────────────────────────────
{
	const onlyUnknown = listState(items(rec({source: undefined})));
	assert.notEqual(reduceSkillsViewState(onlyUnknown, {type: 'request-update'}).mode, 'busy');
	const mixed = items(rec(), rec({name: 'ghost', path: '/h/.agents/skills/ghost', source: undefined}));
	const picked = listState(mixed, {pickedInstalledIds: mixed.map(item => item.id)});
	const requested = reduceSkillsViewState(picked, {type: 'request-update'});
	assert.equal(requested.mode, 'busy');
	assert.deepEqual(pendingBatchInstances(requested).map(item => item.id), mixed.map(item => item.id));

	console.log('[PASS] B-2b 更新优先多选快照，unknown 不得单独启动');
}

// ── 3) 意图快照 instance id，确认后不重查 ────────────────────────────────────
{
	const installed = items(
		rec({source: 'owner/repo', path: '/h/.agents/skills/pdf'}),
		rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']})
	);
	const state = listState(installed, {installedIndex: 1});
	const target = selectedInstalled(state);

	const confirming = reduceSkillsViewState(state, {type: 'request-uninstall'});
	assert.equal(confirming.mode, 'confirm-uninstall');
	assert.deepEqual(confirming.pendingBatchInstanceIds, [target.id], '确认态必须快照 instance id 集合');
	assert.equal(uninstallTargets(confirming)[0].id, target.id, '删除目标来自批量快照，不是 cursor');

	// cursor 移动后，快照仍指向原实例。
	const moved = {...confirming, installedIndex: 0};
	assert.equal(uninstallTargets(moved)[0].id, target.id, 'cursor 移动不得改变已确认的删除目标');

	// 管理态同样快照。
	const managing = reduceSkillsViewState(state, {type: 'manage-inject'});
	assert.equal(managing.pendingInstanceId, target.id, '管理态必须快照 instance id');
	// 草稿只由该 Item 的 agents 派生，不依赖列表排序位置。
	assert.deepEqual(
		managing.installDraft,
		{cc: target.agents.includes('Claude Code'), cx: target.agents.includes('Codex')},
		'草稿必须严格等于选中 Item 的 agents 投影'
	);

	const codexItem = listState(items(rec({agents: ['Codex']})));
	assert.deepEqual(
		reduceSkillsViewState(codexItem, {type: 'manage-inject'}).installDraft,
		{cc: false, cx: true},
		'Codex 实例草稿为仅 Codex'
	);

	const shared = listState(items(rec({agents: ['Claude Code', 'Codex']})));
	assert.deepEqual(reduceSkillsViewState(shared, {type: 'manage-inject'}).installDraft, {cc: true, cx: true});

	console.log('[PASS] B-3 Modal/确认态快照 instance id 并由 agents 派生草稿');
}

// ── 3b) .codex 实例确认仅 Codex 也不是 no-op ─────────────────────────────────
{
	const codexRoot = listState(items(rec({path: '/h/.codex/skills/pdf', agents: ['Codex']})));
	const managing = reduceSkillsViewState(codexRoot, {type: 'manage-inject'});
	assert.deepEqual(managing.installDraft, {cc: false, cx: true});

	const submitted = reduceSkillsViewState(managing, {type: 'request-topology-change'});
	assert.equal(submitted.mode, 'confirm-topology-change', '.codex 实例即使目标同侧也必须进入迁移确认');

	// 受管根的同侧提交才是 no-op。
	const agentsRoot = listState(items(rec({path: '/h/.agents/skills/pdf', agents: ['Codex']})));
	const noop = reduceSkillsViewState(reduceSkillsViewState(agentsRoot, {type: 'manage-inject'}), {
		type: 'request-topology-change'
	});
	assert.notEqual(noop.mode, 'confirm-topology-change', '受管根同侧提交是 no-op');

	// 零目标仍被阻止。
	const zero = reduceSkillsViewState({...managing, installDraft: {cc: false, cx: false}}, {type: 'request-topology-change'});
	assert.notEqual(zero.mode, 'confirm-topology-change');
	assert.match(zero.errorText ?? '', /至少保留一个/);

	console.log('[PASS] B-3b .codex 同侧确认仍触发迁移，受管根同侧为 no-op');
}

// ── 4) 搜索页来源感知 + 目标根冲突 ──────────────────────────────────────────
{
	const results = [
		{name: 'owner/repo@pdf', source: 'owner/repo', description: ''},
		{name: 'other/repo@pdf', source: 'other/repo', description: ''}
	];

	// 同名同来源 → 已安装不可选；同名异源 → 仍可选。
	const state = {
		...createInitialSkillsViewState(),
		mode: 'install',
		results,
		installed: items(rec({source: 'https://github.com/owner/repo', path: '/h/.agents/skills/pdf'}))
	};
	const projected = searchInstallItems(state);
	assert.equal(projected[0].status, 'installed', '同名同来源（GitHub 等价）视为已安装');
	assert.equal(projected[0].selectable, false);
	assert.equal(projected[1].selectable, true, '同名不同来源仍可选择');
	assert.match(projected[1].status, /name-occupied|available|source-replacement/);

	// 未知来源已装实例不得让异源搜索项显示为已安装。
	const unknownInstalled = {...state, installed: items(rec({source: undefined, path: '/h/.agents/skills/pdf'}))};
	const unknownProjected = searchInstallItems(unknownInstalled);
	assert.notEqual(unknownProjected[0].status, 'installed', '未知来源不得与任何搜索来源判为同源已安装');

	// 同批次仍不允许两个异源同名同时选中。
	const bothPicked = reduceSkillsViewState({...state, resultIndex: 1}, {type: 'toggle-result'});
	const afterFirst = reduceSkillsViewState({...bothPicked, resultIndex: 0}, {type: 'toggle-result'});
	const conflicting = searchInstallItems(afterFirst).filter(i => i.selected);
	assert.ok(conflicting.length <= 1, '同一批次不得选中两个异源同名 Skill');

	console.log('[PASS] B-4 搜索页按来源 identity 判定已安装与冲突');
}

// ── 5) 无 name 级乐观删除，最终状态由刷新替换 ────────────────────────────────
{
	const installed = items(
		rec({source: 'owner/repo', path: '/h/.agents/skills/pdf'}),
		rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']})
	);
	const busy = {...listState(installed, {installedIndex: 0}), mode: 'busy', busyAction: 'uninstall', busyReturnMode: 'list'};

	// lifecycle-reconciled 用刷新结果整体替换，同名其它来源由 CLI 事实决定是否保留。
	const remaining = items(rec({source: 'other/repo', path: '/h/.claude/skills/pdf', agents: ['Claude Code']}));
	const done = reduceSkillsViewState(busy, {type: 'lifecycle-reconciled', installed: remaining});
	assert.equal(done.installed.length, 1, '最终列表来自刷新结果');
	assert.equal(done.installed[0].provenance.identity, 'github:other/repo', '保留的是同名其它来源实例');
	assert.equal(done.mode, 'list');
	assert.equal(done.pendingInstanceId, undefined, '生命周期结束必须清理快照');
	assert.deepEqual(done.pendingBatchInstanceIds, [], '生命周期结束必须清理批量快照');

	// reducer 不得暴露按 name 过滤的乐观删除动作。
	const source = await import('node:fs').then(fs =>
		fs.readFileSync(new URL('../src/state/skills-view-state.ts', import.meta.url), 'utf8')
	);
	assert.doesNotMatch(source, /action-uninstall-done/, '不得保留 name 级乐观删除 action');
	assert.doesNotMatch(source, /storage\?\.kind/, 'reducer 不得再依赖物理 storage 分类');
	assert.doesNotMatch(source, /topologyOfInspection/, 'reducer 不得再由物理 inspection 推导拓扑');

	console.log('[PASS] B-5 无 name 级乐观删除，最终状态由完整刷新替换');
}

console.log('[PASS] Skills 逻辑实例 reducer 门禁全部通过');
