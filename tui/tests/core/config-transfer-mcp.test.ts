import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import type {BundlePayload, BundleSection} from '../../src/core/config-transfer.js';
import {
	applyConfigTransferImport,
	planConfigTransferExport,
	planConfigTransferImport,
	type ConfigTransferImportPlanItem,
	type TransferCategoryAction
} from '../../src/core/config-transfer-plan.js';
import {loadVault, newEmptyVault, saveVault, type McpVaultServerEntry} from '../../src/core/mcp-vault.js';
import {
	claudeJsonPath,
	codexConfigPath,
	piMcpAdapterOverridesPath,
	piMcpConfigPath,
	settingsPath,
	vaultPath
} from '../../src/core/paths.js';
import {resetPiMcpNativeFact} from '../../src/core/pi-mcp-adapter.js';
import {createInitialSystemSettingsState, reduceSystemSettingsState} from '../../src/state/system-settings-state.js';
import {parse as parseToml} from '../../src/core/toml-edit.js';
import {createTempHome} from '../helpers/temp-home.js';

const execPi = async () => ({code: 0, stdout: '1.0.0', stderr: ''});
const OPTIONS = {piPackages: {exec: execPi}};
const EXA_URL = 'https://mcp.exa.ai/mcp';
let home: ReturnType<typeof createTempHome>;

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value));
}

function readJson(path: string): Record<string, any> {
	return JSON.parse(readFileSync(path, 'utf8'));
}

function seedVault(servers: Record<string, McpVaultServerEntry>): void {
	const vault = newEmptyVault();
	Object.assign(vault.servers, servers);
	saveVault(vault);
}

function seedCodex(text: string): void {
	mkdirSync(dirname(codexConfigPath()), {recursive: true});
	writeFileSync(codexConfigPath(), text);
}

function codexServers(): Record<string, Record<string, unknown>> {
	return parseToml(readFileSync(codexConfigPath(), 'utf8')).mcp_servers as Record<string, Record<string, unknown>>;
}

function payload(sections: readonly BundleSection[], containsCredentials = false): BundlePayload {
	return {
		createdAt: '2026-10-15T00:00:00.000Z',
		createdBy: {name: 'ccq', version: 'test', platform: 'test'},
		containsCredentials,
		sections
	};
}

const TARGETS = () => [vaultPath(), claudeJsonPath(), settingsPath(), codexConfigPath(), piMcpConfigPath(), piMcpAdapterOverridesPath()];
const snapshot = () => TARGETS().map(path => (existsSync(path) ? readFileSync(path, 'utf8') : null));

async function planAndApply(sections: readonly BundleSection[], decisions = [] as Parameters<typeof applyConfigTransferImport>[2]) {
	const bundle = payload(sections);
	const plan = await planConfigTransferImport(bundle, OPTIONS);
	if (!plan.ok) throw new Error(plan.error);
	const outcome = await applyConfigTransferImport(bundle, plan.data, decisions, OPTIONS);
	return {bundle, plan: plan.data, outcome};
}

beforeEach(() => {
	home = createTempHome('ccq-transfer-mcp-');
	resetPiMcpNativeFact();
});

afterEach(() => {
	resetPiMcpNativeFact();
	home.restore();
	home.cleanup();
});

describe('MCP 共享库分类整体覆盖', () => {
	const library = {
		tool: 'ccq',
		category: 'mcp-library',
		data: {schemaVersion: 1, containsCredentials: false, servers: [{id: 'exa', config: {url: EXA_URL}, permissions: []}]}
	} as const;

	function seedLocal(): void {
		seedVault({
			exa: {
				config: {url: EXA_URL, headers: {'x-api-key': 'LOCAL-SECRET'}, timeout: 30, custom: 'local'},
				credentials: {values: {'x-api-key': 'LOCAL-SECRET'}},
				permissions: ['mcp__exa']
			},
			keep: {config: {command: 'keep-cmd'}, permissions: []}
		});
		writeJson(claudeJsonPath(), {sentinel: 'keep', mcpServers: {exa: {url: EXA_URL, headers: {'x-api-key': 'LOCAL-SECRET'}}}});
		seedCodex(
			`model = "keep"\n[mcp_servers.exa]\nurl = "${EXA_URL}"\nenabled = false\n[mcp_servers.exa.http_headers]\nx-api-key = "LOCAL-SECRET"\n`
		);
		// 旧版 adapter 写入的不合规禁用条目。
		writeJson(piMcpConfigPath(), {mcpServers: {exa: {url: EXA_URL, lifecycle: 'lazy', disabled: true}}});
	}

	test('预览零写盘，只提示将清除的凭据键名；覆盖后清除本机多余字段与凭据并按开关投影各 Agent', async () => {
		seedLocal();
		const before = snapshot();
		const bundle = payload([library]);
		const plan = await planConfigTransferImport(bundle, OPTIONS);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return;
		expect(snapshot()).toEqual(before);
		const item = plan.data.items.find(candidate => candidate.category === 'mcp-library')!;
		expect(item.defaultAction).toBe('replace');
		expect(item.mergeUnavailable).toBeTruthy();
		expect(item.replace?.identities.replaced).toEqual(['exa']);
		expect(item.replace?.counts.removed).toBe(0);
		expect(item.replace?.warnings.join('\n')).toContain('credentials:x-api-key');
		expect(JSON.stringify(plan.data)).not.toContain('LOCAL-SECRET');

		const outcome = await applyConfigTransferImport(bundle, plan.data, [], OPTIONS);
		expect(outcome.ok && outcome.data.status).toBe('complete');
		const vault = loadVault();
		expect(vault.servers.exa).toEqual({config: {url: EXA_URL}, permissions: []});
		expect(vault.servers.keep).toEqual({config: {command: 'keep-cmd'}, permissions: []});
		expect(readJson(claudeJsonPath())).toEqual({sentinel: 'keep', mcpServers: {exa: {url: EXA_URL, type: 'http'}}});
		expect(codexServers().exa).toEqual({url: EXA_URL, enabled: false});
		expect(readJson(piMcpConfigPath()).mcpServers.exa).toEqual({url: EXA_URL, enabled: false});
		for (const path of TARGETS()) if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toContain('LOCAL-SECRET');

		// postflight 幂等：再次预览全部 unchanged。
		const again = await planConfigTransferImport(bundle, OPTIONS);
		expect(again.ok && again.data.items[0]?.status).toBe('unchanged');
	});

	test('本机已有 Pi 条目但 Pi 不可用时预览即阻断，不留到 apply 才失败', async () => {
		seedLocal();
		const noPi = {piPackages: {exec: async () => ({code: 1, stdout: '', stderr: 'not found'})}};
		const plan = await planConfigTransferImport(payload([library]), noPi);
		expect(plan.ok && plan.data.items[0]?.status).toBe('blocked');
		expect(plan.ok && plan.data.items[0]?.reason).toContain('Pi');
	});

	test('merge 决策被拒绝且零写盘；skip 零写盘', async () => {
		seedLocal();
		const before = snapshot();
		const bundle = payload([library]);
		const plan = await planConfigTransferImport(bundle, OPTIONS);
		if (!plan.ok) throw new Error(plan.error);
		const merge = await applyConfigTransferImport(
			bundle,
			plan.data,
			[{tool: 'ccq', category: 'mcp-library', action: 'merge'}],
			OPTIONS
		);
		expect(merge.ok ? 'ok' : merge.error).toBe('导入分类策略无效');
		const skip = await applyConfigTransferImport(bundle, plan.data, [{tool: 'ccq', category: 'mcp-library', action: 'skip'}], OPTIONS);
		expect(skip.ok && skip.data.skipped.length).toBe(1);
		expect(snapshot()).toEqual(before);
	});
});

describe('Agent MCP 分类只迁移开关', () => {
	test('新格式：按包内状态启停（新 id 可开启），契约缺失 id 跳过', async () => {
		seedVault({exa: {config: {url: EXA_URL}, permissions: []}, ctx: {config: {command: 'ctx-cmd'}, permissions: []}});
		seedCodex('[mcp_servers.ctx]\ncommand = "ctx-cmd"\n');
		const sections: BundleSection[] = [
			{
				tool: 'ccq',
				category: 'mcp-library',
				data: {schemaVersion: 1, containsCredentials: false, servers: [{id: 'fresh', config: {command: 'fresh-cmd'}}]}
			},
			{
				tool: 'cc',
				category: 'mcp',
				data: {
					format: 'activation',
					servers: [
						{id: 'exa', enabled: true},
						{id: 'fresh', enabled: true},
						{id: 'ghost', enabled: true}
					]
				}
			},
			{
				tool: 'cx',
				category: 'mcp',
				data: {
					format: 'activation',
					servers: [
						{id: 'ctx', enabled: false},
						{id: 'exa', enabled: true}
					]
				}
			},
			{
				tool: 'pi',
				category: 'mcp',
				data: {
					format: 'activation',
					dialect: 'pi-native',
					autoEnableCodemode: true,
					servers: [
						{id: 'exa', enabled: true},
						{id: 'ctx', enabled: false}
					]
				}
			}
		];
		const {plan, outcome} = await planAndApply(sections);
		const cc = plan.items.find(item => item.tool === 'cc')!;
		expect(cc.identities.added).toEqual(['exa', 'fresh']);
		expect(cc.identities.skipped).toEqual(['ghost']);
		expect(plan.items.find(item => item.tool === 'cx')?.identities).toMatchObject({added: ['exa'], replaced: ['ctx']});
		expect(plan.items.find(item => item.tool === 'pi')?.identities).toMatchObject({
			added: ['exa', 'ctx'],
			replaced: ['autoEnableCodemode']
		});
		expect(outcome.ok && outcome.data.status).toBe('complete');

		expect(readJson(claudeJsonPath()).mcpServers).toEqual({exa: {url: EXA_URL, type: 'http'}, fresh: {command: 'fresh-cmd'}});
		expect(readJson(settingsPath()).permissions.allow).toEqual(['mcp__exa', 'mcp__fresh']);
		expect(codexServers().ctx).toEqual({command: 'ctx-cmd', enabled: false});
		expect(codexServers().exa).toEqual({url: EXA_URL});
		const pi = readJson(piMcpConfigPath());
		expect(pi.autoEnableCodemode).toBe(true);
		expect(pi.mcpServers.exa).toEqual({url: EXA_URL});
		expect(pi.mcpServers.ctx).toEqual({command: 'ctx-cmd', enabled: false});
		for (const path of TARGETS()) if (existsSync(path)) expect(readFileSync(path, 'utf8')).not.toContain('ghost');
	});

	test('旧格式包只推导开关：旧 config、凭据与 Pi 字段不落盘', async () => {
		seedVault({exa: {config: {url: EXA_URL}, permissions: []}});
		const legacy = {url: 'https://legacy.example/mcp', headers: {'x-api-key': 'LEGACY-SECRET'}, lifecycle: 'lazy'};
		const {outcome} = await planAndApply([
			{
				tool: 'cc',
				category: 'mcp',
				data: {containsCredentials: true, servers: [{id: 'exa', config: legacy}], permissions: ['mcp__evil']}
			},
			{
				tool: 'pi',
				category: 'mcp',
				data: {
					dialect: 'pi-native',
					autoEnableCodemode: false,
					managedServers: ['exa'],
					overrides: [{id: 'exa', config: {enabled: true}}],
					servers: [{id: 'exa', config: {...legacy, disabled: true}}]
				}
			}
		]);
		expect(outcome.ok && outcome.data.status).toBe('complete');
		expect(readJson(claudeJsonPath()).mcpServers.exa).toEqual({url: EXA_URL, type: 'http'});
		expect(readJson(piMcpConfigPath())).toEqual({mcpServers: {exa: {url: EXA_URL, enabled: false}}, autoEnableCodemode: false});
		for (const path of TARGETS()) {
			if (!existsSync(path)) continue;
			const text = readFileSync(path, 'utf8');
			for (const needle of ['legacy.example', 'LEGACY-SECRET', 'lifecycle', 'mcp__evil']) expect(text).not.toContain(needle);
		}
	});
});

describe('MCP 导出', () => {
	test('runtime-only id 补入契约，已有契约条目不被改写，Agent 分类只含 {id, enabled}', async () => {
		seedVault({exa: {permissions: ['mcp__exa'], config: {url: EXA_URL}}});
		writeJson(claudeJsonPath(), {mcpServers: {exa: {url: 'https://runtime.example/mcp', type: 'http'}}});
		const codex = '[mcp_servers.rt]\ncommand = "rt-cmd"\n';
		seedCodex(codex);
		const selection = {
			categories: [
				{tool: 'ccq', category: 'mcp-library'},
				{tool: 'cc', category: 'mcp'},
				{tool: 'cx', category: 'mcp'}
			],
			includeCredentials: true
		} as const;
		// 清单读取（未声明 backfillMcp）保持零写盘。
		const vaultBefore = readFileSync(vaultPath(), 'utf8');
		expect((await planConfigTransferExport(selection)).ok).toBe(true);
		expect(readFileSync(vaultPath(), 'utf8')).toBe(vaultBefore);
		const plan = await planConfigTransferExport(selection, {backfillMcp: true});
		if (!plan.ok) throw new Error(plan.error);
		const [libraryData, ccData, cxData] = plan.data.sections.map(section => section.data as Record<string, any>);
		expect(libraryData?.servers.map((entry: {id: string}) => entry.id)).toEqual(['exa', 'rt']);
		expect(libraryData?.servers[0].config).toEqual({url: EXA_URL});
		expect(loadVault().servers.exa?.config).toEqual({url: EXA_URL});
		expect(ccData).toEqual({
			format: 'activation',
			servers: [
				{id: 'exa', enabled: true},
				{id: 'rt', enabled: false}
			]
		});
		expect(cxData).toEqual({
			format: 'activation',
			servers: [
				{id: 'exa', enabled: false},
				{id: 'rt', enabled: true}
			]
		});
		// 补录不得顺带给 Codex 写入 enabled:false 禁用块。
		expect(readFileSync(codexConfigPath(), 'utf8')).toBe(codex);

		// 同机往返：本机条目字段顺序与包不同也判定为 unchanged。
		const back = await planConfigTransferImport(payload([plan.data.sections[0]!], true), OPTIONS);
		expect(back.ok && back.data.items[0]?.status).toBe('unchanged');
	});
});

describe('导入弹窗 MCP 分类动作循环', () => {
	const item = (category: string, extra: Partial<ConfigTransferImportPlanItem>): ConfigTransferImportPlanItem =>
		({tool: 'ccq', category, status: 'replace', replace: {status: 'replace'}, ...extra}) as ConfigTransferImportPlanItem;
	const items = [
		item('mcp-library', {mergeUnavailable: 'MCP 不支持合并', defaultAction: 'replace'}),
		item('system-settings', {defaultAction: 'merge'})
	];
	const toggleAt = (cursor: number, decisions: Readonly<Record<string, TransferCategoryAction>>) => {
		const state = reduceSystemSettingsState(
			{
				...createInitialSystemSettingsState(),
				importModal: {
					kind: 'preview',
					bundlePath: 'x.ccq-backup',
					summary: {containsCredentials: false, items, warnings: []},
					cursor,
					collapsed: new Set(),
					decisions
				}
			},
			{type: 'toggle'}
		);
		return state.mode === 'page' && state.importModal?.kind === 'preview' ? state.importModal.decisions : {};
	};

	test('单项在覆盖与跳过间切换，从不出现合并', () => {
		const skipped = toggleAt(1, {'ccq:mcp-library': 'replace'});
		expect(skipped['ccq:mcp-library']).toBe('skip');
		expect(toggleAt(1, skipped)['ccq:mcp-library']).toBe('replace');
	});

	test('工具批量：基础 → 全覆盖 → 全跳过 → 基础（MCP 基础为覆盖）', () => {
		const base = {'ccq:mcp-library': 'replace', 'ccq:system-settings': 'merge'} as const;
		const replaced = toggleAt(0, base);
		expect(replaced).toEqual({'ccq:mcp-library': 'replace', 'ccq:system-settings': 'replace'});
		const skipped = toggleAt(0, replaced);
		expect(skipped).toEqual({'ccq:mcp-library': 'skip', 'ccq:system-settings': 'skip'});
		expect(toggleAt(0, skipped)).toEqual(base);
	});
});
