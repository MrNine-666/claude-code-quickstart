import assert from 'node:assert/strict';
import {parseSkillsFindOutput, searchSkills, getInstalledSkills} from '../dist/core/skills.js';
import {installSkill, updateSkills, uninstallSkills} from '../dist/core/skills-actions.js';
import {createSkillsDetectionRunner, runSkillsDetection} from '../dist/services/view-detection.js';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	shouldRunSearch,
	canManageInstalled,
	uninstallTargets
} from '../dist/state/skills-view-state.js';

// Phase 5 Skills TUI 门禁：parser fixture（7.4）、不依赖 catalogue（7.8）、
// 进度 callback 不直接 console（7.9）、异步检测状态机（7.10）、视图状态机有界性。

// ── 7.4 skills find parser fixture：成功 / 无结果 / 不可解析 / 命令不可用 ──────
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
	// 回归：旧 split(/\s{2,}/) 分列导致只解析出 1 条且 name 为 URL，必须解析出全部 3 条。
	const block = parseSkillsFindOutput(
		'github/awesome-copilot@pdftk-server 9.6K installs\n└ https://skills.sh/github/awesome-copilot/pdftk-server\n\nopenai/skills@pdf 8K installs\n└ https://skills.sh/openai/skills/pdf'
	);
	assert.equal(block?.length, 2, '真实块状格式应解析出全部条目（回归：旧逻辑只出 1 条）');
	assert.equal(block?.[0]?.name, 'github/awesome-copilot@pdftk-server', 'name 非 URL');
	assert.equal(block?.[1]?.name, 'openai/skills@pdf');

	// 无结果（有输出但无可解析条目 → 空数组，区别于 null）
	const empty = parseSkillsFindOutput('未找到匹配的技能。');
	assert.deepEqual(empty, [], '有输出但无结果应返回空数组');

	// 不可解析 / 完全无输出 → null
	assert.equal(parseSkillsFindOutput(''), null, '完全无输出返回 null');

	// 命令不可用（stderr 含 not recognized，stdout 空）→ null
	const unavailable = parseSkillsFindOutput('', "'skills' is not recognized as an internal or external command");
	assert.equal(unavailable, null, '命令不可用且无 stdout 应返回 null');

	console.log('[PASS] 7.4 skills find parser fixture（成功/无结果/不可解析/命令不可用）');
}

// ── 7.8 搜索不依赖 catalogue：注入 exec 桩驱动结果，catalogue 不参与 ────────────
{
	const fakeExec = async (_cmd, args) => {
		assert.equal(args.includes('find'), true, '搜索必须调用 skills find');
		return {code: 0, stdout: JSON.stringify([{name: 'found-by-find', source: 'x/y', description: 'from find'}]), stderr: ''};
	};

	const outcome = await searchSkills('anything', fakeExec);
	assert.equal(outcome.ok, true);
	assert.equal(outcome.results[0].name, 'found-by-find', '结果完全来自 skills find，不来自 catalogue');

	// 空查询不触发 CLI（exec 不应被调用）
	let called = false;
	const guardExec = async () => {
		called = true;
		return {code: 0, stdout: '', stderr: ''};
	};
	const emptyOutcome = await searchSkills('   ', guardExec);
	assert.equal(emptyOutcome.ok, false);
	assert.equal(called, false, '空/纯空白查询不得触发 skills find');

	console.log('[PASS] 7.8 搜索由 skills find 驱动，不依赖 catalogue，空查询不触发 CLI');
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

		// install：成功路径上报 info + success 事件
		const installEvents = [];
		const installRes = await installSkill(
			{source: 'org/skill', displayName: 'skill'},
			event => installEvents.push(event),
			okExec
		);
		assert.equal(installRes.success, true);
		assert.ok(installEvents.some(e => e.level === 'success'), 'install 成功应上报 success 事件');

		// update：失败路径上报 danger 事件并返回结构化错误
		const updateEvents = [];
		const updateRes = await updateSkills([], event => updateEvents.push(event), failExec);
		assert.equal(updateRes.success, false);
		assert.ok(updateRes.error.includes('网络'), '失败错误应经 getFriendlyError 归一化');
		assert.ok(updateEvents.some(e => e.level === 'danger'), 'update 失败应上报 danger 事件');

		// uninstall：成功路径
		const uninstallEvents = [];
		const uninstallRes = await uninstallSkills(['skill-a'], event => uninstallEvents.push(event), okExec);
		assert.equal(uninstallRes.success, true);
		assert.ok(uninstallEvents.length > 0, 'uninstall 应上报进度事件');

		// 空名单 uninstall 直接结构化失败，不 spawn
		const emptyRes = await uninstallSkills([], () => {}, okExec);
		assert.equal(emptyRes.success, false);

		assert.equal(consoleHits, 0, 'Skills action service 不得直接写 console');
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}

	console.log('[PASS] 7.9 action 进度经 callback 上报，service 不直接 console 输出');
}

// ── 7.10 异步检测状态机：进行中不重复触发，loading → success/error ────────────
{
	// 成功：进行中第二次 run 复用 loading，不重复触发底层任务
	let runCount = 0;
	const states = [];
	const okExec = async () => {
		runCount++;
		return {code: 0, stdout: JSON.stringify([{name: 'installed-x', scope: 'global'}]), stderr: ''};
	};
	const runner = createSkillsDetectionRunner(state => states.push(state));
	// 直接复用 view-detection 的 runner，但注入 exec 桩需经 getInstalledSkills；
	// 这里用 runner.run 包裹注入桩的检测，验证并发去重语义。
	const first = runner.run(() => getInstalledSkills(okExec));
	const second = await runner.run(() => getInstalledSkills(okExec));
	assert.equal(second.status, 'loading', '检测进行中第二次触发应复用 loading');
	const final = await first;
	assert.equal(final.status, 'success');
	assert.equal(final.result[0].name, 'installed-x');
	assert.equal(runCount, 1, '进行中不得重复触发底层检测');
	assert.deepEqual(states.map(s => s.status), ['loading', 'success']);

	// 失败：检测抛错 → error 状态，用户可重试
	const errStates = [];
	const errRunner = createSkillsDetectionRunner(state => errStates.push(state));
	const failed = await errRunner.run(async () => {
		throw new Error('npx 不可用');
	});
	assert.equal(failed.status, 'error');
	assert.equal(failed.error, 'npx 不可用');
	// reset 后可再次触发
	const reset = errRunner.reset();
	assert.equal(reset.status, 'idle');

	console.log('[PASS] 7.10 异步检测进行中不重复触发，loading → success/error 正确迁移');
}

// ── 视图状态机有界性 + 关键不变量 ──────────────────────────────────────────────
{
	const actions = [
		{type: 'nav-up'},
		{type: 'nav-down'},
		{type: 'toggle-select'},
		{type: 'open-search'},
		{type: 'query-input', value: 'x'},
		{type: 'submit-search'},
		{type: 'search-done', results: [{name: 'r1', source: 's', description: 'd'}]},
		{type: 'request-install'},
		{type: 'confirm'},
		{type: 'cancel'},
		{type: 'request-update'},
		{type: 'request-uninstall'},
		{type: 'action-done', summary: 'ok'},
		{type: 'action-failed', error: 'boom'}
	];

	let state = createInitialSkillsViewState();
	state = reduceSkillsViewState(state, {
		type: 'installed-loaded',
		installed: [
			{name: 'a', path: '', scope: 'g', agents: []},
			{name: 'b', path: '', scope: 'g', agents: []}
		]
	});

	const modes = new Set(['list', 'search-input', 'search-results', 'confirm-install', 'confirm-uninstall', 'busy']);
	for (let i = 0; i < 600; i++) {
		const action = actions[(i * 13 + 5) % actions.length];
		state = reduceSkillsViewState(state, action);
		assert.ok(modes.has(state.mode), `未知 mode: ${state.mode}`);
		assert.ok(state.installedIndex >= 0 && state.installedIndex < Math.max(state.installed.length, 1), `installedIndex 越界: ${state.installedIndex}`);
		assert.ok(state.resultIndex >= 0, `resultIndex 下界越界: ${state.resultIndex}`);
		assert.ok(state.results.length === 0 || state.resultIndex < state.results.length, `resultIndex 上界越界: ${state.resultIndex}`);
		assert.ok(state.progress.length <= 8, `progress 未裁剪: ${state.progress.length}`);
	}

	// 空查询不触发搜索的不变量
	const emptyQuery = reduceSkillsViewState(createInitialSkillsViewState(), {type: 'open-search'});
	assert.equal(shouldRunSearch(emptyQuery), false);
	const submitEmpty = reduceSkillsViewState(emptyQuery, {type: 'submit-search'});
	assert.equal(submitEmpty.mode, 'search-input', '空查询提交不进入 busy');
	assert.ok(submitEmpty.errorText, '空查询提交应提示');

	// 无已安装时禁用 update/uninstall
	const noInstalled = createInitialSkillsViewState();
	assert.equal(canManageInstalled(noInstalled), false);
	const reqUpdate = reduceSkillsViewState(noInstalled, {type: 'request-update'});
	assert.equal(reqUpdate.mode, 'list', '无已安装时 update 不进入 busy');

	// 多选优先于光标的卸载目标
	let multi = reduceSkillsViewState(createInitialSkillsViewState(), {
		type: 'installed-loaded',
		installed: [
			{name: 'a', path: '', scope: 'g', agents: []},
			{name: 'b', path: '', scope: 'g', agents: []}
		]
	});
	multi = reduceSkillsViewState(multi, {type: 'nav-down'});
	multi = reduceSkillsViewState(multi, {type: 'toggle-select'});
	assert.deepEqual(uninstallTargets(multi), ['b'], '多选优先');

	console.log('[PASS] Skills 视图状态机有界 + 空查询/禁用/多选不变量');
}

console.log('[PASS] Phase 5 Skills TUI 门禁全部通过');
