import assert from 'node:assert/strict';
import {
	parseSkillsFindOutput,
	parseSkillsListOutput,
	searchSkills,
	listRepoSkills,
	groupByRepo,
	getInstalledSkills,
	skillsAgentOf
} from '../src/core/skills.ts';
import {installSkill, installMultipleSkills, updateSkills, uninstallSkills} from '../src/core/skills-actions.ts';
import {createSkillsDetectionRunner, runSkillsDetection} from '../src/services/view-detection.ts';
import {skillNameFromSearchResult} from '../src/services/skills-service.ts';
import {createSkillsViewServices} from '../src/views/skills-view-services.ts';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	filteredInstalled,
	shouldRunSearch,
	canManageInstalled,
	uninstallTargets,
	selectedResult,
	selectedInstalled,
	displaySkillName
} from '../src/state/skills-view-state.ts';

// Phase 5 Skills TUI 门禁：parser fixture（7.4 / --list）、不依赖 catalogue（7.8）、
// 进度 callback 不直接 console（7.9）、异步检测状态机（7.10）、视图状态机有界性（扁平安装架构）。

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

		// install：指定子 skill 时必须传 --skill，避免误装整个 repo
		const installArgs = [];
		const installWithSkill = await installSkill(
			{source: 'org/repo', displayName: 'org/repo@child', skillName: 'child'},
			undefined,
			async (_cmd, args) => {
				installArgs.push(args);
				return {code: 0, stdout: 'done', stderr: ''};
			}
		);
		assert.equal(installWithSkill.success, true);
		assert.equal(installArgs[0].includes('--skill'), true, '指定子 skill 安装必须带 --skill');
		assert.equal(installArgs[0][installArgs[0].indexOf('--skill') + 1], 'child', '--skill 后应跟选中的子 skill 名');

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

// ── 视图状态机有界性 + 扁平架构单选/确认/cancel 不变量 ──────────────────────
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
		{type: 'select-skill'},
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
		installed: [
			{name: 'apple', path: '', scope: 'g', agents: []},
			{name: 'banana', path: '', scope: 'g', agents: []}
		]
	});

	const modes = new Set(['list', 'install', 'confirm-install', 'confirm-uninstall', 'busy']);
	for (let i = 0; i < 600; i++) {
		const action = actions[(i * 13 + 5) % actions.length];
		state = reduceSkillsViewState(state, action);
		assert.ok(modes.has(state.mode), `未知 mode: ${state.mode}`);
		assert.ok(
			state.installedIndex >= 0 && state.installedIndex < Math.max(filteredInstalled(state).length, 1),
			`installedIndex 越界: ${state.installedIndex}`
		);
		assert.ok(state.resultIndex >= 0 && state.resultIndex < Math.max(state.results.length, 1), `resultIndex 越界: ${state.resultIndex}`);
		assert.ok(state.progress.length <= 8, `progress 未裁剪: ${state.progress.length}`);
	}

	// 扁平安装全链路：open-install → search → select-skill → confirm-install → busy → done
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
	assert.equal(searched.results.length, 3, '扁平 skill 列表保留 3 个（不再按 repo 去重）');
	assert.equal(searched.queryFocused, false, '搜索完成后焦点切到 skill 列表');
	assert.equal(selectedResult(searched)?.name, 'org/a@x', '默认光标首个 skill');

	// select-skill：无光标项拦截 / 有项进 confirm-install
	const emptyResults = reduceSkillsViewState(installPage, {type: 'search-done', results: []});
	const emptySelect = reduceSkillsViewState(emptyResults, {type: 'select-skill'});
	assert.equal(emptySelect.mode, 'install', '无可选 skill 时 select-skill 留在 install');
	assert.ok(emptySelect.errorText, '无可选 skill 应提示');
	const selected = reduceSkillsViewState(searched, {type: 'select-skill'});
	assert.equal(selected.mode, 'confirm-install', 'select-skill 进 confirm-install');
	assert.equal(selectedResult(selected)?.name, 'org/a@x', 'confirm-install 仍指向当前光标 skill');

	// confirm-install：confirm → busy(install) / cancel → 回安装页（保留搜索结果）
	const installBusy = reduceSkillsViewState(selected, {type: 'confirm'});
	assert.equal(installBusy.mode, 'busy', 'confirm-install confirm 进 busy');
	assert.equal(installBusy.busyAction, 'install', 'busyAction=install');
	const backToInstall = reduceSkillsViewState(selected, {type: 'cancel'});
	assert.equal(backToInstall.mode, 'install', 'confirm-install cancel 回安装页');
	assert.equal(backToInstall.results.length, 3, 'cancel 保留搜索结果');

	// 安装页 cancel 回列表页（放弃搜索词/结果）
	const backToList = reduceSkillsViewState(backToInstall, {type: 'cancel'});
	assert.equal(backToList.mode, 'list', '安装页 cancel 回列表页');
	assert.equal(backToList.queryFocused, false, '回列表页 queryFocused 复位');

	// 无已安装时禁用 update
	const noInstalled = createInitialSkillsViewState();
	assert.equal(canManageInstalled(noInstalled), false);
	const reqUpdate = reduceSkillsViewState(noInstalled, {type: 'request-update'});
	assert.equal(reqUpdate.mode, 'list', '无已安装时 update 不进入 busy');

	// 卸载：request-uninstall → confirm-uninstall → busy(uninstall)
	// 双项列表验证光标跟随与卸载确认
	const twoInstalled = reduceSkillsViewState(createInitialSkillsViewState(), {
		type: 'installed-loaded',
		installed: [
			{name: 'apple', path: '', scope: 'g', agents: []},
			{name: 'banana', path: '', scope: 'g', agents: []}
		]
	});
	const cursorDown = reduceSkillsViewState(twoInstalled, {type: 'nav-down'});
	assert.equal(selectedInstalled(cursorDown)?.name, 'banana', '光标下移到 banana');
	assert.deepEqual(uninstallTargets(cursorDown), ['banana'], '卸载目标为当前光标项');
	const reqUninstall = reduceSkillsViewState(twoInstalled, {type: 'request-uninstall'});
	assert.equal(reqUninstall.mode, 'confirm-uninstall', 'request-uninstall 进确认');
	const uninstallBusy = reduceSkillsViewState(reqUninstall, {type: 'confirm'});
	assert.equal(uninstallBusy.mode, 'busy', 'confirm-uninstall confirm 进 busy');
	assert.equal(uninstallBusy.busyAction, 'uninstall', 'busyAction=uninstall');
	const cancelUninstall = reduceSkillsViewState(reqUninstall, {type: 'cancel'});
	assert.equal(cancelUninstall.mode, 'list', 'confirm-uninstall cancel 回列表页');

	// action-done 复位到 list（保留 installed）；action-failed 按动作回退到对应页
	const afterDone = reduceSkillsViewState(installBusy, {type: 'action-done'});
	assert.equal(afterDone.mode, 'list', 'action-done 复位 list');
	assert.equal(afterDone.busyAction, undefined, 'action-done 清空 busyAction');
	const installFailed = reduceSkillsViewState(installBusy, {type: 'action-failed', error: 'boom'});
	assert.equal(installFailed.mode, 'install', 'install 失败回安装页');
	assert.equal(installFailed.busyAction, undefined, 'action-failed 清空 busyAction');
	assert.ok(installFailed.errorText, 'action-failed 应携带 errorText');
	const uninstallFailed = reduceSkillsViewState(uninstallBusy, {type: 'action-failed', error: 'boom'});
	assert.equal(uninstallFailed.mode, 'list', 'uninstall 失败回列表页');

	console.log('[PASS] Skills 视图状态机有界 + 扁平安装/卸载/confirm/cancel/action 不变量');
}

// ── displaySkillName 派生：owner/repo@skill 只取 @ 后 skill 名，避免 confirm 弹窗与列表重复 owner/repo ──
{
	// 有 @：只取 skill 名（confirm 弹窗 `即将安装 <skill> (<source>)` 不再出现 owner/repo 重复）
	assert.equal(displaySkillName('github/awesome-copilot@pdftk-server'), 'pdftk-server', '有 @ 时取 @ 后 skill 名');
	assert.equal(displaySkillName('openai/skills@pdf'), 'pdf');

	// 无 @：原样返回
	assert.equal(displaySkillName('brainstorming'), 'brainstorming', '无 @ 时原样返回');

	// 边界：@ 结尾（split 后为空串）回退原 name，绝不返回空
	assert.equal(displaySkillName('org/repo@'), 'org/repo@', '@ 结尾回退原 name');

	console.log('[PASS] displaySkillName 取 @ 后 skill 名，confirm 弹窗与列表共用不重复 owner/repo');
}


// ── Search result → --skill 派生：只安装选中的子 skill ──────────────────────
{
	assert.equal(
		skillNameFromSearchResult({name: 'openai/skills@pdf', source: 'openai/skills', description: ''}, 'openai/skills'),
		'pdf',
		'owner/repo@skill 应派生出 --skill 参数'
	);
	assert.equal(
		skillNameFromSearchResult({name: 'standalone-skill', source: 'standalone-skill', description: ''}, 'standalone-skill'),
		undefined,
		'非 owner/repo@skill 形态不应强行派生 --skill'
	);

	console.log('[PASS] Search result 派生 --skill，仅安装选中的子 skill');
}
console.log('[PASS] Phase 5 Skills TUI 门禁全部通过');

// ── Task 8.1-8.5：agentContext 参数化 + service 映射 + 命令参数捕获 ──────────────
{
	// 8.1/8.2 映射不变量
	assert.equal(skillsAgentOf('cc'), 'claude-code');
	assert.equal(skillsAgentOf('cx'), 'codex');

	// getInstalledSkills：cc/cx 各自注入对应 --agent
	const listArgs = [];
	await getInstalledSkills('cc', async (_cmd, args) => {
		listArgs.push(args);
		return {code: 0, stdout: '[]', stderr: ''};
	});
	await getInstalledSkills('cx', async (_cmd, args) => {
		listArgs.push(args);
		return {code: 0, stdout: '[]', stderr: ''};
	});
	assert.equal(listArgs[0].includes('--agent'), true, 'list 必须带 --agent');
	assert.equal(listArgs[0][listArgs[0].indexOf('--agent') + 1], 'claude-code', 'cc list --agent=claude-code');
	assert.equal(listArgs[1][listArgs[1].indexOf('--agent') + 1], 'codex', 'cx list --agent=codex');

	// listRepoSkills：cx → --agent codex
	const repoArgs = [];
	await listRepoSkills('org/repo', 'cx', async (_cmd, args) => {
		repoArgs.push(args);
		return {code: 0, stdout: '◇  Available Skills\n│\n│    x\n', stderr: ''};
	});
	assert.equal(repoArgs[0][repoArgs[0].indexOf('--agent') + 1], 'codex', 'cx listRepoSkills --agent=codex');

	// install / installMultipleSkills / uninstall / update：cx → --agent codex
	const installArgs = [];
	await installSkill({source: 'org/repo', displayName: 'org/repo@x', skillName: 'x'}, undefined, 'cx', async (_cmd, args) => {
		installArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(installArgs[0][installArgs[0].indexOf('--agent') + 1], 'codex', 'cx install --agent=codex');

	const multiArgs = [];
	await installMultipleSkills({source: 'org/repo', skillNames: ['a']}, undefined, 'cx', async (_cmd, args) => {
		multiArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(multiArgs[0][multiArgs[0].indexOf('--agent') + 1], 'codex', 'cx installMultiple --agent=codex');

	const uninstallArgs = [];
	await uninstallSkills(['skill-a'], undefined, 'cx', async (_cmd, args) => {
		uninstallArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(uninstallArgs[0][uninstallArgs[0].indexOf('--agent') + 1], 'codex', 'cx uninstall --agent=codex');

	const updateArgs = [];
	await updateSkills([], undefined, 'cx', async (_cmd, args) => {
		updateArgs.push(args);
		return {code: 0, stdout: 'all skills up to date', stderr: ''};
	});
	assert.equal(updateArgs[0][updateArgs[0].indexOf('--agent') + 1], 'codex', 'cx update --agent=codex');

	// 8.3 service 装配：createSkillsViewServices(cx) 的 install/update/uninstall 走 codex
	const cxServices = createSkillsViewServices('cx');
	const svcInstallArgs = [];
	await cxServices.installResult(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		undefined,
		async (_cmd, args) => {
			svcInstallArgs.push(args);
			return {code: 0, stdout: '', stderr: ''};
		}
	);
	assert.equal(svcInstallArgs[0][svcInstallArgs[0].indexOf('--agent') + 1], 'codex', 'cx services.installResult --agent=codex');

	const svcUpdateArgs = [];
	await cxServices.updateAll(undefined, async (_cmd, args) => {
		svcUpdateArgs.push(args);
		return {code: 0, stdout: 'all skills up to date', stderr: ''};
	});
	assert.equal(svcUpdateArgs[0][svcUpdateArgs[0].indexOf('--agent') + 1], 'codex', 'cx services.updateAll --agent=codex');

	const svcUninstallArgs = [];
	await cxServices.uninstall(['skill-a'], undefined, async (_cmd, args) => {
		svcUninstallArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(svcUninstallArgs[0][svcUninstallArgs[0].indexOf('--agent') + 1], 'codex', 'cx services.uninstall --agent=codex');

	// 8.3 runDetection 经 service 装配也带 agentContext
	const detArgs = [];
	const detRunner = cxServices.createDetectionRunner(() => {});
	await cxServices.runDetection(detRunner, async (_cmd, args) => {
		detArgs.push(args);
		return {code: 0, stdout: '[]', stderr: ''};
	});
	assert.equal(detArgs[0][detArgs[0].indexOf('--agent') + 1], 'codex', 'cx services.runDetection --agent=codex');

	// 8.4 cc 仍走 claude-code（零破坏）
	const ccServices = createSkillsViewServices('cc');
	const ccArgs = [];
	await ccServices.installResult(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		undefined,
		async (_cmd, args) => {
			ccArgs.push(args);
			return {code: 0, stdout: '', stderr: ''};
		}
	);
	assert.equal(ccArgs[0][ccArgs[0].indexOf('--agent') + 1], 'claude-code', 'cc services.installResult --agent=claude-code');

	console.log('[PASS] 8.1-8.5 Skills agentContext 参数化：list/install/update/uninstall/detection 均按上下文注入 --agent');
}
