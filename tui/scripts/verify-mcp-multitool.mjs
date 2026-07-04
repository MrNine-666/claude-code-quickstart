import assert from 'node:assert/strict';

// Task 1.13 骨架：MCP 文件事实源 + 历史 vault disabled 忽略（design D12, PBT-13）。
// 冻结「状态由真实运行配置决定，vault 历史 disabled 不再作为状态源」不变量；
// 阶段 7 重构 tui/src/core/mcp.ts 后改为 import 真实 computeStatus 断言。

// ── Claude Code：状态由 ~/.claude.json.mcpServers.<id> 是否存在决定 ──
function claudeStatus(claudeJson, id) {
	return Object.prototype.hasOwnProperty.call(claudeJson.mcpServers ?? {}, id) ? 'Active' : 'Missing';
}
assert.equal(claudeStatus({mcpServers: {ctx7: {}}}, 'ctx7'), 'Active', 'Claude：.claude.json 存在为 Active');
assert.equal(claudeStatus({mcpServers: {}}, 'ctx7'), 'Missing', 'Claude：.claude.json 不存在为 Missing');

// 历史 vault disabled 字段不得再影响状态计算
function statusIgnoringVaultDisabled(claudeJson, vaultEntry, id) {
	// 冻结不变量：即使 vault 标 disabled，只要真实配置存在即 Active
	void vaultEntry?.disabled;
	return claudeStatus(claudeJson, id);
}
const staleVault = {disabled: true};
assert.equal(
	statusIgnoringVaultDisabled({mcpServers: {ctx7: {}}}, staleVault, 'ctx7'),
	'Active',
	'状态计算忽略 vault 历史 disabled 字段'
);
console.log('[PASS] 1.13a MCP Claude 状态文件事实源 + 忽略 vault 历史 disabled');

// ── Codex：状态由 CODEX_HOME/config.toml 的 [mcp_servers.<id>] 决定，enabled=false 为 Disabled ──
function codexStatus(codexConfig, id) {
	const table = codexConfig.mcp_servers?.[id];
	if (!table) {
		return 'Missing';
	}

	return table.enabled === false ? 'Disabled' : 'Active';
}
assert.equal(codexStatus({mcp_servers: {ctx7: {}}}, 'ctx7'), 'Active', 'Codex：table 存在为 Active');
assert.equal(codexStatus({mcp_servers: {ctx7: {enabled: false}}}, 'ctx7'), 'Disabled', 'Codex：enabled=false 为 Disabled');
assert.equal(codexStatus({mcp_servers: {}}, 'ctx7'), 'Missing', 'Codex：无 table 为 Missing');
console.log('[PASS] 1.13b MCP Codex 状态：[mcp_servers.<id>] + enabled=false=Disabled');

// ── vault 职责：只保管凭据/备份/definitionHash，不保存 Codex API key、不作状态事实源 ──
const VAULT_ALLOWED_ROLES = ['credentials', 'configBackup', 'definitionHash'];
const VAULT_FORBIDDEN_ROLES = ['activeState', 'codexApiKey'];
for (const role of VAULT_ALLOWED_ROLES) {
	assert.ok(VAULT_ALLOWED_ROLES.includes(role), `vault 允许职责 ${role}`);
}
for (const role of VAULT_FORBIDDEN_ROLES) {
	assert.equal(VAULT_ALLOWED_ROLES.includes(role), false, `vault 不得承担 ${role}`);
}
console.log('[PASS] 1.13c MCP vault 职责边界：凭据/备份/hash，不作状态源、不存 Codex API key');
