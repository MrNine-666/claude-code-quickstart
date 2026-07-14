import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
import {
	skillNameFromSearchResult,
	installResultToTargets,
	toggleClaudeInstall,
	updateAllSkillsBothSides,
	uninstallSkillAllAgents
} from '../src/services/skills-service.ts';
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

// Skills 首次检测复用 Tools 的全局加载组件，避免各视图维护不同的 loading 布局与文案。
{
	const toolsViewSource = readFileSync(new URL('../src/views/ToolsView.tsx', import.meta.url), 'utf8');
	const skillsViewSource = readFileSync(new URL('../src/views/SkillsView.tsx', import.meta.url), 'utf8');
	const sharedLoadingRender = 'return <ListLoadingState message="检测中..." />;';
	assert.equal(toolsViewSource.includes(sharedLoadingRender), true, 'ToolsView 应使用共享全局 loading');
	assert.equal(skillsViewSource.includes(sharedLoadingRender), true, 'SkillsView 应复用 ToolsView 的共享全局 loading');
	assert.match(skillsViewSource, /将在所有 Agent 中卸载/, 'Skills 卸载 Modal 应明确影响所有 Agent');
}

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

// ── 视图状态机有界性 + 共享投影 + 安装目标/管理安装 Modal 不变量 ──────────────
// 共享行 fixture：一行一 skill name，携带 sharedInstalled/claudeInjected/codexAvailable。
function sharedRow(name, {claude = true, codex = true} = {}) {
	return {name, path: '', scope: 'g', sharedInstalled: codex, claudeInjected: claude, codexAvailable: codex};
}
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
		{type: 'manage-inject'},
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

	const modes = new Set(['list', 'install', 'select-install-target', 'manage-inject', 'confirm-uninstall', 'busy']);
	for (let i = 0; i < 600; i++) {
		const action = actions[(i * 13 + 5) % actions.length];
		state = reduceSkillsViewState(state, action);
		assert.ok(modes.has(state.mode), `未知 mode: ${state.mode}`);
		assert.ok(
			state.installedIndex >= 0 && state.installedIndex < Math.max(filteredInstalled(state).length, 1),
			`installedIndex 越界: ${state.installedIndex}`
		);
		assert.ok(state.resultIndex >= 0 && state.resultIndex < Math.max(state.results.length, 1), `resultIndex 越界: ${state.resultIndex}`);
		assert.ok(state.targetIndex >= 0 && state.targetIndex < 2, `targetIndex 越界: ${state.targetIndex}`);
		// cx 恒 true（只读，投影/草稿不塌缩为 false）
		assert.equal(state.installDraft.cx, true, 'installDraft.cx 恒 true（Codex 只读恒勾）');
		assert.ok(state.progress.length <= 8, `progress 未裁剪: ${state.progress.length}`);
	}

	// 安装全链路：open-install → search → select-skill → select-install-target → confirm → busy → done
	const base = reduceSkillsViewState(createInitialSkillsViewState(), {
		type: 'installed-loaded',
		installed: [sharedRow('apple')]
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

	// select-skill：无光标项拦截 / 有项进 select-install-target（草稿两侧勾选）
	const emptyResults = reduceSkillsViewState(installPage, {type: 'search-done', results: []});
	const emptySelect = reduceSkillsViewState(emptyResults, {type: 'select-skill'});
	assert.equal(emptySelect.mode, 'install', '无可选 skill 时 select-skill 留在 install');
	assert.ok(emptySelect.errorText, '无可选 skill 应提示');
	const selected = reduceSkillsViewState(searched, {type: 'select-skill'});
	assert.equal(selected.mode, 'select-install-target', 'select-skill 进安装目标 Modal');
	assert.equal(selected.installDraft.cc, true, '安装草稿默认 Claude Code 勾选');
	assert.equal(selected.installDraft.cx, true, '安装草稿默认 Codex 勾选');
	assert.equal(selectedResult(selected)?.name, 'org/a@x', '安装目标仍指向当前光标 skill');

	// 安装目标 Modal：↑/↓ loop 选侧、空格仅切 Claude Code（Codex no-op）
	const navToCodex = reduceSkillsViewState(selected, {type: 'install-target-nav', delta: 1});
	assert.equal(navToCodex.targetIndex, 1, 'nav 到 Codex 侧');
	const toggleCodex = reduceSkillsViewState(navToCodex, {type: 'install-target-toggle'});
	assert.equal(toggleCodex.installDraft.cx, true, '空格切 Codex 为 no-op（恒 true）');
	const navLoop = reduceSkillsViewState(navToCodex, {type: 'install-target-nav', delta: 1});
	assert.equal(navLoop.targetIndex, 0, 'nav 首尾相接 loop 回 Claude Code');
	const toggleClaudeOff = reduceSkillsViewState(navLoop, {type: 'install-target-toggle'});
	assert.equal(toggleClaudeOff.installDraft.cc, false, '空格切 Claude Code 生效（可取消）');
	assert.equal(toggleClaudeOff.installDraft.cx, true, '切 Claude Code 不影响 Codex 恒勾');

	// confirm → busy(install) / cancel → 回安装页（保留搜索结果）
	const installBusy = reduceSkillsViewState(selected, {type: 'confirm'});
	assert.equal(installBusy.mode, 'busy', 'select-install-target confirm 进 busy');
	assert.equal(installBusy.busyAction, 'install', 'busyAction=install');
	const backToInstall = reduceSkillsViewState(selected, {type: 'cancel'});
	assert.equal(backToInstall.mode, 'install', '安装目标 Modal cancel 回安装页');
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

	// 管理安装 Modal（列表行 Enter）：草稿预置当前安装态，cx 只读恒勾
	const mixedList = reduceSkillsViewState(createInitialSkillsViewState(), {
		type: 'installed-loaded',
		installed: [sharedRow('apple', {claude: false, codex: true}), sharedRow('banana')]
	});
	const manage = reduceSkillsViewState(mixedList, {type: 'manage-inject'});
	assert.equal(manage.mode, 'manage-inject', '列表行 Enter 进管理安装 Modal');
	assert.equal(manage.installDraft.cc, false, '管理草稿预置 Claude Code 当前态（apple 未注入）');
	assert.equal(manage.installDraft.cx, true, '管理草稿 Codex 只读恒勾');
	const manageCancel = reduceSkillsViewState(manage, {type: 'cancel'});
	assert.equal(manageCancel.mode, 'list', '管理安装 Modal cancel 回列表页');
	const manageConfirm = reduceSkillsViewState(manage, {type: 'confirm'});
	assert.equal(manageConfirm.mode, 'busy', '管理安装 confirm 进 busy');

	// 卸载：request-uninstall → confirm-uninstall → busy(uninstall)（全量，无单侧）
	const twoInstalled = reduceSkillsViewState(createInitialSkillsViewState(), {
		type: 'installed-loaded',
		installed: [sharedRow('apple'), sharedRow('banana')]
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
	const manageFailed = reduceSkillsViewState(manageConfirm, {type: 'action-failed', error: 'boom'});
	assert.equal(manageFailed.mode, 'list', 'manage-inject 失败回原列表页');

	console.log('[PASS] Skills 视图状态机有界 + 共享投影 + 安装目标/管理安装 Modal（Codex 只读恒勾）不变量');
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

	// install / installMultipleSkills / uninstall：cx → --agent codex；update 为全局单次且无 --agent
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
	await updateSkills([], undefined, async (_cmd, args) => {
		updateArgs.push(args);
		return {code: 0, stdout: 'all skills up to date', stderr: ''};
	});
	assert.equal(updateArgs.length, 1, 'update 只执行一次');
	assert.equal(updateArgs[0].includes('--agent'), false, 'update 不得传 --agent');

	console.log('[PASS] 8.1-8.5 Skills 核心 action：list/install/uninstall 显式 agent，update 全局无 agent');
}

// ── Section 17/19.4：双侧共享 service（多目标安装 / 全量删省略 --agent / 单侧 --agent claude-code） ──
{
	// installResultToTargets：含 cc → 一次调用同传 [claude-code, codex] 双 --agent 触发 symlink（非逐侧多次）。
	const agentsOf = args => args.reduce((acc, a, i) => (a === '--agent' ? [...acc, args[i + 1]] : acc), []);
	const agentOf = args => args[args.indexOf('--agent') + 1];
	const bothArgs = [];
	const bothSides = await installResultToTargets(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		['cc', 'cx'],
		undefined,
		async (_cmd, args) => {
			bothArgs.push(args);
			return {code: 0, stdout: '', stderr: ''};
		}
	);
	assert.equal(bothArgs.length, 1, '含 cc 单次原子调用（非逐侧）');
	assert.deepEqual(agentsOf(bothArgs[0]).sort(), ['claude-code', 'codex'], '单次调用同传双 --agent 触发 symlink');
	assert.equal(bothSides.every(s => s.result.success), true, '结果映射回两 target 皆成功');

	// 单侧安装（仅 cc）：含 cc 补 cx，仍一次双 agent 调用。
	const ccOnlyArgs = [];
	await installResultToTargets(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		['cc'],
		undefined,
		async (_cmd, args) => {
			ccOnlyArgs.push(args);
			return {code: 0, stdout: '', stderr: ''};
		}
	);
	assert.equal(ccOnlyArgs.length, 1, '仅选 cc 也只调一次');
	assert.deepEqual(agentsOf(ccOnlyArgs[0]).sort(), ['claude-code', 'codex'], '含 cc 补 cx，一次双 --agent');

	// 仅 cx：单 agent 直落本体（universal，无 copy 问题）。
	const cxOnlyArgs = [];
	await installResultToTargets(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		['cx'],
		undefined,
		async (_cmd, args) => {
			cxOnlyArgs.push(args);
			return {code: 0, stdout: '', stderr: ''};
		}
	);
	assert.equal(cxOnlyArgs.length, 1, '仅 cx 只调一次');
	assert.deepEqual(agentsOf(cxOnlyArgs[0]), ['codex'], '仅 cx 单 --agent codex');

	// 单次原子调用失败 → 各 side 皆标失败（per-side 失败隔离退化）。
	const mixedSides = await installResultToTargets(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		['cc', 'cx'],
		undefined,
		async () => ({code: 1, stdout: '', stderr: 'boom'})
	);
	assert.equal(mixedSides.every(s => !s.result.success), true, '单次调用失败则各 side 皆失败');

	// toggleClaudeInstall(true) → 一次双 --agent（建 symlink）；(false) → remove --agent claude-code（单侧撤销）。
	const addArgs = [];
	const installedRow = {
		name: 'x', path: '', scope: 'global', source: 'org/repo', ref: 'main', skillName: 'x',
		sharedInstalled: true, claudeInjected: false, codexAvailable: true
	};
	await toggleClaudeInstall(installedRow, true, undefined, async (_cmd, args) => {
		addArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(addArgs[0].includes('add'), true, 'toggleClaudeInstall(true) 走 add');
	assert.equal(addArgs[0].includes('org/repo#main'), true, '重注入使用 lock source + ref');
	assert.equal(addArgs[0][addArgs[0].indexOf('--skill') + 1], 'x', '重注入使用 lock skillName');
	assert.deepEqual(agentsOf(addArgs[0]).sort(), ['claude-code', 'codex'], 'install 建 symlink 传双 --agent');
	const missingSource = await toggleClaudeInstall({...installedRow, source: undefined}, true);
	assert.equal(missingSource.success, false, 'lock 缺 source 时拒绝把裸 name 当 source');
	assert.match(missingSource.error ?? '', /重新搜索安装/, 'lock 缺 source 时给出可操作提示');

	const removeArgs = [];
	await toggleClaudeInstall(installedRow, false, undefined, async (_cmd, args) => {
		removeArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(removeArgs[0].includes('remove'), true, 'toggleClaudeInstall(false) 走 remove');
	assert.equal(agentOf(removeArgs[0]), 'claude-code', '单侧撤销走 --agent claude-code');

	// updateAllSkillsBothSides：CLI 的全局 update 本身覆盖所有 Agent，故只调一次且省略 --agent。
	const updBothArgs = [];
	await updateAllSkillsBothSides(undefined, async (_cmd, args) => {
		updBothArgs.push(args);
		return {code: 0, stdout: 'all skills up to date', stderr: ''};
	});
	assert.equal(updBothArgs.length, 1, '全局 update 只能调用一次');
	assert.equal(updBothArgs[0].includes('--agent'), false, '全局 update 必须省略 --agent');

	// uninstallSkillAllAgents：单条 skills remove（省略 --agent，CLI 默认全 agent + 清本体；非挨个 agent）。
	// CLI 1.5.16 的 remove 不接受 --agent '*'（报 Invalid agents: * 并 exit 1），故全量删靠省略 --agent。
	const delArgs = [];
	await uninstallSkillAllAgents('org/repo@x', undefined, async (_cmd, args) => {
		delArgs.push(args);
		return {code: 0, stdout: '', stderr: ''};
	});
	assert.equal(delArgs.length, 1, '全量删只调一次（非挨个 agent）');
	assert.equal(delArgs[0].includes('remove'), true, '全量删走 remove');
	assert.equal(delArgs[0].includes('--agent'), false, "全量删省略 --agent（不再传 '*'，避免 Invalid agents）");

	console.log("[PASS] 17/19.4 双侧共享 service：多目标安装 per-side、单侧撤销 --agent claude-code、全量删省略 --agent");
}
