import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {persistMcpServer, enableServer} from '../../src/core/mcp.js';
import {importCodexMcpSection, importPiMcpSection} from '../../src/core/config-transfer-mcp.js';
import {detectPiMcpNative, resetPiMcpNativeFact} from '../../src/core/pi-mcp-adapter.js';
import {createTempHome} from '../helpers/temp-home.js';

function write(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

for (const agent of ['cx', 'pi'] as const) {
	describe(`${agent} MCP 默认禁用`, () => {
		for (const initial of ['missing-file', 'missing-id', 'disabled', 'active'] as const) {
			test(`save ${initial}: preserve local activation, explicit enable still works`, async () => {
				const home = createTempHome('ccq-mcp-default-');
				try {
					resetPiMcpNativeFact();
					await detectPiMcpNative(async () => ({code: 0, stdout: '1.0.0', stderr: ''}));
					const path = agent === 'cx' ? join(home.path, '.codex', 'config.toml') : join(home.path, '.pi', 'agent', 'mcp.json');
					if (initial !== 'missing-file') {
						const config = {command: 'old', ...(initial === 'disabled' ? {enabled: false} : {})};
						write(
							path,
							agent === 'cx'
								? `[mcp_servers.${initial === 'missing-id' ? 'other' : 'custom'}]\ncommand = "old"\n${initial === 'disabled' ? 'enabled = false\n' : ''}`
								: {mcpServers: {[initial === 'missing-id' ? 'other' : 'custom']: config}}
						);
					}
					const result = persistMcpServer('custom', {command: 'new', enabled: true}, {}, '', agent);
					expect(result.Success).toBe(true);
					const readDisabled = () =>
						agent === 'cx'
							? readFileSync(path, 'utf8').includes('enabled = false')
							: JSON.parse(readFileSync(path, 'utf8')).mcpServers.custom.enabled === false;
					expect(readDisabled()).toBe(initial !== 'active');
					expect(enableServer('custom', agent).Success).toBe(true);
					expect(readDisabled()).toBe(false);
				} finally {
					resetPiMcpNativeFact();
					home.restore();
					home.cleanup();
				}
			});
		}

		for (const initial of ['missing-file', 'missing-id'] as const) {
			test(`import ${initial}: incoming active server defaults disabled`, () => {
				const home = createTempHome('ccq-mcp-import-default-');
				try {
					const path = agent === 'cx' ? join(home.path, '.codex', 'config.toml') : join(home.path, '.pi', 'agent', 'mcp.json');
					if (initial === 'missing-id')
						write(path, agent === 'cx' ? '[mcp_servers.other]\ncommand = "keep"\n' : {mcpServers: {other: {command: 'keep'}}});
					const data = {
						servers: [{id: 'custom', config: {command: 'new', enabled: true}}],
						containsCredentials: false,
						excluded: [],
						excludedCredentials: [],
						dialect: 'pi-native',
						managedServers: ['custom'],
						overrides: []
					};
					const importSection = agent === 'cx' ? importCodexMcpSection : importPiMcpSection;
					expect(importSection(data, {containsCredentials: false}).ok).toBe(true);
					expect(
						agent === 'cx'
							? readFileSync(path, 'utf8').includes('enabled = false')
							: JSON.parse(readFileSync(path, 'utf8')).mcpServers.custom.enabled === false
					).toBe(true);
				} finally {
					home.restore();
					home.cleanup();
				}
			});
		}
	});
}
