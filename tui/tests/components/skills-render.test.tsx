import React, {act} from 'react';
import {KeyEvent, PasteEvent, RGBA, type ParsedKey} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import {SingleLineInput} from '../../src/components/single-line-input.js';
import type {InstalledSkillItem} from '../../src/core/skills-installed.js';
import type {DetectionCache} from '../../src/hooks/use-detection-cache.js';
import type {TaskCancellation} from '../../src/hooks/use-task-cancellation.js';
import type {DetectionState} from '../../src/services/async-detection.js';
import {createInitialSkillsViewState, type SkillsViewAction, type SkillsViewState} from '../../src/state/skills-view-state.js';
import {SkillsHomeView} from '../../src/views/skills/SkillsHomeView.js';
import {SkillsView} from '../../src/views/skills/SkillsView.js';
import {handleSkillsKey} from '../../src/views/skills/skills-view-input.js';
import type {SkillsDetection, SkillsViewServices} from '../../src/views/skills/skills-view-types.js';

// 迁自 scripts/verify-skills-render.mjs 的 render/交互段（试点批 implement Step 4）。
// P1-G3 已把原脚本剩余 27 条源码正则断言逐条分类：22 条改写为本文件/其他 tests 的行为断言，
// 5 条有 spec 背书但无行为等价物的静态合同并入 scripts/verify-view-architecture.mjs 的 P1-G3 段，
// 原脚本因只剩空壳已删除（tui/package.json verify 链同步移除）。
// 每个 testRender 用例固定 terminal 尺寸，并在 finally 的 act() 内销毁 renderer。

function key(name: string, modifiers: Partial<ParsedKey> = {}): KeyEvent {
	return new KeyEvent({
		name,
		sequence: name === 'enter' ? '\r' : name,
		ctrl: false,
		shift: false,
		meta: false,
		option: false,
		number: false,
		raw: name === 'enter' ? '\r' : name,
		eventType: 'press',
		source: 'raw',
		repeated: false,
		...modifiers
	});
}

// 已安装 fixture 使用逻辑实例契约（task 07-28）：身份为 (name, sourceIdentity)，
// Agent 侧只来自 agents，存储位置只来自 path，不再有 storage 物理检查字段。
type ItemOverrides = {
	name?: string;
	source?: string | undefined;
	sourceUrl?: string;
	path?: string;
	agents?: readonly string[];
};

function item(over: ItemOverrides = {}): InstalledSkillItem {
	const name = over.name ?? 'same';
	const source = 'source' in over ? over.source : 'old/repo';
	const sourceUrl = over.sourceUrl;
	const installSource = sourceUrl ?? source;
	const path = over.path ?? `/home/.agents/skills/${name}`;
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
	} as unknown as InstalledSkillItem;
}

const initialState: DetectionState<SkillsDetection> = {
	status: 'success',
	result: [
		item({name: 'same', agents: ['Claude Code'], path: '/home/.claude/skills/same'}),
		item({name: 'second', agents: ['Codex'], source: 'own/second', sourceUrl: 'https://github.com/own/second'}),
		item({name: 'third', agents: ['Pi'], source: undefined, path: '/home/.agents/skills/third'})
	]
};
const cache: DetectionCache<SkillsDetection> = {
	state: initialState,
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
	async updateInstances(items: readonly InstalledSkillItem[]) {
		return {success: true, selectedCount: items.length, updatedNames: items.map(entry => entry.name), skippedInstanceIds: []};
	},
	async uninstallInstances(items: readonly InstalledSkillItem[]) {
		return {
			outcome: 'complete',
			mutated: true,
			items: items.map(entry => ({item: entry, result: {outcome: 'complete', mutated: true}}))
		};
	},
	createDetectionRunner() {
		throw new Error('external cache should be reused');
	},
	async runDetection() {}
} as unknown as SkillsViewServices;

const noOpTaskCancellation = {start: () => null, cancel: () => false, finish() {}} as unknown as TaskCancellation;

/** 直接驱动 handleSkillsKey，并收集 dispatch 出的 action 与 preventDefault 结果。 */
function dispatchKey(
	name: string,
	view: Record<string, unknown>,
	options: {onExit?: () => void; actions?: SkillsViewAction[]} = {}
): KeyEvent {
	const event = key(name);
	handleSkillsKey(
		event,
		view as unknown as SkillsViewState,
		action => options.actions?.push(action),
		services,
		cache,
		options.onExit,
		noOpTaskCancellation
	);
	return event;
}

describe('SkillsView input focus isolation', () => {
	test('输入框焦点下 ↑/↓/Esc 留给原生 input，不得切换列表 active 或返回菜单', () => {
		for (const focusedView of [
			{mode: 'install', queryFocused: true},
			{mode: 'list', filterFocused: true}
		]) {
			for (const name of ['up', 'down', 'escape']) {
				const actions: SkillsViewAction[] = [];
				const event = dispatchKey(name, focusedView, {actions});
				expect(actions).toEqual([]);
				expect(event.defaultPrevented).toBe(false);
			}
		}
	});

	test('列表首项左键返回菜单，非首项左键不返回', () => {
		let skillsExitCount = 0;
		const firstListLeft = dispatchKey(
			'left',
			{mode: 'list', filterFocused: false, installedIndex: 0},
			{
				onExit: () => {
					skillsExitCount++;
				}
			}
		);
		expect(skillsExitCount).toBe(1);
		expect(firstListLeft.defaultPrevented).toBe(true);

		dispatchKey(
			'left',
			{mode: 'list', filterFocused: false, installedIndex: 1},
			{
				onExit: () => {
					skillsExitCount++;
				}
			}
		);
		expect(skillsExitCount).toBe(1);

		const firstInstallListLeft = dispatchKey(
			'left',
			{mode: 'install', queryFocused: false, resultIndex: 0},
			{
				onExit: () => {
					skillsExitCount++;
				}
			}
		);
		expect(skillsExitCount).toBe(2);
		expect(firstInstallListLeft.defaultPrevented).toBe(true);
	});
});

describe('SkillsView shared input mouse focus', () => {
	test('鼠标点击后 input 仍接收输入，Enter 只提交一次', async () => {
		let mouseSubmitted = 0;
		let mouseValue = '';
		const setup = await testRender(
			<SingleLineInput
				label="搜索"
				value={mouseValue}
				focused
				placeholder="输入关键词"
				onChange={value => {
					mouseValue = value;
				}}
				onSubmit={() => {
					mouseSubmitted++;
				}}
			/>,
			{width: 40, height: 3}
		);
		try {
			await setup.mockMouse.click(8, 1);
			await setup.mockInput.typeText('pi');
			setup.mockInput.pressEnter();
			await setup.renderOnce();
			expect(mouseValue).toBe('pi');
			expect(mouseSubmitted).toBe(1);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('点击尚未获得页面焦点的 input 必须通知页面同步搜索焦点', async () => {
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
		const setup = await testRender(React.createElement(MouseFocusHarness), {width: 40, height: 3});
		try {
			await setup.renderOnce();
			await act(async () => {
				await setup.mockMouse.click(8, 1);
				await setup.renderOnce();
			});
			expect(mouseFocusNotified).toBe(true);
			await setup.mockInput.typeText('pi');
			setup.mockInput.pressEnter();
			await setup.renderOnce();
			expect(statefulMouseSubmitted).toBe(1);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('完整安装页：Tab 到列表后再点回搜索框，Enter 必须发起一次搜索', async () => {
		const baseline = searchCallCount;
		const setup = await testRender(<SkillsView services={services} cache={cache} active />, {width: 64, height: 24});
		try {
			await setup.waitForFrame(frame => frame.includes('same（old/repo）'));
			const press = async (name: string) => {
				await act(async () => {
					setup.renderer.keyInput.emit('keypress', key(name));
					await setup.renderOnce();
				});
			};
			await press('i');
			const installFrame = await setup.waitForFrame(frame => frame.includes('输入关键词搜索 skills.sh'));
			const searchY = installFrame.split('\n').findIndex(line => line.includes('搜索：'));
			expect(searchY).toBeGreaterThanOrEqual(0);
			await press('tab');
			await act(async () => {
				await setup.mockMouse.click(8, searchY);
				await setup.renderOnce();
			});
			await act(async () => {
				await setup.mockInput.typeText('pi');
				setup.mockInput.pressEnter();
				await setup.renderOnce();
			});
			await setup.waitForFrame(frame => frame.includes('new/repo'));
			expect(searchCallCount).toBe(baseline + 1);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SkillsView filter input mouse focus', () => {
	test('点击已安装过滤框必须派发 filter-focus，交给共享输入处理编辑', async () => {
		const actions: SkillsViewAction[] = [];
		const view = {
			...createInitialSkillsViewState(),
			installed: [item({name: 'same'})],
			filterFocused: false
		};
		const setup = await testRender(<SkillsHomeView view={view} active dispatch={action => actions.push(action)} />, {
			width: 64,
			height: 10
		});
		try {
			await setup.renderOnce();
			await act(async () => {
				await setup.mockMouse.click(8, 1);
				await setup.renderOnce();
			});
			expect(actions).toContainEqual({type: 'filter-focus'});
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SkillsView cache reuse on page switch', () => {
	test('进入安装页复用 App 缓存，不触发额外刷新', async () => {
		let refreshCalls = 0;
		const countingCache = {
			...cache,
			refresh() {
				refreshCalls++;
			}
		};
		const setup = await testRender(<SkillsView services={services} cache={countingCache} active />, {width: 64, height: 24});
		try {
			await setup.waitForFrame(frame => frame.includes('same（old/repo）'));
			await act(async () => {
				setup.renderer.keyInput.emit('keypress', key('i'));
				await setup.renderOnce();
			});
			await setup.waitForFrame(frame => frame.includes('输入关键词搜索 skills.sh'));
			expect(refreshCalls).toBe(0);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SkillsView flat layout and native input editing', () => {
	test('窄终端三行条目、分组切换、过滤光标/paste/撤销与同名覆盖 Modal', async () => {
		const existingSearchBaseline = searchCallCount;
		const setup = await testRender(<SkillsView services={services} cache={cache} active />, {width: 64, height: 24});

		try {
			const flatFrame = await setup.waitForFrame(
				frame => frame.includes('same（old/repo）') && frame.includes('second（own/second）') && frame.includes('third（未知来源）')
			);
			const focusedSkillTitleSpans = setup
				.captureSpans()
				.lines.flatMap(line => line.spans)
				.filter(span => span.text.includes('same（old/repo）'));
			expect(focusedSkillTitleSpans.length).toBeGreaterThan(0);
			expect(focusedSkillTitleSpans.every(span => span.bg.equals(RGBA.fromHex('#2A1A10')))).toBe(true);

			const flatLines = flatFrame.split('\n');
			expect(flatFrame).toMatch(/布局：[\s\S]*平铺[\s\S]*分组[\s\S]*已选 0/);
			expect(flatFrame).toMatch(/Claude Code[\s\S]*Codex[\s\S]*Pi/);
			expect(flatFrame).not.toMatch(/● Codex \/ Pi|○ Codex \/ Pi/);
			expect(flatFrame).not.toMatch(/Pi global|Pi project/);

			const firstTitle = flatLines.findIndex(line => line.includes('same（old/repo）'));
			const firstFallback = flatLines.findIndex((line, index) => index > firstTitle && line.includes('无来源链接'));
			const firstStatus = flatLines.findIndex(
				(line, index) => index > firstFallback && line.includes('Claude') && line.includes('Codex')
			);
			const secondTitle = flatLines.findIndex(line => line.includes('second（own/second）'));
			const secondStatus = flatLines.findIndex((line, index) => index > secondTitle && line.includes('● Codex'));
			const thirdTitle = flatLines.findIndex(line => line.includes('third（未知来源）'));
			const thirdStatus = flatLines.findIndex((line, index) => index > thirdTitle && line.includes('● Pi'));
			expect(firstTitle >= 0 && firstFallback > firstTitle && firstStatus > firstFallback).toBe(true);
			expect(secondTitle > firstStatus).toBe(true);
			expect(secondStatus > secondTitle).toBe(true);
			expect(thirdStatus > thirdTitle).toBe(true);
			expect(flatFrame).toMatch(/https:\/\/github\.com\/own\/second/);
			expect(flatLines.every(line => line.length <= 64)).toBe(true);

			const press = async (name: string, modifiers?: Partial<ParsedKey>) => {
				await act(async () => {
					setup.renderer.keyInput.emit('keypress', key(name, modifiers));
					await setup.renderOnce();
				});
			};
			await press('space');
			await setup.waitForFrame(frame => frame.includes('[✓]') && frame.includes('已选 1'));
			await press('v');
			const groupedFrame = await setup.waitForFrame(frame => /[▾▸][\s\S]*old\/repo/.test(frame));
			expect(groupedFrame.includes('same（old/repo）')).toBe(false);
			expect(groupedFrame).toMatch(/[▾▸][\s\S]*old\/repo/);
			await press('v');
			await press('tab');
			for (const name of ['a', 'b', 'left', 'x']) await press(name);
			const edited = await setup.waitForFrame(frame => frame.includes('axb'));
			expect(edited.includes('same')).toBe(false);
			expect(edited).toMatch(/布局：[\s\S]*平铺[\s\S]*分组[\s\S]*已选 1/);

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

			await act(async () => {
				setup.renderer.keyInput.emit('paste', new PasteEvent(new TextEncoder().encode('X'.repeat(240))));
				await setup.renderOnce();
			});
			const longInputFrame = await setup.waitForFrame(frame => frame.includes('XXXXX'));
			expect(longInputFrame.split('\n').every(line => line.length <= 64)).toBe(true);

			await press('a', editMod);
			await press('x', editMod);
			await setup.waitForFrame(frame => frame.includes('same'));
			await press('tab');
			await setup.waitForFrame(frame => frame.includes('same'));
			for (const name of ['i', 'x', 'enter']) {
				await press(name);
			}
			const searchFrame = await setup.waitForFrame(frame => frame.includes('new/repo'));
			expect(searchFrame).toMatch(/已有同名/);
			expect(searchCallCount).toBe(existingSearchBaseline + 1);
			for (const name of ['space', 'enter', 'enter']) {
				await press(name);
			}
			const frame = await setup.waitForFrame(value => value.includes('确认覆盖同名 Skill'));
			expect(frame).toMatch(/当前来源：old\/repo/);
			expect(frame).toMatch(/新来源：new\/repo/);
			expect(frame).toMatch(/目标根[\s\S]*完整 CLI 检测/);
			expect(frame.split('\n').every(line => line.length <= 64)).toBe(true);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SkillsView topology modal', () => {
	test('Modal 上下键隔离背景列表，mutation 失败后仍刷新共享检测', async () => {
		const adoptName = 'langchain-dependencies';
		type CountingCache = DetectionCache<SkillsDetection> & {refreshCount: number};
		const adoptCache: CountingCache = {
			...cache,
			refreshCount: 0,
			async refreshAndWait() {
				this.refreshCount++;
				return this.state;
			},
			state: {
				status: 'success',
				result: [
					item({name: adoptName, agents: ['Claude Code'], path: `/home/.claude/skills/${adoptName}`, source: 'own/langchain'}),
					item({name: 'same', agents: ['Claude Code', 'Codex']})
				]
			}
		};
		const setup = await testRender(<SkillsView services={services} cache={adoptCache} active />, {width: 76, height: 24});

		try {
			await setup.waitForFrame(frame => frame.includes(adoptName));
			const press = async (name: string) => {
				await act(async () => {
					setup.renderer.keyInput.emit('keypress', key(name));
					await setup.renderOnce();
				});
			};
			await setup.waitForFrame(frame => frame.includes('(1/2)'));
			await press('enter');
			await setup.waitForFrame(frame => frame.includes('管理安装'));
			await press('up');
			let modalFrame = await setup.waitForFrame(frame => frame.includes('Claude Code'));
			expect(modalFrame).toMatch(/\(1\/2\)/);
			expect(modalFrame).toMatch(/Pi/);
			await press('down');
			modalFrame = await setup.waitForFrame(frame => frame.includes('Codex'));
			expect(modalFrame).toMatch(/\(1\/2\)/);
			for (const name of ['down', 'space', 'enter']) await press(name);
			const frame = await setup.waitForFrame(value => value.includes('确认更新安装范围'));
			expect(frame).toMatch(/当前安装到：Claude Code/);
			expect(frame).toMatch(/变更为：Claude Code、Codex/);
			expect(frame).toMatch(/本次新增：Codex/);
			expect(frame).not.toMatch(/确认切换安装拓扑/);
			expect(frame).not.toMatch(/来源：|其它 Agent：|\/home\/|\.agents\/skills/);
			expect(frame).toMatch(/Enter\s+确认执行/);
			expect(frame).toMatch(/Esc\s+取消/);
			await press('enter');
			await setup.waitForFrame(value => value.includes('simulated adoption failure'));
			expect(adoptCache.refreshCount).toBe(1);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
