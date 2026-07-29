import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React, {act} from 'react';
import {PasteEvent} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {SkillsView} from '../src/views/skills/SkillsView.tsx';

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
	const root = path.includes('.claude') ? 'claude' : path.includes('.codex') ? 'codex' : 'agents';
	const identity = installSource
		? 'github:' + String(installSource).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').toLowerCase()
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
			item({name: 'third', agents: ['Codex'], source: undefined, path: '/home/.codex/skills/third'})
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

const skillsViewSource = [
	'skills/SkillsView.tsx',
	'skills/SkillsHomeView.tsx',
	'skills/SkillsInstallView.tsx',
	'skills/SkillsModals.tsx'
].map(file => readFileSync(new URL(`../src/views/${file}`, import.meta.url), 'utf8')).join('\n');
const inputSource = readFileSync(new URL('../src/components/single-line-input.tsx', import.meta.url), 'utf8');
const checkboxSource = readFileSync(new URL('../src/components/checkbox.tsx', import.meta.url), 'utf8');
const cardSource = readFileSync(new URL('../src/components/card.tsx', import.meta.url), 'utf8');
const scrollListSource = readFileSync(new URL('../src/components/scroll-list.tsx', import.meta.url), 'utf8');
assert.match(inputSource, /<input[\s\S]*value=\{value\}[\s\S]*onChange=/, '共享搜索框必须使用受控 OpenTUI input');
assert.doesNotMatch(inputSource, /onSubmit=/, 'Enter 只能由 Skills 页顶层 handler 提交');
assert.doesNotMatch(skillsViewSource, /filterText\.slice|view\.filterText \+ char|query\.slice|view\.query \+ char/, 'SkillsView 不得继续手工编辑字符串');
assert.match(
	skillsViewSource,
	/skillsModalOpen\(view\.mode\)/,
	'Skills Modal 打开时背景页面必须失焦'
);
assert.match(skillsViewSource, /<ScrollList items=\{items\}/, 'Skills 已安装页必须是单列 ScrollList');
assert.match(skillsViewSource, /<RadioField[\s\S]*label="布局："[\s\S]*value=\{view\.homeLayout\}[\s\S]*compact/, '布局摘要必须复用紧凑 RadioField 展示平铺/分组');
assert.match(skillsViewSource, /<Checkbox checked=\{selected\} focused=\{focused\} \/>/, 'Skills 条目必须展示多选 Checkbox');
assert.match(skillsViewSource, /view\.homeLayout === 'flat' \? `\$\{row\.item\.name\}（\$\{installedSourceLabel\(row\.item\)\}）` : row\.item\.name/, '平铺标题显示 name（source），分组标题只显示 name');
assert.match(skillsViewSource, /<a href=\{url\}/, '安全 sourceUrl 必须渲染为可点击链接');
assert.match(skillsViewSource, /<a href=\{url\} fg=\{colors\.muted\} attributes=\{TextAttributes\.DIM \| TextAttributes\.UNDERLINE\}>/, '已安装 sourceUrl 颜色必须与安装页 muted + DIM 一致');
assert.match(skillsViewSource, /无来源链接/, '无安全 sourceUrl 必须显示固定 fallback');
assert.match(skillsViewSource, /StateBadge label=\{AGENT_CONTEXT_LABELS\.cc\}[\s\S]*StateBadge label=\{AGENT_CONTEXT_LABELS\.cx\}/, '第三行必须同时展示 Claude Code/Codex 状态');
assert.match(checkboxSource, /disabled \? colors\.muted : focused \|\| checked \? colors\.primary : colors\.muted/, '安装页与已安装页共用 Checkbox 必须使用主题色');
assert.match(checkboxSource, /<text fg=\{checkboxColor\}>\{checkmark\}<\/text>/, 'Checkbox 勾选内容必须与边框共用主题色');
assert.match(skillsViewSource, /bordered: false/, '分组标题必须声明为无边框行');
assert.match(scrollListSource, /bordered=\{item\.bordered\}/, 'ScrollList 必须把无边框语义透传给 Card');
assert.match(cardSource, /borderStyle=\{bordered \? 'rounded' : undefined\}/, 'Card 必须只在 bordered 开启时渲染边框');

const setup = await testRender(
	React.createElement(SkillsView, {services, cache, active: true}),
	{width: 64, height: 24}
);

try {
	const flatFrame = await setup.waitForFrame(frame => frame.includes('same（old/repo）') && frame.includes('second（own/second）') && frame.includes('third（未知来源）'));
	const flatLines = flatFrame.split('\n');
	assert.match(flatFrame, /布局：[\s\S]*平铺[\s\S]*分组[\s\S]*已选 0/, '平铺模式顶部必须使用 Radio 展示布局选项与已选数量');
	const firstTitle = flatLines.findIndex(line => line.includes('same（old/repo）'));
	const firstFallback = flatLines.findIndex((line, index) => index > firstTitle && line.includes('无来源链接'));
	const firstStatus = flatLines.findIndex((line, index) => index > firstFallback && line.includes('Claude Code') && line.includes('Codex'));
	const secondTitle = flatLines.findIndex(line => line.includes('second（own/second）'));
	assert.ok(firstTitle >= 0 && firstFallback > firstTitle && firstStatus > firstFallback, '平铺 Skill 必须按标题/来源链接/Agent 状态三行排列');
	assert.ok(secondTitle > firstStatus, '已安装 Skill 必须一行一列纵向排列');
	assert.match(flatFrame, /https:\/\/github\.com\/own\/second/, '有效 sourceUrl 应展示原始 URL');
	assert.equal(flatLines.every(line => line.length <= 64), true, '平铺三行条目不得撑破窄终端');
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
	assert.equal(longInputFrame.split('\n').every(line => line.length <= 64), true, '超长粘贴必须在 input 内滚动，不得撑破窄终端');
	await press('a', editMod);
	await press('x', editMod);
	await setup.waitForFrame(frame => frame.includes('same'));
	await press('escape');
	await setup.waitForFrame(frame => frame.includes('same'));
	// 列表页 i 进安装页，x 输入搜索词，enter 提交搜索
	for (const name of ['i', 'x', 'enter']) {
		await press(name);
	}
	await setup.waitForFrame(frame => frame.includes('new/repo'));
	assert.equal(searchCallCount, 1, '搜索框 Enter 只能提交一次');
	for (const name of ['space', 'enter', 'enter']) {
		await press(name);
	}
	const frame = await setup.waitForFrame(value => value.includes('确认覆盖同名 Skill'));
	assert.match(frame, /当前来源：old\/repo/);
	assert.match(frame, /新来源：new\/repo/);
	assert.match(frame, /目标根[\s\S]*完整 CLI 检测/, '覆盖确认应说明目标根范围与最终 CLI 复检');
	assert.equal(frame.split('\n').every(line => line.length <= 64), true, '窄终端帧不得横向溢出');
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
const adoptSetup = await testRender(
	React.createElement(SkillsView, {services, cache: adoptCache, active: true}),
	{width: 76, height: 24}
);

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
	await press('down');
	modalFrame = await adoptSetup.waitForFrame(frame => frame.includes('Codex'));
	assert.match(modalFrame, /\(1\/2\)/, 'Skills Modal 下键不得移动背景列表');
	for (const name of ['down', 'space', 'enter']) await press(name);
	const frame = await adoptSetup.waitForFrame(value => value.includes('确认切换安装拓扑'));
	assert.match(frame, /仅 Claude Code → 双侧共享/);
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
