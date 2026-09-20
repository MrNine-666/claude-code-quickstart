import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {computeSharedStatus, type McpSharedRow} from '../../src/core/mcp.js';
import {resetMcpContractCache} from '../../src/core/mcp-contract.js';
import {createTempHome} from '../helpers/temp-home.js';

// A 类改写（P1-G3）：MCP 三侧聚合投影函数（core/mcp.ts computeSharedStatus）——
// 与原 verify-mcp-shared-projection.mjs 行为段同源，把视图源码正则（badge/提示/输入隔离）
// 对应的聚合事实纳入 tests/ 的可调用行为入口。
//
// 覆盖：四源并集去重、cc/cx/pi 独立不塌缩、vault 定义 ≠ 激活态、runtime 实时派生、
// Pi runtime 回灌 vault、Codex enabled=false 归 not-active 且纯读不物化。

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
}

function writeText(path: string, value: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, value, 'utf8');
}

function row(rows: readonly McpSharedRow[], id: string): McpSharedRow | undefined {
	return rows.find(item => item.Id === id);
}

describe('computeSharedStatus 三侧聚合投影', () => {
	test('四源并集一行一 Id，cc/cx/pi 独立不塌缩，runtime 实时派生且 Pi 回灌 vault', () => {
		const home = createTempHome('ccq-mcp-shared-');
		const previousHome = process.env.HOME;
		const previousUserProfile = process.env.USERPROFILE;
		process.env.HOME = home.path;
		process.env.USERPROFILE = home.path;
		try {
			const claudeJsonPath = join(home.path, '.claude.json');
			const codexConfigPath = join(home.path, '.codex', 'config.toml');
			const piMcpConfigPath = join(home.path, '.pi', 'agent', 'mcp.json');
			const vaultPath = join(home.path, '.ccq', 'mcp-meta.json');

			writeJson(claudeJsonPath, {mcpServers: {alpha: {type: 'http', url: 'https://alpha.example'}}});
			writeText(
				codexConfigPath,
				[
					'[mcp_servers.beta]',
					'command = "beta-cli"',
					'',
					'[mcp_servers.gamma]',
					'command = "gamma-cli"',
					'enabled = false',
					''
				].join('\n')
			);
			writeJson(piMcpConfigPath, {mcpServers: {epsilon: {command: 'epsilon-cli'}}});
			writeJson(vaultPath, {
				schemaVersion: 1,
				createdAt: '2026-07-12T00:00:00.000Z',
				updatedAt: '2026-07-12T00:00:00.000Z',
				servers: {delta: {config: {command: 'delta-cli', args: ['serve']}}}
			});

			resetMcpContractCache();
			const rows = computeSharedStatus();
			const ids = rows.map(entry => entry.Id);
			expect(new Set(ids).size).toBe(ids.length);
			for (const id of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
				expect(ids).toContain(id);
			}

			expect(row(rows, 'alpha')?.injectByAgent.cc.active).toBe(true);
			expect(row(rows, 'alpha')?.injectByAgent.cx.active).toBe(false);
			expect(row(rows, 'beta')?.injectByAgent.cx.active).toBe(true);
			expect(row(rows, 'beta')?.injectByAgent.cc.active).toBe(false);
			expect(row(rows, 'delta')?.hasDefinition).toBe(true);
			expect(row(rows, 'delta')?.injectByAgent.cc.active).toBe(false);
			expect(row(rows, 'epsilon')?.hasDefinition).toBe(true);
			expect(JSON.parse(readFileSync(vaultPath, 'utf8')).servers.epsilon.config.command).toBe('epsilon-cli');

			// 外部删除 alpha 后重投影立即反映；gamma 第三态归 not-active 且纯读不物化。
			writeJson(claudeJsonPath, {mcpServers: {}});
			const afterEdit = computeSharedStatus();
			expect(row(afterEdit, 'alpha')?.injectByAgent.cc.active).toBe(false);
			expect(row(afterEdit, 'gamma')?.injectByAgent.cx.active).toBe(false);
			const codexAfter = readFileSync(codexConfigPath, 'utf8');
			expect(codexAfter).toContain('[mcp_servers.gamma]');
			expect(codexAfter).toContain('enabled = false');
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = previousUserProfile;
			home.restore();
			home.cleanup();
		}
	});
});
