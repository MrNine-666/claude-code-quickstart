import assert from 'node:assert/strict';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {tmpdir} from 'node:os';
import {resetMcpContractCache} from '../src/core/mcp-contract.ts';
import {
	computeStatus,
	disableServer,
	enableServer,
	getServerDetail,
	persistMcpServer,
	removeServer
} from '../src/core/mcp.ts';
import {loadVault} from '../src/core/mcp-vault.ts';

// MCP 双 Agent 文件事实源。
// MCP 列表不再由内置契约生成；用户自管 MCP，状态只来自 runtime 配置与 vault 备份。
// Codex 的 ~/.codex/config.toml 与 vault 双向补齐：config-only 备份到 vault；vault-only 补回 config.toml 且 enabled=false。
// 只有 ccq remove 才同时删除 table 与 vault entry；用户手动删 config table 不删除 vault。
// vault 只备份 credentials/config/definitionHash，不再写/读 disabled 作为状态事实源。

const root = mkdtempSync(join(tmpdir(), 'ccq-mcp-multitool-'));
const codexHome = join(root, '.codex');
process.env.CCQ_HOME = root;
process.env.HOME = root;
process.env.CODEX_HOME = codexHome;
resetMcpContractCache();

function writeJson(path, value) {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value, null, 2));
}

function row(statusRows, id) {
	return statusRows.find(item => item.Id === id);
}

function readCodexConfig() {
	return existsSync(join(codexHome, 'config.toml')) ? readFileSync(join(codexHome, 'config.toml'), 'utf8') : '';
}

const claudeJsonPath = join(root, '.claude.json');
const settingsPath = join(root, '.claude', 'settings.json');
writeJson(claudeJsonPath, {mcpServers: {ctx7: {type: 'http', url: 'https://ctx7.example'}}});
writeJson(settingsPath, {permissions: {allow: ['mcp__ctx7']}});

// 历史 vault disabled 字段不得影响 Claude 状态；真实 .claude.json 存在即 Active，并同步覆盖 vault 备份。
writeJson(join(root, '.ccq', 'mcp-meta.json'), {
	schemaVersion: 1,
	createdAt: '2026-07-05T00:00:00.000Z',
	updatedAt: '2026-07-05T00:00:00.000Z',
	servers: {ctx7: {disabled: true, config: {type: 'http', url: 'https://old.example'}}}
});
assert.equal(row(computeStatus('cc'), 'ctx7').Status, 'Active', 'Claude：状态由 .claude.json 决定，忽略 vault.disabled');
assert.equal(loadVault().servers.ctx7.config.url, 'https://ctx7.example', 'Claude runtime 会主动同步到 vault');
assert.equal(loadVault().servers.ctx7.disabled, undefined, 'saveVault 写出时清理历史 disabled 字段');
console.log('[PASS] 7.1/7.5 Claude 状态文件事实源 + 忽略/清理 vault disabled');

// Codex：vault-only 会以 disabled 状态补回 config.toml，而不是 contract Missing；这表示用户手动删 table 不会删除 vault。
let codexRows = computeStatus('cx');
assert.equal(row(codexRows, 'ctx7').Status, 'Disabled', 'Codex：vault-only 会补写 config.toml 并显示 Disabled');
let codexToml = readCodexConfig();
assert.match(codexToml, /url\s*=\s*"https:\/\/ctx7\.example"/, 'Codex vault-only 配置补写到 config.toml');
assert.match(codexToml, /enabled\s*=\s*false/, 'Codex vault-only 补回时写 enabled=false');
assert.equal(codexRows.some(item => item.Status === 'Missing'), false, 'MCP 列表不再由内置契约生成 Missing 项');
console.log('[PASS] 7.2 Codex vault/config.toml 双向补齐（vault → config disabled）');

// Codex persist 写入 config.toml [mcp_servers.<id>]，不写 .claude.json permissions，并同步 vault。
persistMcpServer('ctx7', {type: 'http', url: 'https://codex.example'}, {}, '', 'cx');
codexToml = readCodexConfig();
assert.match(codexToml, /\[mcp_servers\.ctx7\]/, 'Codex persist 写 [mcp_servers.ctx7]');
assert.match(codexToml, /url\s*=\s*"https:\/\/codex\.example"/, 'Codex persist 写入 URL');
assert.equal(row(computeStatus('cx'), 'ctx7').Status, 'Active', 'Codex：table 存在为 Active');
assert.equal(loadVault().servers.ctx7.config.url, 'https://codex.example', 'Codex persist 同步 vault');
assert.equal(readFileSync(settingsPath, 'utf8').includes('mcp__ctx7'), true, 'Codex persist 不删除既有 Claude permission');
console.log('[PASS] 7.2/7.3 Codex MCP TOML persist + Active 状态');

// Codex disable 保留 table 并写 enabled=false；vault 只备份，不写 disabled 字段。
assert.equal(disableServer('ctx7', 'cx').Success, true, 'Codex disable 成功');
codexToml = readCodexConfig();
assert.match(codexToml, /enabled\s*=\s*false/, 'Codex disable 写 enabled=false');
assert.equal(row(computeStatus('cx'), 'ctx7').Status, 'Disabled', 'Codex：enabled=false 为 Disabled');
assert.equal(loadVault().servers.ctx7.disabled, undefined, 'vault 不再保存 disabled 状态');
console.log('[PASS] 7.2/7.4/7.5 Codex disable = enabled=false，vault 不作状态源');

// Codex enable 删除 enabled=false，状态恢复 Active。
assert.equal(enableServer('ctx7', 'cx').Success, true, 'Codex enable 成功');
codexToml = readCodexConfig();
assert.equal(/enabled\s*=\s*false/.test(codexToml), false, 'Codex enable 移除 enabled=false');
assert.equal(row(computeStatus('cx'), 'ctx7').Status, 'Active', 'Codex enable 后 Active');
console.log('[PASS] 7.3 Codex enable 恢复 Active');

// 用户手工在 Codex config 中新增/禁用 MCP，会同步回 vault。
writeFileSync(join(codexHome, 'config.toml'), '[mcp_servers.manual]\ntype = "http"\nurl = "https://manual.example"\nenabled = false\n', 'utf8');
codexRows = computeStatus('cx');
assert.equal(row(codexRows, 'manual').Status, 'Disabled', 'Codex 手动 enabled=false 为 Disabled');
assert.equal(loadVault().servers.manual.config.url, 'https://manual.example', 'Codex 手动配置会同步到 vault');
codexToml = readCodexConfig();
assert.match(codexToml, /\[mcp_servers\.ctx7\]/, 'Codex config 缺少 vault 中 ctx7 时会自动补回');
assert.match(codexToml, /\[mcp_servers\.ctx7\][\s\S]*enabled\s*=\s*false/, 'Codex 手动删除 table 后从 vault 补回为 disabled');
assert.equal(row(codexRows, 'ctx7').Status, 'Disabled', 'Codex 手动删除 table 后补回 Disabled，不删除 vault');
console.log('[PASS] 7.2 Codex 手动 MCP config/vault 同步 + 手动删除补回 disabled');

// Codex remove 同时删除 Codex TOML table 与 vault entry，不触碰 Claude .claude.json 中同名 server。
assert.equal(removeServer('ctx7', true, 'cx').Success, true, 'Codex remove 成功');
assert.equal(row(computeStatus('cx'), 'ctx7'), undefined, 'Codex remove 后 table 与 vault entry 均删除，不再显示');
assert.equal(/\[mcp_servers\.ctx7\]/.test(readCodexConfig()), false, 'Codex remove 删除 config.toml table');
assert.equal(loadVault().servers.ctx7, undefined, 'Codex remove 删除 vault entry');
const claudeJson = JSON.parse(readFileSync(claudeJsonPath, 'utf8'));
assert.ok(claudeJson.mcpServers.ctx7, 'Codex remove 不删除 Claude .claude.json 同名 MCP');
console.log('[PASS] 7.4/7.7 Codex remove = config/vault 双删，且与 Claude 独立');

// Claude disable/remove 仍操作 .claude.json；disable 保留 vault 备份用于重新启用，remove 才删除 vault。
assert.equal(disableServer('ctx7', 'cc').Success, true, 'Claude disable 成功');
assert.equal(row(computeStatus('cc'), 'ctx7').Status, 'Disabled', 'Claude disable 移除 .claude.json 后由 vault 备份展示 Disabled，便于重新启用');
assert.equal(loadVault().servers.ctx7.disabled, undefined, 'Claude disable 不写 vault.disabled');
assert.equal(getServerDetail('ctx7', 'cc').config.url, 'https://ctx7.example', '禁用后编辑详情可从 vault 备份回显 config');
assert.equal(enableServer('ctx7', 'cc').Success, true, 'Claude enable 从 vault 恢复');
assert.equal(row(computeStatus('cc'), 'ctx7').Status, 'Active', 'Claude enable 恢复 .claude.json 状态');
console.log('[PASS] 7.1/7.3/7.5 Claude enable/disable 文件事实源 + vault 备份');

// vault 职责：只保管 MCP credentials/config/hash，不保存 Codex API key。
const vaultText = JSON.stringify(loadVault());
assert.equal(/experimental_bearer_token|sk-[A-Za-z0-9_-]+/.test(vaultText), false, 'vault 不保存 Codex API key');
console.log('[PASS] 7.6 vault 职责边界：备份 MCP config/credentials/hash，不保存 Codex API key');

console.log('[PASS] 7.1-7.8 MCP 双 Agent 文件事实源门禁全部通过');
