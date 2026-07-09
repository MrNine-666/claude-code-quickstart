import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {contractPath, loadContract, loadTextContract, resolveContractsDir} from '../src/core/contracts.ts';

// TDR-10 拆分后 TUI 契约位于 tui/contracts/（install 链契约在 installer/contracts/）。
const dir = resolveContractsDir();
assert.ok(existsSync(dir), `contracts 目录不存在: ${dir}`);
assert.ok(dir.includes('contracts'), `TUI 契约根应指向 contracts 目录: ${dir}`);
assert.ok(!dir.includes('installer'), `TUI 契约根不得位于 installer 下: ${dir}`);

// TUI 链契约（供应商 / MCP / ClaudeConfig / CcgWorkflow）应可加载且解析为对象
const claudeConfig = loadContract('claude-config.json');
assert.ok(claudeConfig && typeof claudeConfig === 'object', 'claude-config.json 应解析为对象');

const providers = loadContract('providers.json');
assert.ok(providers && typeof providers === 'object', 'providers.json 应解析为对象');

const mcpServers = loadContract('mcp-servers.json');
assert.ok(mcpServers && typeof mcpServers === 'object', 'mcp-servers.json 应解析为对象');

const claudeMdBase = loadTextContract('templates/claude-md.base.md');
assert.ok(claudeMdBase.includes('# Claude Code 增强配置'), 'claude-md.base.md 应加载为 Claude base 模板文本');

const claudeMdWindows = loadTextContract('templates/claude-md.platform-windows.md');
assert.ok(claudeMdWindows.includes('Windows / PowerShell'), 'claude-md.platform-windows.md 应加载为 Claude Windows 平台模板文本');

const codexMd = loadTextContract('templates/codex-md.md');
assert.ok(codexMd.includes('# Codex AGENTS.md 推荐规则'), 'codex-md.md 应加载为 Codex 独立模板文本');

// install 链契约 steps.json 属 installer/contracts/，不应在 TUI 契约目录（边界保护）
assert.throws(() => loadContract('steps.json'), /契约文件不存在/,
	'steps.json 属 install 链，不应在 TUI 契约目录');

assert.ok(contractPath('providers.json').endsWith('providers.json'), 'contractPath 拼接错误');

console.log('[PASS] TUI 契约加载器指向 tui/contracts/（TDR-10 拆分）');
