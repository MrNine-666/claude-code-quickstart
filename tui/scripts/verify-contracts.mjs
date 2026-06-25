import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {contractPath, loadContract, resolveContractsDir} from '../dist/core/contracts.js';

// TDR-10 拆分后 TUI 契约位于 manage/contracts/（install 链契约在 installer/contracts/）。
// 本模块编译后位于 manage/dist/core/contracts.js，上溯两级到 manage/contracts/。
const dir = resolveContractsDir();
assert.ok(existsSync(dir), `contracts 目录不存在: ${dir}`);
assert.ok(dir.includes('manage'), `TUI 契约根应位于 manage 下: ${dir}`);
assert.ok(!dir.includes('installer'), `TUI 契约根不得位于 installer 下: ${dir}`);

// TUI 链契约（供应商 / MCP / ClaudeConfig / CcgWorkflow）应可加载且解析为对象
const claudeConfig = loadContract('claude-config.json');
assert.ok(claudeConfig && typeof claudeConfig === 'object', 'claude-config.json 应解析为对象');

const providers = loadContract('providers.json');
assert.ok(providers && typeof providers === 'object', 'providers.json 应解析为对象');

const mcpServers = loadContract('mcp-servers.json');
assert.ok(mcpServers && typeof mcpServers === 'object', 'mcp-servers.json 应解析为对象');

const ccgWorkflow = loadContract('ccg-workflow.json');
assert.ok(ccgWorkflow && typeof ccgWorkflow === 'object', 'ccg-workflow.json 应解析为对象');

// install 链契约 steps.json 属 installer/contracts/，不应在 TUI 契约目录（边界保护）
assert.throws(() => loadContract('steps.json'), /契约文件不存在/,
	'steps.json 属 install 链，不应在 TUI 契约目录');

assert.ok(contractPath('providers.json').endsWith('providers.json'), 'contractPath 拼接错误');

console.log('[PASS] TUI 契约加载器指向 manage/contracts/（TDR-10 拆分）');
