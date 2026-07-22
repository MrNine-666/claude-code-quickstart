import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import React, {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {Spinner, busyActionTitle} from '../src/components/spinner.tsx';

// Layout shell 回归门禁：
// - Agent Header 用 width="100%" 铺满右侧内容栏，禁止再用 contentWidth 写死宽度。
// - active layout 边框使用“圆角转角 + 加粗单线边”的统一字符集。
// - split 横向列用 flexGrow={1} + flexBasis={0} 等分；纵向溢出用 minHeight={0} 收缩。

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../src/theme/index.ts', import.meta.url), 'utf8');
const documentFormSource = readFileSync(new URL('../src/components/managed-document/DocumentFormView.tsx', import.meta.url), 'utf8');
const spinnerSource = readFileSync(new URL('../src/components/spinner.tsx', import.meta.url), 'utf8');
const execSource = readFileSync(new URL('../src/core/exec.ts', import.meta.url), 'utf8');
const componentsIndexSource = readFileSync(new URL('../src/components/index.ts', import.meta.url), 'utf8');
const toolsViewSource = readFileSync(new URL('../src/views/tools/ToolsView.tsx', import.meta.url), 'utf8');
const toolsActionsSource = readFileSync(new URL('../src/views/tools/tools-view-actions.ts', import.meta.url), 'utf8');
const skillsViewSource = readFileSync(new URL('../src/views/skills/SkillsView.tsx', import.meta.url), 'utf8');
const skillsActionsSource = readFileSync(new URL('../src/views/skills/skills-view-actions.ts', import.meta.url), 'utf8');

assert.match(
	appSource,
	/<AgentHeader agentContext=\{state\.agentContext\} active=\{headerActive\} \/>/,
	'AgentHeader 调用不得继续传 width={contentWidth}'
);
assert.doesNotMatch(
	appSource,
	/function AgentHeader\([^)]*width[^)]*\)/,
	'AgentHeader props 不得再声明 width，避免 Header 宽度与 content 卡片估算不一致'
);
assert.match(
	appSource,
	/function AgentHeader[\s\S]{0,260}width="100%"/,
	'AgentHeader 内部应使用 width="100%" 铺满右侧内容栏'
);
assert.doesNotMatch(
	appSource,
	/function AgentHeader[\s\S]{0,260}width=\{width\}/,
	'AgentHeader 内部不得使用 width={width} 写死宽度'
);

assert.match(themeSource, /export const activeBorderChars/, 'theme 必须导出 activeBorderChars');
for (const char of ['╭', '╮', '╰', '╯', '━', '┃']) {
	assert.match(themeSource, new RegExp(char), `activeBorderChars 应包含 ${char}`);
}
assert.equal(
	(appSource.match(/customBorderChars=\{[^}]*activeBorderChars[^}]*\}/g) ?? []).length,
	3,
	'侧边栏、content 卡片、AgentHeader 三个 layout active 边框都应使用 activeBorderChars'
);

// split 横向等分：推荐列/编辑列用 flexGrow={1} + flexBasis={0} + minWidth={0}；
// 纵向溢出：推荐列内边框与 scrollbox 用 minHeight={0}，避免内容撑大父容器、挤掉标题 marginBottom。
for (const [name, source] of [['ConfigView', documentFormSource], ['PromptsView', documentFormSource]]) {
	assert.match(
		source,
		/<box(?=[^>]*key="recommend-panel")(?=[^>]*flexGrow=\{1\})(?=[^>]*flexBasis=\{0\})(?=[^>]*minWidth=\{0\})[^>]*>/,
		`${name} split 推荐列必须用 flexGrow={1} + flexBasis={0} + minWidth={0} 保持横向等分`
	);
	assert.match(
		source,
		/<box(?=[^>]*key="editor-panel")(?=[^>]*flexGrow=\{1\})(?=[^>]*flexBasis=\{0\})(?=[^>]*minWidth=\{0\})[^>]*>/,
		`${name} split 编辑列必须用 flexGrow={1} + flexBasis={0} + minWidth={0} 保持横向等分`
	);
	assert.match(
		source,
		/<box(?=[^>]*flexGrow=\{1\})(?=[^>]*minHeight=\{0\})[^>]*borderStyle="rounded"/,
		`${name} split 左列推荐边框必须带 flexGrow={1} + minHeight={0}，避免溢出内容挤掉标题 marginBottom 导致边框错位`
	);
	assert.match(
		source,
		/<ThemedScrollbox(?=[^>]*style=\{\{[^}]*flexGrow: 1)(?=[^>]*style=\{\{[^}]*minHeight: 0)[^>]*>/,
		`${name} split 左列推荐 ThemedScrollbox 必须带 minHeight: 0，让内容在分配空间内收缩而非撑大父容器`
	);
}

// 耗时 mutation 由视图上报展示状态，App 在整个终端根节点渲染透明蒙层并占用输入。
assert.match(spinnerSource, /props\.variant === 'overlay'/, '共享 Spinner 必须同时支持 inline 与 overlay 模式');
assert.match(spinnerSource, /position="absolute"[\s\S]*width="100%"[\s\S]*height="100%"[\s\S]*zIndex=\{200\}/, 'Spinner overlay 必须覆盖整个终端并高于普通 Modal');
assert.match(spinnerSource, /backgroundColor=\{colors\.modalBackground\}[\s\S]{0,80}opacity=\{0\.72\}/, 'Spinner overlay 背景必须使用主题色与半透明度');
assert.match(appSource, /const \[busyOverlay, setBusyOverlay\] = useState<BusyOverlayState \| null>\(null\)/, 'App 必须持有全局 busy 蒙层状态');
assert.match(appSource, /ownsViewInput = busyOverlay !== null \|\| updateDialogOpen/, '全局 busy 蒙层显示时必须锁住底层输入');
assert.match(appSource, /active=\{effectiveFocus === 'view' && busyOverlay === null && !updateDialogOpen\}/, '全局蒙层或更新 Modal 显示时必须让底层视图失活');
assert.match(appSource, /<Spinner[\s\S]{0,180}variant="overlay"[\s\S]{0,180}label=\{busyOverlay\.title\}/, 'App 根节点必须复用 Spinner 的 overlay 模式');
assert.match(execSource, /readonly instruction\?: string/, '结构化 progress 必须单独携带当前真实指令');
for (const [name, rootSource, actionSource] of [['ToolsView', toolsViewSource, toolsActionsSource], ['SkillsView', skillsViewSource, skillsActionsSource]]) {
	assert.match(rootSource, /onBusyStateChange\?\./, `${name} 必须把执行状态上报 App`);
	assert.doesNotMatch(`${rootSource}\n${actionSource}`, /<ProgressLog\b/, `${name} 不得继续在页面底部渲染执行日志`);
	assert.match(actionSource, /if \(event\.instruction\)[\s\S]{0,180}message: event\.instruction/, `${name} 的 overlay 只能投影外部组件上报的真实指令`);
}
assert.equal(existsSync(new URL('../src/components/progress-log.tsx', import.meta.url)), false, '旧 ProgressLog 组件文件必须删除');
assert.doesNotMatch(componentsIndexSource, /ProgressLog|progress-log/, '共享组件出口不得继续导出旧 ProgressLog');

assert.equal(busyActionTitle('update', '工具'), '正在更新工具');
assert.equal(busyActionTitle('install', ' Skill'), '正在安装 Skill');
let cancelCount = 0;
const overlaySetup = await testRender(
	React.createElement(Spinner, {
		variant: 'overlay',
		label: '正在更新工具',
		message: 'CodeGraph · npm install -g @acme/codegraph',
		terminalWidth: 40,
		onCancel: () => {
			cancelCount += 1;
		}
	}),
	{width: 40, height: 16}
);
try {
	const frame = await overlaySetup.waitForFrame(value => value.includes('正在更新工具') && value.includes('npm install'));
	assert.match(frame, /CodeGraph · npm install -g/, 'BusyOverlay 第二行必须展示外部组件上报的当前真实指令');
	assert.match(frame, /@acme\/codegraph/, 'BusyOverlay 必须完整保留窄终端中换行后的命令参数');
	assert.equal(frame.split('\n').every(line => line.length <= 40), true, 'BusyOverlay 在窄终端不得横向溢出');
	await act(async () => {
		overlaySetup.renderer.keyInput.emit('keypress', {
			name: 'escape',
			sequence: '\u001b',
			ctrl: false,
			shift: false,
			meta: false,
			option: false,
			eventType: 'press',
			repeated: false
		});
		await overlaySetup.renderOnce();
	});
	const cancelledFrame = await overlaySetup.waitForFrame(value => !value.includes('正在更新工具'));
	assert.equal(cancelCount, 1, 'Spinner Esc 只向父组件发送一次取消意图');
	assert.equal(cancelledFrame.includes('Esc 取消任务'), false, 'Spinner Esc 后应立即隐藏 overlay');
} finally {
	await act(async () => {
		overlaySetup.renderer.destroy();
	});
}

console.log('[PASS] layout shell：Header/边框/split 约束 + 全局半透明 busy 蒙层');
