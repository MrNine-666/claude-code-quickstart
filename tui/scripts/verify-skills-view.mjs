import assert from 'node:assert/strict';
import {
	parseSkillsFindOutput,
	parseSkillsListOutput,
	searchSkills,
	listRepoSkills,
	groupByRepo,
	getInstalledSkills
} from '../src/core/skills.ts';
import {installSkill, installMultipleSkills, updateSkills, uninstallSkills} from '../src/core/skills-actions.ts';
import {createSkillsDetectionRunner, runSkillsDetection} from '../src/services/view-detection.ts';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	filteredInstalled,
	shouldRunSearch,
	canManageInstalled,
	uninstallTargets,
	selectedRepo,
	installTargets,
	canConfirmPick
} from '../src/state/skills-view-state.ts';

// Phase 5 Skills TUI 门禁：parser fixture（7.4 / --list）、不依赖 catalogue（7.8）、
// 进度 callback 不直接 console（7.9）、异步检测状态机（7.10）、视图状态机有界性（两级选择 + 多选）。

// ── 7.4a skills find parser fixture：成功 / 无结果 / 不可解析 / 命令不可用 ──────
{
	// 成功（JSON）
	const ok = parseSkillsFindOutput(JSON.stringify([{name: 'a-skill', source: 'org/a', description: 'A'}]));
	assert.equal(ok?.length, 1);
	assert.equal(ok?.[0]?.name, 'a-skill');

	// 成功（表格）
	const table = parseSkillsFindOutput('a-skill  org/a  desc one\nb-skill  org/b  desc two');
	assert.equal(table?.length, 2);
	assert.equal(table?.[1]?.name, 'b-skill');

	// 成功（真实块状格式：name 与 install count 单空格分隔，URL 续行以 └ 开头）
	const block = parseSkillsFindOutput(
		'github/awesome-copilot@pdftk-server 9.6K installs\n└ https://skills.sh/github/awesome-copilot/pdftk-server\n\nopenai/skills@pdf 8K installs\n└ https://skills.sh/openai/skills/pdf'
	);
	assert.equal(block?.length, 2, '真实块状格式应解析出全部条目');
	assert.equal(block?.[0]?.name, 'github/awesome-copilot@pdftk-server');
	assert.equal(block?.[1]?.name, 'openai/skills@pdf');

	// 无结果（有输出但无可解析条目 → 空数组，区别于 null）
	const empty = parseSkillsFindOutput('未找到匹配的技能。');
	assert.deepEqual(empty, []);

	// 不可解析 / 完全无输出 → null
	assert.equal(parseSkillsFindOutput(''), null);

	// 命令不可用（stderr 含 not recognized，stdout 空）→ null
	const unavailable = parseSkillsFindOutput('', "'skills' is not recognized as an internal or external command");
	assert.equal(unavailable, null);

	console.log('[PASS] 7.4a skills find parser fixture（成功/无结果/不可解析/命令不可用）');
}

// ── 7.4b skills add <repo> --list parser fixture（需求③）：多 skill / 单 skill / 命令不可用 / 空 ──
{
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
	assert.equal(multi?.length, 2, '应解析出 2 个 skill');
	assert.equal(multi?.[0]?.name, 'brainstorming');
	assert.ok(multi?.[0]?.description?.includes('creative work'), 'description 应含自然语言');
	assert.equal(multi?.[1]?.name, 'dispatching-parallel-agents', '连字符 name 为单 token');
	assert.ok(multi?.[1]?.description?.includes('independent tasks'));

	// 单 skill
	const single = parseSkillsListOutput(
		['◇  Available Skills', '│', '│    writing-guidelines', '│', '│      Review docs/prose.', '│', '└  Use --skill'].join('\n')
	);
	assert.equal(single?.length, 1);
	assert.equal(single?.[0]?.name, 'writing-guidelines');

	// 无 Available Skills 标题 + 命令不可用 → null
	assert.equal(parseSkillsListOutput('', "'skills' is not recognized"), null, '命令不可用应返回 null');

	// 有标题但无 skill 块 → 空数组
	const emptyRegion = parseSkillsListOutput('◇  Available Skills\n│\n└  Use --skill');
	assert.deepEqual(emptyRegion, [], '有标题无 skill 返回空数组');

	console.log('[PASS] 7.4b skills add --list parser fixture（多 skill/单 skill/命令不可用/空）');
}

// ── 7.4c groupByRepo 按 owner/repo 去重 + hitCount + installs 求和 ─────────────
{
	const groups = groupByRepo([
		{name: 'org/a@skill1', source: 'org/a', installCount: 100},
		{name: 'org/a@skill2', source: 'org/a', installCount: 50},
		{name: 'org/b@skill3', source: 'org/b'}
	]);
	assert.equal(groups.length, 2, '两个 repo 去重');
	const a = groups.find(group => group.repo === 'org/a');
	assert.equal(a.hitCount, 2, 'org/a 命中 2 个 skill');
	assert.equal(a.totalInstalls, 150, 'installs 求和');
	const b = groups.find(group => group.repo === 'org/b');
	assert.equal(b.hitCount, 1);
	assert.equal(b.totalInstalls, undefined, '无 installCount 时 totalInstalls undefined');

	// source 缺失时从 name 的 @ 前缀解析
	const fromName = groupByRepo([{name: 'org/c@x', source: ''}]);
	assert.equal(fromName[0].repo, 'org/c', 'source 空时从 name 解析 repo');

	console.log('[PASS] 7.4c groupByRepo 按 owner/repo 去重 + hitCount + installs 求和');
}

// ── 7.8 搜索由 skills find 驱动，不依赖 catalogue，空查询不触发 CLI ────────────
{
	const fakeExec = async (_cmd, args) => {
		assert.equal(args.includes('find'), true, '搜索必须调用 skills find');
		return {code: 0, stdout: JSON.stringify([{name: 'found-by-find', source: 'x/y', description: 'from find'}]), stderr: ''};
	};

	const outcome = await searchSkills('anything', fakeExec);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.results[0].name, 'found-by-find');

	// 空查询不触发 CLI
	let called = false;
	const guardExec = async () => {
		called = true;
		return {code: 0, stdout: '', stderr: ''};
	};
	const emptyOutcome = await searchSkills('   ', guardExec);
	assert.equal(emptyOutcome.ok, false);
	assert.equal(called, false);

	console.log('[PASS] 7.8 搜索由 skills find 驱动，空查询不触发 CLI');
}

// ── 7.8b listRepoSkills 由 skills add --list 驱动，空 repo 不触发 CLI ─────────
{
	const fakeExec = async (_cmd, args) => {
		assert.equal(args.includes('add'), true, 'listRepoSkills 必须调用 skills add');
		assert.equal(args.includes('--list'), true, '必须带 --list');
		return {code: 0, stdout: '◇  Available Skills\n│\n│    skill-x\n│\n│      desc x\n', stderr: ''};
	};
	const outcome = await listRepoSkills('org/repo', fakeExec);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.skills[0].name, 'skill-x');

	// 空 repo 不触发 CLI
	let called = false;
	const guardExec = async () => {
		called = true;
		return {code: 0, stdout: '', stderr: ''};
	};
	const empty = await listRepoSkills('  ', guardExec);
	assert.equal(empty.ok, false);
	assert.equal(called, false);

	console.log('[PASS] 7.8b listRepoSkills 由 skills add --list 驱动，空 repo 不触发 CLI');
}

// ── 7.9 action 进度通过 callback 上报，不直接 console ─────────────────────────
{
	const originalLog = console.log;
	const originalError = console.error;
	let consoleHits = 0;
	console.log = () => {
		consoleHits++;
	};
	console.error = () => {
		consoleHits++;
	};

	try {
		const okExec = async () => ({code: 0, stdout: 'done', stderr: ''});
		const failExec = async () => ({code: 1, stdout: '', stderr: 'ETIMEDOUT'});

		// install：成功路径
		const installEvents = [];
		const installRes = await installSkill({source: 'org/skill', displayName: 'skill'}, event => installEvents.push(event), okExec);
		assert.equal(installRes.success, true);
		assert.ok(installEvents.some(event => event.level === 'success'));

		// installMultipleSkills：单次多 --skill 批量安装（需求③）
		const captured = [];
		const multiExec = async (_cmd, args) => {
			captured.push(args);
			return {code: 0, stdout: 'done', stderr: ''};
		};
		const multiEvents = [];
		const multiRes = await installMultipleSkills(
			{source: 'org/repo', skillNames: ['a', 'b', 'c'], displayName: 'org/repo'},
			event => multiEvents.push(event),
			multiExec
		);
		assert.equal(multiRes.success, true);
		assert.equal(captured.length, 1, '批量安装应单次调用');
		const skillArgs = captured[0].filter((value, index, arr) => arr[index - 1] === '--skill');
		assert.equal(skillArgs.length, 3, '三个 --skill 一次传入');
		assert.ok(multiEvents.some(event => event.level === 'success'));
		// 空名单直接失败不 spawn
		let emptyCalled = false;
		const emptyMulti = await installMultipleSkills({source: 'org/repo', skillNames: []}, undefined, async () => {
			emptyCalled = true;
			return {code: 0, stdout: '', stderr: ''};
		});
		assert.equal(emptyMulti.success, false);
		assert.equal(emptyCalled, false, '空名单不得 spawn');

		// update：失败路径
		const updateEvents = [];
		const updateRes = await updateSkills([], event => updateEvents.push(event), failExec);
		assert.equal(updateRes.success, false);
		assert.ok(updateRes.error.includes('网络'));
		assert.ok(updateEvents.some(event => event.level === 'danger'));

		// uninstall：成功路径
		const uninstallEvents = [];
		const uninstallRes = await uninstallSkills(['skill-a'], event => uninstallEvents.push(event), okExec);
		assert.equal(uninstallRes.success, true);
		assert.ok(uninstallEvents.length > 0);

		// 空名单 uninstall 直接失败
		const emptyRes = await uninstallSkills([], () => {}, okExec);
		assert.equal(emptyRes.success, false);

		assert.equal(consoleHits, 0, 'action service 不得直接写 console');
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	console.log('[PASS] 7.9 action 进度经 callback 上报，installMultipleSkills 单次多 --skill，空名单不 spawn');
}

// ── 7.10 异步检测状态机：进行中不重复触发，loading → success/error ────────────
{
	let runCount = 0;
	const states = [];
	const okExec = async () => {
		runCount++;
		return {code: 0, stdout: JSON.stringify([{name: 'installed-x', scope: 'global'}]), stderr: ''};
	};
	const runner = createSkillsDetectionRunner(state => states.push(state));
	const first = runner.run(() => getInstalledSkills(okExec));
	const second = await runner.run(() => getInstalledSkills(okExec));
	assert.equal(second.status, 'loading', '检测进行中第二次触发应复用 loading');
	const final = await first;
	assert.equal(final.status, 'success');
	assert.equal(final.result[0].name, 'installed-x');
	assert.equal(runCount, 1, '进行中不得重复触发底层检测');
	assert.deepEqual(states.map(state => state.status), ['loading', 'success']);

	const errStates = [];
	const errRunner = createSkillsDetectionRunner(state => errStates.push(state));
	const failed = await errRunner.run(async () => {
		throw new Error('npx 不可用');
	});
	assert.equal(failed.status, 'error');
	assert.equal(failed.error, 'npx 不可用');
	const reset = errRunner.reset();
	assert.equal(reset.status, 'idle');

	console.log('[PASS] 7.10 异步检测进行中不重复触发，loading → success/error 正确迁移');
}

// ── 视图状态机有界性 + 两级选择/多选不变量 ─────────────────────────────────
{
	const actions = [
		{type: 'nav-up'},
		{type: 'nav-down'},
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
		{type: 'select-repo'},
		{type: 'repo-skills-loaded', repo: 'org/a', skills: [{name: 's1', description: 'd'}]},
		{type: 'repo-skills-failed', error: 'boom'},
		{type: 'toggle-pick'},
		{type: 'toggle-all-picks'},
		{type: 'confirm-pick'},
		{type: 'request-update'},
		{type: 'request-uninstall'},
		{type: 'confirm'},
		{type: 'cancel'},
		{type: 'action-done'},
		{type: 'action-failed', error: 'boom'}
	];

	let state = createInitialSkillsViewState();
	state = reduceSkillsViewState(state, {
		type: 'installed-loaded',
		installed: [
			{name: 'apple', path: '', scope: 'g', agents: []},
			{name: 'banana', path: '', scope: 'g', agents: []}
		]
	});

	const modes = new Set(['list', 'install', 'install-pick', 'confirm-install', 'confirm-uninstall', 'busy']);
	for (let i = 0; i < 600; i++) {
		const action = actions[(i * 13 + 5) % actions.length];
		state = reduceSkillsViewState(state, action);
		assert.ok(modes.has(state.mode), `未知 mode: ${state.mode}`);
		assert.ok(state.installedIndex >= 0 && state.installedIndex < Math.max(filteredInstalled(state).length, 1), `installedIndex 越界: ${state.installedIndex}`);
		assert.ok(state.repoIndex >= 0 && state.repoIndex < Math.max(state.repos.length, 1), `repoIndex 越界: ${state.repoIndex}`);
		assert.ok(state.pickIndex >= 0 && state.pickIndex < Math.max(state.repoSkills.length, 1), `pickIndex 越界: ${state.pickIndex}`);
		assert.ok(state.pickedSkills.length <= state.repoSkills.length, `pickedSkills 越界: ${state.pickedSkills.length} > ${state.repoSkills.length}`);
		assert.ok(state.progress.length <= 8, `progress 未裁剪: ${state.progress.length}`);
	}

	// 两级选择全链路：搜索 → 父级 repo → select-repo → --list 回填 → 多选 → confirm-pick → 安装目标
	const base = reduceSkillsViewState(createInitialSkillsViewState(), {
		type: 'installed-loaded',
		installed: [{name: 'apple', path: '', scope: 'g', agents: []}]
	});
	const installPage = reduceSkillsViewState(base, {type: 'open-install'});
	assert.equal(installPage.mode, 'install');
	assert.equal(installPage.queryFocused, true, '进入安装页默认聚焦搜索框');
	assert.equal(shouldRunSearch(installPage), false);
	const submitEmpty = reduceSkillsViewState(installPage, {type: 'submit-search'});
	assert.equal(submitEmpty.searching, false, '空查询提交不进入 searching');
	assert.ok(submitEmpty.errorText, '空查询提交应提示');

	const searched = reduceSkillsViewState(installPage, {
		type: 'search-done',
		results: [
			{name: 'org/a@x', source: 'org/a'},
			{name: 'org/a@y', source: 'org/a'},
			{name: 'org/b@z', source: 'org/b'}
		]
	});
	assert.equal(searched.repos.length, 2, 'find 结果按 repo 去重为 2 个父级');
	assert.equal(searched.queryFocused, false, '搜索完成后焦点直接切到 repo 列表');
	assert.equal(selectedRepo(searched)?.repo, 'org/a', '默认光标首个 repo');

	const picked = reduceSkillsViewState(searched, {type: 'select-repo'});
	assert.equal(picked.mode, 'install-pick', 'select-repo 进子级');
	assert.equal(picked.loadingRepo, true, '子级初始 loadingRepo');
	assert.equal(picked.currentRepo, 'org/a');

	// repo-skills-loaded 防竞态：repo 不匹配时忽略
	const raced = reduceSkillsViewState(picked, {type: 'repo-skills-loaded', repo: 'org/other', skills: [{name: 'q'}]});
	assert.equal(raced.repoSkills.length, 0, 'repo 不匹配的回填应忽略');
	const loaded = reduceSkillsViewState(picked, {type: 'repo-skills-loaded', repo: 'org/a', skills: [{name: 'x'}, {name: 'y'}]});
	assert.equal(loaded.loadingRepo, false);
	assert.equal(loaded.repoSkills.length, 2);

	// 多选 toggle：选中 x → 下移到 y → 选中 y（累积）→ 回 x 再 toggle（取消 x）
	const toggleX = reduceSkillsViewState(loaded, {type: 'toggle-pick'});
	assert.deepEqual(toggleX.pickedSkills, ['x'], 'toggle 光标项 x 选中');
	const atY = reduceSkillsViewState(toggleX, {type: 'nav-down'});
	assert.equal(atY.pickIndex, 1);
	const toggleY = reduceSkillsViewState(atY, {type: 'toggle-pick'});
	assert.deepEqual(toggleY.pickedSkills, ['x', 'y'], '多选累积');
	const allCleared = reduceSkillsViewState(toggleY, {type: 'toggle-all-picks'});
	assert.deepEqual(allCleared.pickedSkills, [], '已全选时 a 取消全选');
	const allPicked = reduceSkillsViewState(allCleared, {type: 'toggle-all-picks'});
	assert.deepEqual(allPicked.pickedSkills, ['x', 'y'], '未全选时 a 全选');
	const backToX = reduceSkillsViewState(toggleY, {type: 'nav-up'});
	const toggleX2 = reduceSkillsViewState(backToX, {type: 'toggle-pick'});
	assert.deepEqual(toggleX2.pickedSkills, ['y'], '再次 toggle x 取消');

	// confirm-pick：空选拦截 / 非空进 confirm-install
	assert.equal(canConfirmPick(loaded), false, '未选时不可确认');
	const emptyConfirm = reduceSkillsViewState(loaded, {type: 'confirm-pick'});
	assert.equal(emptyConfirm.mode, 'install-pick', '空选不进 confirm');
	assert.ok(emptyConfirm.errorText, '空选应提示');
	const ready = reduceSkillsViewState(toggleY, {type: 'confirm-pick'});
	assert.equal(ready.mode, 'confirm-install', '非空进 confirm-install');
	const targets = installTargets(ready);
	assert.equal(targets.length, 2, '两个安装目标');
	assert.equal(targets[0].source, 'org/a');
	assert.equal(targets[0].skillName, 'x');

	// confirm-install cancel 回子级（保留多选可调整）；install-pick cancel 回父级
	const backToPick = reduceSkillsViewState(ready, {type: 'cancel'});
	assert.equal(backToPick.mode, 'install-pick', 'confirm-install cancel 回子级');
	assert.deepEqual(backToPick.pickedSkills, ['x', 'y'], 'cancel 保留多选');
	const backToRepos = reduceSkillsViewState(backToPick, {type: 'cancel'});
	assert.equal(backToRepos.mode, 'install', 'install-pick cancel 回父级');
	assert.equal(backToRepos.currentRepo, undefined, '回父级清空 currentRepo');

	// 无已安装时禁用 update
	const noInstalled = createInitialSkillsViewState();
	assert.equal(canManageInstalled(noInstalled), false);
	const reqUpdate = reduceSkillsViewState(noInstalled, {type: 'request-update'});
	assert.equal(reqUpdate.mode, 'list', '无已安装时 update 不进入 busy');

	// 卸载目标：列表页单条光标项
	const cursorDown = reduceSkillsViewState(base, {type: 'nav-down'});
	assert.deepEqual(uninstallTargets(cursorDown), ['apple'], '卸载目标为当前光标项');

	console.log('[PASS] Skills 视图状态机有界 + 两级选择/多选/confirm-pick/防竞态/cancel 不变量');
}

console.log('[PASS] Phase 5 Skills TUI 门禁全部通过');
