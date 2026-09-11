import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React, {act} from 'react';
import {PasteEvent, RGBA} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {SingleLineInput} from '../src/components/single-line-input.tsx';
import {SkillsView} from '../src/views/skills/SkillsView.tsx';
import {handleSkillsKey} from '../src/views/skills/skills-view-input.ts';

function key(name, modifiers = {}) {
	return {
		name,
		sequence: name === 'enter' ? '\r' : name,
		ctrl: false,
		shift: false,
		meta: false,
		option: false,
		eventType: 'press',
		repeated: false,
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		...modifiers
	};
}

// 已安装 fixture 使用逻辑实例契约（task 07-28）：身份为 (name, sourceIdentity)，
// Agent 侧只来自 agents，存储位置只来自 path，不再有 storage 物理检查字段。
const item = (over = {}) => {
	const name = over.name ?? 'same';
	const source = 'source' in over ? over.source : 'old/repo';
	const sourceUrl = over.sourceUrl;
	const installSource = sourceUrl ?? source;
	const path = over.path ?? '/home/.agents/skills/' + name;
	const agents = over.agents ?? ['Claude Code', 'Codex'];
	const root = path.includes('.claude')
		? 'claude'
		: path.includes('.codex')
			? 'codex'
			: path.includes('.pi/agent/skills')
				? 'pi-global'
				: path.includes('.pi/skills')
					? 'pi-project'
					: 'agents';
	const identity = installSource
		? 'github:' +
			String(installSource)
				.replace(/^https?:\/\/github\.com\//, '')
				.replace(/\.git$/, '')
				.toLowerCase()
		: undefined;
	const provenance = identity
		? {kind: 'known', identity, ...(source ? {source} : {}), ...(sourceUrl ? {sourceUrl} : {}), installSource}
		: {kind: 'unknown'};
	const known = provenance.kind === 'known';
	return {
		id: JSON.stringify(known ? ['known', name, identity] : ['unknown', name, path]),
		name,
		provenance,
		agents,
		projections: [{path, root, scope: 'global', agents}],
		capabilities: {update: known, manageAgents: known, migrate: known, delete: true}
	};
};

const cache = {
	state: {
		status: 'success',
		result: [
			item({name: 'same', agents: ['Claude Code'], path: '/home/.claude/skills/same'}),
			item({name: 'second', agents: ['Codex'], source: 'own/second', sourceUrl: 'https://github.com/own/second'}),
			item({name: 'third', agents: ['Pi'], source: undefined, path: '/home/.agents/skills/third'})
		]
	},
	refresh() {},
	async refreshAndWait() {
		return this.state;
	}
};
let searchCallCount = 0;
const services = {
	async searchSkills() {
		searchCallCount++;
		return {ok: true, results: [{name: 'new/repo@same', source: 'new/repo', description: 'replacement'}]};
	},
	async installBatchToTargets() {
		return {batches: [], replacements: []};
	},
	async finalizeReplacementSnapshots() {},
	async transitionTopology() {
		return {
			success: false,
			outcome: 'failed',
			mutated: true,
			error: 'simulated adoption failure'
		};
	},
	async updateInstances(items) {
		return {success: true, selectedCount: items.length, updatedNames: items.map(item => item.name), skippedInstanceIds: []};
	},
	async uninstallInstances(items) {
		return {
			outcome: 'complete',
			mutated: true,
			items: items.map(item => ({item, result: {outcome: 'complete', mutated: true}}))
		};
	},
	createDetectionRunner() {
		throw new Error('external cache should be reused');
	},
	async runDetection() {}
};

// 输入框拿到页面逻辑焦点后，↑/↓ 必须留给原生 input，不能再被页面
// 键盘处理器转成列表导航，否则鼠标点击搜索框后仍会改变 active 条目。
const noOpTaskCancellation = {start: () => null, cancel: () => false, finish() {}};
for (const focusedView of [
	{mode: 'install', queryFocused: true},
	{mode: 'list', filterFocused: true}
]) {
	for (const name of ['up', 'down', 'escape']) {
		const actions = [];
		const event = key(name);
		handleSkillsKey(event, focusedView, action => actions.push(action), services, cache, undefined, noOpTaskCancellation);
		assert.deepEqual(actions, [], `${focusedView.mode} 输入框的 ${name} 不得切换列表 active 或返回菜单`);
		assert.equal(event.defaultPrevented, false, `${focusedView.mode} 输入框的 ${name} 不应被页面拦截`);
	}
}

let skillsExitCount = 0;
const firstListLeft = key('left');
handleSkillsKey(
	firstListLeft,
	{mode: 'list', filterFocused: false, installedIndex: 0},
	() => {},
	services,
	cache,
	() => {
		skillsExitCount++;
	},
	noOpTaskCancellation
);
assert.equal(skillsExitCount, 1, 'Skills 列表首项左键应返回菜单');
assert.equal(firstListLeft.defaultPrevented, true, 'Skills 列表首项左键应阻止继续冒泡');
const nonFirstListLeft = key('left');
handleSkillsKey(
	nonFirstListLeft,
	{mode: 'list', filterFocused: false, installedIndex: 1},
	() => {},
	services,
	cache,
	() => {
		skillsExitCount++;
	},
	noOpTaskCancellation
);
assert.equal(skillsExitCount, 1, 'Skills 非首项左键不应返回菜单');

const firstInstallListLeft = key('left');
handleSkillsKey(
	firstInstallListLeft,
	{mode: 'install', queryFocused: false, resultIndex: 0},
	() => {},
	services,
	cache,
	() => {
		skillsExitCount++;
	},
	noOpTaskCancellation
);
assert.equal(skillsExitCount, 2, 'Skills 安装结果首项左键应返回菜单');

const skillsViewSource = ['skills/SkillsView.tsx', 'skills/SkillsHomeView.tsx', 'skills/SkillsInstallView.tsx', 'skills/SkillsModals.tsx']
	.map(file => readFileSync(new URL(`../src/views/${file}`, import.meta.url), 'utf8'))
	.join('\n');
const inputSource = readFileSync(new URL('../src/components/single-line-input.tsx', import.meta.url), 'utf8');
const checkboxSource = readFileSync(new URL('../src/components/checkbox.tsx', import.meta.url), 'utf8');
const cardSource = readFileSync(new URL('../src/components/card.tsx', import.meta.url), 'utf8');
const scrollListSource = readFileSync(new URL('../src/components/scroll-list.tsx', import.meta.url), 'utf8');
assert.match(inputSource, /<input[\s\S]*value=\{value\}[\s\S]*onChange=/, '共享搜索框必须使用受控 OpenTUI input');
assert.match(inputSource, /onMouseDown=\{onFocus \?/, '共享搜索框必须把鼠标点击同步给页面逻辑焦点');
assert.match(
	skillsViewSource,
	/label="过滤"[\s\S]*onFocus=\{\(\) => dispatch\(\{type: 'filter-focus'\}\)\}/,
	'Skills 已安装过滤框必须把鼠标点击同步为过滤焦点'
);
assert.doesNotMatch(
	skillsViewSource,
	/filterText\.slice|view\.filterText \+ char|query\.slice|view\.query \+ char/,
	'SkillsView 不得继续手工编辑字符串'
);
assert.match(skillsViewSource, /skillsModalOpen\(view\.mode\)/, 'Skills Modal 打开时背景页面必须失焦');
assert.match(skillsViewSource, /onFocus=\{onFocusSearch\}/, 'Skills 安装页必须接收共享输入的鼠标焦点通知');
assert.match(
	skillsViewSource,
	/renderPage\(view, detection, pageActive, dispatch, focusInstallSearch, submitInstallSearch\)/,
	'SkillsView 必须把搜索焦点回调传入安装页'
);
assert.match(skillsViewSource, /<ScrollList items=\{items\}/, 'Skills 已安装页必须是单列 ScrollList');
assert.match(skillsViewSource, /focusIndicator="card"/, 'Skills 条目聚焦态必须复用 Card 的边框与背景');
assert.match(
	skillsViewSource,
	/<RadioField[\s\S]*label="布局："[\s\S]*value=\{view\.homeLayout\}[\s\S]*compact/,
	'布局摘要必须复用紧凑 RadioField 展示平铺/分组'
);
assert.match(skillsViewSource, /<Checkbox checked=\{selected\} focused=\{focused\} \/>/, 'Skills 条目必须展示多选 Checkbox');
assert.match(
	skillsViewSource,
	/view\.homeLayout === 'flat' \? `\$\{row\.item\.name\}（\$\{installedSourceLabel\(row\.item\)\}）` : row\.item\.name/,
	'平铺标题显示 name（source），分组标题只显示 name'
);
assert.match(skillsViewSource, /<a href=\{url\}/, '安全 sourceUrl 必须渲染为可点击链接');
assert.match(
	skillsViewSource,
	/<a href=\{url\} fg=\{colors\.muted\} attributes=\{TextAttributes\.DIM \| TextAttributes\.UNDERLINE\}>/,
	'已安装 sourceUrl 颜色必须与安装页 muted + DIM 一致'
);
assert.match(skillsViewSource, /无来源链接/, '无安全 sourceUrl 必须显示固定 fallback');
assert.match(
	skillsViewSource,
	/StateBadge label=\{AGENT_CONTEXT_LABELS\.cc\}[\s\S]*itemAvailableOn\(skill, 'cc'\)[\s\S]*StateBadge label=\{AGENT_CONTEXT_LABELS\.cx\}[\s\S]*itemAvailableOn\(skill, 'cx'\)[\s\S]*StateBadge label=\{AGENT_CONTEXT_LABELS\.pi\}[\s\S]*itemAvailableOn\(skill, 'pi'\)/,
	'Agent 状态行必须只按 agents 映射展示 Claude Code、Codex 与 Pi'
);
assert.doesNotMatch(skillsViewSource, /StateBadge label="Codex \/ Pi"/, 'Skills 卡片不得展示 Codex / Pi 共享状态');
assert.doesNotMatch(
	skillsViewSource,
	/StateBadge label="Pi global"|StateBadge label="Pi project"/,
	'Skills 卡片不应展示 Pi global/project 状态'
);
assert.doesNotMatch(skillsViewSource, /Pi（全局原生）|Pi（项目原生）/, 'Skills 目标 Modal 不应展开 Pi global/project 选项');
assert.match(skillsViewSource, /SKILLS_MANAGE_TARGET_ORDER/, 'Skills 管理 Modal 必须使用独立的 Agent 目标集合');
assert.match(
	skillsViewSource,
	/migrating[\s\S]*检测到旧版安装，应用后会迁移到当前支持的位置/,
	'Skills 拓扑确认应以用户可理解的文案提示旧版安装迁移'
);
assert.match(
	checkboxSource,
	/disabled \? colors\.muted : focused \|\| checked \? colors\.primary : colors\.muted/,
	'安装页与已安装页共用 Checkbox 必须使用主题色'
);
assert.match(checkboxSource, /<text fg=\{checkboxColor\}>\{checkmark\}<\/text>/, 'Checkbox 勾选内容必须与边框共用主题色');
assert.match(skillsViewSource, /bordered: false/, '分组标题必须声明为无边框行');
assert.match(scrollListSource, /bordered=\{item\.bordered\}/, 'ScrollList 必须把无边框语义透传给 Card');
assert.match(cardSource, /borderStyle=\{bordered \? 'rounded' : undefined\}/, 'Card 必须只在 bordered 开启时渲染边框');

// 鼠标点击会让 OpenTUI 原生 input 自己取得真实焦点，但不会同步 Skills/扩展页的
// queryFocused/focus 状态；共享 input 必须在这个状态不同步时仍能触发提交回调。
let mouseSubmitted = 0;
let mouseValue = '';
const mouseSubmitSetup = await testRender(
	React.createElement(SingleLineInput, {
		label: '搜索',
		value: mouseValue,
		focused: true,
		placeholder: '输入关键词',
		onChange: value => {
			mouseValue = value;
		},
		onSubmit: () => {
			mouseSubmitted++;
		}
	}),
	{width: 40, height: 3}
);
try {
	await mouseSubmitSetup.mockMouse.click(8, 1);
	await mouseSubmitSetup.mockInput.typeText('pi');
	mouseSubmitSetup.mockInput.pressEnter();
	await mouseSubmitSetup.renderOnce();
	assert.equal(mouseValue, 'pi', '鼠标点击后的 input 仍应接收输入');
	assert.equal(mouseSubmitted, 1, '鼠标点击后的 Enter 必须提交一次');
} finally {
	await act(async () => {
		mouseSubmitSetup.renderer.destroy();
	});
}
assert.match(inputSource, /onSubmit=/, '鼠标聚焦后 Enter 必须由共享 input 提交');

// 页面焦点与 OpenTUI 原生焦点是两套状态：点击一个原本未被页面标记为焦点的
// input 后，页面必须同步切回搜索焦点，否则全局 useKeyboard 会先把 Enter 当成
// Grid 快捷键消费。这个测试故意从 focused=false 开始覆盖真实鼠标路径。
let mouseFocusNotified = false;
let statefulMouseSubmitted = 0;
let statefulMouseValue = '';
function MouseFocusHarness() {
	const [focused, setFocused] = React.useState(false);
	return React.createElement(SingleLineInput, {
		label: '搜索',
		value: statefulMouseValue,
		focused,
		placeholder: '输入关键词',
		onChange: value => {
			statefulMouseValue = value;
		},
		onFocus: () => {
			mouseFocusNotified = true;
			setFocused(true);
		},
		onSubmit: () => {
			statefulMouseSubmitted++;
		}
	});
}
const statefulMouseSetup = await testRender(React.createElement(MouseFocusHarness), {width: 40, height: 3});
try {
	await statefulMouseSetup.renderOnce();
	await act(async () => {
		await statefulMouseSetup.mockMouse.click(8, 1);
		await statefulMouseSetup.renderOnce();
	});
	assert.equal(mouseFocusNotified, true, '点击原生 input 必须通知页面同步搜索焦点');
	await statefulMouseSetup.mockInput.typeText('pi');
	statefulMouseSetup.mockInput.pressEnter();
	await statefulMouseSetup.renderOnce();
	assert.equal(statefulMouseSubmitted, 1, '同步页面焦点后鼠标 Enter 必须提交一次');
} finally {
	await act(async () => {
		statefulMouseSetup.renderer.destroy();
	});
}

// 完整安装页路径：先用 Tab 让 reducer 认为焦点在结果列表，再点击搜索框。
// 若页面没有收到鼠标焦点通知，下面的 Enter 会落入 select-skill，而不会发起搜索。
const mousePageSetup = await testRender(React.createElement(SkillsView, {services, cache, active: true}), {width: 64, height: 24});
try {
	await mousePageSetup.waitForFrame(frame => frame.includes('same（old/repo）'));
	const pagePress = async name => {
		await act(async () => {
			mousePageSetup.renderer.keyInput.emit('keypress', key(name));
			await mousePageSetup.renderOnce();
		});
	};
	await pagePress('i');
	const installFrame = await mousePageSetup.waitForFrame(frame => frame.includes('输入关键词搜索 skills.sh'));
	const searchY = installFrame.split('\n').findIndex(line => line.includes('搜索：'));
	assert.ok(searchY >= 0, '完整安装页回归必须定位到搜索框');
	await pagePress('tab');
	await act(async () => {
		await mousePageSetup.mockMouse.click(8, searchY);
		await mousePageSetup.renderOnce();
	});
	await act(async () => {
		await mousePageSetup.mockInput.typeText('pi');
		mousePageSetup.mockInput.pressEnter();
		await mousePageSetup.renderOnce();
	});
	await mousePageSetup.waitForFrame(frame => frame.includes('new/repo'));
	assert.equal(searchCallCount, 1, '完整安装页鼠标点回搜索框后 Enter 必须发起一次搜索');
} finally {
	await act(async () => {
		mousePageSetup.renderer.destroy();
	});
}

const existingSearchBaseline = searchCallCount;
const setup = await testRender(React.createElement(SkillsView, {services, cache, active: true}), {width: 64, height: 24});

try {
	const flatFrame = await setup.waitForFrame(
		frame => frame.includes('same（old/repo）') && frame.includes('second（own/second）') && frame.includes('third（未知来源）')
	);
	const focusedSkillTitleSpans = setup
		.captureSpans()
		.lines.flatMap(line => line.spans)
		.filter(span => span.text.includes('same（old/repo）'));
	assert.ok(focusedSkillTitleSpans.length > 0, 'Skills 当前条目必须渲染聚焦标题 Span');
	assert.equal(
		focusedSkillTitleSpans.every(span => span.bg.equals(RGBA.fromHex('#2A1A10'))),
		true,
		'Skills 当前条目必须使用 Card 的主题聚焦背景'
	);
	const flatLines = flatFrame.split('\n');
	assert.match(flatFrame, /布局：[\s\S]*平铺[\s\S]*分组[\s\S]*已选 0/, '平铺模式顶部必须使用 Radio 展示布局选项与已选数量');
	assert.match(flatFrame, /Claude Code[\s\S]*Codex[\s\S]*Pi/, 'Skills 卡片应展示 Claude Code、Codex、Pi 三种 Agent 状态');
	assert.doesNotMatch(flatFrame, /● Codex \/ Pi|○ Codex \/ Pi/, 'Skills 卡片不得渲染 Codex / Pi 共享状态');
	assert.doesNotMatch(flatFrame, /Pi global|Pi project/, 'Skills 卡片不应展示 Pi global/project 状态');
	const firstTitle = flatLines.findIndex(line => line.includes('same（old/repo）'));
	const firstFallback = flatLines.findIndex((line, index) => index > firstTitle && line.includes('无来源链接'));
	const firstStatus = flatLines.findIndex((line, index) => index > firstFallback && line.includes('Claude') && line.includes('Codex'));
	const secondTitle = flatLines.findIndex(line => line.includes('second（own/second）'));
	const secondStatus = flatLines.findIndex((line, index) => index > secondTitle && line.includes('● Codex'));
	const thirdTitle = flatLines.findIndex(line => line.includes('third（未知来源）'));
	const thirdStatus = flatLines.findIndex((line, index) => index > thirdTitle && line.includes('● Pi'));
	assert.ok(
		firstTitle >= 0 && firstFallback > firstTitle && firstStatus > firstFallback,
		'平铺 Skill 必须按标题/来源链接/Agent 状态三行排列'
	);
	assert.ok(secondTitle > firstStatus, '已安装 Skill 必须一行一列纵向排列');
	assert.ok(secondStatus > secondTitle, 'Codex 状态必须直接映射 agents 数组');
	assert.ok(thirdStatus > thirdTitle, 'Pi 状态必须直接映射 agents 数组');
	assert.match(flatFrame, /https:\/\/github\.com\/own\/second/, '有效 sourceUrl 应展示原始 URL');
	assert.equal(
		flatLines.every(line => line.length <= 64),
		true,
		'平铺三行条目不得撑破窄终端'
	);
	const press = async (name, modifiers) => {
		await act(async () => {
			setup.renderer.keyInput.emit('keypress', key(name, modifiers));
			await setup.renderOnce();
		});
	};
	await press('space');
	await setup.waitForFrame(frame => frame.includes('[✓]') && frame.includes('已选 1'));
	await press('v');
	const groupedFrame = await setup.waitForFrame(frame => /[▾▸][\s\S]*old\/repo/.test(frame));
	assert.equal(groupedFrame.includes('same（old/repo）'), false, '分组模式 Skill 标题只显示 name');
	assert.match(groupedFrame, /[▾▸][\s\S]*old\/repo/, '分组标题应展示展开/收缩指示');
	await press('v');
	await press('tab');
	for (const name of ['a', 'b', 'left', 'x']) await press(name);
	let edited = await setup.waitForFrame(frame => frame.includes('axb'));
	assert.equal(edited.includes('same'), false, '真实过滤 input 的光标插入应同步 reducer 并过滤列表');
	assert.match(edited, /布局：[\s\S]*平铺[\s\S]*分组[\s\S]*已选 1/, '平铺过滤无结果时仍必须展示 Radio 布局选项与已选数量');
	await act(async () => {
		setup.renderer.keyInput.emit('paste', new PasteEvent(new TextEncoder().encode('Q\nR')));
		await setup.renderOnce();
	});
	await setup.waitForFrame(frame => frame.includes('axQRb'));
	const editMod = process.platform === 'darwin' ? {super: true} : {ctrl: true};
	await press('a', editMod);
	await press('x', editMod);
	await setup.waitForFrame(frame => frame.includes('same'));
	await press('z', editMod);
	await setup.waitForFrame(frame => frame.includes('axQRb'));
	await press('z', {...editMod, shift: true});
	await setup.waitForFrame(frame => frame.includes('same'));
	console.log('[PASS] OpenTUI Skills 原生 input：光标插入、paste 单行化、全选/剪切、撤销/重做');
	await act(async () => {
		setup.renderer.keyInput.emit('paste', new PasteEvent(new TextEncoder().encode('X'.repeat(240))));
		await setup.renderOnce();
	});
	const longInputFrame = await setup.waitForFrame(frame => frame.includes('XXXXX'));
	assert.equal(
		longInputFrame.split('\n').every(line => line.length <= 64),
		true,
		'超长粘贴必须在 input 内滚动，不得撑破窄终端'
	);
	await press('a', editMod);
	await press('x', editMod);
	await setup.waitForFrame(frame => frame.includes('same'));
	await press('tab');
	await setup.waitForFrame(frame => frame.includes('same'));
	// 列表页 i 进安装页，x 输入搜索词，enter 提交搜索
	for (const name of ['i', 'x', 'enter']) {
		await press(name);
	}
	await setup.waitForFrame(frame => frame.includes('new/repo'));
	assert.equal(searchCallCount, existingSearchBaseline + 1, '搜索框 Enter 只能提交一次');
	for (const name of ['space', 'enter', 'enter']) {
		await press(name);
	}
	const frame = await setup.waitForFrame(value => value.includes('确认覆盖同名 Skill'));
	assert.match(frame, /当前来源：old\/repo/);
	assert.match(frame, /新来源：new\/repo/);
	assert.match(frame, /目标根[\s\S]*完整 CLI 检测/, '覆盖确认应说明目标根范围与最终 CLI 复检');
	assert.equal(
		frame.split('\n').every(line => line.length <= 64),
		true,
		'窄终端帧不得横向溢出'
	);
	console.log('[PASS] OpenTUI Skills 同名覆盖确认 Modal：窄终端、旧/新来源与复检范围展示');
} finally {
	await act(async () => {
		setup.renderer.destroy();
	});
}

// 迁移场景 fixture：`.claude` 仅 Claude 实例（可迁移），加一个双侧共享实例。
const adoptName = 'langchain-dependencies';
const adoptCache = {
	...cache,
	refreshCount: 0,
	async refreshAndWait() {
		this.refreshCount++;
		return this.state;
	},
	state: {
		status: 'success',
		result: [
			item({name: adoptName, agents: ['Claude Code'], path: '/home/.claude/skills/' + adoptName, source: 'own/langchain'}),
			item({name: 'same', agents: ['Claude Code', 'Codex']})
		]
	}
};
const adoptSetup = await testRender(React.createElement(SkillsView, {services, cache: adoptCache, active: true}), {width: 76, height: 24});

try {
	await adoptSetup.waitForFrame(frame => frame.includes(adoptName));
	const press = async name => {
		await act(async () => {
			adoptSetup.renderer.keyInput.emit('keypress', key(name));
			await adoptSetup.renderOnce();
		});
	};
	await adoptSetup.waitForFrame(frame => frame.includes('(1/2)'));
	await press('enter');
	await adoptSetup.waitForFrame(frame => frame.includes('管理安装'));
	await press('up');
	let modalFrame = await adoptSetup.waitForFrame(frame => frame.includes('Claude Code'));
	assert.match(modalFrame, /\(1\/2\)/, 'Skills Modal 上键不得移动背景列表');
	assert.match(modalFrame, /Pi/, 'Skills 管理 Modal 必须显示独立 Pi 入口');
	await press('down');
	modalFrame = await adoptSetup.waitForFrame(frame => frame.includes('Codex'));
	assert.match(modalFrame, /\(1\/2\)/, 'Skills Modal 下键不得移动背景列表');
	for (const name of ['down', 'space', 'enter']) await press(name);
	const frame = await adoptSetup.waitForFrame(value => value.includes('确认更新安装范围'));
	assert.match(frame, /当前安装到：Claude Code/);
	assert.match(frame, /变更为：Claude Code、Codex/);
	assert.match(frame, /本次新增：Codex/);
	assert.doesNotMatch(frame, /确认切换安装拓扑/);
	assert.doesNotMatch(frame, /来源：|其它 Agent：|\/home\/|\.agents\/skills/);
	assert.match(frame, /Enter\s+确认执行/, '拓扑确认弹窗应显示 Enter 操作提示');
	assert.match(frame, /Esc\s+取消/, '拓扑确认弹窗应显示 Esc 取消提示');
	await press('enter');
	await adoptSetup.waitForFrame(value => value.includes('simulated adoption failure'));
	assert.equal(adoptCache.refreshCount, 1, '收编 mutation 后即使 service 返回失败也必须刷新一次共享检测');
	console.log('[PASS] OpenTUI Skills Modal：快捷键提示、上下键隔离与 mutation 失败后刷新');
} finally {
	await act(async () => {
		adoptSetup.renderer.destroy();
	});
}
