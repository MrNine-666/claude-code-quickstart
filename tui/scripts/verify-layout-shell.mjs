import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Layout shell 回归门禁：
// - Agent Header 用 width="100%" 铺满右侧内容栏，禁止再用 contentWidth 写死宽度。
// - active layout 边框使用“圆角转角 + 加粗单线边”的统一字符集。
// - split 横向列用 flexGrow={1} + flexBasis={0} 等分；纵向溢出用 minHeight={0} 收缩。

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../src/theme/index.ts', import.meta.url), 'utf8');
const configViewSource = readFileSync(new URL('../src/views/ConfigView.tsx', import.meta.url), 'utf8');
const promptsViewSource = readFileSync(new URL('../src/views/PromptsView.tsx', import.meta.url), 'utf8');

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
for (const [name, source] of [['ConfigView', configViewSource], ['PromptsView', promptsViewSource]]) {
	assert.match(
		source,
		/<box(?=[^>]*key='recommend-panel')(?=[^>]*flexGrow=\{1\})(?=[^>]*flexBasis=\{0\})(?=[^>]*minWidth=\{0\})[^>]*>/,
		`${name} split 推荐列必须用 flexGrow={1} + flexBasis={0} + minWidth={0} 保持横向等分`
	);
	assert.match(
		source,
		/<box(?=[^>]*key='editor-panel')(?=[^>]*flexGrow=\{1\})(?=[^>]*flexBasis=\{0\})(?=[^>]*minWidth=\{0\})[^>]*>/,
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

console.log('[PASS] layout shell：Header 宽度铺满 + active 加粗圆角边框 + split 横向等分与纵向溢出约束');
