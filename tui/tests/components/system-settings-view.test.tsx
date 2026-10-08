import {act, useMemo, useState} from 'react';
import {homedir} from 'node:os';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {KeyEvent, type ParsedKey} from '@opentui/core';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import {transferFail, transferOk, TRANSFER_CATEGORY_REGISTRY, type TransferResult} from '../../src/core/config-transfer.js';
import type {CcqSystemSettings} from '../../src/core/system-settings.js';
import {displayWidth} from '../../src/core/text-utils.js';
import type {FileDialogOutcome} from '../../src/core/native-file-dialog.js';
import type {
	ConfigTransferApplyOutcome,
	ConfigTransferCategoryDecision,
	ConfigTransferExportCategorySummary,
	ConfigTransferImportPlanItem
} from '../../src/core/config-transfer-plan.js';
import {createConfigTransferService, type ConfigTransferService} from '../../src/services/config-transfer-service.js';
import {createTempHome} from '../helpers/temp-home.js';
import {ShortcutBar, resetToasts, type BusyOverlayState} from '../../src/components/index.js';
import {getToastSnapshot} from '../../src/components/toast-store.js';
import {viewShortcuts} from '../../src/state/shortcuts.js';
import type {ConfigTransferExportSummary, ConfigTransferImportSummary} from '../../src/state/system-settings-state.js';
import {SystemSettingsView, type SystemSettingsPreferencesStore} from '../../src/views/system-settings/SystemSettingsView.js';

// 系统设置真实 OpenTUI 渲染门禁：自动更新 SelectField、只读清单树、导出/导入两个树形弹窗、
// Enter 直接执行导入（无第二确认）、Esc 分层与「帧内无绝对 HOME 路径」负向断言。
// 每个用例固定终端尺寸，并在 finally 的 act() 内销毁 renderer。
function createTestSettingsStore(initial: Partial<CcqSystemSettings> = {}) {
	let value: CcqSystemSettings = {autoUpdate: false, backupEncryption: false, backupPassword: '', ...initial};
	const store: SystemSettingsPreferencesStore = {
		load: () => ({status: 'valid', value, error: null}),
		save: changes => {
			value = {...value, ...changes};
			return {ok: true};
		}
	};
	return {store, current: () => value};
}

function key(name: string, modifiers: Partial<ParsedKey> = {}): KeyEvent {
	return new KeyEvent({
		name,
		sequence: name === 'enter' ? '\r' : name,
		ctrl: false,
		shift: false,
		meta: false,
		option: false,
		number: false,
		raw: name === 'enter' ? '\r' : name,
		eventType: 'press',
		source: 'raw',
		repeated: false,
		...modifiers
	});
}

function categorySummary(tool: 'ccq' | 'cc' | 'cx' | 'pi', category: string, itemCount = 1): ConfigTransferExportCategorySummary {
	return {tool, category, itemCount, containsCredentials: false, excludedCredentials: [], excluded: [], warnings: []};
}

const inventory: readonly ConfigTransferExportCategorySummary[] = [
	categorySummary('ccq', 'mcp-library'),
	categorySummary('cc', 'providers', 2),
	categorySummary('pi', 'extensions', 3)
];

const exportSummary: ConfigTransferExportSummary = {
	categories: [categorySummary('cc', 'providers', 2), categorySummary('pi', 'extensions', 3)],
	containsCredentials: false,
	warnings: []
};

function importItem(
	tool: 'cc' | 'cx' | 'pi',
	category: string,
	status: ConfigTransferImportPlanItem['status']
): ConfigTransferImportPlanItem {
	return {
		tool,
		category,
		status,
		defaultAction: status === 'blocked' ? 'skip' : 'merge',
		counts: {
			added: status === 'add' ? 1 : 0,
			replaced: status === 'replace' ? 1 : 0,
			unchanged: 0,
			blocked: status === 'blocked' ? 1 : 0
		},
		identities: {added: [], replaced: [], unchanged: [], skipped: []},
		warnings: [],
		reason: status === 'blocked' ? '本机目标损坏' : null
	};
}

const importSummary: ConfigTransferImportSummary = {
	containsCredentials: false,
	items: [importItem('cc', 'providers', 'add'), importItem('cx', 'settings', 'replace'), importItem('pi', 'mcp', 'blocked')],
	warnings: []
};

const completeOutcome: ConfigTransferApplyOutcome = {
	status: 'complete',
	completed: [{tool: 'cc', category: 'providers'}],
	skipped: [],
	notExecuted: [],
	failed: [],
	warnings: []
};

type FakeState = {
	exportPath: FileDialogOutcome;
	importPath: FileDialogOutcome;
	exportPicks: number;
	importPicks: number;
	inventoryCalls: number;
	prepareCalls: number;
	prepare: () => Promise<TransferResult<ConfigTransferExportSummary>>;
	writeRequests: {targetPath: string; categories: readonly {tool: string; category: string}[]; password: string; encrypt: boolean}[];
	loadResults: TransferResult<ConfigTransferImportSummary>[];
	loadPasswords: string[];
	loadCalls: number;
	appliedDecisions: readonly ConfigTransferCategoryDecision[] | null;
	appliedCalls: number;
};

function fakeService(overrides: Partial<FakeState> = {}): {service: ConfigTransferService; state: FakeState} {
	const state: FakeState = {
		exportPath: {kind: 'cancelled'},
		importPath: {kind: 'cancelled'},
		exportPicks: 0,
		importPicks: 0,
		inventoryCalls: 0,
		prepareCalls: 0,
		prepare: async () => transferOk(exportSummary),
		writeRequests: [],
		loadResults: [transferOk(importSummary)],
		loadPasswords: [],
		loadCalls: 0,
		appliedDecisions: null,
		appliedCalls: 0,
		...overrides
	};

	const service: ConfigTransferService = {
		pickExportPath: async () => {
			state.exportPicks += 1;
			return state.exportPath;
		},
		pickImportPath: async () => {
			state.importPicks += 1;
			return state.importPath;
		},
		inventory: async () => {
			state.inventoryCalls += 1;
			return transferOk(inventory);
		},
		prepareExport: () => {
			state.prepareCalls += 1;
			return state.prepare();
		},
		writeExport: async request => {
			state.writeRequests.push(request);
			return transferOk({
				bundlePath: '/Users/example/out.ccq-backup',
				categoryCount: 2,
				itemCount: 5,
				containsCredentials: false,
				encrypted: request.encrypt,
				excluded: []
			});
		},
		loadImport: async request => {
			state.loadCalls += 1;
			state.loadPasswords.push(request.password);
			const index = Math.min(state.loadCalls - 1, state.loadResults.length - 1);
			return state.loadResults[index] ?? transferOk(importSummary);
		},
		applyImport: async decisions => {
			state.appliedCalls += 1;
			state.appliedDecisions = decisions;
			return transferOk(completeOutcome);
		}
	};

	return {service, state};
}

// App 持有自动更新偏好；测试用 Harness 模拟受控 owner，视图本身不保存副本。
function Harness({
	service,
	initialAutoUpdate,
	settingsStore,
	onAutoUpdateChange,
	onBusyStateChange,
	onExitToNav
}: {
	readonly service: ConfigTransferService;
	readonly initialAutoUpdate: boolean;
	readonly settingsStore?: SystemSettingsPreferencesStore;
	readonly onAutoUpdateChange?: (value: boolean) => {ok: true} | {ok: false; error: string};
	readonly onBusyStateChange?: (state: BusyOverlayState | null) => void;
	readonly onExitToNav?: () => void;
}) {
	const [autoUpdate, setAutoUpdate] = useState(initialAutoUpdate);
	const defaultStore = useMemo(() => createTestSettingsStore().store, []);
	return (
		<SystemSettingsView
			active
			service={service}
			settingsStore={settingsStore ?? defaultStore}
			autoUpdate={autoUpdate}
			autoUpdateError={null}
			onAutoUpdateChange={value => {
				const result = onAutoUpdateChange?.(value) ?? {ok: true};
				if (result.ok) setAutoUpdate(value);
				return result;
			}}
			onBusyStateChange={onBusyStateChange}
			onExitToNav={onExitToNav ?? (() => {})}
		/>
	);
}

async function renderView(
	service: ConfigTransferService,
	options: {
		width?: number;
		height?: number;
		autoUpdate?: boolean;
		settingsStore?: SystemSettingsPreferencesStore;
		onAutoUpdateChange?: (value: boolean) => {ok: true} | {ok: false; error: string};
		onBusyStateChange?: (state: BusyOverlayState | null) => void;
		onExitToNav?: () => void;
	} = {}
) {
	resetToasts();
	const setup = await testRender(
		<Harness
			service={service}
			initialAutoUpdate={options.autoUpdate ?? false}
			settingsStore={options.settingsStore}
			onAutoUpdateChange={options.onAutoUpdateChange}
			onBusyStateChange={options.onBusyStateChange}
			onExitToNav={options.onExitToNav}
		/>,
		{width: options.width ?? 90, height: options.height ?? 32}
	);
	const press = async (name: string, modifiers: Partial<ParsedKey> = {}): Promise<void> => {
		await act(async () => {
			setup.renderer.keyInput.emit('keypress', key(name, modifiers));
			await setup.renderOnce();
		});
	};
	return {setup, press};
}

function expectNoHomePath(frame: string): void {
	expect(frame.includes(homedir()), `帧内不得出现绝对 HOME 路径：${homedir()}`).toBe(false);
}

function ShellFooterHarness({service, width}: {readonly service: ConfigTransferService; readonly width: number}) {
	const [subMode, setSubMode] = useState('page-auto-update');
	const store = useMemo(() => createTestSettingsStore().store, []);
	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<SystemSettingsView
				active
				service={service}
				settingsStore={store}
				autoUpdate={false}
				autoUpdateError={null}
				onSubModeChange={setSubMode}
				onExitToNav={() => {}}
			/>
			<ShortcutBar shortcuts={viewShortcuts('system-settings', subMode)} width={width} />
		</box>
	);
}

describe('SystemSettingsView 渲染：页面两区', () => {
	test('页面展示自动更新与加密选项；清单只在弹窗内', async () => {
		const {service, state} = fakeService();
		const {setup} = await renderView(service);
		try {
			const frame = await setup.waitForFrame(value => value.includes('是否加密'));
			expect(frame).toMatch(/自动更新/);
			expect(frame).not.toMatch(/本机配置清单|MCP 共享库|终端代理/);
			expect(frame).toMatch(/未开启/);
			expect(frame).toMatch(/⚠ 明文包可能包含 API Key/);
			expect(frame.match(/╭/g), '两个功能区各自有边界').toHaveLength(2);
			expect(frame.match(/╰/g), '两个区块都要完整闭合').toHaveLength(2);
			expect(frame, '页面不能重复绘制 App 的快捷键 footer').not.toContain('返回菜单');
			expect(state.inventoryCalls, '主页不读取配置清单').toBe(0);
			expect(frame.includes('导出配置'), '未按 Ctrl+O 不得出现导出弹窗').toBe(false);
			expectNoHomePath(frame);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('快捷键仅由 App 风格的统一 footer 渲染，随页面焦点更新', async () => {
		const {service} = fakeService();
		const setup = await testRender(<ShellFooterHarness service={service} width={90} />, {width: 90, height: 32});
		try {
			const initial = await setup.waitForFrame(value => value.includes('自动更新') && value.includes('返回菜单'));
			expect(initial.split('\n').filter(line => line.includes('返回菜单'))).toHaveLength(1);
			expect(initial, '上下键切换字段与卡片').toContain('字段/卡片');

			await act(async () => {
				setup.renderer.keyInput.emit('keypress', key('down'));
				await setup.renderOnce();
			});
			const encryptionFrame = await setup.waitForFrame(value => value.includes('是否加密') && value.includes('返回菜单'));
			expect(encryptionFrame.split('\n').filter(line => line.includes('返回菜单'))).toHaveLength(1);

			await act(async () => {
				setup.renderer.keyInput.emit('keypress', key('o', {ctrl: true}));
				await setup.renderOnce();
			});
			const modalFrame = await setup.waitForFrame(value => value.includes('导出配置') && value.includes('取消'));
			expect(modalFrame, '弹窗期间 App footer 应切换为弹窗操作').not.toContain('返回菜单');
			await act(async () => {
				setup.renderer.keyInput.emit('keypress', key('escape'));
				await setup.renderOnce();
			});
			await setup.waitForFrame(value => !value.includes('导出配置') && value.includes('返回菜单'));
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('窄屏连同 App footer 仍显示两区与明文风险', async () => {
		const {service} = fakeService();
		const setup = await testRender(<ShellFooterHarness service={service} width={46} />, {width: 46, height: 24});
		try {
			const frame = await setup.waitForFrame(value => value.includes('自动更新') && value.includes('返回菜单'));
			expect(frame).toContain('是否加密');
			const encryptionRow = frame.split('\n').find(line => line.includes('是否加密')) ?? '';
			expect(encryptionRow.slice(encryptionRow.indexOf('是否加密') + '是否加密'.length)).toMatch(/是\s+否/u);
			expect(frame).toContain('明文包可能包含');
			expect(frame.match(/╰/g)).toHaveLength(2);
			expect(frame, '两个卡片应紧挨着').toMatch(/╰[^\n]*╯ *\n╭/u);
			expect(frame.split('\n').filter(line => displayWidth(line) > 46)).toEqual([]);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('系统设置不展示仅供开发者参考的安装位提示', async () => {
		const {service} = fakeService();
		const {setup} = await renderView(service, {autoUpdate: true, settingsStore: createTestSettingsStore({autoUpdate: true}).store});
		try {
			const frame = await setup.waitForFrame(value => value.includes('已开启'));
			expect(frame).not.toContain('官方安装位置');
			expect(frame).not.toContain('开发/构建产物');
			expect(frame).not.toContain('仅手动');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('自动更新先编辑草稿，Ctrl+S 后才通知 App；加密开启显示密码字段', async () => {
		const changes: boolean[] = [];
		const {service} = fakeService();
		const {setup, press} = await renderView(service, {
			onAutoUpdateChange: value => {
				changes.push(value);
				return {ok: true};
			}
		});
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('left');
			expect(changes, '编辑草稿不得立刻更新 App 运行态').toEqual([]);
			await setup.waitForFrame(value => value.includes('已开启'));
			await press('s', {ctrl: true});
			expect(changes, 'Ctrl+S 后才更新 App 运行态').toEqual([true]);
			await press('right');
			expect(changes).toEqual([true]);
			await setup.waitForFrame(value => value.includes('未开启'));
			await press('s', {ctrl: true});
			expect(changes).toEqual([true, false]);

			await press('down');
			await press('right');
			await setup.waitForFrame(value => value.includes('导出密码'));
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('三项设置仅在 Ctrl+S 时一次写盘，未保存不更新运行态', async () => {
		const settings = createTestSettingsStore();
		const writes: Partial<CcqSystemSettings>[] = [];
		const store: SystemSettingsPreferencesStore = {
			load: settings.store.load,
			save: changes => {
				writes.push(changes);
				return settings.store.save(changes);
			}
		};
		const changes: boolean[] = [];
		const {service} = fakeService();
		const {setup, press} = await renderView(service, {
			settingsStore: store,
			onAutoUpdateChange: value => {
				changes.push(value);
				return {ok: true};
			}
		});
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('left');
			await press('down');
			await press('space');
			await press('down');
			await act(async () => {
				setup.mockInput.typeText('draft-secret');
				await setup.renderOnce();
			});
			expect(writes).toEqual([]);
			expect(changes).toEqual([]);
			expect(settings.current()).toMatchObject({autoUpdate: false, backupEncryption: false, backupPassword: ''});
			await press('s', {ctrl: true});
			expect(writes).toEqual([{autoUpdate: true, backupEncryption: true, backupPassword: 'draft-secret'}]);
			expect(changes).toEqual([true]);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('未保存退出需确认；Esc 返回编辑，Enter 才放弃草稿', async () => {
		const settings = createTestSettingsStore();
		let exits = 0;
		const {service} = fakeService();
		const {setup, press} = await renderView(service, {settingsStore: settings.store, onExitToNav: () => (exits += 1)});
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('left');
			await press('escape');
			const prompt = await setup.waitForFrame(value => value.includes('放弃未保存的系统设置'));
			expect(prompt).toContain('Enter 放弃修改');
			expect(exits).toBe(0);
			await press('s', {ctrl: true});
			expect(settings.current().autoUpdate).toBe(false);
			await press('escape');
			await setup.waitForFrame(value => !value.includes('放弃未保存的系统设置') && value.includes('已开启'));
			await press('escape');
			await press('enter');
			expect(exits).toBe(1);
			expect(settings.current().autoUpdate).toBe(false);
			await setup.waitForFrame(value => value.includes('未开启'));
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('重新进入设置页会恢复加密选项和密码', async () => {
		const settings = createTestSettingsStore({backupEncryption: true, backupPassword: 'remembered-pw'});
		const {service} = fakeService();
		const {setup, press} = await renderView(service, {settingsStore: settings.store});
		try {
			await setup.waitForFrame(value => value.includes('保存后密码明文写入本机 JSON'));
			await press('down');
			await press('down');
			await press('o', {ctrl: true});
			const frame = await setup.waitForFrame(value => value.includes('导出配置'));
			expect(frame).not.toContain('remembered-pw');
			expect(settings.current().backupEncryption).toBe(true);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('Ctrl+S 写入失败时保留草稿且不假装保存成功', async () => {
		const settings = createTestSettingsStore();
		const store: SystemSettingsPreferencesStore = {
			load: settings.store.load,
			save: () => ({ok: false, error: '无法保存本机系统设置'})
		};
		const {service} = fakeService();
		const {setup, press} = await renderView(service, {settingsStore: store});
		try {
			await setup.waitForFrame(value => value.includes('是否加密'));
			await press('down');
			await press('space');
			await setup.waitForFrame(value => value.includes('导出密码'));
			expect(settings.current().backupEncryption).toBe(false);
			await press('s', {ctrl: true});
			expect(getToastSnapshot().filter(item => item.message === '无法保存本机系统设置')).toHaveLength(1);
			const frame = setup.captureCharFrame();
			expect(frame).not.toContain('无法保存本机系统设置');
			expect(frame).toContain('导出密码');
			expect(settings.current().backupEncryption).toBe(false);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('已保存 JSON 密码预填并可用于导入；Ctrl+K 清除本机密码', async () => {
		const settings = createTestSettingsStore({backupPassword: 'fake-pw'});
		const fake = fakeService({importPath: {kind: 'selected', path: '/tmp/fake.ccq-backup'}});
		const {setup, press} = await renderView(fake.service, {settingsStore: settings.store});
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('i', {ctrl: true});
			await setup.waitForFrame(value => value.includes('导入配置') || value.includes('分类'));
			expect(fake.state.loadPasswords).toContain('fake-pw');
			await press('escape');
			await press('down');
			await press('right');
			await setup.waitForFrame(value => value.includes('保存后密码明文写入本机 JSON'));
			await press('down');
			await press('up');
			await press('k', {ctrl: true});
			expect(settings.current().backupPassword, '上键回到加密选项，不应清除密码').toBe('fake-pw');
			await press('down');
			await press('down');
			await press('k', {ctrl: true});
			expect(settings.current().backupPassword, '密码焦点按 Tab 应切换到另一张卡片').toBe('fake-pw');
			await press('down');
			await press('down');
			await press('k', {ctrl: true});
			expect(settings.current().backupPassword, '清除先留在草稿').toBe('fake-pw');
			await press('s', {ctrl: true});
			expect(settings.current().backupPassword).toBe('');
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});
});

describe('SystemSettingsView 渲染：Ctrl+O 导出弹窗', () => {
	for (const width of [90, 46]) {
		test(`真实快照的常规排除不展示，问题/风险/树操作保留（${width} 列）`, async () => {
			const home = createTempHome('ccq-export-exclusions-render-');
			let setup: Awaited<ReturnType<typeof renderView>>['setup'] | undefined;
			try {
				for (const dir of ['.codex', '.claude', '.pi/agent/extensions/demo']) mkdirSync(join(home.path, dir), {recursive: true});
				writeFileSync(
					join(home.path, '.codex/config.toml'),
					'model = "demo"\n[projects."/local/project"]\ntrust_level = "trusted"\n[notice]\nhide = true\n'
				);
				writeFileSync(join(home.path, '.claude/settings.json'), '{broken');
				writeFileSync(
					join(home.path, '.pi/agent/settings.json'),
					JSON.stringify({packages: ['./local-package', 'file:local'], extensions: ['/local/entry.ts']})
				);
				writeFileSync(join(home.path, '.pi/agent/models.json'), JSON.stringify({providers: {official: {oauth: 'radius'}}}));
				writeFileSync(join(home.path, '.pi/agent/extensions/demo/index.ts'), 'export default () => {};');
				writeFileSync(join(home.path, '.pi/agent/extensions/demo/.env'), 'TOKEN=fake-excluded');
				writeFileSync(
					join(home.path, '.pi/agent/auth.json'),
					JSON.stringify({invalid: {type: 'api_key', key: 42}, official: {type: 'oauth', access: 'fake-oauth'}})
				);
				const service = createConfigTransferService({pickExportPath: async () => ({kind: 'cancelled'})});
				const snapshot = await service.prepareExport({categories: TRANSFER_CATEGORY_REGISTRY});
				expect(snapshot.ok).toBe(true);
				if (!snapshot.ok) throw new Error(snapshot.error);
				expect(snapshot.data.warnings).toContain('已排除 OAuth 供应商：official');
				const rendered = await renderView(service, {width, height: 24});
				setup = rendered.setup;
				const {press} = rendered;
				await setup.waitForFrame(f => f.includes('系统设置'));
				await press('o', {ctrl: true});
				const first = await setup.waitForFrame(f => f.includes('导出配置'));
				expect(first).toContain('已选 18 个分类');
				expect(first).toContain('API Key/');
				await press('space');
				await setup.waitForFrame(f => f.includes('已选 16 个分类'));
				await press('left');
				await setup.waitForFrame(f => f.includes('▶ CCQ'));
				await press('right');
				await setup.waitForFrame(f => f.includes('▼ CCQ'));
				const frames: string[] = [];
				for (let i = 0; i < TRANSFER_CATEGORY_REGISTRY.length + 4; i++) {
					await press('down');
					const frame = setup.captureCharFrame();
					frames.push(frame);
					expect(frame.replace(/\s+/gu, '')).toContain('APIKey/源码中的密钥');
					expect(frame).not.toMatch(
						/已排除本机|已排除 OAuth|已排除认证|已排除不受管|已移除凭据字段|已排除 \d+ 项|local-package|fake-excluded|fake-oauth/
					);
					expect(frame.split('\n').filter(line => displayWidth(line) > width)).toEqual([]);
				}
				expect(frames.join('\n')).toContain('settings.json 损坏');
				expect(frames.join('\n')).toContain('无效的 Pi API-key 凭据');
				const lastRow =
					frames
						.at(-1)
						?.split('\n')
						.find(line => line.includes('Extensions')) ?? '';
				expect(lastRow).toMatch(/\[✓\]\s+Extensions/u);
				expect(lastRow).not.toMatch(/\(\d+\/\d+\)/);
				expect(readFileSync(join(home.path, '.claude/settings.json'), 'utf8')).toBe('{broken');
			} finally {
				if (setup) await act(async () => setup?.renderer.destroy());
				home.restore();
				home.cleanup();
			}
		});
	}

	test('导出保留无法读取、非法结构、安全问题和未知 warning', async () => {
		const warnings = ['条目目录无法读取', 'Pi 显式扩展入口结构无效，未收录', '已跳过不安全的条目：escape.ts', '未知导出问题'];
		const {service} = fakeService({
			prepare: async () =>
				transferOk({
					categories: [{...categorySummary('ccq', 'mcp-library'), warnings}],
					containsCredentials: false,
					warnings
				})
		});
		const {setup, press} = await renderView(service);
		try {
			await setup.waitForFrame(f => f.includes('系统设置'));
			await press('o', {ctrl: true});
			await press('down');
			const frame = await setup.waitForFrame(f => f.includes('未知导出问题'));
			for (const warning of warnings) expect(frame).toContain(warning);
			expect(frame).toContain('可能包含 API Key/源码中的密钥');
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('真实损坏源仍阻断导出并显示错误，原字节不变', async () => {
		const home = createTempHome('ccq-export-corrupt-render-');
		mkdirSync(join(home.path, '.ccq'), {recursive: true});
		const source = join(home.path, '.ccq/system-settings.json');
		writeFileSync(source, '{broken');
		const {setup, press} = await renderView(createConfigTransferService());
		try {
			await setup.waitForFrame(f => f.includes('系统设置'));
			await press('o', {ctrl: true});
			expect(getToastSnapshot().filter(t => t.type === 'error' && t.message === '本机 CCQ 系统设置损坏，无法导出')).toHaveLength(1);
			expect(setup.captureCharFrame()).not.toContain('导出配置');
			expect(readFileSync(source, 'utf8')).toBe('{broken');
		} finally {
			await act(async () => setup.renderer.destroy());
			home.restore();
			home.cleanup();
		}
	});

	test('导出阻断与写失败仍可见，不假报成功', async () => {
		const home = createTempHome('ccq-export-errors-render-');
		const fake = fakeService({exportPath: {kind: 'selected', path: join(home.path, 'out.ccq-backup')}});
		const service = {...fake.service, writeExport: async () => transferFail('io', '导出包写入失败')};
		const {setup, press} = await renderView(service);
		try {
			await setup.waitForFrame(f => f.includes('系统设置'));
			await press('down');
			await press('space');
			await press('o', {ctrl: true});
			await setup.waitForFrame(f => f.includes('导出配置'));
			await press('enter');
			await setup.waitForFrame(f => f.includes('选择加密时必须设置导出密码'));
			expect(fake.state.exportPicks).toBe(0);
			await press('escape');
			await press('space');
			await press('o', {ctrl: true});
			await setup.waitForFrame(f => f.includes('导出配置'));
			await press('enter');
			expect(getToastSnapshot().filter(t => t.message === '导出包写入失败')).toHaveLength(1);
			expect(getToastSnapshot().some(t => t.message === '配置导出完成')).toBe(false);
		} finally {
			await act(async () => setup.renderer.destroy());
			home.restore();
			home.cleanup();
		}
	});
	test('Ctrl+O 打开多选树与明文风险；picker 取消留在弹窗，成功后写入并关闭', async () => {
		const fake = fakeService({exportPath: {kind: 'cancelled'}});
		const {setup, press} = await renderView(fake.service);
		try {
			await setup.waitForFrame(value => value.includes('系统设置'));
			await press('o', {ctrl: true});
			const modal = await setup.waitForFrame(value => value.includes('导出配置'));
			expect(fake.state.prepareCalls, 'Ctrl+O 先采集内容摘要').toBe(1);
			expect(modal, '弹窗不重复长篇说明').not.toContain('请妥善保管');
			expect(modal, '明文风险独立于分类树滚动/折叠始终可见').toContain('可能包含 API Key/源码中的密钥');
			expect(modal, '导出弹窗必须展示已选计数').toMatch(/已选/);
			expect(modal, '弹窗提示必须展示 Enter 导出').toMatch(/Enter[\s─]+导出/);
			await press('space'); // CCQ 父节点取消：写入请求不得带其分类。

			await press('enter');
			await setup.waitForFrame(value => value.includes('导出配置'));
			expect(fake.state.exportPicks, 'Enter 才调起系统另存为').toBe(1);
			expect(fake.state.writeRequests).toHaveLength(0);

			fake.state.exportPath = {kind: 'selected', path: '/Users/example/out.ccq-backup'};
			await press('enter');
			const done = await setup.waitForFrame(value => !value.includes('导出配置'));
			expect(getToastSnapshot().filter(item => item.message === '配置导出完成')).toHaveLength(1);
			expect(done).not.toContain('已导出');
			expect(fake.state.writeRequests).toHaveLength(1);
			expect(fake.state.writeRequests[0], '默认明文导出且不加密').toMatchObject({password: '', encrypt: false});
			expect(
				fake.state.writeRequests[0]?.categories.some(item => item.tool === 'ccq'),
				'取消的工具不能进入导出请求'
			).toBe(false);
			expect(done.includes('导出配置'), '写入成功后关闭弹窗').toBe(false);
			expectNoHomePath(done);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('导出弹窗不重复排除摘要，快捷键不遮挡末行（常规与窄弹窗）', async () => {
		for (const width of [90, 46]) {
			const {service} = fakeService({
				prepare: async () =>
					transferOk({
						...exportSummary,
						categories: exportSummary.categories.map((category, index) =>
							index === 0 ? {...category, excluded: ['local-a', 'local-b']} : category
						),
						warnings: ['warning-one', 'warning-two']
					})
			});
			const {setup, press} = await renderView(service, {width, height: 24});
			try {
				await setup.waitForFrame(value => value.includes('系统设置'));
				await press('o', {ctrl: true});
				await setup.waitForFrame(value => value.includes('导出配置'));
				for (let index = 0; index < TRANSFER_CATEGORY_REGISTRY.length + 4; index++) await press('down');
				const frame = await setup.waitForFrame(value => value.includes('Extensions'));
				const lines = frame.split('\n');
				const lastRow = lines.find(line => line.includes('Extensions')) ?? '';
				expect(frame).toMatch(/已选 \d+ 个分类/u);
				expect(lastRow, '末行必须同时显示多选框和分类名，而非列表位置计数').toMatch(/\[✓\]\s+Extensions/u);
				expect(lastRow).not.toMatch(/\(\d+\/\d+\)/);
				expect(frame).not.toMatch(/warning-one|warning-two|已排除 2 项/);
				expect(lines.findIndex(line => line.includes('Enter 导出'))).toBeGreaterThan(lines.indexOf(lastRow));
				expect(lines.filter(line => displayWidth(line) > width)).toEqual([]);
			} finally {
				await act(async () => setup.renderer.destroy());
			}
		}
	});

	test('加密与密码只有 Ctrl+S 后才持久化；导出仍用草稿', async () => {
		const fake = fakeService({exportPath: {kind: 'selected', path: '/Users/example/out.ccq-backup'}});
		const settings = createTestSettingsStore();
		const {setup, press} = await renderView(fake.service, {settingsStore: settings.store});
		try {
			await setup.waitForFrame(value => value.includes('系统设置'));
			// Tab 到加密并开启。
			await press('down');
			await press('space');
			await setup.waitForFrame(value => value.includes('导出密码'));
			expect(settings.current().backupEncryption).toBe(false);
			// 输入密码：卡片内下键到密码字段后输入。
			await press('down');
			await act(async () => {
				setup.mockInput.typeText('sentinel-pw');
				await setup.renderOnce();
			});

			expect(settings.current().backupPassword).toBe('');
			await press('o', {ctrl: true});
			await setup.waitForFrame(value => value.includes('导出配置'));
			await press('enter');
			expect(getToastSnapshot().some(item => item.message === '配置导出完成')).toBe(true);
			expect(fake.state.writeRequests[0], '加密导出必须带密码与 encrypt:true').toMatchObject({
				password: 'sentinel-pw',
				encrypt: true
			});
			expect(settings.current().backupPassword).toBe('');
			await press('s', {ctrl: true});
			expect(settings.current()).toMatchObject({backupEncryption: true, backupPassword: 'sentinel-pw'});
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SystemSettingsView 渲染：Ctrl+I 导入弹窗', () => {
	test('Pi package 预览显示来源/第三方风险；确认后只报告一次实际逐包结果', async () => {
		const item = {...importItem('pi', 'extensions', 'add'), warnings: ['待安装来源：npm:demo@1.2.3；确认后下载/安装第三方代码']};
		const fake = fakeService({
			importPath: {kind: 'selected', path: '/tmp/packages.ccq-backup'},
			loadResults: [transferOk({containsCredentials: false, items: [item], warnings: item.warnings})]
		});
		const outcome: ConfigTransferApplyOutcome = {
			status: 'partial',
			completed: [],
			skipped: [],
			notExecuted: [],
			failed: [{tool: 'pi', category: 'extensions', error: '安装失败', restored: true}],
			warnings: [],
			packages: {
				completed: ['npm:demo@1.2.3'],
				unchanged: [],
				failed: [{source: 'npm:bad', kind: 'install', error: '安装失败'}],
				notExecuted: ['npm:later'],
				externalSideEffects: true
			}
		};
		const service = {...fake.service, applyImport: async () => transferOk(outcome)};
		const {setup, press} = await renderView(service);
		try {
			await setup.waitForFrame(f => f.includes('系统设置'));
			await press('i', {ctrl: true});
			const preview = await setup.waitForFrame(f => f.includes('npm:demo@1.2.3'));
			expect(preview).toContain('第三方');
			expect(fake.state.appliedCalls).toBe(0);
			await press('enter');
			const toasts = getToastSnapshot();
			expect(toasts).toHaveLength(1);
			expect(toasts[0]?.message).toContain('npm:demo@1.2.3');
			expect(toasts[0]?.message).toContain('npm:bad');
			expect(toasts[0]?.message).toContain('npm:later');
			expect(toasts[0]?.message).toContain('外部');
			expect(toasts[0]?.message).toContain('文件已恢复');
			expect(setup.captureCharFrame()).not.toContain('副作用');
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('取消 package busy 后仍报告真实 partial，不丢弃迟到安装事实', async () => {
		const fake = fakeService({importPath: {kind: 'selected', path: '/tmp/packages.ccq-backup'}});
		let finish: ((r: TransferResult<ConfigTransferApplyOutcome>) => void) | undefined;
		let cancel: (() => void) | undefined;
		let signal: AbortSignal | undefined;
		const applyImport: ConfigTransferService['applyImport'] = async (_decisions, _progress, options) => {
			signal = options?.signal;
			return new Promise(resolve => {
				finish = resolve;
			});
		};
		const {setup, press} = await renderView(
			{...fake.service, applyImport},
			{
				onBusyStateChange: busy => {
					if (busy) cancel = busy.onCancel;
				}
			}
		);
		try {
			await setup.waitForFrame(f => f.includes('系统设置'));
			await press('i', {ctrl: true});
			await setup.waitForFrame(f => f.includes('合并'));
			await press('enter');
			expect(cancel).toBeDefined();
			await act(async () => {
				cancel?.();
				await setup.renderOnce();
			});
			expect(signal?.aborted).toBe(true);
			expect(getToastSnapshot()).toHaveLength(0);
			await act(async () => {
				finish?.(
					transferOk({
						...completeOutcome,
						status: 'partial',
						cancelled: true,
						packages: {
							completed: ['npm:landed'],
							unchanged: [],
							failed: [{source: 'npm:aborted', kind: 'cancelled', error: '已取消'}],
							notExecuted: ['npm:later'],
							externalSideEffects: true
						}
					})
				);
				await setup.renderOnce();
			});
			expect(getToastSnapshot()).toHaveLength(1);
			expect(getToastSnapshot()[0]?.message).toContain('npm:landed');
			expect(getToastSnapshot()[0]?.message).toContain('npm:later');
			expect(getToastSnapshot()[0]?.type).toBe('warning');
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});
	test('picker 不可用只提示 warning toast，不显示页面状态行', async () => {
		const fake = fakeService({importPath: {kind: 'unavailable', reason: '文件选择器不可用'}});
		const {setup, press} = await renderView(fake.service);
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('i', {ctrl: true});
			expect(getToastSnapshot().filter(item => item.type === 'warning' && item.message.includes('文件选择器不可用'))).toHaveLength(1);
			expect(setup.captureCharFrame()).not.toContain('文件选择器不可用');
			await press('down');
			expect(getToastSnapshot().filter(item => item.message.includes('文件选择器不可用'))).toHaveLength(1);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('传统 Ctrl+I 的 Tab 字节触发导入而不是切卡片', async () => {
		const fake = fakeService({importPath: {kind: 'cancelled'}});
		const {setup, press} = await renderView(fake.service);
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('tab', {raw: '\t', sequence: '\t'});
			expect(fake.state.importPicks).toBe(1);
			const frame = setup.captureCharFrame();
			expect(frame).toContain('› 自动更新');
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});
	test('加密包先密码，解析后展示分类树，Enter 直接执行导入（无第二确认）', async () => {
		const fake = fakeService({
			importPath: {kind: 'selected', path: '/Users/example/in.ccq-backup'},
			loadResults: [
				transferFail('password', '此导出包已加密，需要输入密码'),
				transferOk({...importSummary, warnings: ['preview-warning']})
			]
		});
		const {setup, press} = await renderView(fake.service);
		try {
			await setup.waitForFrame(value => value.includes('系统设置'));
			await press('i', {ctrl: true});
			const passwordModal = await setup.waitForFrame(value => value.includes('该导出包已加密'));
			expect(passwordModal).toMatch(/导入/);
			expect(fake.state.loadPasswords, '首次解析使用空密码').toEqual(['']);

			await act(async () => {
				setup.mockInput.typeText('sentinel-pw');
				await setup.renderOnce();
			});
			await press('enter');
			const preview = await setup.waitForFrame(value => value.includes('合并'));
			expect(fake.state.loadPasswords[1], '密码经弹窗回填 service').toBe('sentinel-pw');
			expect(preview, '导入明细必须显示阻断分类').toMatch(/已阻断/);
			expect(preview).not.toContain('preview-warning');
			expect(preview.includes('确认导入'), '不得再出现第二个确认弹窗').toBe(false);
			expect(preview.replace(/\s+/g, ' '), 'footer 必须展示 Enter 执行导入').toMatch(/Enter 执行导入/);

			await press('enter');
			const done = await setup.waitForFrame(value => !value.includes('in.ccq-backup') && !value.includes('合并'));
			expect(getToastSnapshot().filter(item => item.message === '配置导入完成')).toHaveLength(1);
			expect(done).not.toContain('导入完成');
			expect(fake.state.appliedCalls, 'Enter 直接执行一次导入').toBe(1);
			expect(fake.state.appliedDecisions).toHaveLength(3);
			expect(done.includes('合并'), '执行后关闭弹窗').toBe(false);
			expectNoHomePath(done);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('窄屏导入弹窗末行阻断复选框与计数不重叠', async () => {
		const fake = fakeService({importPath: {kind: 'selected', path: '/tmp/example.ccq-backup'}});
		const {setup, press} = await renderView(fake.service, {width: 46, height: 24});
		try {
			await setup.waitForFrame(value => value.includes('自动更新'));
			await press('i', {ctrl: true});
			await setup.waitForFrame(value => value.includes('合并'));
			for (let i = 0; i < 8; i++) await press('down');
			const frame = await setup.waitForFrame(value => value.includes('已阻断'));
			const blocked = frame.split('\n').find(line => line.includes('MCP') && line.includes('[—]')) ?? '';
			expect(blocked, `末行阻断项的复选框应保持可见：\n${frame}`).toContain('MCP');
			expect(blocked).not.toMatch(/\(\d+\/\d+\)/);
			expect(frame.split('\n').filter(line => displayWidth(line) > 46)).toEqual([]);
		} finally {
			await act(async () => setup.renderer.destroy());
		}
	});

	test('picker 取消不报错；导出弹窗 Esc 分层返回页面', async () => {
		const fake = fakeService();
		let exits = 0;
		const {setup, press} = await renderView(fake.service, {onExitToNav: () => (exits += 1)});
		try {
			await setup.waitForFrame(value => value.includes('系统设置'));
			await press('i', {ctrl: true});
			const page = await setup.waitForFrame(value => value.includes('是否加密'));
			expect(page.includes('系统文件对话框不可用'), '取消不得误报').toBe(false);

			await press('o', {ctrl: true});
			await setup.waitForFrame(value => value.includes('导出配置'));
			await press('escape');
			const back = await setup.waitForFrame(value => value.includes('是否加密') && !value.includes('导出配置'));
			expect(back.includes('导出配置'), 'Esc 只关闭弹窗').toBe(false);
			expect(exits, '弹窗 Esc 不得退出模块').toBe(0);

			await press('escape');
			expect(exits, '页面 Esc 才返回菜单').toBe(1);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});

	test('窄终端下两区不横向溢出', async () => {
		const {service} = fakeService();
		const {setup} = await renderView(service, {width: 46, height: 24});
		try {
			const frame = await setup.waitForFrame(value => value.includes('是否加密'));
			expect(frame, '窄屏仍需展示明文风险').toContain('明文包可能包含');
			expect(frame.match(/╭/g), '窄屏保留两区边界').toHaveLength(2);
			const tooLong = frame.split('\n').filter(line => displayWidth(line) > 46);
			expect(tooLong, `窄终端不得横向溢出: ${JSON.stringify(tooLong)}`).toEqual([]);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
