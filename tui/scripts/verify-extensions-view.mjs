import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React, {act} from 'react';
import {RGBA} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {Card} from '../src/components/card.tsx';
import {packageFromManifest, piPackageDetailsUrl, searchPiPackageCatalogPage} from '../src/core/extensions.ts';
import {
	createInitialExtensionsViewState,
	isExtensionInstalled,
	reduceExtensionsViewState,
	visibleExtensions
} from '../src/state/extensions-view-state.ts';
import {handleExtensionsKey} from '../src/views/extensions/extensions-view-input.ts';
import {ExtensionCard} from '../src/views/extensions/ExtensionsView.tsx';

const viewSource = readFileSync(new URL('../src/views/extensions/ExtensionsView.tsx', import.meta.url), 'utf8');
const inputSource = readFileSync(new URL('../src/views/extensions/extensions-view-input.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const cardSource = readFileSync(new URL('../src/components/card.tsx', import.meta.url), 'utf8');
const keybindingsSource = readFileSync(new URL('../src/config/keybindings.ts', import.meta.url), 'utf8');
const shortcutsSource = readFileSync(new URL('../src/state/shortcuts.ts', import.meta.url), 'utf8');

assert.match(viewSource, /<SingleLineInput/);
assert.match(viewSource, /flexWrap="wrap"/);
assert.match(viewSource, /height=\{3\} maxHeight=\{3\} overflow="hidden"/, '扩展简介必须限制为三行并裁剪溢出');
assert.match(viewSource, /formatMonthlyDownloads/);
assert.match(viewSource, /onSubmit=\{value =>/, '扩展搜索必须使用原生 input 提交回调');
assert.match(viewSource, /onFocus=\{focusSearch\}/, '扩展搜索必须把鼠标点击同步为搜索焦点');
assert.match(
	readFileSync(new URL('../src/components/single-line-input.tsx', import.meta.url), 'utf8'),
	/onMouseDown=\{onFocus \?/,
	'扩展页必须复用共享输入的鼠标焦点修复'
);
assert.match(viewSource, /<span fg=\{colors\.primary\}>\{item\.author/, '作者必须使用主题主色');
assert.match(viewSource, /<span fg=\{colors\.success\}>\{`\$\{formatMonthlyDownloads/, '月下载量必须使用主题成功色');
assert.match(
	viewSource,
	/<span fg=\{colors\.muted\} attributes=\{TextAttributes\.DIM\}>[\s\S]*formatPublishedAge/,
	'发布时间必须使用主题弱化色'
);
assert.match(viewSource, /<span fg=\{colors\.warning\}>\{piResourceLabel/, '资源类型必须使用主题警告色');
assert.match(viewSource, /<span fg=\{colors\.primaryBright\}>\{`v\$\{item\.version\}`\}/, '版本必须使用主题亮主色');
assert.match(viewSource, /openExternalFile/);
assert.match(viewSource, /piPackageDetailsUrl/);
assert.doesNotMatch(viewSource, /ExtensionDetailModal|DetailPanel/, '扩展详情必须交给外部网址，不得实现 View 内弹窗');
assert.match(viewSource, /<box flexDirection="row" flexWrap="wrap" width="100%" flexGrow=\{1\}/, '扩展 Grid 行必须占满可用宽度');
assert.match(viewSource, /const gridWidth = Math\.max\(contentWidth, 49\)/, '扩展卡片宽度必须以 Grid 实际宽度计算');
assert.match(viewSource, /marginRight=\{index % 2 === 0 \? 1 : 0\}/, '扩展卡片间距只能占用列间空隙');
assert.match(viewSource, /page=\{view\.query\.trim\(\) \? view\.page : undefined\}/, '已安装扩展列表不得传入分页信息');
assert.match(viewSource, /visibleExtensions/);
assert.match(viewSource, /agentContext === 'pi'/);
assert.match(viewSource, /当前没有可管理的扩展/);
assert.match(viewSource, /onBusyStateChange/);
assert.match(viewSource, /taskCancellation\.start\(\)/, '扩展命令执行必须进入共享 busy overlay 生命周期');
assert.match(viewSource, /message: extensionCommand\(action\)/, '执行遮罩必须展示当前命令');
assert.match(viewSource, /view\.pendingAction && !view\.mutating/, '确认弹窗与执行遮罩必须分离');
assert.match(viewSource, /即将执行 \$\{command\}/, '确认弹窗只提示即将执行的 Pi 命令');
const confirmSource = viewSource.slice(
	viewSource.indexOf('function ExtensionConfirmModal'),
	viewSource.indexOf('async function runConfirmed')
);
assert.doesNotMatch(confirmSource, /colors\.warning/, '确认弹窗不再展示额外风险文案');
assert.doesNotMatch(viewSource, /扩展可运行代码|不会删除 ~\/\.pi\/agent/, '确认弹窗不得继续展示额外说明');
assert.doesNotMatch(viewSource, /ErrorPanel/, '扩展页不得把底层错误原文打印到底部');
assert.match(viewSource, /console\.error/, '扩展底层诊断必须写入控制台');
assert.match(cardSource, /const focusedBackground = focused \? colors\.focusedBackground : undefined;/, 'Card 聚焦背景必须来自主题');
assert.ok((cardSource.match(/backgroundColor=\{focusedBackground\}/g) ?? []).length >= 4, 'Card 聚焦背景必须覆盖内容子节点');
assert.doesNotMatch(viewSource, /fixedPiMcpAdapterPackage|withFixedAdapter/);
assert.match(inputSource, /key === 'tab'/);
assert.doesNotMatch(
	inputSource,
	/if \(key === 'enter' \|\| key === 'return'\)[\s\S]*onSearch\(0\)/,
	'搜索 Enter 必须由 input onSubmit 处理'
);
assert.match(inputSource, /key === 'o'/, '扩展卡片必须支持 O 查看详情');
assert.match(inputSource, /onOpenExternal/);
assert.doesNotMatch(inputSource, /close-detail/);
assert.match(inputSource, /key === 'pageup'/);
assert.doesNotMatch(inputSource, /onExitToHeader/);
assert.match(appSource, /const piOnlyModule = displayMenuId === 'extensions'/);
assert.match(appSource, /const moduleAgentContext: AgentContext = piOnlyModule \? 'pi' : state\.agentContext/);
assert.match(appSource, /const visibleHeaderContexts: readonly AgentContext\[\] = piOnlyModule \? \['pi'\] : AGENT_CONTEXT_ORDER/);
assert.match(appSource, /<AgentHeader agentContext=\{moduleAgentContext\} contexts=\{visibleHeaderContexts\}/);
assert.match(appSource, /<ModuleContent[\s\S]*agentContext=\{moduleAgentContext\}/);
assert.match(appSource, /<ExtensionsView[\s\S]*agentContext=\{agentContext\}/);
assert.match(appSource, /case 'extensions'[\s\S]*onBusyStateChange=\{onBusyStateChange\}/, '扩展执行必须接入全局 busy overlay');
assert.match(appSource, /variant="overlay"/, '命令执行必须复用带 mask 的 Spinner overlay');
assert.doesNotMatch(appSource, /<ExtensionsView[\s\S]*onExitToHeader/);
assert.match(keybindingsSource, /OPEN_DETAILS: 'extensions:open-details'/);
assert.match(keybindingsSource, /UPDATE_ALL: 'extensions:update-all'/);
assert.match(keybindingsSource, /\[EXTENSIONS_COMMANDS\.OPEN_DETAILS\]: 'o'/);
assert.match(keybindingsSource, /\[EXTENSIONS_COMMANDS\.UPDATE_ALL\]: 'a'/);
assert.match(shortcutsSource, /EXTENSIONS_COMMANDS\.OPEN_DETAILS, label: '查看详情'/);
assert.match(shortcutsSource, /EXTENSIONS_COMMANDS\.UPDATE_ALL, label: '全部更新'/);

const extension = (name, installed, source = `npm:${name}`) => ({
	name,
	source,
	version: '1.0.0',
	description: `${name} description`,
	type: 'extension',
	resourceTypes: ['extension'],
	author: 'community',
	repository: '',
	npmUrl: `https://www.npmjs.com/package/${name}`,
	catalogListed: true,
	piMaintained: false,
	installed,
	installCommand: `pi install ${source}`
});

const installed = [extension('alpha', true), extension('beta', true)];
const initialState = createInitialExtensionsViewState();
assert.equal(initialState.focus, 'grid', '从菜单进入扩展管理时初始焦点应在列表');
let state = reduceExtensionsViewState(initialState, {
	type: 'installed-loaded',
	items: installed
});
assert.deepEqual(
	visibleExtensions(state).map(item => item.name),
	['alpha', 'beta']
);

state = reduceExtensionsViewState(state, {type: 'query-input', value: 'tool'});
assert.deepEqual(visibleExtensions(state), []);
state = reduceExtensionsViewState(state, {
	type: 'search-done',
	result: {
		items: [extension('tool-a', false), extension('tool-b', false), extension('tool-c', false)],
		page: 1,
		pageSize: 20,
		total: 41,
		hasPrevious: true,
		hasNext: true
	}
});
assert.equal(state.focus, 'grid');
assert.equal(state.page, 1);
assert.equal(state.total, 41);
assert.equal(state.hasPrevious, true);
assert.equal(state.hasNext, true);
state = reduceExtensionsViewState(state, {type: 'move', direction: 'right'});
assert.equal(state.cursor, 1, 'grid 右移应在同一行切换到第二列');
assert.equal(isExtensionInstalled(visibleExtensions(state)[0], installed), false);
assert.equal(isExtensionInstalled(extension('alpha', false), installed), true);
const thirdItemState = reduceExtensionsViewState({...state, cursor: 2}, {type: 'move', direction: 'left'});
assert.equal(thirdItemState.cursor, 1, '扩展 Grid 第三项左移应回到第二项');
const secondItemRightState = reduceExtensionsViewState({...state, cursor: 1}, {type: 'move', direction: 'right'});
assert.equal(secondItemRightState.cursor, 2, '扩展 Grid 第二项右移应按列表顺序进入第三项');

let extensionInputExitCount = 0;
const inputEscape = {
	name: 'escape',
	defaultPrevented: false,
	preventDefault() {
		this.defaultPrevented = true;
	}
};
handleExtensionsKey(
	inputEscape,
	{...state, focus: 'search'},
	{
		dispatch() {
			throw new Error('搜索框 Escape 不应改变扩展 View 状态');
		},
		onSearch() {},
		onOpenExternal() {},
		onOpenConfirm() {},
		onRunConfirm() {},
		onExitToNav() {
			extensionInputExitCount++;
		}
	},
	installed
);
assert.equal(extensionInputExitCount, 0, '扩展搜索框 Escape 不应返回菜单');

let extensionExitCount = 0;
const firstLeft = {
	name: 'left',
	defaultPrevented: false,
	preventDefault() {
		this.defaultPrevented = true;
	}
};
handleExtensionsKey(
	firstLeft,
	{...state, cursor: 0},
	{
		dispatch() {
			throw new Error('扩展列表首项左键不应移动 Grid');
		},
		onSearch() {},
		onOpenExternal() {},
		onOpenConfirm() {},
		onRunConfirm() {},
		onExitToNav() {
			extensionExitCount++;
		}
	},
	installed
);
assert.equal(extensionExitCount, 1, '扩展列表首项左键应返回菜单');
assert.equal(firstLeft.defaultPrevented, true, '扩展列表首项左键应阻止继续冒泡');

const openedItems = [];
handleExtensionsKey(
	{
		name: 'o',
		preventDefault() {
			this.defaultPrevented = true;
		},
		defaultPrevented: false
	},
	state,
	{
		dispatch(action) {
			throw new Error(`O 不应改变扩展 View 状态：${action.type}`);
		},
		onSearch() {},
		onOpenExternal(item) {
			openedItems.push(item);
		},
		onOpenConfirm() {},
		onRunConfirm() {},
		onExitToNav() {}
	},
	installed
);
assert.deepEqual(
	openedItems.map(item => item.name),
	['tool-b'],
	'O 应把当前扩展交给外部打开器'
);
assert.equal(piPackageDetailsUrl('npm:tool-b'), 'https://pi.dev/packages/tool-b');

let updateAllAction;
const updateAllKey = {
	name: 'a',
	defaultPrevented: false,
	preventDefault() {
		this.defaultPrevented = true;
	}
};
handleExtensionsKey(
	updateAllKey,
	state,
	{
		dispatch(action) {
			throw new Error(`A 全部更新不应直接改变扩展 View 状态：${action.type}`);
		},
		onSearch() {},
		onOpenExternal() {},
		onOpenConfirm(action) {
			updateAllAction = action;
		},
		onRunConfirm() {},
		onExitToNav() {}
	},
	installed
);
assert.equal(updateAllKey.defaultPrevented, true, '扩展 Grid A 应阻止继续冒泡');
assert.deepEqual(
	updateAllAction,
	{
		kind: 'update-all',
		targets: [
			{name: 'alpha', source: 'npm:alpha'},
			{name: 'beta', source: 'npm:beta'}
		]
	},
	'A 应基于已安装扩展快照打开全部更新确认'
);

const catalogUrls = [];
const catalogPage = await searchPiPackageCatalogPage('mcp', 0, {
	request: async url => {
		catalogUrls.push(url);
		return {
			ok: true,
			status: 200,
			async json() {
				return {
					objects: [
						{
							downloads: {monthly: 761442},
							package: {
								name: 'pi-mcp-adapter',
								keywords: ['pi-package'],
								date: '2026-09-01T21:11:07.693Z',
								links: {
									npm: 'https://www.npmjs.com/package/pi-mcp-adapter',
									repository: 'https://github.com/nicobailon/pi-mcp-adapter',
									bugs: 'https://github.com/nicobailon/pi-mcp-adapter/issues'
								}
							}
						}
					],
					total: 1
				};
			}
		};
	},
	exec: async () => ({
		code: 0,
		stdout: JSON.stringify({
			name: 'pi-mcp-adapter',
			version: '2.32.1',
			description: 'MCP adapter',
			author: {name: 'nicopreme'},
			repository: 'https://github.com/nicobailon/pi-mcp-adapter',
			pi: {extensions: ['index.ts'], skills: ['skill.md']}
		}),
		stderr: ''
	})
});
assert.match(catalogUrls[0], /size=20/);
assert.match(catalogUrls[0], /from=0/);
assert.equal(catalogPage.items[0].monthlyDownloads, 761442);
assert.equal(catalogPage.items[0].publishedAt, '2026-09-01T21:11:07.693Z');
assert.deepEqual(catalogPage.items[0].resourceTypes, ['extension', 'skill']);
assert.equal(catalogPage.items[0].bugsUrl, 'https://github.com/nicobailon/pi-mcp-adapter/issues');
const manifestPackage = packageFromManifest({
	name: 'x',
	version: '1.0.0',
	pi: {extensions: ['index.ts']},
	bugs: {url: 'https://example.test/issues'},
	time: {'1.0.0': '2026-09-01T00:00:00.000Z'}
});
assert.equal(manifestPackage?.publishedAt, '2026-09-01T00:00:00.000Z');
assert.equal(manifestPackage?.bugsUrl, 'https://example.test/issues');

const moves = [];
handleExtensionsKey(
	{
		name: 'up',
		preventDefault() {
			this.defaultPrevented = true;
		},
		defaultPrevented: false
	},
	state,
	{
		dispatch(action) {
			moves.push(action);
		},
		onSearch() {},
		onOpenExternal() {},
		onOpenConfirm() {},
		onRunConfirm() {},
		onExitToNav() {}
	},
	installed
);
assert.deepEqual(moves, [{type: 'move', direction: 'up'}], '扩展页 Grid 上键只做 Grid 移动，不再进入 Agent Header');

const cardSetup = await testRender(
	React.createElement(Card, {title: 'alpha', focused: true, width: 20}, React.createElement('text', null, 'body')),
	{width: 24, height: 6}
);
try {
	await cardSetup.waitForFrame(frame => frame.includes('alpha') && frame.includes('body'));
	const focusedSpans = cardSetup
		.captureSpans()
		.lines.flatMap(line => line.spans)
		.filter(span => span.text.includes('alpha') || span.text.includes('body'));
	assert.ok(focusedSpans.length > 0, '聚焦 Card 必须渲染标题和正文 Span');
	const expectedFocusedBackground = RGBA.fromHex('#2A1A10');
	assert.equal(
		focusedSpans.every(span => span.bg.equals(expectedFocusedBackground)),
		true,
		'聚焦 Card 的标题和正文必须使用主题 focusedBackground'
	);
} finally {
	await act(async () => {
		cardSetup.renderer.destroy();
	});
}

const clippedCardSetup = await testRender(
	React.createElement(
		ExtensionCard,
		{
			item: {
				...extension('long-description', false),
				description: '第一行\n第二行\n第三行\n第四行'
			},
			installed: false,
			focused: false,
			width: 50
		},
		null
	),
	{width: 54, height: 12}
);
try {
	const frame = await clippedCardSetup.waitForFrame(current => current.includes('第一行'));
	assert.equal(frame.includes('第四行'), false, '扩展简介超过三行时必须隐藏第四行');
} finally {
	await act(async () => {
		clippedCardSetup.renderer.destroy();
	});
}

console.log('[PASS] Extensions View：三行简介、官网元数据、O 外部详情、两列焦点、Tab/Enter/分页交互与 adapter 默认隐藏门禁全部通过');
