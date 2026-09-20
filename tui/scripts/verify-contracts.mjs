import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {contractPath, loadContract, resolveContractsDir} from '../src/core/contracts.ts';

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

// Pi 请求头预设：受控白名单（Apis）与 Headers 是表单动作行的唯一数据源，缺失即静默降级为无预设。
const headerPresets = loadContract('pi-header-presets.json');
assert.ok(headerPresets && typeof headerPresets === 'object', 'pi-header-presets.json 应解析为对象');
const presets = headerPresets.Presets;
assert.ok(presets && typeof presets === 'object', 'pi-header-presets.json 缺少 Presets');
for (const key of ['claude-code', 'codex', 'gemini-cli']) {
	const preset = presets[key];
	assert.ok(preset, `pi-header-presets.json 缺少预设 ${key}`);
	assert.ok(Array.isArray(preset.Apis) && preset.Apis.length > 0, `预设 ${key} 缺少 Apis 白名单`);
	assert.ok(preset.Headers && typeof preset.Headers === 'object', `预设 ${key} 缺少 Headers`);
	assert.ok(typeof preset.Label === 'string' && preset.Label.length > 0, `预设 ${key} 缺少 Label`);
}
assert.equal(presets['claude-code'].Apis.includes('anthropic-messages'), true, 'claude-code 应受控于 anthropic-messages');
assert.equal(presets.codex.Apis.includes('openai-responses'), true, 'codex 应受控于 openai-responses');
assert.equal(presets.codex.Apis.includes('openai-completions'), false, 'codex 不得受控于 openai-completions');
assert.equal(presets['gemini-cli'].Apis.includes('google-generative-ai'), true, 'gemini-cli 应受控于 google-generative-ai');

assert.throws(() => loadContract('templates/index.json'), /契约文件不存在/, '全局规则推荐模板契约应已移除');

// install 链契约 steps.json 属 installer/contracts/，不应在 TUI 契约目录（边界保护）
assert.throws(() => loadContract('steps.json'), /契约文件不存在/,
	'steps.json 属 install 链，不应在 TUI 契约目录');

assert.ok(contractPath('providers.json').endsWith('providers.json'), 'contractPath 拼接错误');

console.log('[PASS] TUI 契约加载器指向 tui/contracts/（TDR-10 拆分）');
