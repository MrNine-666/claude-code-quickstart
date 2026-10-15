import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {computeSharedStatus, disableServer, enableServer} from '../../src/core/mcp.js';
import {loadVault, newEmptyVault, saveVault} from '../../src/core/mcp-vault.js';
import {claudeJsonPath, codexConfigPath, piMcpAdapterOverridesPath, piMcpConfigPath, vaultPath} from '../../src/core/paths.js';
import {detectPiMcpNative, resetPiMcpNativeFact} from '../../src/core/pi-mcp-adapter.js';
import {parse as parseToml} from '../../src/core/toml-edit.js';
import {applyMcpToggleTargetsAsync, saveEditedMcpServer, saveMcpServer} from '../../src/services/mcp-service.js';
import {createMcpEditFormModel} from '../../src/views/mcp/mcp-view-actions.js';
import {createTempHome} from '../helpers/temp-home.js';

const ID = 'bookclub';
const OLD = {url: 'https://old.example/mcp', headers: {'api-key': 'OLD-TEST-KEY'}};
const NEXT = {url: 'https://new.example/mcp', headers: {'api-key': 'NEW-TEST-KEY'}};
const execPi = async () => ({code: 0, stdout: '1.0.0', stderr: ''});
let home: ReturnType<typeof createTempHome>;

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value));
}

function seedPi(config: Record<string, unknown> = OLD): void {
	writeJson(piMcpConfigPath(), {sentinel: 'keep', mcpServers: {[ID]: config, untouched: {command: 'keep'}}});
}

function seedCodex(): void {
	mkdirSync(dirname(codexConfigPath()), {recursive: true});
	writeFileSync(
		codexConfigPath(),
		'# Keep this comment\nmodel = "keep"\n[mcp_servers.bookclub]\nurl = "https://old.example/mcp"\nenabled = false\n[mcp_servers.bookclub.http_headers]\napi-key = "OLD-TEST-KEY"\n[mcp_servers.untouched]\ncommand = "keep"\n'
	);
}

function seedVault(config: Record<string, unknown> = NEXT): void {
	const vault = newEmptyVault();
	vault.servers[ID] = {config, credentials: {values: {'api-key': 'NEW-TEST-KEY'}}};
	saveVault(vault);
}

function piEntry(): Record<string, unknown> {
	return JSON.parse(readFileSync(piMcpConfigPath(), 'utf8')).mcpServers[ID];
}

function codexEntry(): Record<string, unknown> {
	return (parseToml(readFileSync(codexConfigPath(), 'utf8')).mcp_servers as Record<string, Record<string, unknown>>)[ID]!;
}

beforeEach(async () => {
	home = createTempHome('ccq-mcp-edit-toggle-');
	resetPiMcpNativeFact();
	await detectPiMcpNative(execPi);
});

afterEach(() => {
	resetPiMcpNativeFact();
	home.restore();
	home.cleanup();
});

describe('MCP 完整编辑与开关不恢复旧定义', () => {
	test('Pi 完整编辑删除旧 auth/oauth/timeout/未知字段，保留其他 ID 与根字段', () => {
		seedPi({...OLD, auth: {provider: 'old'}, oauth: {clientId: 'old'}, timeout: 15, custom: 'old'});
		expect(saveEditedMcpServer(ID, JSON.stringify(NEXT)).ok).toBe(true);
		expect(piEntry()).toEqual(NEXT);
		const document = JSON.parse(readFileSync(piMcpConfigPath(), 'utf8'));
		expect(document.sentinel).toBe('keep');
		expect(document.mcpServers.untouched).toEqual({command: 'keep'});
	});

	test('Pi 已开启时，共享 http_headers 可替换同 URL 的旧 headers，并转换给 Claude', () => {
		seedPi();
		writeJson(claudeJsonPath(), {mcpServers: {[ID]: OLD}});
		const incoming = {url: OLD.url, http_headers: {'api-key': 'NEW-TEST-KEY'}};
		expect(saveEditedMcpServer(ID, JSON.stringify(incoming)).ok).toBe(true);
		expect(piEntry()).toEqual({url: OLD.url, headers: incoming.http_headers});
		expect(loadVault().servers[ID]?.config).toEqual(incoming);
		expect(JSON.parse(readFileSync(claudeJsonPath(), 'utf8')).mcpServers[ID]).toEqual({
			url: OLD.url,
			type: 'http',
			headers: incoming.http_headers
		});
	});

	test('仅 Pi 开启：编辑 URL/key → 刷新 → Pi 关闭/Codex 开启，使用新定义', async () => {
		seedPi();
		seedCodex();
		computeSharedStatus();
		expect(saveEditedMcpServer(ID, JSON.stringify(NEXT)).ok).toBe(true);
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers, enabled: false});
		computeSharedStatus();
		expect(loadVault().servers[ID]?.config).toEqual(NEXT);
		expect(await applyMcpToggleTargetsAsync(ID, {cc: false, cx: true, pi: false}, execPi)).toEqual({ok: true, status: 'Applied'});
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers});
		expect(piEntry()).toEqual({...NEXT, enabled: false});
		expect(loadVault().servers[ID]?.config).toEqual(NEXT);
		const toml = readFileSync(codexConfigPath(), 'utf8');
		expect(parseToml(toml).model).toBe('keep');
		expect((parseToml(toml).mcp_servers as Record<string, unknown>).untouched).toEqual({command: 'keep'});
		expect(await applyMcpToggleTargetsAsync(ID, {cc: false, cx: false, pi: true}, execPi)).toEqual({ok: true, status: 'Applied'});
		expect(piEntry()).toEqual(NEXT);
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers, enabled: false});
		expect(loadVault().servers[ID]?.config).toEqual(NEXT);
	});

	test('编辑立即更新所有 Agent，已关闭或缺失的 Codex/Pi 不自动开启', () => {
		seedPi({...OLD, enabled: false});
		writeJson(claudeJsonPath(), {sentinel: 'keep', mcpServers: {[ID]: OLD}});
		expect(saveEditedMcpServer(ID, JSON.stringify(NEXT)).ok).toBe(true);
		expect(JSON.parse(readFileSync(claudeJsonPath(), 'utf8')).mcpServers[ID]).toEqual({...NEXT, type: 'http'});
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers, enabled: false});
		expect(piEntry()).toEqual({...NEXT, enabled: false});
	});

	test('HTTP 改 stdio 立即替换所有已开启 Agent，旧 URL/header 不残留', () => {
		seedPi({...OLD, timeout: 15});
		seedCodex();
		writeFileSync(codexConfigPath(), readFileSync(codexConfigPath(), 'utf8').replace('enabled = false', 'enabled = true'));
		writeJson(claudeJsonPath(), {mcpServers: {[ID]: OLD}});
		const stdio = {command: 'new-command', args: ['--test']};
		expect(saveEditedMcpServer(ID, JSON.stringify(stdio)).ok).toBe(true);
		expect(piEntry()).toEqual(stdio);
		expect(codexEntry()).toEqual(stdio);
		expect(JSON.parse(readFileSync(claudeJsonPath(), 'utf8')).mcpServers[ID]).toEqual(stdio);
		computeSharedStatus();
		expect(loadVault().servers[ID]?.config).toEqual(stdio);
	});

	test('Pi 缺失时也立即写最新禁用配置，已关闭 Claude 不写回条目', () => {
		seedCodex();
		writeJson(claudeJsonPath(), {sentinel: 'keep', mcpServers: {untouched: {command: 'keep'}}});
		expect(saveEditedMcpServer(ID, JSON.stringify(NEXT)).ok).toBe(true);
		expect(piEntry()).toEqual({...NEXT, enabled: false});
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers, enabled: false});
		expect(JSON.parse(readFileSync(claudeJsonPath(), 'utf8'))).toEqual({
			sentinel: 'keep',
			mcpServers: {untouched: {command: 'keep'}}
		});
	});

	test('直接启用旧 Codex 禁用条目也不得覆盖共享新定义', () => {
		seedCodex();
		seedVault();
		expect(enableServer(ID, 'cx').Success).toBe(true);
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers});
		expect(loadVault().servers[ID]?.config).toEqual(NEXT);
	});

	test('关闭旧 Claude/Codex 条目不反写共享新定义；编辑回显用共享定义', () => {
		writeJson(claudeJsonPath(), {sentinel: 'keep', mcpServers: {[ID]: OLD}});
		seedCodex();
		seedVault();
		computeSharedStatus();
		expect(JSON.parse(createMcpEditFormModel(ID).initialJson)).toEqual(NEXT);
		expect(disableServer(ID, 'cc').Success).toBe(true);
		expect(disableServer(ID, 'cx').Success).toBe(true);
		expect(loadVault().servers[ID]?.config).toEqual(NEXT);
		expect(JSON.parse(readFileSync(claudeJsonPath(), 'utf8')).sentinel).toBe('keep');
	});

	test('首次发现 runtime-only 条目仍备份配置和凭据；刷新不反复写 vault', () => {
		seedPi();
		computeSharedStatus();
		expect(loadVault().servers[ID]?.config).toEqual(OLD);
		expect(loadVault().servers[ID]?.credentials).toEqual({values: OLD.headers});
		const before = readFileSync(vaultPath(), 'utf8');
		computeSharedStatus();
		expect(readFileSync(vaultPath(), 'utf8')).toBe(before);
	});

	test('显式 Codex 保存仍替换已有共享定义，并保留禁用状态', () => {
		seedCodex();
		seedVault(OLD);
		expect(saveMcpServer(ID, JSON.stringify(NEXT), 'cx').ok).toBe(true);
		expect(codexEntry()).toEqual({url: NEXT.url, http_headers: NEXT.headers, enabled: false});
		expect(loadVault().servers[ID]?.config).toEqual({...NEXT, type: 'http'});
	});

	test('编辑保存不重置 vault permissions（投影只写 Agent runtime）', () => {
		const vault = newEmptyVault();
		vault.servers[ID] = {config: OLD, permissions: [`mcp__${ID}`]};
		saveVault(vault);
		writeJson(claudeJsonPath(), {mcpServers: {[ID]: OLD}});
		seedCodex();
		expect(saveEditedMcpServer(ID, JSON.stringify(NEXT)).ok).toBe(true);
		expect(loadVault().servers[ID]?.permissions).toEqual([`mcp__${ID}`]);
		expect(loadVault().servers[ID]?.config).toEqual(NEXT);
	});

	test('Pi 已禁用时编辑仍完整替换，但不自动开启', () => {
		seedPi({...OLD, enabled: false, timeout: 15});
		expect(saveEditedMcpServer(ID, JSON.stringify(NEXT)).ok).toBe(true);
		expect(piEntry()).toEqual({...NEXT, enabled: false});
	});

	test('删除凭据立即从共享定义与 Agent 配置移除，不被刷新或启用恢复', () => {
		seedPi();
		seedCodex();
		const anonymous = {url: NEXT.url};
		expect(saveEditedMcpServer(ID, JSON.stringify(anonymous)).ok).toBe(true);
		computeSharedStatus();
		expect(loadVault().servers[ID]?.credentials).toBeUndefined();
		expect(piEntry()).toEqual(anonymous);
		expect(codexEntry()).toEqual({...anonymous, enabled: false});
		expect(enableServer(ID, 'cx').Success).toBe(true);
		expect(enableServer(ID, 'cc').Success).toBe(true);
		expect(codexEntry()).toEqual(anonymous);
		expect(JSON.parse(readFileSync(claudeJsonPath(), 'utf8')).mcpServers[ID]).toEqual({...anonymous, type: 'http'});
	});

	test('直接 Pi 原生保存仍拒绝 http_headers，禁用 Pi 编辑也校验 raw args/env', () => {
		seedPi({...OLD, enabled: false});
		const before = readFileSync(piMcpConfigPath(), 'utf8');
		expect(saveMcpServer(ID, JSON.stringify({url: NEXT.url, http_headers: NEXT.headers}), 'pi').ok).toBe(false);
		for (const incoming of [
			{...NEXT, args: [1]},
			{...NEXT, env: {KEY: 1}},
			{...NEXT, http_headers: {'api-key': 1}}
		]) {
			expect(saveEditedMcpServer(ID, JSON.stringify(incoming)).ok).toBe(false);
			expect(readFileSync(piMcpConfigPath(), 'utf8')).toBe(before);
		}
	});

	test.each(['claude', 'codex', 'pi', 'ownership'] as const)('损坏 %s 目标时，保存前拒绝且不改其他文件', target => {
		seedPi();
		seedCodex();
		seedVault(OLD);
		writeJson(claudeJsonPath(), {mcpServers: {[ID]: OLD}});
		writeJson(piMcpAdapterOverridesPath(), {schemaVersion: 1, servers: {}});
		const paths = {
			claude: claudeJsonPath(),
			codex: codexConfigPath(),
			pi: piMcpConfigPath(),
			ownership: piMcpAdapterOverridesPath()
		};
		writeFileSync(paths[target], 'BROKEN-TEST-SECRET = "');
		const snapshots = [...Object.values(paths), vaultPath()].map(path => [path, readFileSync(path, 'utf8')] as const);
		const result = saveEditedMcpServer(ID, JSON.stringify(NEXT));
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain('BROKEN-TEST-SECRET');
		for (const [path, text] of snapshots) expect(readFileSync(path, 'utf8')).toBe(text);
	});

	describe('本机 Pi 条目不合规（旧版 lifecycle/disabled 字段）', () => {
		const EXA = 'exa';
		const EXA_NEXT = {url: 'https://mcp.exa.ai/mcp', headers: {'x-api-key': 'EXA-NEW-KEY'}};
		const seedLegacyExa = (legacy: Record<string, unknown>): void =>
			writeJson(piMcpConfigPath(), {mcpServers: {[EXA]: {url: 'https://mcp.exa.ai/mcp', ...legacy}}});
		const exaEntry = (): Record<string, unknown> => JSON.parse(readFileSync(piMcpConfigPath(), 'utf8')).mcpServers[EXA];

		test('旧禁用条目编辑保存成功：整条替换为新配置并保持禁用', () => {
			seedLegacyExa({lifecycle: 'lazy', disabled: true});
			expect(saveEditedMcpServer(EXA, JSON.stringify(EXA_NEXT))).toEqual({ok: true, status: 'Saved'});
			expect(exaEntry()).toEqual({...EXA_NEXT, enabled: false});
		});

		test('旧开启条目编辑保存成功：整条替换为新配置并保持开启', () => {
			seedLegacyExa({lifecycle: 'lazy'});
			expect(saveEditedMcpServer(EXA, JSON.stringify(EXA_NEXT))).toEqual({ok: true, status: 'Saved'});
			expect(exaEntry()).toEqual(EXA_NEXT);
		});

		test('sidecar 损坏时编辑失败，报错含具体原因且所有目标字节不变', () => {
			seedLegacyExa({lifecycle: 'lazy'});
			seedCodex();
			seedVault(OLD);
			writeJson(claudeJsonPath(), {mcpServers: {[EXA]: EXA_NEXT}});
			writeJson(piMcpAdapterOverridesPath(), {schemaVersion: 2, servers: {}});
			const paths = [claudeJsonPath(), codexConfigPath(), piMcpConfigPath(), piMcpAdapterOverridesPath(), vaultPath()];
			const snapshots = paths.map(path => [path, readFileSync(path, 'utf8')] as const);
			const result = saveEditedMcpServer(EXA, JSON.stringify(EXA_NEXT));
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).toContain('Pi MCP ownership sidecar 无法读取或结构无效');
			for (const [path, text] of snapshots) expect(readFileSync(path, 'utf8')).toBe(text);
		});

		test('开关操作仍拒绝不合规条目，并给出具体原因', () => {
			seedLegacyExa({lifecycle: 'lazy', disabled: true});
			const before = readFileSync(piMcpConfigPath(), 'utf8');
			for (const result of [enableServer(EXA, 'pi'), disableServer(EXA, 'pi')]) {
				expect(result.Success).toBe(false);
				expect(result.Status).toContain('adapter 字段');
			}
			expect(readFileSync(piMcpConfigPath(), 'utf8')).toBe(before);
		});
	});

	test('Pi active edit 保留空 Authorization，拒绝坏 args/env/SSE/矛盾别名且不泄漏凭据', () => {
		seedPi();
		const anonymous = {...NEXT, headers: {Authorization: ''}};
		expect(saveEditedMcpServer(ID, JSON.stringify(anonymous)).ok).toBe(true);
		expect(piEntry()).toEqual(anonymous);
		const before = readFileSync(piMcpConfigPath(), 'utf8');
		const vaultBefore = readFileSync(vaultPath(), 'utf8');
		for (const config of [
			{...NEXT, args: [1]},
			{...NEXT, env: {KEY: 1}},
			{...NEXT, type: 'sse'},
			{...NEXT, http_headers: {'api-key': 'CONFLICT-TEST-KEY'}},
			{...NEXT, http_headers: {'api-key': 1}},
			{...NEXT, disabled: true, enabled: true}
		]) {
			const result = saveEditedMcpServer(ID, JSON.stringify(config));
			expect(result.ok).toBe(false);
			expect(JSON.stringify(result)).not.toContain('NEW-TEST-KEY');
			expect(JSON.stringify(result)).not.toContain('CONFLICT-TEST-KEY');
			expect(readFileSync(piMcpConfigPath(), 'utf8')).toBe(before);
			expect(readFileSync(vaultPath(), 'utf8')).toBe(vaultBefore);
		}
	});
});
