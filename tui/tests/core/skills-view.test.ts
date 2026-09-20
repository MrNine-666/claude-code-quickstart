import {describe, expect, test} from 'bun:test';
import {
	groupByRepo,
	listRepoSkills,
	parseSkillsFindOutput,
	parseSkillsListOutput,
	searchSkillIdentity,
	searchSkills
} from '../../src/core/skills.js';
import {
	groupInstalledSkillItems,
	normalizeSkillSourceIdentity,
	type InstalledSkillItem,
	type SkillProvenance,
	type SkillsStorageRoot
} from '../../src/core/skills-installed.js';
import type {SkillStorageInspection, SkillStorageKind} from '../../src/core/skills-storage.js';
import {skillNameFromSearchResult} from '../../src/services/skills-service.js';
import {
	createInitialSkillsViewState,
	displaySkillName,
	filteredInstalled,
	groupInstalledBySource,
	pendingBatchInstances,
	pendingInstallResults,
	pendingSourceReplacements,
	reduceSkillsViewState,
	searchInstallItems,
	selectedInstalled,
	selectedOrCurrentInstalled,
	selectedResult,
	selectedSearchResults,
	shouldRunSearch,
	skillsHomeRows,
	uninstallTargets,
	type SkillsViewAction,
	type SkillsViewState
} from '../../src/state/skills-view-state.js';

// 载体迁移（P3a）：原 scripts/verify-skills-view.mjs 的 core / view-state 段（181 条静态断言）迁入。
// owner 模块：core/skills.ts（parser/搜索/分组）+ state/skills-view-state.ts（视图状态机）。
//
// Phase 5 Skills TUI 门禁：parser fixture（7.4 / --list）、不依赖 catalogue（7.8）、
// 异步检测状态机 7.10 已按 owner 拆到 tests/core/skills-detection.test.ts，
// action/service 段（7.9 / 8.1-8.5 / 17-19.4 / 批量安装）拆到 tests/core/skills-actions.test.ts。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

// 已安装 fixture 使用逻辑实例契约（task 07-28）：身份为 (name, sourceIdentity)，
// Agent 侧只由 agents 派生，存储位置只由 path 派生。
function sharedRow(name: string, over: {claude?: boolean; codex?: boolean; path?: string; source?: string} = {}): InstalledSkillItem {
	const {claude = true, codex = true, path} = over;
	// 显式传 `source: undefined` 表示未知来源；ES 默认参数会激活默认值，故用 `in` 判定。
	const source = 'source' in over ? over.source : `own/${name}`;
	const agents = [...(claude ? ['Claude Code'] : []), ...(codex ? ['Codex'] : [])];
	const resolvedPath = path ?? `/home/.agents/skills/${name}`;
	const root: SkillsStorageRoot = resolvedPath.includes('.claude') ? 'claude' : resolvedPath.includes('.codex') ? 'codex' : 'agents';
	const identity = normalizeSkillSourceIdentity(source);
	const provenance: SkillProvenance = identity
		? {kind: 'known', identity, source: source ?? '', installSource: source ?? ''}
		: {kind: 'unknown'};
	const known = provenance.kind === 'known';
	return {
		id: JSON.stringify(known ? ['known', name, identity] : ['unknown', name, resolvedPath]),
		name,
		provenance,
		agents,
		projections: [{path: resolvedPath, root, scope: 'global', agents}],
		capabilities: {update: known, manageAgents: known, migrate: known, delete: true}
	};
}

function withStorage(item: InstalledSkillItem, inspection: SkillStorageInspection): InstalledSkillItem {
	return {...item, storage: inspection} as InstalledSkillItem;
}

describe('Skills parser / 搜索 / 分组（core/skills.ts）', () => {
	// ── 7.4a skills find parser fixture：成功 / 无结果 / 不可解析 / 命令不可用 ──────
	test('7.4a skills find parser fixture（成功/无结果/不可解析/命令不可用）', () => {
		// 成功（JSON）
		const ok = parseSkillsFindOutput(JSON.stringify([{name: 'a-skill', source: 'org/a', description: 'A'}]));
		expect(ok?.length).toBe(1);
		expect(ok?.[0]?.name).toBe('a-skill');
		// P5e 去重补迁（verify-core-functions.mjs）：JSON 来源的 installCount 必须解析保留。
		const withCount = parseSkillsFindOutput(
			JSON.stringify([{name: 'foo-skill', source: 'org/repo', description: 'desc', installCount: 5}])
		);
		expect(withCount?.[0]?.installCount).toBe(5);

		// 成功（表格）
		const table = parseSkillsFindOutput('a-skill  org/a  desc one\nb-skill  org/b  desc two');
		expect(table?.length).toBe(2);
		expect(table?.[1]?.name).toBe('b-skill');

		// 成功（真实块状格式：name 与 install count 单空格分隔，URL 续行以 └ 开头）
		const block = parseSkillsFindOutput(
			'github/awesome-copilot@pdftk-server 9.6K installs\n└ https://skills.sh/github/awesome-copilot/pdftk-server\n\nopenai/skills@pdf 8K installs\n└ https://skills.sh/openai/skills/pdf'
		);
		expect(block?.length, '真实块状格式应解析出全部条目').toBe(2);
		expect(block?.[0]?.name).toBe('github/awesome-copilot@pdftk-server');
		expect(block?.[1]?.name).toBe('openai/skills@pdf');

		// 无结果（有输出但无可解析条目 → 空数组，区别于 null）
		const empty = parseSkillsFindOutput('未找到匹配的技能。');
		expect(empty).toEqual([]);

		// 不可解析 / 完全无输出 → null
		expect(parseSkillsFindOutput('')).toBe(null);

		// 命令不可用（stderr 含 not recognized，stdout 空）→ null
		const unavailable = parseSkillsFindOutput('', "'skills' is not recognized as an internal or external command");
		expect(unavailable).toBe(null);
	});

	// ── 7.4b skills add <repo> --list parser fixture（需求③）：多 skill / 单 skill / 命令不可用 / 空 ──
	test('7.4b skills add --list parser fixture（多 skill/单 skill/命令不可用/空）', () => {
		// 多 skill 块状格式（实测 obra/superpowers 形态，含多行 desc）
		const multi = parseSkillsListOutput(
			[
				'◇  Available Skills',
				'│',
				'│    brainstorming',
				'│',
				'│      You MUST use this before any creative work. Explores intent.',
				'│',
				'│    dispatching-parallel-agents',
				'│',
				'│      Use when facing 2+ independent tasks.',
				'│',
				'└  Use --skill <name> to install specific skills'
			].join('\n')
		);
		expect(multi?.length, '应解析出 2 个 skill').toBe(2);
		expect(multi?.[0]?.name).toBe('brainstorming');
		expect(multi?.[0]?.description?.includes('creative work'), 'description 应含自然语言').toBe(true);
		expect(multi?.[1]?.name, '连字符 name 为单 token').toBe('dispatching-parallel-agents');
		expect(multi?.[1]?.description?.includes('independent tasks')).toBe(true);

		// 单 skill
		const single = parseSkillsListOutput(
			['◇  Available Skills', '│', '│    writing-guidelines', '│', '│      Review docs/prose.', '│', '└  Use --skill'].join('\n')
		);
		expect(single?.length).toBe(1);
		expect(single?.[0]?.name).toBe('writing-guidelines');

		// 无 Available Skills 标题 + 命令不可用 → null
		expect(parseSkillsListOutput('', "'skills' is not recognized"), '命令不可用应返回 null').toBe(null);

		// 有标题但无 skill 块 → 空数组
		const emptyRegion = parseSkillsListOutput('◇  Available Skills\n│\n└  Use --skill');
		expect(emptyRegion, '有标题无 skill 返回空数组').toEqual([]);
	});

	// ── 7.4c groupByRepo 按 owner/repo 去重 + hitCount + installs 求和 ─────────────
	test('7.4c groupByRepo 按 owner/repo 去重 + hitCount + installs 求和', () => {
		const groups = groupByRepo([
			{name: 'org/a@skill1', source: 'org/a', description: '', installCount: 100},
			{name: 'org/a@skill2', source: 'org/a', description: '', installCount: 50},
			{name: 'org/b@skill3', source: 'org/b', description: ''}
		]);
		expect(groups.length, '两个 repo 去重').toBe(2);
		const a = required(
			groups.find(group => group.repo === 'org/a'),
			'group org/a'
		);
		expect(a.hitCount, 'org/a 命中 2 个 skill').toBe(2);
		expect(a.totalInstalls, 'installs 求和').toBe(150);
		const b = required(
			groups.find(group => group.repo === 'org/b'),
			'group org/b'
		);
		expect(b.hitCount).toBe(1);
		expect(b.totalInstalls, '无 installCount 时 totalInstalls undefined').toBe(undefined);

		// source 缺失时从 name 的 @ 前缀解析
		const fromName = groupByRepo([{name: 'org/c@x', source: '', description: ''}]);
		expect(required(fromName[0], 'fromName[0]').repo, 'source 空时从 name 解析 repo').toBe('org/c');
	});

	// ── 7.8 搜索由 skills find 驱动，不依赖 catalogue，空查询不触发 CLI ────────────
	test('7.8 搜索由 skills find 驱动，空查询不触发 CLI', async () => {
		const fakeExec = async (_cmd: string, args: readonly string[]) => {
			expect(args.includes('find'), '搜索必须调用 skills find').toBe(true);
			return {code: 0, stdout: JSON.stringify([{name: 'found-by-find', source: 'x/y', description: 'from find'}]), stderr: ''};
		};

		const outcome = await searchSkills('anything', fakeExec);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error('搜索应成功');
		expect(required(outcome.results[0], 'outcome.results[0]').name).toBe('found-by-find');

		// 空查询不触发 CLI
		let called = false;
		const guardExec = async () => {
			called = true;
			return {code: 0, stdout: '', stderr: ''};
		};
		const emptyOutcome = await searchSkills('   ', guardExec);
		expect(emptyOutcome.ok).toBe(false);
		expect(called).toBe(false);
	});

	// ── 7.8b listRepoSkills 由 skills add --list 驱动，空 repo 不触发 CLI ─────────
	test('7.8b listRepoSkills 由 skills add --list 驱动，空 repo 不触发 CLI', async () => {
		const fakeExec = async (_cmd: string, args: readonly string[]) => {
			expect(args.includes('add'), 'listRepoSkills 必须调用 skills add').toBe(true);
			expect(args.includes('--list'), '必须带 --list').toBe(true);
			return {code: 0, stdout: '◇  Available Skills\n│\n│    skill-x\n│\n│      desc x\n', stderr: ''};
		};
		const outcome = await listRepoSkills('org/repo', fakeExec);
		expect(outcome.ok).toBe(true);
		if (!outcome.ok) throw new Error('listRepoSkills 应成功');
		expect(required(outcome.skills[0], 'outcome.skills[0]').name).toBe('skill-x');

		// 空 repo 不触发 CLI
		let called = false;
		const guardExec = async () => {
			called = true;
			return {code: 0, stdout: '', stderr: ''};
		};
		const empty = await listRepoSkills('  ', guardExec);
		expect(empty.ok).toBe(false);
		expect(called).toBe(false);
	});
});

describe('Skills 视图状态机（state/skills-view-state.ts）', () => {
	// ── 视图状态机有界性 + 共享投影 + 安装目标/管理安装 Modal 不变量 ──────────────
	test('Skills 视图状态机有界 + 新安装 Codex 必选 + 存量 C/X/B 管理不变量', () => {
		const [projected] = groupInstalledSkillItems([
			{
				name: 'multi-agent',
				path: '/home/.agents/skills/multi-agent',
				scope: 'global',
				agents: ['Claude Code', 'Codex', 'Cursor', 'Cline'],
				source: 'own/multi'
			}
		]);
		expect(required(projected, 'projected').agents).toEqual(['Claude Code', 'Codex', 'Cursor', 'Cline']);

		const actions: SkillsViewAction[] = [
			{type: 'nav-up'},
			{type: 'nav-down'},
			{type: 'toggle-home-layout'},
			{type: 'toggle-all-source-groups'},
			{type: 'toggle-installed-selection'},
			{type: 'select-all-installed'},
			{type: 'filter-input', value: 'a'},
			{type: 'filter-focus'},
			{type: 'filter-blur'},
			{type: 'filter-clear'},
			{type: 'open-install'},
			{type: 'query-input', value: 'x'},
			{type: 'query-focus'},
			{type: 'query-blur'},
			{type: 'submit-search'},
			{type: 'search-done', results: [{name: 'org/a@r1', source: 'org/a', description: 'd'}]},
			{type: 'search-failed', error: 'boom', rawSummary: 's'},
			{type: 'select-skill'},
			{type: 'manage-inject'},
			{type: 'request-topology-change'},
			{type: 'install-target-nav', delta: 1},
			{type: 'install-target-toggle'},
			{type: 'request-update'},
			{type: 'request-uninstall'},
			{type: 'confirm'},
			{type: 'cancel'},
			{type: 'progress', message: 'm'},
			{type: 'action-done'},
			{type: 'action-failed', error: 'boom'}
		];

		let state = createInitialSkillsViewState();
		state = reduceSkillsViewState(state, {
			type: 'installed-loaded',
			installed: [sharedRow('apple'), sharedRow('banana')]
		});

		const modes = new Set([
			'list',
			'install',
			'select-install-target',
			'manage-inject',
			'confirm-topology-change',
			'confirm-uninstall',
			'busy'
		]);
		for (let i = 0; i < 600; i++) {
			const action = required(actions[(i * 13 + 5) % actions.length], 'action');
			state = reduceSkillsViewState(state, action);
			expect(modes.has(state.mode), `未知 mode: ${state.mode}`).toBe(true);
			expect(
				state.installedIndex >= 0 && state.installedIndex < Math.max(filteredInstalled(state).length, 1),
				`installedIndex 越界: ${state.installedIndex}`
			).toBe(true);
			expect(
				state.resultIndex >= 0 && state.resultIndex < Math.max(state.results.length, 1),
				`resultIndex 越界: ${state.resultIndex}`
			).toBe(true);
			expect(state.targetIndex >= 0 && state.targetIndex < 3, `targetIndex 越界: ${state.targetIndex}`).toBe(true);
			if (state.mode === 'select-install-target') {
				expect(state.installDraft.cx, '新安装目标的 Codex 仍只读恒勾').toBe(true);
			}
			expect(state.progress.length <= 8, `progress 未裁剪: ${state.progress.length}`).toBe(true);
		}

		// 安装全链路：open-install → search → select-skill → select-install-target → confirm → busy → done
		const base = reduceSkillsViewState(createInitialSkillsViewState(), {
			type: 'installed-loaded',
			installed: [sharedRow('apple')]
		});
		const installPage = reduceSkillsViewState(base, {type: 'open-install'});
		expect(installPage.mode).toBe('install');
		expect(installPage.queryFocused, '进入安装页默认聚焦搜索框').toBe(true);
		expect(shouldRunSearch(installPage)).toBe(false);
		const submitEmpty = reduceSkillsViewState(installPage, {type: 'submit-search'});
		expect(submitEmpty.searching, '空查询提交不进入 searching').toBe(false);
		expect(submitEmpty.errorText, '空查询提交应提示').toBeTruthy();

		const searched = reduceSkillsViewState(installPage, {
			type: 'search-done',
			results: [
				{name: 'org/a@x', source: 'org/a', description: ''},
				{name: 'org/a@y', source: 'org/a', description: ''},
				{name: 'org/b@z', source: 'org/b', description: ''}
			]
		});
		expect(searched.results.length, '扁平 skill 列表保留 3 个（不再按 repo 去重）').toBe(3);
		expect(searched.queryFocused, '搜索完成后焦点切到 skill 列表').toBe(false);
		expect(selectedResult(searched)?.name, '默认光标首个 skill').toBe('org/a@x');
		const resultLoopUp = reduceSkillsViewState(searched, {type: 'nav-up'});
		expect(selectedResult(resultLoopUp)?.name, '安装结果列表首项向上应 loop 到末项').toBe('org/b@z');
		const resultLoopDown = reduceSkillsViewState(resultLoopUp, {type: 'nav-down'});
		expect(selectedResult(resultLoopDown)?.name, '安装结果列表末项向下应 loop 回首项').toBe('org/a@x');

		// select-skill：无光标项拦截 / 有项进 select-install-target（草稿三侧勾选）
		const emptyResults = reduceSkillsViewState(installPage, {type: 'search-done', results: []});
		const emptySelect = reduceSkillsViewState(emptyResults, {type: 'select-skill'});
		expect(emptySelect.mode, '无可选 skill 时 select-skill 留在 install').toBe('install');
		expect(emptySelect.errorText, '无可选 skill 应提示').toBeTruthy();
		const selected = reduceSkillsViewState(searched, {type: 'select-skill'});
		expect(selected.mode, 'select-skill 进安装目标 Modal').toBe('select-install-target');
		expect(selected.installDraft.cc, '安装草稿默认 Claude Code 勾选').toBe(true);
		expect(selected.installDraft.cx, '安装草稿默认 Codex 勾选').toBe(true);
		expect(selected.installDraft.pi, '安装草稿默认勾选 Pi 全局原生目录').toBe(true);
		expect(selectedResult(selected)?.name, '安装目标仍指向当前光标 skill').toBe('org/a@x');

		// 安装目标 Modal：C/X shared install projection 默认恒勾，Pi 默认勾选但可取消。
		const navToCodex = reduceSkillsViewState(selected, {type: 'install-target-nav', delta: 1});
		expect(navToCodex.targetIndex, 'nav 到 Codex 侧').toBe(1);
		const toggleCodex = reduceSkillsViewState(navToCodex, {type: 'install-target-toggle'});
		expect(toggleCodex.installDraft.cx, '空格切 Codex 为 no-op（恒 true）').toBe(true);
		const navToPi = reduceSkillsViewState(navToCodex, {type: 'install-target-nav', delta: 1});
		expect(navToPi.targetIndex, 'nav 到 Pi 目标').toBe(2);
		const togglePi = reduceSkillsViewState(navToPi, {type: 'install-target-toggle'});
		expect(togglePi.installDraft.pi, '空格可取消默认勾选的 Pi 目标').toBe(false);
		const navLoop = reduceSkillsViewState(navToPi, {type: 'install-target-nav', delta: 1});
		expect(navLoop.targetIndex, 'nav 首尾相接 loop 回 Claude Code').toBe(0);
		const toggleClaudeOff = reduceSkillsViewState(navLoop, {type: 'install-target-toggle'});
		expect(toggleClaudeOff.installDraft.cc, '空格切 Claude Code 生效（可取消）').toBe(false);
		expect(toggleClaudeOff.installDraft.cx, '切 Claude Code 不影响 Codex 恒勾').toBe(true);

		// confirm → busy(install) / cancel → 回安装页（保留搜索结果）
		const installBusy = reduceSkillsViewState(selected, {type: 'confirm'});
		expect(installBusy.mode, 'select-install-target confirm 进 busy').toBe('busy');
		expect(installBusy.busyAction, 'busyAction=install').toBe('install');
		const backToInstall = reduceSkillsViewState(selected, {type: 'cancel'});
		expect(backToInstall.mode, '安装目标 Modal cancel 回安装页').toBe('install');
		expect(backToInstall.results.length, 'cancel 保留搜索结果').toBe(3);

		// 安装页 cancel 回列表页（放弃搜索词/结果）
		const backToList = reduceSkillsViewState(backToInstall, {type: 'cancel'});
		expect(backToList.mode, '安装页 cancel 回列表页').toBe('list');
		expect(backToList.queryFocused, '回列表页 queryFocused 复位').toBe(false);

		// 已安装页默认平铺单列；分组只是展示投影，不改写 Item identity。
		const installedItems = [
			sharedRow('apple', {source: 'own/a'}),
			sharedRow('banana', {source: 'own/a'}),
			sharedRow('cherry', {source: 'own/b'}),
			sharedRow('unknown-one', {source: undefined, path: '/home/.agents/skills/unknown-one'}),
			sharedRow('unknown-two', {source: undefined, path: '/home/.codex/skills/unknown-two'})
		];
		const flat = reduceSkillsViewState(createInitialSkillsViewState(), {
			type: 'installed-loaded',
			installed: installedItems
		});
		expect(flat.homeLayout, '首次加载必须默认平铺').toBe('flat');
		expect(skillsHomeRows(flat).length).toBe(installedItems.length);
		expect(
			skillsHomeRows(flat).every(row => row.kind === 'skill'),
			'平铺投影不应混入组标题'
		).toBe(true);
		const grouped = reduceSkillsViewState(flat, {type: 'toggle-home-layout'});
		expect(grouped.homeLayout).toBe('grouped');
		const groups = groupInstalledBySource(grouped.installed);
		expect(groups.length, '两个已知来源加一个未知来源展示组').toBe(3);
		const unknownGroup = groups.find(group => group.key === 'unknown');
		expect(unknownGroup?.label).toBe('未知来源');
		expect(unknownGroup?.items.length, '所有 unknown Item 应进入同一展示组').toBe(2);
		expect(unknownGroup?.items[0]?.id, '未知来源展示合组不得合并路径限定 identity').not.toBe(unknownGroup?.items[1]?.id);
		expect(skillsHomeRows(grouped).filter(row => row.kind === 'group').length).toBe(3);
		const bananaIndex = skillsHomeRows(grouped).findIndex(row => row.kind === 'skill' && row.item.name === 'banana');
		const allCollapsed = reduceSkillsViewState({...grouped, installedIndex: bananaIndex}, {type: 'toggle-all-source-groups'});
		expect(new Set(allCollapsed.collapsedSourceKeys), 'e 应收起全部来源组').toEqual(new Set(groups.map(group => group.key)));
		expect(
			skillsHomeRows(allCollapsed).every(row => row.kind === 'group'),
			'全部收起后只保留组标题'
		).toBe(true);
		const collapsedAnchor = skillsHomeRows(allCollapsed)[allCollapsed.installedIndex];
		expect(collapsedAnchor?.kind, '收起全部后光标应落在原 Skill 所属组').toBe('group');
		expect(collapsedAnchor?.kind === 'group' && collapsedAnchor.group.items.some(item => item.name === 'banana')).toBe(true);
		const allExpanded = reduceSkillsViewState(allCollapsed, {type: 'toggle-all-source-groups'});
		expect(allExpanded.collapsedSourceKeys.length, '全部已收起时再次按 e 应全部展开').toBe(0);
		const filteredCollapse = reduceSkillsViewState({...grouped, filterText: 'unknown'}, {type: 'toggle-all-source-groups'});
		expect(new Set(filteredCollapse.collapsedSourceKeys), '过滤不得缩窄全部收起范围').toEqual(new Set(groups.map(group => group.key)));
		expect(reduceSkillsViewState(flat, {type: 'toggle-all-source-groups'}), '平铺模式下 e 必须 no-op').toBe(flat);

		const unknownHeaderIndex = skillsHomeRows(grouped).findIndex(row => row.kind === 'group' && row.group.key === 'unknown');
		const collapsed = reduceSkillsViewState({...grouped, installedIndex: unknownHeaderIndex}, {type: 'toggle-source-group'});
		expect(collapsed.collapsedSourceKeys.includes('unknown')).toBe(true);
		expect(skillsHomeRows(collapsed).some(row => row.kind === 'skill' && row.item.name.startsWith('unknown-'))).toBe(false);
		const selectedWhileCollapsed = reduceSkillsViewState(
			{...collapsed, filterText: 'unknown', installedIndex: 0},
			{
				type: 'select-all-installed'
			}
		);
		expect(new Set(selectedWhileCollapsed.pickedInstalledIds), '收缩组中的匹配 Item 仍必须进入 a 的当前过滤范围').toEqual(
			new Set(required(unknownGroup, 'unknownGroup').items.map(item => item.id))
		);
		const deselectedWhileCollapsed = reduceSkillsViewState(selectedWhileCollapsed, {type: 'select-all-installed'});
		expect(deselectedWhileCollapsed.pickedInstalledIds.length, '当前过滤范围已全选时 a 应只取消该范围').toBe(0);

		const picked = {
			...flat,
			pickedInstalledIds: [required(installedItems[0], 'installedItems[0]').id, required(installedItems[3], 'installedItems[3]').id]
		};
		expect(
			selectedOrCurrentInstalled(picked).map(item => item.id),
			'批量动作应优先显式多选'
		).toEqual(picked.pickedInstalledIds);
		const requestedUpdate = reduceSkillsViewState(picked, {type: 'request-update'});
		expect(requestedUpdate.mode).toBe('busy');
		expect(
			pendingBatchInstances(requestedUpdate).map(item => item.id),
			'更新必须锁定选中快照'
		).toEqual(picked.pickedInstalledIds);
		const requestedBatchUninstall = reduceSkillsViewState(picked, {type: 'request-uninstall'});
		expect(
			uninstallTargets(requestedBatchUninstall).map(item => item.id),
			'卸载确认必须锁定选中快照'
		).toEqual(picked.pickedInstalledIds);
		const reconciled = reduceSkillsViewState(
			{...requestedUpdate, homeLayout: 'grouped', collapsedSourceKeys: ['unknown'], filterText: 'app'},
			{type: 'lifecycle-reconciled', installed: installedItems.slice(0, 3)}
		);
		expect(reconciled.pickedInstalledIds, '复检后多选只保留仍存在的 Item id').toEqual([
			required(installedItems[0], 'installedItems[0]').id
		]);
		expect(reconciled.homeLayout).toBe('grouped');
		expect(reconciled.collapsedSourceKeys).toEqual(['unknown']);
		expect(reconciled.filterText).toBe('app');

		// 无已安装时不启动 update；未知来源不得进入批量更新。
		const noInstalled = createInitialSkillsViewState();
		const reqUpdate = reduceSkillsViewState(noInstalled, {type: 'request-update'});
		expect(reqUpdate.mode, '无已安装时 update 不进入 busy').toBe('list');
		const localOnlyUpdate = reduceSkillsViewState(
			{...noInstalled, installed: [sharedRow('local-only', {source: undefined})]},
			{type: 'request-update'}
		);
		expect(localOnlyUpdate.mode, '未知来源的 Skill 不得进入更新').toBe('list');
		expect(localOnlyUpdate.errorText ?? '').toMatch(/未知来源/);

		// 管理安装 Modal（列表行 Enter）：草稿预置当前安装态，cx 只读恒勾
		const mixedList = reduceSkillsViewState(createInitialSkillsViewState(), {
			type: 'installed-loaded',
			installed: [sharedRow('apple', {claude: false, codex: true}), sharedRow('banana')]
		});
		const manage = reduceSkillsViewState(mixedList, {type: 'manage-inject'});
		expect(manage.mode, '列表行 Enter 进管理安装 Modal').toBe('manage-inject');
		expect(manage.installDraft.cc, '管理草稿预置 Claude Code 当前态（apple 未注入）').toBe(false);
		expect(manage.installDraft.cx, '管理草稿 Codex 只读恒勾').toBe(true);
		const manageCancel = reduceSkillsViewState(manage, {type: 'cancel'});
		expect(manageCancel.mode, '管理安装 Modal cancel 回列表页').toBe('list');
		const manageConfirm = reduceSkillsViewState(manage, {type: 'confirm'});
		expect(manageConfirm.mode, '管理安装 confirm 进 busy').toBe('busy');

		// 卸载：request-uninstall → confirm-uninstall → busy(uninstall)（全量，无单侧）
		const twoInstalled = reduceSkillsViewState(createInitialSkillsViewState(), {
			type: 'installed-loaded',
			installed: [sharedRow('apple'), sharedRow('banana')]
		});
		const cursorDown = reduceSkillsViewState(twoInstalled, {type: 'nav-down'});
		expect(selectedInstalled(cursorDown)?.name, '光标下移到 banana').toBe('banana');
		const installedLoopDown = reduceSkillsViewState(cursorDown, {type: 'nav-down'});
		expect(selectedInstalled(installedLoopDown)?.name, '已安装列表末项向下应 loop 回首项').toBe('apple');
		const installedLoopUp = reduceSkillsViewState(twoInstalled, {type: 'nav-up'});
		expect(selectedInstalled(installedLoopUp)?.name, '已安装列表首项向上应 loop 到末项').toBe('banana');
		expect(required(selectedOrCurrentInstalled(cursorDown)[0], 'cursorDown target').name, '无多选时卸载目标回退当前光标项').toBe(
			'banana'
		);
		const reqUninstall = reduceSkillsViewState(twoInstalled, {type: 'request-uninstall'});
		expect(reqUninstall.mode, 'request-uninstall 进确认').toBe('confirm-uninstall');
		const uninstallBusy = reduceSkillsViewState(reqUninstall, {type: 'confirm'});
		expect(uninstallBusy.mode, 'confirm-uninstall confirm 进 busy').toBe('busy');
		expect(uninstallBusy.busyAction, 'busyAction=uninstall').toBe('uninstall');
		const cancelUninstall = reduceSkillsViewState(reqUninstall, {type: 'cancel'});
		expect(cancelUninstall.mode, 'confirm-uninstall cancel 回列表页').toBe('list');

		// action-done 复位到 list（保留 installed）；action-failed 按动作回退到对应页
		const afterDone = reduceSkillsViewState(installBusy, {type: 'action-done'});
		expect(afterDone.mode, 'action-done 复位 list').toBe('list');
		expect(afterDone.busyAction, 'action-done 清空 busyAction').toBe(undefined);
		const installFailed = reduceSkillsViewState(installBusy, {type: 'action-failed', error: 'boom'});
		expect(installFailed.mode, 'install 失败回安装页').toBe('install');
		expect(installFailed.busyAction, 'action-failed 清空 busyAction').toBe(undefined);
		expect(installFailed.errorText, 'action-failed 应携带 errorText').toBeTruthy();
		const uninstallFailed = reduceSkillsViewState(uninstallBusy, {type: 'action-failed', error: 'boom'});
		expect(uninstallFailed.mode, 'uninstall 失败回列表页').toBe('list');
		const manageFailed = reduceSkillsViewState(manageConfirm, {type: 'action-failed', error: 'boom'});
		expect(manageFailed.mode, 'manage-inject 失败回原列表页').toBe('list');
	});

	// ── displaySkillName 派生：owner/repo@skill 只取 @ 后 skill 名，避免 confirm 弹窗与列表重复 owner/repo ──
	test('displaySkillName 取 @ 后 skill 名，confirm 弹窗与列表共用不重复 owner/repo', () => {
		// 有 @：只取 skill 名（confirm 弹窗 `即将安装 <skill> (<source>)` 不再出现 owner/repo 重复）
		expect(displaySkillName('github/awesome-copilot@pdftk-server'), '有 @ 时取 @ 后 skill 名').toBe('pdftk-server');
		expect(displaySkillName('openai/skills@pdf')).toBe('pdf');

		// 无 @：原样返回
		expect(displaySkillName('brainstorming'), '无 @ 时原样返回').toBe('brainstorming');

		// 边界：@ 结尾（split 后为空串）回退原 name，绝不返回空
		expect(displaySkillName('org/repo@'), '@ 结尾回退原 name').toBe('org/repo@');
	});

	// ── Search result → --skill 派生：只安装选中的子 skill ──────────────────────
	test('Search result 派生 --skill，仅安装选中的子 skill', () => {
		expect(
			skillNameFromSearchResult({name: 'openai/skills@pdf', source: 'openai/skills', description: ''}, 'openai/skills'),
			'owner/repo@skill 应派生出 --skill 参数'
		).toBe('pdf');
		expect(
			skillNameFromSearchResult({name: 'standalone-skill', source: 'standalone-skill', description: ''}, 'standalone-skill'),
			'非 owner/repo@skill 形态不应强行派生 --skill'
		).toBe(undefined);
	});

	// ── 安装页多选资格 + Modal 快照 + 最终检测对账 ────────────────────────────
	test('安装页多选资格、同名冲突、Modal 快照、留页与最终检测对账', () => {
		const results = [
			{name: 'org/a@alpha', source: 'org/a', description: ''},
			{name: 'org/b@alpha', source: 'org/b', description: ''},
			{name: 'org/a@beta', source: 'org/a', description: ''},
			{name: 'org/c@installed-one', source: 'org/c', description: ''},
			{name: 'org/b@gamma', source: 'org/b', description: ''}
		];
		// 已安装项与搜索结果同名同来源（org/c），因此判定为已安装而非同名覆盖（task 07-28 R4）。
		let state = reduceSkillsViewState(createInitialSkillsViewState(), {
			type: 'installed-loaded',
			installed: [sharedRow('installed-one', {source: 'org/c'})]
		});
		state = reduceSkillsViewState(state, {type: 'open-install'});
		state = reduceSkillsViewState(state, {type: 'search-done', results});

		let items = searchInstallItems(state);
		expect(items.map(item => item.status)).toEqual(['available', 'available', 'available', 'installed', 'available']);
		const equivalentSourceState = {
			...state,
			installed: [sharedRow('langchain-rag', {source: 'https://github.com/langchain-ai/langchain-skills.git'})],
			results: [{name: 'langchain-ai/langchain-skills@langchain-rag', source: 'langchain-ai/langchain-skills', description: ''}]
		};
		expect(searchInstallItems(equivalentSourceState)[0]?.status, 'GitHub sourceUrl 与 owner/repo 简写应识别为同一来源').toBe(
			'installed'
		);
		// prd R4：同名异来源在搜索页仍可选（source-replacement），只有选定目标且目标根冲突
		// 才显示「已有同名」覆盖确认；搜索页未选目标时不能预先判 name-occupied。
		expect(
			searchInstallItems({
				...equivalentSourceState,
				installed: [sharedRow('langchain-rag', {source: 'https://github.com/other/repo.git'})]
			})[0]?.status,
			'同名异来源在搜索页应可选，目标根占用留待选定目标后判定'
		).toBe('source-replacement');
		const selectAll = reduceSkillsViewState(state, {type: 'select-all-results'});
		expect(
			selectedSearchResults(selectAll).map(result => result.name),
			'全选应排除已安装项，并为同名结果只保留首个可安装来源'
		).toEqual(['org/a@alpha', 'org/a@beta', 'org/b@gamma']);
		state = reduceSkillsViewState(state, {type: 'toggle-result'});
		items = searchInstallItems(state);
		expect(required(items[0], 'items[0]').selected, 'Space 应选择当前可安装项').toBe(true);
		expect(required(items[1], 'items[1]').status, '选中一个来源后，同名其它来源应立即冲突禁选').toBe('selection-conflict');

		state = reduceSkillsViewState({...state, resultIndex: 1}, {type: 'toggle-result'});
		expect(state.pickedResultKeys.length, '同名冲突项不得进入选择集合').toBe(1);
		state = reduceSkillsViewState({...state, resultIndex: 3}, {type: 'toggle-result'});
		expect(state.pickedResultKeys.length, '已安装项不得进入选择集合').toBe(1);
		state = reduceSkillsViewState({...state, resultIndex: 2}, {type: 'toggle-result'});
		state = reduceSkillsViewState({...state, resultIndex: 4}, {type: 'toggle-result'});
		expect(selectedSearchResults(state).map(result => result.name)).toEqual(['org/a@alpha', 'org/a@beta', 'org/b@gamma']);

		const modal = reduceSkillsViewState(state, {type: 'select-skill'});
		expect(modal.mode).toBe('select-install-target');
		expect(
			pendingInstallResults(modal).map(result => result.name),
			'Modal 应快照整批选择'
		).toEqual(['org/a@alpha', 'org/a@beta', 'org/b@gamma']);
		const modalCancel = reduceSkillsViewState(modal, {type: 'cancel'});
		expect(modalCancel.pickedResultKeys.length, 'Modal 取消应保留显式选择').toBe(3);
		expect(modalCancel.pendingInstallKeys.length, 'Modal 取消只清 pending 快照').toBe(0);

		const executing = reduceSkillsViewState(modal, {type: 'confirm'});
		expect(executing.batchStage).toBe('executing');
		const reconciling = reduceSkillsViewState(executing, {type: 'install-execution-done'});
		expect(reconciling.batchStage).toBe('reconciling');
		const reconciled = reduceSkillsViewState(reconciling, {
			type: 'install-reconciled',
			installed: [
				sharedRow('installed-one', {source: 'org/c'}),
				sharedRow('alpha', {source: 'org/a'}),
				sharedRow('beta', {source: 'org/a'})
			]
		});
		expect(reconciled.mode, '批量完成后必须停留在安装页').toBe('install');
		expect(reconciled.query, '对账应保留查询').toBe(state.query);
		expect(reconciled.results, '对账应保留扁平结果引用').toBe(state.results);
		expect(reconciled.resultIndex, '对账应保留光标').toBe(state.resultIndex);
		expect(
			selectedSearchResults(reconciled).map(result => result.name),
			'成功项取消选择，仍缺失项保持选择以便重试'
		).toEqual(['org/b@gamma']);
		const incompleteInstalled = [
			sharedRow('installed-one'),
			sharedRow('alpha'),
			sharedRow('beta'),
			sharedRow('gamma', {claude: false, codex: true, source: 'org/b'})
		];
		const targetIncomplete = reduceSkillsViewState(reconciling, {
			type: 'install-reconciled',
			installed: incompleteInstalled,
			confirmedKeys: [JSON.stringify(['org/a', 'alpha']), JSON.stringify(['org/a', 'beta'])]
		});
		expect(selectedSearchResults(targetIncomplete).map(result => result.name)).toEqual(['org/b@gamma']);
		const repeatedCacheLoad = reduceSkillsViewState(targetIncomplete, {
			type: 'installed-loaded',
			installed: incompleteInstalled
		});
		expect(
			selectedSearchResults(repeatedCacheLoad).map(result => result.name),
			'同一 postflight cache 结果的 effect 不得清掉 reducer 已保留的未确认选择'
		).toEqual(['org/b@gamma']);
		const allSucceeded = reduceSkillsViewState(reconciling, {
			type: 'install-reconciled',
			installed: [
				sharedRow('installed-one', {source: 'org/c'}),
				sharedRow('alpha', {source: 'org/a'}),
				sharedRow('beta', {source: 'org/a'}),
				sharedRow('gamma', {source: 'org/b'})
			]
		});
		expect(selectedSearchResults(allSucceeded).length, '全部成功后应清空整批选择').toBe(0);
		const allFailed = reduceSkillsViewState(reconciling, {
			type: 'install-reconciled',
			installed: [sharedRow('installed-one')]
		});
		expect(
			selectedSearchResults(allFailed).map(result => result.name),
			'全部失败后应保留整批选择以便重试'
		).toEqual(['org/a@alpha', 'org/a@beta', 'org/b@gamma']);

		const retryModal = reduceSkillsViewState(reconciled, {type: 'select-skill'});
		const retryBusy = reduceSkillsViewState(retryModal, {type: 'confirm'});
		const unconfirmed = reduceSkillsViewState(retryBusy, {type: 'install-reconcile-failed', error: '检测失败'});
		expect(unconfirmed.mode, '安装后检测失败仍停留安装页').toBe('install');
		expect(
			selectedSearchResults(unconfirmed).map(result => result.name),
			'检测失败保留可恢复选择'
		).toEqual(['org/b@gamma']);
		expect(unconfirmed.errorText ?? '').toMatch(/检测失败/);

		const newSearch = reduceSkillsViewState(reconciled, {
			type: 'search-done',
			results: [{name: 'org/new@delta', source: 'org/new', description: ''}]
		});
		expect(newSearch.pickedResultKeys.length, '新搜索必须清空旧结果选择').toBe(0);
		expect(newSearch.pendingInstallKeys.length, '新搜索不得留下隐藏 pending 目标').toBe(0);

		const singleton = reduceSkillsViewState(newSearch, {type: 'select-skill'});
		expect(pendingInstallResults(singleton).length, '无显式多选时 Enter 应回退为当前单项批次').toBe(1);
	});

	// ── Skills 三态管理与同名来源替换：安装页只放开可证明的异来源，管理页统一进入 topology 强确认。 ──
	test('Skills 同名来源替换资格、固定文案与 C/X/B 统一强确认状态机', () => {
		const storage = (kind: SkillStorageKind, name: string): SkillStorageInspection => ({
			kind,
			name,
			claudePath: `/home/.claude/skills/${name}`,
			canonicalPath: `/home/.agents/skills/${name}`,
			claudeValid: kind === 'claude-only' || kind === 'shared-symlink' || kind === 'shared-copy',
			canonicalValid: kind === 'canonical-only' || kind === 'shared-symlink' || kind === 'shared-copy'
		});
		const replacementResult = {name: 'new/repo@same', source: 'new/repo', description: ''};
		const replacementState: SkillsViewState = {
			...createInitialSkillsViewState(),
			mode: 'install',
			installed: [withStorage(sharedRow('same', {source: 'old/repo'}), storage('shared-symlink', 'same'))],
			results: [replacementResult],
			queryFocused: false
		};
		const replacementItem = required(searchInstallItems(replacementState)[0], 'replacementItem');
		expect(replacementItem.status, '可证明同名不同源时应进入来源替换状态').toBe('source-replacement');
		expect(replacementItem.selectable, '同名不同源允许选择').toBe(true);

		const sameSourceItem = required(
			searchInstallItems({
				...replacementState,
				results: [{name: 'old/repo@same', source: 'old/repo', description: ''}]
			})[0],
			'sameSourceItem'
		);
		expect(sameSourceItem.selectable, '同来源已安装仍禁选').toBe(false);

		const unknownSourceItem = required(
			searchInstallItems({
				...replacementState,
				installed: [withStorage(sharedRow('same', {source: undefined}), storage('canonical-only', 'same'))]
			})[0],
			'unknownSourceItem'
		);
		expect(unknownSourceItem.selectable, '旧来源未知不得猜测为可替换').toBe(false);

		const claudeOnly: SkillsViewState = {
			...createInitialSkillsViewState(),
			installed: [withStorage(sharedRow('local-only', {claude: true, codex: false}), storage('claude-only', 'local-only'))]
		};
		const topologyRows = [
			{kind: 'claude-only' as const, draft: {cc: true, cx: false, pi: false}},
			{kind: 'canonical-only' as const, draft: {cc: false, cx: true, pi: false}},
			{kind: 'shared-symlink' as const, draft: {cc: true, cx: true, pi: false}},
			{kind: 'shared-copy' as const, draft: {cc: true, cx: true, pi: false}}
		];
		for (const {kind, draft} of topologyRows) {
			const row: SkillsViewState = {
				...createInitialSkillsViewState(),
				installed: [withStorage(sharedRow(kind, {claude: draft.cc, codex: draft.cx}), storage(kind, kind))]
			};
			const manage = reduceSkillsViewState(row, {type: 'manage-inject'});
			expect(manage.installDraft, `${kind} 应按物理事实初始化草稿`).toEqual(draft);
			const toggledCc = reduceSkillsViewState({...manage, targetIndex: 0}, {type: 'install-target-toggle'});
			const toggledCx = reduceSkillsViewState({...manage, targetIndex: 1}, {type: 'install-target-toggle'});
			expect(toggledCc.installDraft.cc, `${kind} 的 Claude 目标应可编辑`).not.toBe(draft.cc);
			expect(toggledCx.installDraft.cx, `${kind} 的 Codex 目标应可编辑`).not.toBe(draft.cx);
		}

		const cManage = reduceSkillsViewState(claudeOnly, {type: 'manage-inject'});
		const cNoop = reduceSkillsViewState(cManage, {type: 'request-topology-change'});
		expect(cNoop.mode, '精确 C no-op 应直接关闭管理 Modal').toBe('list');
		const cToX = reduceSkillsViewState(
			{...cManage, installDraft: {cc: false, cx: true, pi: false}},
			{
				type: 'request-topology-change'
			}
		);
		expect(cToX.mode, 'C→X 必须经过统一强确认').toBe('confirm-topology-change');
		expect(reduceSkillsViewState(cToX, {type: 'cancel'}).mode, '取消拓扑确认应回管理 Modal并保留草稿').toBe('manage-inject');
		const emptyTarget = reduceSkillsViewState(
			{...cManage, installDraft: {cc: false, cx: false, pi: false}},
			{
				type: 'request-topology-change'
			}
		);
		expect(emptyTarget.mode).toBe('manage-inject');
		expect(emptyTarget.errorText ?? '', '零目标应引导使用全量卸载').toMatch(/d|卸载/);

		const busyCancelled = reduceSkillsViewState(
			{
				...cManage,
				mode: 'busy',
				busyAction: 'update',
				busyReturnMode: 'list',
				progress: ['更新中'],
				errorText: '旧错误'
			},
			{type: 'cancel-busy'}
		);
		expect(busyCancelled.mode, '取消 busy 后返回原 Skills 页面').toBe('list');
		expect(busyCancelled.busyAction, '取消 busy 后清空动作').toBe(undefined);
		expect(busyCancelled.progress, '取消 busy 后清空进度').toEqual([]);
		expect(busyCancelled.errorText, '用户取消不得显示为失败').toBe(undefined);

		let replacement = reduceSkillsViewState(replacementState, {type: 'toggle-result'});
		replacement = reduceSkillsViewState(replacement, {type: 'select-skill'});
		const replacementConfirm = reduceSkillsViewState(replacement, {type: 'request-source-replacement'});
		expect(replacementConfirm.mode, '来源替换必须经过独立强确认').toBe('confirm-source-replacement');
		expect(reduceSkillsViewState(replacementConfirm, {type: 'cancel'}).mode).toBe('select-install-target');

		const multiRootReplacement = {
			...replacement,
			installed: [
				sharedRow('same', {source: 'old/agents', claude: false, path: '/home/.agents/skills/same'}),
				sharedRow('same', {source: 'old/claude', codex: false, path: '/home/.claude/skills/same'})
			]
		};
		const multiRootConflicts = pendingSourceReplacements(multiRootReplacement);
		expect(multiRootConflicts.length, 'Shared 目标覆盖两个根的异源实例时确认列表必须展示两项').toBe(2);
		expect(
			multiRootConflicts
				.map(item => (item.installed.provenance.kind === 'known' ? item.installed.provenance.installSource : undefined))
				.sort()
		).toEqual(['old/agents', 'old/claude']);
		expect(
			multiRootConflicts.map(item => item.projections.map(projection => projection.root)),
			'确认项只展示本次会被覆盖的目标根投影'
		).toEqual([['agents'], ['claude']]);
	});
});
