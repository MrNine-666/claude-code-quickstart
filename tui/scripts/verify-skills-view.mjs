import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {
	parseSkillsFindOutput,
	parseSkillsListOutput,
	searchSkills,
	listRepoSkills,
	groupByRepo,
	getInstalledSkills,
	skillsAgentOf,
	searchSkillIdentity
} from '../src/core/skills.ts';
import {detectInstalledSkillItems, groupInstalledSkillItems, normalizeSkillSourceIdentity} from '../src/core/skills-installed.ts';
import {installSkill, installMultipleSkills, updateSkills, uninstallSkills} from '../src/core/skills-actions.ts';
import {createSkillsDetectionRunner, runSkillsDetection} from '../src/services/view-detection.ts';
import {
	skillNameFromSearchResult,
	installResultToTargets,
	installSearchResultsToTargets,
	planSkillInstallBatches,
	toggleClaudeInstall,
	uninstallSkillAllAgents
} from '../src/services/skills-service.ts';
import {
	createInitialSkillsViewState,
	reduceSkillsViewState,
	filteredInstalled,
	groupInstalledBySource,
	skillsHomeRows,
	shouldRunSearch,
	selectedOrCurrentInstalled,
	pendingBatchInstances,
	uninstallTargets,
	selectedResult,
	selectedInstalled,
	displaySkillName,
	searchInstallItems,
	selectedSearchResults,
	pendingInstallResults,
	pendingSourceReplacements
} from '../src/state/skills-view-state.ts';

// Skills 首次检测复用 Tools 的全局加载组件，避免各视图维护不同的 loading 布局与文案。
{
	const toolsViewSource = readFileSync(new URL('../src/views/tools/ToolsHomeView.tsx', import.meta.url), 'utf8');
	const skillsViewSource = [
		'skills/SkillsView.tsx',
		'skills/SkillsHomeView.tsx',
		'skills/SkillsInstallView.tsx',
		'skills/SkillsModals.tsx'
	].map(file => readFileSync(new URL(`../src/views/${file}`, import.meta.url), 'utf8')).join('\n');
	const checkboxSource = readFileSync(new URL('../src/components/checkbox.tsx', import.meta.url), 'utf8');
	const cardSource = readFileSync(new URL('../src/components/card.tsx', import.meta.url), 'utf8');
	const sharedLoadingRender = /<ListLoadingState message="检测中\.\.\." \/>/;
	assert.match(toolsViewSource, sharedLoadingRender, 'ToolsView 应使用共享全局 loading');
	assert.match(skillsViewSource, sharedLoadingRender, 'SkillsView 应复用 ToolsView 的共享全局 loading');
	// task 07-28 R7：D 删除当前逻辑实例的全部投影，但同名其它来源必须保持不变，
	// 因此确认文案从「所有 Agent」改为实例作用域 + 同名其它来源提示。
	assert.match(skillsViewSource, /的全部 Agent 与存储投影/, 'Skills 卸载 Modal 必须说明删除范围是当前实例的全部投影');
	assert.match(skillsViewSource, /同名其它来源的 \$\{sameNameOthers\} 个实例不受影响/, 'Skills 卸载 Modal 必须声明同名其它来源不受影响');
	assert.doesNotMatch(
		skillsViewSource,
		/case 'install':[\s\S]{0,160}cache\.refresh\(\)/,
		'进入安装页应复用 App 缓存，不得仅因页面切换再次刷新'
	);
	assert.doesNotMatch(checkboxSource, /TextAttributes\.INVERSE/, 'Checkbox active/checked 应使用主题前景色，不得反转为背景色');
	assert.match(skillsViewSource, /focusIndicator="leading"/, 'Skills 安装页 active 应仅使用 leading Checkbox 作为焦点指示');
	assert.match(
		skillsViewSource,
		/titleColor: active && index === view\.resultIndex \? colors\.primary : colors\.text/,
		'Skills 安装页 active 标题应使用主题色，非 active 标题使用正常文字色'
	);
	assert.doesNotMatch(
		skillsViewSource,
		/titleColor: detectionReady && item\.selectable \? colors\.primary : colors\.muted/,
		'非 active 与不可选标题不得使用主题色或 muted 色'
	);
	assert.match(
		cardSource,
		/<box flexDirection="row" flexShrink=\{0\} width=\{3\} height=\{1\} justifyContent="center" marginRight=\{1\}>/,
		'Card leading 标记必须固定在标题首行顶对齐'
	);
	assert.match(
		cardSource,
		/if \(leading !== undefined\)[\s\S]*?titleRight === undefined[\s\S]*?\/\/ 纵向布局/,
		'Card leading 布局必须渲染 titleRight，确保 Skills 状态与下载量可见'
	);
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
		assert.equal(
			multiEvents.find(event => event.instruction)?.instruction,
			'npx --yes skills@latest add org/repo --yes --agent claude-code -g --skill a --skill b --skill c',
			'Skills progress 必须上报实际批量安装命令'
		);
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
		assert.equal(updateEvents.find(event => event.instruction)?.instruction, 'npx --yes skills@latest update -g -y', 'Skills update progress 必须上报实际命令');
		assert.ok(updateEvents.some(event => event.level === 'danger'));

		// uninstall：成功路径
		const uninstallEvents = [];
		const uninstallRes = await uninstallSkills(['skill-a'], event => uninstallEvents.push(event), okExec);
		assert.equal(uninstallRes.success, true);
		assert.equal(
			uninstallEvents.find(event => event.instruction)?.instruction,
			'npx --yes skills@latest remove skill-a -g --agent claude-code --yes',
			'Skills uninstall progress 必须上报实际命令'
		);
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
		return {
			code: 0,
			stdout: JSON.stringify([
				{name: 'installed-x', path: '/home/.agents/skills/installed-x', scope: 'global', agents: ['Codex']}
			]),
			stderr: ''
		};
	};
	const runner = createSkillsDetectionRunner(state => states.push(state));
	const first = runner.run(() => detectInstalledSkillItems(okExec));
	const second = await runner.run(() => detectInstalledSkillItems(okExec));
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
// 已安装 fixture 使用逻辑实例契约（task 07-28）：身份为 (name, sourceIdentity)，
// Agent 侧只由 agents 派生，存储位置只由 path 派生。
function sharedRow(name, over = {}) {
	const {claude = true, codex = true, path} = over;
	// 显式传 `source: undefined` 表示未知来源；ES 默认参数会激活默认值，故用 `in` 判定。
	const source = 'source' in over ? over.source : `own/${name}`;
	const agents = [...(claude ? ['Claude Code'] : []), ...(codex ? ['Codex'] : [])];
	const resolvedPath = path ?? `/home/.agents/skills/${name}`;
	const root = resolvedPath.includes('.claude') ? 'claude' : resolvedPath.includes('.codex') ? 'codex' : 'agents';
	const identity = normalizeSkillSourceIdentity(source);
	const provenance = identity ? {kind: 'known', identity, source, installSource: source} : {kind: 'unknown'};
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
{
	const [projected] = groupInstalledSkillItems([{
		name: 'multi-agent',
		path: '/home/.agents/skills/multi-agent',
		scope: 'global',
		agents: ['Claude Code', 'Codex', 'Cursor', 'Cline'],
		source: 'own/multi'
	}]);
	assert.deepEqual(projected.agents, ['Claude Code', 'Codex', 'Cursor', 'Cline']);
}
{
	const actions = [
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

	const modes = new Set(['list', 'install', 'select-install-target', 'manage-inject', 'confirm-topology-change', 'confirm-uninstall', 'busy']);
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
		if (state.mode === 'select-install-target') {
			assert.equal(state.installDraft.cx, true, '新安装目标的 Codex 仍只读恒勾');
		}
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
	const resultLoopUp = reduceSkillsViewState(searched, {type: 'nav-up'});
	assert.equal(selectedResult(resultLoopUp)?.name, 'org/b@z', '安装结果列表首项向上应 loop 到末项');
	const resultLoopDown = reduceSkillsViewState(resultLoopUp, {type: 'nav-down'});
	assert.equal(selectedResult(resultLoopDown)?.name, 'org/a@x', '安装结果列表末项向下应 loop 回首项');

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
	assert.equal(flat.homeLayout, 'flat', '首次加载必须默认平铺');
	assert.equal(skillsHomeRows(flat).length, installedItems.length);
	assert.equal(skillsHomeRows(flat).every(row => row.kind === 'skill'), true, '平铺投影不应混入组标题');
	const grouped = reduceSkillsViewState(flat, {type: 'toggle-home-layout'});
	assert.equal(grouped.homeLayout, 'grouped');
	const groups = groupInstalledBySource(grouped.installed);
	assert.equal(groups.length, 3, '两个已知来源加一个未知来源展示组');
	const unknownGroup = groups.find(group => group.key === 'unknown');
	assert.equal(unknownGroup?.label, '未知来源');
	assert.equal(unknownGroup?.items.length, 2, '所有 unknown Item 应进入同一展示组');
	assert.notEqual(unknownGroup?.items[0].id, unknownGroup?.items[1].id, '未知来源展示合组不得合并路径限定 identity');
	assert.equal(skillsHomeRows(grouped).filter(row => row.kind === 'group').length, 3);
	const bananaIndex = skillsHomeRows(grouped).findIndex(row => row.kind === 'skill' && row.item.name === 'banana');
	const allCollapsed = reduceSkillsViewState({...grouped, installedIndex: bananaIndex}, {type: 'toggle-all-source-groups'});
	assert.deepEqual(new Set(allCollapsed.collapsedSourceKeys), new Set(groups.map(group => group.key)), 'e 应收起全部来源组');
	assert.equal(skillsHomeRows(allCollapsed).every(row => row.kind === 'group'), true, '全部收起后只保留组标题');
	const collapsedAnchor = skillsHomeRows(allCollapsed)[allCollapsed.installedIndex];
	assert.equal(collapsedAnchor?.kind, 'group', '收起全部后光标应落在原 Skill 所属组');
	assert.equal(collapsedAnchor?.kind === 'group' && collapsedAnchor.group.items.some(item => item.name === 'banana'), true);
	const allExpanded = reduceSkillsViewState(allCollapsed, {type: 'toggle-all-source-groups'});
	assert.equal(allExpanded.collapsedSourceKeys.length, 0, '全部已收起时再次按 e 应全部展开');
	const filteredCollapse = reduceSkillsViewState({...grouped, filterText: 'unknown'}, {type: 'toggle-all-source-groups'});
	assert.deepEqual(new Set(filteredCollapse.collapsedSourceKeys), new Set(groups.map(group => group.key)), '过滤不得缩窄全部收起范围');
	assert.strictEqual(reduceSkillsViewState(flat, {type: 'toggle-all-source-groups'}), flat, '平铺模式下 e 必须 no-op');

	const unknownHeaderIndex = skillsHomeRows(grouped).findIndex(row => row.kind === 'group' && row.group.key === 'unknown');
	const collapsed = reduceSkillsViewState({...grouped, installedIndex: unknownHeaderIndex}, {type: 'toggle-source-group'});
	assert.equal(collapsed.collapsedSourceKeys.includes('unknown'), true);
	assert.equal(skillsHomeRows(collapsed).some(row => row.kind === 'skill' && row.item.name.startsWith('unknown-')), false);
	const selectedWhileCollapsed = reduceSkillsViewState(
		{...collapsed, filterText: 'unknown', installedIndex: 0},
		{type: 'select-all-installed'}
	);
	assert.deepEqual(
		new Set(selectedWhileCollapsed.pickedInstalledIds),
		new Set(unknownGroup.items.map(item => item.id)),
		'收缩组中的匹配 Item 仍必须进入 a 的当前过滤范围'
	);
	const deselectedWhileCollapsed = reduceSkillsViewState(selectedWhileCollapsed, {type: 'select-all-installed'});
	assert.equal(deselectedWhileCollapsed.pickedInstalledIds.length, 0, '当前过滤范围已全选时 a 应只取消该范围');

	const picked = {...flat, pickedInstalledIds: [installedItems[0].id, installedItems[3].id]};
	assert.deepEqual(selectedOrCurrentInstalled(picked).map(item => item.id), picked.pickedInstalledIds, '批量动作应优先显式多选');
	const requestedUpdate = reduceSkillsViewState(picked, {type: 'request-update'});
	assert.equal(requestedUpdate.mode, 'busy');
	assert.deepEqual(pendingBatchInstances(requestedUpdate).map(item => item.id), picked.pickedInstalledIds, '更新必须锁定选中快照');
	const requestedBatchUninstall = reduceSkillsViewState(picked, {type: 'request-uninstall'});
	assert.deepEqual(uninstallTargets(requestedBatchUninstall).map(item => item.id), picked.pickedInstalledIds, '卸载确认必须锁定选中快照');
	const reconciled = reduceSkillsViewState(
		{...requestedUpdate, homeLayout: 'grouped', collapsedSourceKeys: ['unknown'], filterText: 'app'},
		{type: 'lifecycle-reconciled', installed: installedItems.slice(0, 3)}
	);
	assert.deepEqual(reconciled.pickedInstalledIds, [installedItems[0].id], '复检后多选只保留仍存在的 Item id');
	assert.equal(reconciled.homeLayout, 'grouped');
	assert.deepEqual(reconciled.collapsedSourceKeys, ['unknown']);
	assert.equal(reconciled.filterText, 'app');

	// 无已安装时不启动 update；未知来源不得进入批量更新。
	const noInstalled = createInitialSkillsViewState();
	const reqUpdate = reduceSkillsViewState(noInstalled, {type: 'request-update'});
	assert.equal(reqUpdate.mode, 'list', '无已安装时 update 不进入 busy');
	const localOnlyUpdate = reduceSkillsViewState(
		{...noInstalled, installed: [sharedRow('local-only', {source: undefined})]},
		{type: 'request-update'}
	);
	assert.equal(localOnlyUpdate.mode, 'list', '未知来源的 Skill 不得进入更新');
	assert.match(localOnlyUpdate.errorText ?? '', /未知来源/);

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
	const installedLoopDown = reduceSkillsViewState(cursorDown, {type: 'nav-down'});
	assert.equal(selectedInstalled(installedLoopDown)?.name, 'apple', '已安装列表末项向下应 loop 回首项');
	const installedLoopUp = reduceSkillsViewState(twoInstalled, {type: 'nav-up'});
	assert.equal(selectedInstalled(installedLoopUp)?.name, 'banana', '已安装列表首项向上应 loop 到末项');
	assert.equal(selectedOrCurrentInstalled(cursorDown)[0].name, 'banana', '无多选时卸载目标回退当前光标项');
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

	console.log('[PASS] Skills 视图状态机有界 + 新安装 Codex 必选 + 存量 C/X/B 管理不变量');
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

// ── 扁平跨来源批量安装：共享身份 + source 批次规划/顺序执行 ────────────────
{
	const sourceAOne = {name: 'org/a@one', source: 'org/a', description: ''};
	const sourceATwo = {name: 'org/a@two', source: 'org/a', description: ''};
	const sourceBThree = {name: 'org/b@three', source: 'org/b', description: ''};

	assert.deepEqual(searchSkillIdentity(sourceAOne), {
		key: JSON.stringify(['org/a', 'one']),
		source: 'org/a',
		skillName: 'one'
	}, '搜索结果身份应由 source + 子 Skill 名共同决定');
	assert.equal(searchSkillIdentity({name: 'standalone', source: '', description: ''}), undefined, '无法派生子 Skill 身份时应禁选');

	const plan = planSkillInstallBatches([sourceAOne, sourceATwo, sourceBThree, sourceATwo]);
	assert.deepEqual(plan, [
		{source: 'org/a', skillNames: ['one', 'two']},
		{source: 'org/b', skillNames: ['three']}
	], 'planner 应按首次出现顺序合并同 source，并去重同 source 子 Skill');

	const calls = [];
	let activeCalls = 0;
	let maxActiveCalls = 0;
	const execution = await installSearchResultsToTargets(
		[sourceAOne, sourceATwo, sourceBThree],
		['cc', 'cx'],
		undefined,
		async (_cmd, args) => {
			activeCalls++;
			maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
			calls.push(args);
			await Promise.resolve();
			activeCalls--;
			return args.includes('org/a')
				? {code: 1, stdout: '', stderr: 'source a failed'}
				: {code: 0, stdout: 'done', stderr: ''};
		}
	);
	assert.equal(maxActiveCalls, 1, '不同 source 必须顺序执行');
	assert.equal(calls.length, 2, '一个 source 失败后仍应继续后续 source');
	assert.equal(calls[0].filter(value => value === '--skill').length, 2, '同 source 多 Skill 应合并为一次多 --skill 调用');
	assert.deepEqual(execution.batches.map(batch => batch.result.success), [false, true], '批次结果应保留每个 source 的独立结果');

	let conflictSpawned = false;
	await assert.rejects(
		() => installSearchResultsToTargets(
			[sourceAOne, {name: 'org/b@one', source: 'org/b', description: ''}],
			['cx'],
			undefined,
			async () => {
				conflictSpawned = true;
				return {code: 0, stdout: '', stderr: ''};
			}
		),
		/同名/,
		'不同 source 的同名 Skill 应在 spawn 前被拒绝'
	);
	assert.equal(conflictSpawned, false, '同名冲突不得启动任何命令');

	console.log('[PASS] 扁平跨来源批量安装按 source 合并、顺序执行、失败隔离并防御同名冲突');
}

// ── 安装页多选资格 + Modal 快照 + 最终检测对账 ────────────────────────────
{
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
	assert.deepEqual(items.map(item => item.status), ['available', 'available', 'available', 'installed', 'available']);
	const equivalentSourceState = {
		...state,
		installed: [sharedRow('langchain-rag', {source: 'https://github.com/langchain-ai/langchain-skills.git'})],
		results: [{name: 'langchain-ai/langchain-skills@langchain-rag', source: 'langchain-ai/langchain-skills', description: ''}]
	};
	assert.equal(
		searchInstallItems(equivalentSourceState)[0]?.status,
		'installed',
		'GitHub sourceUrl 与 owner/repo 简写应识别为同一来源'
	);
	// prd R4：同名异来源在搜索页仍可选（source-replacement），只有选定目标且目标根冲突
	// 才显示「已有同名」覆盖确认；搜索页未选目标时不能预先判 name-occupied。
	assert.equal(
		searchInstallItems({
			...equivalentSourceState,
			installed: [sharedRow('langchain-rag', {source: 'https://github.com/other/repo.git'})]
		})[0]?.status,
		'source-replacement',
		'同名异来源在搜索页应可选，目标根占用留待选定目标后判定'
	);
	const selectAll = reduceSkillsViewState(state, {type: 'select-all-results'});
	assert.deepEqual(
		selectedSearchResults(selectAll).map(result => result.name),
		['org/a@alpha', 'org/a@beta', 'org/b@gamma'],
		'全选应排除已安装项，并为同名结果只保留首个可安装来源'
	);
	state = reduceSkillsViewState(state, {type: 'toggle-result'});
	items = searchInstallItems(state);
	assert.equal(items[0].selected, true, 'Space 应选择当前可安装项');
	assert.equal(items[1].status, 'selection-conflict', '选中一个来源后，同名其它来源应立即冲突禁选');

	state = reduceSkillsViewState({...state, resultIndex: 1}, {type: 'toggle-result'});
	assert.equal(state.pickedResultKeys.length, 1, '同名冲突项不得进入选择集合');
	state = reduceSkillsViewState({...state, resultIndex: 3}, {type: 'toggle-result'});
	assert.equal(state.pickedResultKeys.length, 1, '已安装项不得进入选择集合');
	state = reduceSkillsViewState({...state, resultIndex: 2}, {type: 'toggle-result'});
	state = reduceSkillsViewState({...state, resultIndex: 4}, {type: 'toggle-result'});
	assert.deepEqual(selectedSearchResults(state).map(result => result.name), ['org/a@alpha', 'org/a@beta', 'org/b@gamma']);

	const modal = reduceSkillsViewState(state, {type: 'select-skill'});
	assert.equal(modal.mode, 'select-install-target');
	assert.deepEqual(pendingInstallResults(modal).map(result => result.name), ['org/a@alpha', 'org/a@beta', 'org/b@gamma'], 'Modal 应快照整批选择');
	const modalCancel = reduceSkillsViewState(modal, {type: 'cancel'});
	assert.equal(modalCancel.pickedResultKeys.length, 3, 'Modal 取消应保留显式选择');
	assert.equal(modalCancel.pendingInstallKeys.length, 0, 'Modal 取消只清 pending 快照');

	const executing = reduceSkillsViewState(modal, {type: 'confirm'});
	assert.equal(executing.batchStage, 'executing');
	const reconciling = reduceSkillsViewState(executing, {type: 'install-execution-done'});
	assert.equal(reconciling.batchStage, 'reconciling');
	const reconciled = reduceSkillsViewState(reconciling, {
		type: 'install-reconciled',
		installed: [sharedRow('installed-one', {source: 'org/c'}), sharedRow('alpha', {source: 'org/a'}), sharedRow('beta', {source: 'org/a'})]
	});
	assert.equal(reconciled.mode, 'install', '批量完成后必须停留在安装页');
	assert.equal(reconciled.query, state.query, '对账应保留查询');
	assert.equal(reconciled.results, state.results, '对账应保留扁平结果引用');
	assert.equal(reconciled.resultIndex, state.resultIndex, '对账应保留光标');
	assert.deepEqual(selectedSearchResults(reconciled).map(result => result.name), ['org/b@gamma'], '成功项取消选择，仍缺失项保持选择以便重试');
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
	assert.deepEqual(selectedSearchResults(targetIncomplete).map(result => result.name), ['org/b@gamma']);
	const repeatedCacheLoad = reduceSkillsViewState(targetIncomplete, {
		type: 'installed-loaded',
		installed: incompleteInstalled
	});
	assert.deepEqual(
		selectedSearchResults(repeatedCacheLoad).map(result => result.name),
		['org/b@gamma'],
		'同一 postflight cache 结果的 effect 不得清掉 reducer 已保留的未确认选择'
	);
	const allSucceeded = reduceSkillsViewState(reconciling, {
		type: 'install-reconciled',
		installed: [sharedRow('installed-one', {source: 'org/c'}), sharedRow('alpha', {source: 'org/a'}), sharedRow('beta', {source: 'org/a'}), sharedRow('gamma', {source: 'org/b'})]
	});
	assert.equal(selectedSearchResults(allSucceeded).length, 0, '全部成功后应清空整批选择');
	const allFailed = reduceSkillsViewState(reconciling, {
		type: 'install-reconciled',
		installed: [sharedRow('installed-one')]
	});
	assert.deepEqual(
		selectedSearchResults(allFailed).map(result => result.name),
		['org/a@alpha', 'org/a@beta', 'org/b@gamma'],
		'全部失败后应保留整批选择以便重试'
	);

	const retryModal = reduceSkillsViewState(reconciled, {type: 'select-skill'});
	const retryBusy = reduceSkillsViewState(retryModal, {type: 'confirm'});
	const unconfirmed = reduceSkillsViewState(retryBusy, {type: 'install-reconcile-failed', error: '检测失败'});
	assert.equal(unconfirmed.mode, 'install', '安装后检测失败仍停留安装页');
	assert.deepEqual(selectedSearchResults(unconfirmed).map(result => result.name), ['org/b@gamma'], '检测失败保留可恢复选择');
	assert.match(unconfirmed.errorText ?? '', /检测失败/);

	const newSearch = reduceSkillsViewState(reconciled, {
		type: 'search-done',
		results: [{name: 'org/new@delta', source: 'org/new', description: ''}]
	});
	assert.equal(newSearch.pickedResultKeys.length, 0, '新搜索必须清空旧结果选择');
	assert.equal(newSearch.pendingInstallKeys.length, 0, '新搜索不得留下隐藏 pending 目标');

	const singleton = reduceSkillsViewState(newSearch, {type: 'select-skill'});
	assert.equal(pendingInstallResults(singleton).length, 1, '无显式多选时 Enter 应回退为当前单项批次');

	console.log('[PASS] 安装页多选资格、同名冲突、Modal 快照、留页与最终检测对账');
}

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

	// 仅 cx：单 Agent + --copy，并用 scoped CODEX_HOME 物化到 canonical .agents。
	const cxOnlyArgs = [];
	const cxOnlyOptions = [];
	await installResultToTargets(
		{name: 'org/repo@x', source: 'org/repo', description: ''},
		['cx'],
		undefined,
		async (_cmd, args, options) => {
			cxOnlyArgs.push(args);
			cxOnlyOptions.push(options);
			return {code: 0, stdout: '', stderr: ''};
		}
	);
	assert.equal(cxOnlyArgs.length, 1, '仅 cx 只调一次');
	assert.deepEqual(agentsOf(cxOnlyArgs[0]), ['codex'], '仅 cx 单 --agent codex');
	assert.equal(cxOnlyArgs[0].includes('--copy'), true, '仅 Codex 必须显式物化实体');
	assert.match(cxOnlyOptions[0].env.CODEX_HOME, /\.agents$/, '仅 Codex 必须把 CODEX_HOME 定向到 canonical .agents');
	assert.match(cxOnlyOptions[0].env.CLAUDE_CONFIG_DIR, /\.claude$/, 'Skills 子进程必须显式固定 CLAUDE_CONFIG_DIR');

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

// Skills 三态管理与同名来源替换：安装页只放开可证明的异来源，管理页统一进入 topology 强确认。
{
	const storage = (kind, name) => ({
		kind,
		name,
		claudePath: `/home/.claude/skills/${name}`,
		canonicalPath: `/home/.agents/skills/${name}`,
		claudeValid: kind === 'claude-only' || kind === 'shared-symlink' || kind === 'shared-copy',
		canonicalValid: kind === 'canonical-only' || kind === 'shared-symlink' || kind === 'shared-copy'
	});
	const replacementResult = {name: 'new/repo@same', source: 'new/repo', description: ''};
	const replacementState = {
		...createInitialSkillsViewState(),
		mode: 'install',
		installed: [{...sharedRow('same', {source: 'old/repo'}), storage: storage('shared-symlink', 'same')}],
		results: [replacementResult],
		queryFocused: false
	};
	const replacementItem = searchInstallItems(replacementState)[0];
	assert.equal(replacementItem.status, 'source-replacement', '可证明同名不同源时应进入来源替换状态');
	assert.equal(replacementItem.selectable, true, '同名不同源允许选择');

	const sameSourceItem = searchInstallItems({
		...replacementState,
		results: [{name: 'old/repo@same', source: 'old/repo', description: ''}]
	})[0];
	assert.equal(sameSourceItem.selectable, false, '同来源已安装仍禁选');

	const unknownSourceItem = searchInstallItems({
		...replacementState,
		installed: [{...sharedRow('same', {source: undefined}), storage: storage('canonical-only', 'same')}]
	})[0];
	assert.equal(unknownSourceItem.selectable, false, '旧来源未知不得猜测为可替换');

	const claudeOnly = {
		...createInitialSkillsViewState(),
		installed: [{...sharedRow('local-only', {claude: true, codex: false}), storage: storage('claude-only', 'local-only')}]
	};
	const topologyRows = [
		{kind: 'claude-only', draft: {cc: true, cx: false}},
		{kind: 'canonical-only', draft: {cc: false, cx: true}},
		{kind: 'shared-symlink', draft: {cc: true, cx: true}},
		{kind: 'shared-copy', draft: {cc: true, cx: true}}
	];
	for (const {kind, draft} of topologyRows) {
		const row = {
			...createInitialSkillsViewState(),
			installed: [{...sharedRow(kind, {claude: draft.cc, codex: draft.cx}), storage: storage(kind, kind)}]
		};
		const manage = reduceSkillsViewState(row, {type: 'manage-inject'});
		assert.deepEqual(manage.installDraft, draft, `${kind} 应按物理事实初始化草稿`);
		const toggledCc = reduceSkillsViewState({...manage, targetIndex: 0}, {type: 'install-target-toggle'});
		const toggledCx = reduceSkillsViewState({...manage, targetIndex: 1}, {type: 'install-target-toggle'});
		assert.notEqual(toggledCc.installDraft.cc, draft.cc, `${kind} 的 Claude 目标应可编辑`);
		assert.notEqual(toggledCx.installDraft.cx, draft.cx, `${kind} 的 Codex 目标应可编辑`);
	}

	const cManage = reduceSkillsViewState(claudeOnly, {type: 'manage-inject'});
	const cNoop = reduceSkillsViewState(cManage, {type: 'request-topology-change'});
	assert.equal(cNoop.mode, 'list', '精确 C no-op 应直接关闭管理 Modal');
	const cToX = reduceSkillsViewState({...cManage, installDraft: {cc: false, cx: true}}, {type: 'request-topology-change'});
	assert.equal(cToX.mode, 'confirm-topology-change', 'C→X 必须经过统一强确认');
	assert.equal(reduceSkillsViewState(cToX, {type: 'cancel'}).mode, 'manage-inject', '取消拓扑确认应回管理 Modal并保留草稿');
	const emptyTarget = reduceSkillsViewState({...cManage, installDraft: {cc: false, cx: false}}, {type: 'request-topology-change'});
	assert.equal(emptyTarget.mode, 'manage-inject');
	assert.match(emptyTarget.errorText ?? '', /d|卸载/, '零目标应引导使用全量卸载');

	const busyCancelled = reduceSkillsViewState({
		...cManage,
		mode: 'busy',
		busyAction: 'update',
		busyReturnMode: 'list',
		progress: ['更新中'],
		errorText: '旧错误'
	}, {type: 'cancel-busy'});
	assert.equal(busyCancelled.mode, 'list', '取消 busy 后返回原 Skills 页面');
	assert.equal(busyCancelled.busyAction, undefined, '取消 busy 后清空动作');
	assert.deepEqual(busyCancelled.progress, [], '取消 busy 后清空进度');
	assert.equal(busyCancelled.errorText, undefined, '用户取消不得显示为失败');

	let replacement = reduceSkillsViewState(replacementState, {type: 'toggle-result'});
	replacement = reduceSkillsViewState(replacement, {type: 'select-skill'});
	const replacementConfirm = reduceSkillsViewState(replacement, {type: 'request-source-replacement'});
	assert.equal(replacementConfirm.mode, 'confirm-source-replacement', '来源替换必须经过独立强确认');
	assert.equal(reduceSkillsViewState(replacementConfirm, {type: 'cancel'}).mode, 'select-install-target');

	const multiRootReplacement = {
		...replacement,
		installed: [
			sharedRow('same', {source: 'old/agents', claude: false, path: '/home/.agents/skills/same'}),
			sharedRow('same', {source: 'old/claude', codex: false, path: '/home/.claude/skills/same'})
		]
	};
	const multiRootConflicts = pendingSourceReplacements(multiRootReplacement);
	assert.equal(multiRootConflicts.length, 2, 'Shared 目标覆盖两个根的异源实例时确认列表必须展示两项');
	assert.deepEqual(
		multiRootConflicts.map(item => item.installed.provenance.installSource).sort(),
		['old/agents', 'old/claude']
	);
	assert.deepEqual(
		multiRootConflicts.map(item => item.projections.map(projection => projection.root)),
		[['agents'], ['claude']],
		'确认项只展示本次会被覆盖的目标根投影'
	);

	const skillsViewSource = [
		'skills/SkillsInstallView.tsx',
		'skills/SkillsModals.tsx'
	].map(file => readFileSync(new URL(`../src/views/${file}`, import.meta.url), 'utf8')).join('\n');
	assert.match(skillsViewSource, /已有同名/, '同名异来源列表文案固定为“已有同名”');
	assert.match(skillsViewSource, /当前来源[\s\S]*新来源/, '来源替换确认必须展示旧/新 source');
	assert.match(skillsViewSource, /目标根[\s\S]*完整 CLI 检测/, '来源替换确认必须说明目标根覆盖与最终复检');
	assert.match(skillsViewSource, /item\.installed\.id/, '同一新来源对应多个旧实例时 Modal key 必须区分旧实例');

	console.log('[PASS] Skills 同名来源替换资格、固定文案与 C/X/B 统一强确认状态机');
}
