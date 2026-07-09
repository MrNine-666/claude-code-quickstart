import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

// Layout shell 回归门禁：
// - Agent Header 用 width="100%" 铺满右侧内容栏，禁止再用 contentWidth 写死宽度。
// - active layout 边框使用“圆角转角 + 加粗单线边”的统一字符集。
// - MCP 视图切换 agentContext 时必须立即刷新，不能等 content 焦点恢复。

const appSource = readFileSync(new URL('../src/app.tsx', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../src/theme/index.ts', import.meta.url), 'utf8');
const mcpViewSource = readFileSync(new URL('../src/views/mcp/McpView.tsx', import.meta.url), 'utf8');

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

assert.match(
	mcpViewSource,
	/useEffect\(\(\) => \{\s*setRows\(loadMcpStatus\(agentContext\)\);\s*setSelected\(0\);\s*setScreen\(\{kind: 'list'\}\);\s*\}, \[agentContext\]\);/,
	'McpView 应在 agentContext 变化时立即刷新状态表并复位列表'
);
assert.doesNotMatch(
	mcpViewSource,
	/useEffect\(\(\) => \{\s*if \(active\) \{\s*setRows\(loadMcpStatus\(agentContext\)\)/,
	'McpView 刷新状态不得被 active 守卫拦截，否则 Header 切换 agent 后内容会滞后'
);

console.log('[PASS] layout shell：Header 宽度铺满 + active 加粗圆角边框 + MCP agent 切换即时刷新');
