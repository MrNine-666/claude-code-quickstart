import assert from 'node:assert/strict';
import {existsSync, mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {buildMcpFormFields} from '../dist/core/mcp-form.js';
import {buildMcpServerConfig} from '../dist/services/mcp-service.js';
import {persistMcpServer, disableServer, enableServer, removeServer} from '../dist/core/mcp.js';
import {settingsPath, claudeJsonPath, vaultPath} from '../dist/core/paths.js';

// Phase 4 尾巴门禁：MCP ID 不变性（6.10）+ MCP permissions 生命周期一致性（6.11）。

const singleDef = {
	Name: 'Exa',
	McpType: 'stdio',
	Command: 'npx',
	Args: ['-y', 'exa-mcp-server'],
	CredentialType: 'single-key',
	ApiKeyName: 'EXA_API_KEY'
};

function withTempHome(fn) {
	const home = mkdtempSync(join(tmpdir(), 'ccq-mcp-test-'));
	const previous = process.env.CCQ_HOME;
	process.env.CCQ_HOME = home;
	try {
		fn(home);
	} finally {
		if (previous === undefined) {
			delete process.env.CCQ_HOME;
		} else {
			process.env.CCQ_HOME = previous;
		}

		rmSync(home, {recursive: true, force: true});
	}
}

// ── 6.10 MCP ID 不变性：编辑表单 Server ID 只读 + 改名 payload 拒绝且不写盘 ──────
{
	// 内置编辑：Server ID 字段可见且只读
	const editForm = buildMcpFormFields('exa', singleDef, {env: {EXA_API_KEY: 'k'}}, 'edit-builtin');
	const idField = editForm.fields[0];
	assert.equal(idField.id, '__serverId', '首字段应为 Server ID');
	assert.equal(idField.type, 'readonly', 'edit-builtin Server ID 必须只读');
	assert.equal(idField.value, 'exa');

	// 已存在自定义（serverId 非空）→ 只读；新建（serverId 空）→ 可填
	const customDef = {McpType: 'stdio', CredentialType: 'none'};
	const customEdit = buildMcpFormFields('my-custom', customDef, {command: 'node', args: []}, 'add-custom-stdio');
	assert.equal(customEdit.fields[0].type, 'readonly', '已存在自定义 Server ID 必须只读');
	const customAdd = buildMcpFormFields('', customDef, null, 'add-custom-stdio');
	assert.equal(customAdd.fields[0].type, 'text', '新建自定义 Server ID 可填');

	// payload 携带不同 Server ID → 拒绝
	const mismatch = buildMcpServerConfig('exa-renamed', singleDef, {EXA_API_KEY: 'k'}, 'exa');
	assert.equal(mismatch.ok, false, '改名 payload 必须拒绝');
	assert.match(mismatch.error, /不可修改/);

	// 同 ID → 放行
	const same = buildMcpServerConfig('exa', singleDef, {EXA_API_KEY: 'k'}, 'exa');
	assert.equal(same.ok, true, '同 ID 应放行');

	// 改名拒绝时不得产生任何写盘副作用
	withTempHome(() => {
		const rejected = buildMcpServerConfig('exa-renamed', singleDef, {EXA_API_KEY: 'k'}, 'exa');
		assert.equal(rejected.ok, false);
		assert.equal(existsSync(settingsPath()), false, '改名拒绝不得写 settings.json');
		assert.equal(existsSync(claudeJsonPath()), false, '改名拒绝不得写 .claude.json');
		assert.equal(existsSync(vaultPath()), false, '改名拒绝不得写 vault');
	});

	console.log('[PASS] 6.10 MCP ID 不变性：编辑只读 / 改名拒绝且不写盘');
}

// ── 6.11 MCP permissions 一致性：add → disable → enable → remove 全生命周期 ──────
{
	withTempHome(() => {
		const serverId = 'perm-test';
		const mcpPerm = `mcp__${serverId}`;

		const readAllow = () => {
			if (!existsSync(settingsPath())) {
				return [];
			}

			const settings = JSON.parse(readFileSync(settingsPath(), 'utf8'));
			return settings.permissions?.allow ?? [];
		};
		const hasServer = () => {
			if (!existsSync(claudeJsonPath())) {
				return false;
			}

			const cj = JSON.parse(readFileSync(claudeJsonPath(), 'utf8'));
			return Boolean(cj.mcpServers && serverId in cj.mcpServers);
		};
		const vaultEntry = () => {
			if (!existsSync(vaultPath())) {
				return undefined;
			}

			return JSON.parse(readFileSync(vaultPath(), 'utf8')).servers?.[serverId];
		};

		// add：mcp__<id> 进入 settings；server 进入 .claude.json；vault disabled:false
		const added = persistMcpServer(serverId, {command: 'npx', args: ['-y', 'x']}, {}, 'h1');
		assert.equal(added.Success, true);
		assert.ok(readAllow().includes(mcpPerm), 'add 后 settings 应含 mcp__<id>');
		assert.equal(hasServer(), true, 'add 后 .claude.json 应含 server');
		assert.equal(vaultEntry()?.disabled, false, 'add 后 vault disabled:false');

		// add 幂等：重复 add 不产生重复 permission
		persistMcpServer(serverId, {command: 'npx', args: ['-y', 'x']}, {}, 'h1');
		assert.equal(readAllow().filter(p => p === mcpPerm).length, 1, 'add 幂等：mcp__<id> 不重复');

		// disable：移除 settings permission 与 .claude.json，vault 保留可恢复 permission
		const disabled = disableServer(serverId);
		assert.equal(disabled.Success, true);
		assert.equal(readAllow().includes(mcpPerm), false, 'disable 后移除 mcp__<id>');
		assert.equal(hasServer(), false, 'disable 后从 .claude.json 移除');
		assert.equal(vaultEntry()?.disabled, true, 'disable 后 vault disabled:true');
		assert.ok((vaultEntry()?.permissions ?? []).includes(mcpPerm), 'disable 保留可恢复 permission');

		// enable：从 vault 恢复 permission 与 server
		const enabled = enableServer(serverId);
		assert.equal(enabled.Success, true);
		assert.ok(readAllow().includes(mcpPerm), 'enable 后恢复 mcp__<id>');
		assert.equal(hasServer(), true, 'enable 后恢复 server');
		assert.equal(vaultEntry()?.disabled, false, 'enable 后 vault disabled:false');

		// remove：彻底清除 settings permission、.claude.json、vault
		const removed = removeServer(serverId, true);
		assert.equal(removed.Success, true);
		assert.equal(readAllow().includes(mcpPerm), false, 'remove 后移除 mcp__<id>');
		assert.equal(hasServer(), false, 'remove 后从 .claude.json 移除');
		assert.equal(vaultEntry(), undefined, 'remove 后 vault 清除');

		// remove 未确认 → NeedConfirmation，不写盘
		const unconfirmed = removeServer('whatever', false);
		assert.equal(unconfirmed.Success, false);
		assert.equal(unconfirmed.Status, 'NeedConfirmation');
	});

	console.log('[PASS] 6.11 MCP permissions 生命周期：add/disable/enable/remove 后 mcp__<id> 一致');
}

console.log('[PASS] Phase 4 尾巴（6.10 ID 不变性 / 6.11 permissions 一致性）门禁通过');
