import assert from 'node:assert/strict';
import {getServerDetail} from '../src/core/mcp.ts';
import {writeJsonAtomic} from '../src/core/fs-utils.ts';
import {vaultPath, claudeJsonPath, ccqDir} from '../src/core/paths.ts';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// MCP 表单门禁（真实文件段）。
//
// P2a 载体迁移：纯函数段（args-multi/args-token 与 http header 模板预填、url-embedded 模板、
// parseMcpFormInput url-embedded / headers / stdio-http 回归、parseMcpJsonFormat、configToJson、
// toCodexMcpConfig 降级、端到端透传）已迁 `tests/core/mcp-template.test.ts`。
// 本脚本保留依赖真实落盘的断言：
// - getServerDetail：Disabled MCP 编辑回显 vault(mcp-meta.json) config fallback
//   （disableServer 把 config 备份进 vault 并清 .claude.json，编辑须从 vault 回显，不能展示空 {}）。

// ── getServerDetail Disabled fallback（CCQ_HOME 隔离临时目录）──
const home = join(tmpdir(), 'ccq-mcp-template-test');
process.env.CCQ_HOME = home;
rmSync(home, {recursive: true, force: true});
mkdirSync(ccqDir(), {recursive: true});

// vault 备份被禁用 MCP 的 config（对齐 disableServer 行为）
writeJsonAtomic(vaultPath(), {
	schemaVersion: 1,
	createdAt: '2026-01-01T00:00:00.000Z',
	updatedAt: '2026-01-01T00:00:00.000Z',
	servers: {
		't-disabled': {
			disabled: true,
			config: {command: 'npx', args: ['-y', 'x']},
			credentials: {values: {TOKEN: 's'}},
			updatedAt: '2026-01-01T00:00:00.000Z'
		}
	}
});
// .claude.json 不含该 server（disabled 时已被清除）
writeJsonAtomic(claudeJsonPath(), {mcpServers: {}});
assert.deepEqual(
	getServerDetail('t-disabled').config,
	{command: 'npx', args: ['-y', 'x']},
	'disabled 回显 vault(mcp-meta.json) config'
);

// Active 优先 .claude.json，fallback 不影响活跃态
writeJsonAtomic(claudeJsonPath(), {mcpServers: {'t-disabled': {command: 'node', args: ['a.js']}}});
assert.deepEqual(
	getServerDetail('t-disabled').config,
	{command: 'node', args: ['a.js']},
	'active 优先 .claude.json'
);

rmSync(home, {recursive: true, force: true});
delete process.env.CCQ_HOME;
console.log('[PASS] Disabled 编辑回显 vault config / Active 优先 .claude.json');
