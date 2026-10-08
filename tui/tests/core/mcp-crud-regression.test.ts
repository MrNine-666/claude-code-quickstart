import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {computeSharedStatus, removeSharedServer} from '../../src/core/mcp.js';
import {addSharedMcpServer} from '../../src/services/mcp-service.js';
import {createTempHome} from '../helpers/temp-home.js';

function write(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

describe('MCP CRUD regression', () => {
	test('confirmed delete removes unowned Pi entry across all agents and does not revive on refresh', () => {
		const home = createTempHome('ccq-mcp-delete-');
		try {
			const cc = join(home.path, '.claude.json');
			const cx = join(home.path, '.codex', 'config.toml');
			const pi = join(home.path, '.pi', 'agent', 'mcp.json');
			const vault = join(home.path, '.ccq', 'mcp-meta.json');
			const sidecar = join(home.path, '.pi', 'agent', 'mcp-adapter-overrides.json');
			write(cc, {mcpServers: {exa: {command: 'old-cc'}, keep: {command: 'keep'}}, userRoot: true});
			write(cx, '[mcp_servers.exa]\ncommand = "old-cx"\nenabled = false\n[mcp_servers.keep]\ncommand = "keep"\n');
			write(pi, {mcpServers: {exa: {command: 'old-pi'}, keep: {command: 'keep'}}, autoEnableCodemode: false});
			write(sidecar, {
				schemaVersion: 1,
				managedServers: ['exa', 'keep'],
				servers: {exa: {enabled: true}, keep: {enabled: false}},
				userRoot: true
			});
			computeSharedStatus();
			expect(removeSharedServer('exa').Success).toBe(false);
			expect(JSON.parse(readFileSync(pi, 'utf8')).mcpServers.exa).toBeDefined();
			expect(removeSharedServer('exa', true).Success).toBe(true);
			expect(computeSharedStatus().some(row => row.Id === 'exa')).toBe(false);
			expect(JSON.parse(readFileSync(vault, 'utf8')).servers.exa).toBeUndefined();
			expect(JSON.parse(readFileSync(cc, 'utf8'))).toEqual({mcpServers: {keep: {command: 'keep'}}, userRoot: true});
			expect(JSON.parse(readFileSync(pi, 'utf8'))).toEqual({mcpServers: {keep: {command: 'keep'}}, autoEnableCodemode: false});
			expect(JSON.parse(readFileSync(sidecar, 'utf8'))).toEqual({
				schemaVersion: 1,
				managedServers: ['keep'],
				servers: {keep: {enabled: false}},
				userRoot: true
			});
			expect(readFileSync(cx, 'utf8')).not.toContain('[mcp_servers.exa]');
			expect(readFileSync(cx, 'utf8')).toContain('[mcp_servers.keep]');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('corrupt Pi config rejects full deletion and preserves bytes', () => {
		const home = createTempHome('ccq-mcp-corrupt-');
		try {
			const cc = join(home.path, '.claude.json');
			const pi = join(home.path, '.pi', 'agent', 'mcp.json');
			write(cc, {mcpServers: {exa: {command: 'keep'}}});
			write(pi, '{broken');
			const before = readFileSync(cc, 'utf8');
			expect(removeSharedServer('exa', true).Success).toBe(false);
			expect(readFileSync(pi, 'utf8')).toBe('{broken');
			expect(readFileSync(cc, 'utf8')).toBe(before);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	for (const source of ['cc', 'cx', 'pi', 'vault'] as const) {
		test(`add rejects duplicate ID from ${source} without changing files`, () => {
			const home = createTempHome('ccq-mcp-duplicate-');
			try {
				const paths = {
					cc: join(home.path, '.claude.json'),
					cx: join(home.path, '.codex', 'config.toml'),
					pi: join(home.path, '.pi', 'agent', 'mcp.json'),
					vault: join(home.path, '.ccq', 'mcp-meta.json')
				};
				write(paths.cc, {mcpServers: source === 'cc' ? {exa: {command: 'old'}} : {}});
				write(paths.cx, source === 'cx' ? '[mcp_servers.exa]\ncommand = "old"\nenabled = false\n' : '# keep\n');
				write(paths.pi, {mcpServers: source === 'pi' ? {exa: {command: 'old', enabled: false}} : {}});
				write(paths.vault, {schemaVersion: 1, servers: source === 'vault' ? {exa: {config: {command: 'old'}}} : {}});
				const before = Object.values(paths).map(path => readFileSync(path, 'utf8'));
				const result = addSharedMcpServer(' exa ', '{"command":"new"}');
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error).toContain('已存在');
				expect(Object.values(paths).map(path => readFileSync(path, 'utf8'))).toEqual(before);
			} finally {
				home.restore();
				home.cleanup();
			}
		});
	}
});
