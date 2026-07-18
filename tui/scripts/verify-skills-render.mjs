import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React, {act} from 'react';
import {PasteEvent} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {SkillsView} from '../src/views/SkillsView.tsx';

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

const storage = {
	name: 'same',
	kind: 'shared-symlink',
	claudePath: '/home/.claude/skills/same',
	canonicalPath: '/home/.agents/skills/same',
	claudeValid: true,
	canonicalValid: true
};
const cache = {
	state: {
		status: 'success',
		result: [{
			name: 'same',
			path: storage.canonicalPath,
			scope: 'global',
			agents: ['Claude Code'],
			source: 'old/repo',
			storage
		}]
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
			inspection: adoptStorage,
			error: 'simulated adoption failure'
		};
	},
	async updateBothSides() {
		return {success: true};
	},
	async uninstallAllAgents() {
		return {success: true};
	},
	createDetectionRunner() {
		throw new Error('external cache should be reused');
	},
	async runDetection() {}
};

const skillsViewSource = readFileSync(new URL('../src/views/SkillsView.tsx', import.meta.url), 'utf8');
const inputSource = readFileSync(new URL('../src/components/single-line-input.tsx', import.meta.url), 'utf8');
assert.match(inputSource, /<input[\s\S]*value=\{value\}[\s\S]*onChange=/, '共享搜索框必须使用受控 OpenTUI input');
assert.doesNotMatch(inputSource, /onSubmit=/, 'Enter 只能由 Skills 页顶层 handler 提交');
assert.doesNotMatch(skillsViewSource, /filterText\.slice|view\.filterText \+ char|query\.slice|view\.query \+ char/, 'SkillsView 不得继续手工编辑字符串');
assert.match(
	skillsViewSource,
	/renderPage\(view, detection, active && !skillsModalOpen\(view\.mode\), dispatch\)/,
	'Skills Modal 打开时背景页面必须失焦'
);

const setup = await testRender(
	React.createElement(SkillsView, {services, cache, active: true}),
	{width: 64, height: 24}
);

try {
	await setup.waitForFrame(frame => frame.includes('same'));
	const press = async (name, modifiers) => {
		await act(async () => {
			setup.renderer.keyInput.emit('keypress', key(name, modifiers));
			await setup.renderOnce();
		});
	};
	await press('tab');
	for (const name of ['a', 'b', 'left', 'x']) await press(name);
	let edited = await setup.waitForFrame(frame => frame.includes('axb'));
	assert.equal(edited.includes('same'), false, '真实过滤 input 的光标插入应同步 reducer 并过滤列表');
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
	// 列表页键位重排后 i 进安装页（原 a 现为“更新全部”），x 输入搜索词，enter 提交搜索
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
	assert.match(frame, /共享本体与 lock 来源/);
	assert.equal(frame.split('\n').every(line => line.length <= 64), true, '窄终端帧不得横向溢出');
	console.log('[PASS] OpenTUI Skills 同名覆盖确认 Modal：窄终端交互与旧/新来源展示');
} finally {
	await act(async () => {
		setup.renderer.destroy();
	});
}

const adoptStorage = {
	name: 'langchain-dependencies',
	kind: 'claude-only',
	claudePath: '/home/.claude/skills/langchain-dependencies',
	canonicalPath: '/home/.agents/skills/langchain-dependencies',
	claudeValid: true,
	canonicalValid: false
};
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
			{
				name: adoptStorage.name,
				path: adoptStorage.claudePath,
				scope: 'global',
				agents: ['Claude Code'],
				storage: adoptStorage
			},
			{
				name: storage.name,
				path: storage.canonicalPath,
				scope: 'global',
				agents: ['Claude Code', 'Codex'],
				storage
			}
		]
	}
};
const adoptSetup = await testRender(
	React.createElement(SkillsView, {services, cache: adoptCache, active: true}),
	{width: 76, height: 24}
);

try {
	await adoptSetup.waitForFrame(frame => frame.includes(adoptStorage.name));
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
