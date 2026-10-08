import {describe, expect, test} from 'bun:test';
import type {TransferTool} from '../../src/core/config-transfer.js';
import type {
	ConfigTransferApplyOutcome,
	ConfigTransferExportCategorySummary,
	ConfigTransferImportPlanItem,
	TransferCategoryStatus
} from '../../src/core/config-transfer-plan.js';
import {
	createInitialSystemSettingsState,
	reduceSystemSettingsState,
	systemSettingsCategoryKey,
	systemSettingsDecisionOf,
	systemSettingsDefaultDecisions,
	systemSettingsExportValidation,
	systemSettingsImportRows,
	systemSettingsSelectedCategories,
	systemSettingsSubMode,
	systemSettingsToolFullySelected,
	systemSettingsVisibleRows,
	type ConfigTransferExportSummary,
	type ConfigTransferImportSummary,
	type SystemSettingsAction,
	type SystemSettingsExportModal,
	type SystemSettingsPageState,
	type SystemSettingsState
} from '../../src/state/system-settings-state.js';

// 系统设置 reducer 门禁：自动更新/清单/加密页面焦点、导出明细弹窗树、导入弹窗直执行、
// busy 恢复与取消，以及「密码/路径绝不进入 eventLog」的负向断言。

function run(state: SystemSettingsState, actions: readonly SystemSettingsAction[]): SystemSettingsState {
	return actions.reduce((current, action) => reduceSystemSettingsState(current, action), state);
}

function page(state: SystemSettingsState): SystemSettingsPageState {
	if (state.mode !== 'page') {
		throw new Error(`期望 page，实际 ${state.mode}`);
	}

	return state;
}

function summaryFor(
	tool: TransferTool,
	category: string,
	overrides: Partial<ConfigTransferExportCategorySummary> = {}
): ConfigTransferExportCategorySummary {
	return {
		tool,
		category,
		itemCount: 1,
		containsCredentials: false,
		excludedCredentials: [],
		excluded: [],
		warnings: [],
		...overrides
	};
}

function exportSummary(): ConfigTransferExportSummary {
	return {
		categories: [summaryFor('cc', 'providers'), summaryFor('pi', 'extensions', {itemCount: 2})],
		containsCredentials: false,
		warnings: []
	};
}

function importItem(
	tool: TransferTool,
	category: string,
	status: TransferCategoryStatus,
	overrides: Partial<ConfigTransferImportPlanItem> = {}
): ConfigTransferImportPlanItem {
	return {
		tool,
		category,
		status,
		defaultAction: status === 'blocked' ? 'skip' : 'merge',
		counts: {added: 1, replaced: 0, unchanged: 0, blocked: status === 'blocked' ? 1 : 0},
		identities: {added: [], replaced: [], unchanged: [], skipped: []},
		warnings: [],
		reason: status === 'blocked' ? '本机目标损坏' : null,
		...overrides
	};
}

const importSummary: ConfigTransferImportSummary = {
	containsCredentials: false,
	items: [importItem('cc', 'providers', 'add'), importItem('cx', 'settings', 'replace'), importItem('pi', 'mcp', 'blocked')],
	warnings: []
};

const applyOutcome: ConfigTransferApplyOutcome = {
	status: 'partial',
	completed: [{tool: 'cc', category: 'providers'}],
	skipped: [{tool: 'pi', category: 'mcp'}],
	notExecuted: [{tool: 'cx', category: 'settings'}],
	failed: [{tool: 'cx', category: 'settings', error: '写入失败', restored: true}],
	warnings: ['已排除本机绑定配置']
};

function reachExportModal(): SystemSettingsState {
	return run(createInitialSystemSettingsState(), [{type: 'request-export'}, {type: 'export-prepared', summary: exportSummary()}]);
}

function reachImportPreview(): SystemSettingsState {
	return run(createInitialSystemSettingsState(), [
		{type: 'import-picked', path: '/tmp/in.ccq-backup'},
		{type: 'import-loaded', summary: importSummary}
	]);
}

describe('system-settings-state：页面与清单', () => {
	test('初始状态：默认焦点自动更新、默认不加密、清单加载中、无弹窗', () => {
		const state = createInitialSystemSettingsState();
		expect(state.mode).toBe('page');
		expect(state.focus).toBe('auto-update');
		expect(state.encryption).toBe(false);
		expect(state.password).toBe('');
		expect(state.inventory.status).toBe('loading');
		expect(state.exportModal).toBeNull();
		expect(state.importModal).toBeNull();
	});

	test('清单快照可折叠浏览：4 个工具行 + 注册分类行', () => {
		const rows = systemSettingsVisibleRows(new Set());
		expect(rows.filter(row => row.kind === 'tool').map(row => row.tool)).toEqual(['ccq', 'cc', 'cx', 'pi']);
		expect(rows.filter(row => row.kind === 'category').length).toBeGreaterThan(10);
	});

	test('清单加载成功/失败与折叠', () => {
		let state = reduceSystemSettingsState(createInitialSystemSettingsState(), {
			type: 'inventory-loaded',
			rows: [summaryFor('cc', 'providers')],
			warnings: []
		});
		expect(page(state).inventory.status).toBe('ready');
		expect(page(state).inventory.rows).toHaveLength(1);

		state = reduceSystemSettingsState(state, {type: 'inventory-failed', message: '读取失败'});
		expect(page(state).inventory.status).toBe('error');

		state = reduceSystemSettingsState(state, {type: 'cycle-focus', direction: 1});
		expect(page(state).focus).toBe('encryption');
	});

	test('加密开启后卡片内下键聚焦密码，关闭再开启不必重输密码', () => {
		let state = run(createInitialSystemSettingsState(), [
			{type: 'set-encryption', value: true},
			{type: 'password-input', value: 'secret-a'}
		]);
		expect(page(state).password).toBe('secret-a');
		state = run(state, [
			{type: 'cycle-focus', direction: 1},
			{type: 'move-field', direction: 1}
		]);
		expect(page(state).focus).toBe('password');
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: -1});
		expect(page(state).focus).toBe('encryption');
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: 1});

		state = reduceSystemSettingsState(state, {type: 'set-encryption', value: false});
		expect(page(state).focus).toBe('encryption');
		expect(page(state).password).toBe('secret-a');
		state = reduceSystemSettingsState(state, {type: 'set-encryption', value: true});
		expect(page(state).password).toBe('secret-a');
	});

	test('上下键遍历卡片与可见密码字段', () => {
		let state: SystemSettingsState = createInitialSystemSettingsState();
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: 1});
		expect(page(state).focus).toBe('encryption');
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: -1});
		expect(page(state).focus).toBe('auto-update');
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: 1});
		expect(page(state).focus).toBe('encryption'); // 未开启加密时没有密码字段
		state = reduceSystemSettingsState(state, {type: 'set-encryption', value: true});
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: 1});
		expect(page(state).focus).toBe('password');
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: 1});
		expect(page(state).focus).toBe('auto-update'); // 末字段循环回首卡片
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: -1});
		expect(page(state).focus).toBe('password');
		state = reduceSystemSettingsState(state, {type: 'move-field', direction: -1});
		expect(page(state).focus).toBe('encryption'); // 返回卡片时落在首字段
	});
});

describe('system-settings-state：导出明细弹窗', () => {
	test('request-export 进入 prepare 事务，export-prepared 打开默认全选弹窗', () => {
		let state = reduceSystemSettingsState(createInitialSystemSettingsState(), {type: 'request-export'});
		const busy = state as Extract<SystemSettingsState, {mode: 'busy'}>;
		expect(busy.operation).toBe('prepare-export');

		state = reduceSystemSettingsState(state, {type: 'export-prepared', summary: exportSummary()});
		const modal = page(state).exportModal;
		expect(modal).not.toBeNull();
		expect(modal ? systemSettingsSelectedCategories(modal.selected).length : 0).toBeGreaterThan(10);
		// 弹窗选择默认全选，且包含 Pi Extensions。
		expect(modal?.selected.has(systemSettingsCategoryKey('pi', 'extensions'))).toBe(true);
		expect(modal?.selected.has(systemSettingsCategoryKey('ccq', 'system-settings'))).toBe(true);
	});

	test('分类与工具父行 Space 勾选；工具行 Enter 折叠后光标收回', () => {
		let state = reachExportModal();
		let modal = page(state).exportModal as SystemSettingsExportModal;
		const piIndex = systemSettingsVisibleRows(modal.collapsed).findIndex(row => row.kind === 'tool' && row.tool === 'pi');
		state = run(state, [{type: 'move', delta: piIndex}, {type: 'toggle'}]);
		modal = page(state).exportModal as SystemSettingsExportModal;
		expect(systemSettingsToolFullySelected(modal.selected, 'pi')).toBe(false);
		expect(modal.selected.has(systemSettingsCategoryKey('pi', 'extensions'))).toBe(false);

		state = reduceSystemSettingsState(state, {type: 'fold', direction: 'collapse'});
		modal = page(state).exportModal as SystemSettingsExportModal;
		expect(modal.collapsed.has('pi')).toBe(true);
	});

	test('导出校验：空选择/加密无密码拒绝', () => {
		const state = reachExportModal();
		const modal = page(state).exportModal as SystemSettingsExportModal;
		expect(systemSettingsExportValidation(modal, false, '')).toEqual({ok: true});
		expect(systemSettingsExportValidation({...modal, selected: new Set<string>()}, false, '')).toEqual({
			ok: false,
			error: '请至少选择一个导出分类'
		});
		expect(systemSettingsExportValidation(modal, true, '')).toEqual({
			ok: false,
			error: '选择加密时必须设置导出密码'
		});
	});

	test('校验失败只回填弹窗错误；拿到路径后进入 write-export 且带 encrypt/password', () => {
		let state = reachExportModal();
		state = reduceSystemSettingsState(state, {type: 'export-modal-error', message: '请至少选择一个导出分类'});
		expect(page(state).exportModal?.error).toBe('请至少选择一个导出分类');

		const piIndex = systemSettingsVisibleRows(new Set()).findIndex(row => row.kind === 'tool' && row.tool === 'pi');
		state = run(state, [
			{type: 'move', delta: piIndex},
			{type: 'toggle'},
			{type: 'set-encryption', value: true},
			{type: 'password-input', value: 'secret-a'},
			{type: 'export-path-picked', path: '/tmp/out.ccq-backup'}
		]);
		const busy = state as Extract<SystemSettingsState, {mode: 'busy'}>;
		expect(busy.operation).toBe('write-export');
		expect(busy.retry).toMatchObject({stage: 'write-export', targetPath: '/tmp/out.ccq-backup', password: 'secret-a', encrypt: true});
		if (busy.retry.stage === 'write-export') {
			expect(
				busy.retry.categories.some(item => item.tool === 'pi'),
				'必须传递弹窗最终选择'
			).toBe(false);
		}

		state = reduceSystemSettingsState(state, {
			type: 'export-written',
			result: {
				bundlePath: '/tmp/out.ccq-backup',
				categoryCount: 2,
				itemCount: 3,
				containsCredentials: false,
				encrypted: true,
				excluded: []
			}
		});
		const done = page(state);
		expect(done.exportModal).toBeNull();
		expect(done.lastResult?.kind).toBe('export');
	});
});

describe('system-settings-state：导入弹窗与直接执行', () => {
	test('选中包后先密码弹窗；密码错误保留弹窗；空密码提示', () => {
		let state = reduceSystemSettingsState(createInitialSystemSettingsState(), {
			type: 'import-picked',
			path: '/tmp/in.ccq-backup'
		});
		const busy = state as Extract<SystemSettingsState, {mode: 'busy'}>;
		expect(busy.operation).toBe('load-import');
		expect(busy.retry).toMatchObject({stage: 'load-import', password: ''});

		state = reduceSystemSettingsState(state, {type: 'failed', kind: 'password', message: '此导出包已加密，需要输入密码'});
		const withError = page(state).importModal;
		expect(withError?.kind).toBe('password');
		expect(withError?.kind === 'password' ? withError.error : null).toBe('此导出包已加密，需要输入密码');

		state = reduceSystemSettingsState(state, {type: 'primary'});
		const emptyPassword = page(state).importModal;
		expect(emptyPassword?.kind === 'password' ? emptyPassword.error : null).toBe('请输入导出包密码');
	});

	test('解析成功进入分类树；阻断类不可合并；Space 切换决策', () => {
		let state = reachImportPreview();
		const preview = page(state).importModal;
		expect(preview?.kind).toBe('preview');
		if (preview?.kind !== 'preview') return;
		expect(systemSettingsDefaultDecisions(preview.summary.items)).toMatchObject({
			'cc:providers': 'merge',
			'cx:settings': 'merge',
			'pi:mcp': 'skip'
		});

		// 光标移动到阻断分类：Space 不改变其 skip 决策。
		const rows = systemSettingsImportRows(preview.summary.items, preview.collapsed);
		const blockedIndex = rows.findIndex(row => row.kind === 'category' && row.tool === 'pi');
		state = run(state, [{type: 'move', delta: blockedIndex}, {type: 'toggle'}]);
		const blocked = page(state).importModal;
		if (blocked?.kind !== 'preview') return;
		expect(systemSettingsDecisionOf(blocked.decisions, blocked.summary.items[2] as ConfigTransferImportPlanItem)).toBe('skip');
	});

	test('Space 按合并→覆盖→跳过循环；覆盖执行前要求危险确认', () => {
		const replaceItem = importItem('cc', 'rules', 'add', {
			replace: {
				status: 'replace',
				counts: {added: 1, replaced: 0, removed: 2, unchanged: 0, blocked: 0},
				identities: {added: ['new-rule'], replaced: [], removed: ['old-a', 'old-b'], unchanged: [], skipped: []},
				warnings: [],
				reason: null,
				targetFact: 'rules-fact'
			}
		});
		const summary: ConfigTransferImportSummary = {containsCredentials: false, items: [replaceItem], warnings: []};
		let state = run(createInitialSystemSettingsState(), [
			{type: 'import-picked', path: '/tmp/in.ccq-backup'},
			{type: 'import-loaded', summary}
		]);
		let modal = page(state).importModal;
		if (modal?.kind !== 'preview') return;
		const row = systemSettingsImportRows(modal.summary.items, modal.collapsed).findIndex(candidate => candidate.kind === 'category');
		state = run(state, [{type: 'move', delta: row}, {type: 'toggle'}]);
		modal = page(state).importModal;
		expect(modal?.kind === 'preview' ? modal.decisions['cc:rules'] : null).toBe('replace');

		state = reduceSystemSettingsState(state, {type: 'primary'});
		expect(page(state).importModal?.kind).toBe('confirm');
		expect(systemSettingsSubMode(state)).toBe('import-confirm');
		state = reduceSystemSettingsState(state, {type: 'back'});
		expect(page(state).importModal?.kind).toBe('preview');
		state = reduceSystemSettingsState(state, {type: 'toggle'});
		modal = page(state).importModal;
		expect(modal?.kind === 'preview' ? modal.decisions['cc:rules'] : null).toBe('skip');
	});
	test('Enter 直接进入 apply-import（无第二个确认弹窗），结果回到页面', () => {
		let state = reachImportPreview();
		state = reduceSystemSettingsState(state, {type: 'primary'});
		const busy = state as Extract<SystemSettingsState, {mode: 'busy'}>;
		expect(busy.operation).toBe('apply-import');
		expect(busy.retry.stage === 'apply-import' ? busy.retry.decisions.length : 0).toBe(3);

		state = reduceSystemSettingsState(state, {type: 'import-applied', outcome: applyOutcome});
		const done = page(state);
		expect(done.importModal).toBeNull();
		expect(done.lastResult?.kind === 'import' ? done.lastResult.outcome.status : null).toBe('partial');
	});

	test('Esc 关闭导入弹窗停留页面，不退出模块；非密码失败回页面错误行', () => {
		let state = reachImportPreview();
		state = reduceSystemSettingsState(state, {type: 'back'});
		expect(page(state).importModal).toBeNull();

		state = run(createInitialSystemSettingsState(), [{type: 'import-picked', path: '/tmp/in.ccq-backup'}]);
		state = reduceSystemSettingsState(state, {type: 'failed', kind: 'validation', message: '导出包格式不受支持'});
		const current = page(state);
		expect(current.importModal).toBeNull();
		expect(current.error).toBe('导出包格式不受支持');
	});

	test('busy 取消回到进入事务前的页面', () => {
		const busy = run(createInitialSystemSettingsState(), [{type: 'request-export'}]);
		const cancelled = reduceSystemSettingsState(busy, {type: 'cancel-busy'});
		expect(page(cancelled).exportModal).toBeNull();
		expect(page(cancelled).lastResult).toBeNull();
	});
});

describe('system-settings-state：subMode 与秘密不落日志', () => {
	test('subMode 覆盖页面焦点、两个弹窗与 busy', () => {
		expect(systemSettingsSubMode(createInitialSystemSettingsState())).toBe('page-auto-update');
		expect(
			systemSettingsSubMode(
				run(createInitialSystemSettingsState(), [
					{type: 'set-encryption', value: true},
					{type: 'cycle-focus', direction: 1}
				])
			)
		).toBe('page-encryption-enabled');
		expect(systemSettingsSubMode(reachExportModal())).toBe('export-modal');
		expect(systemSettingsSubMode(run(createInitialSystemSettingsState(), [{type: 'import-picked', path: '/tmp/a'}]))).toBe('busy');
		expect(systemSettingsSubMode(reachImportPreview())).toBe('import-preview');
		expect(systemSettingsSubMode(run(createInitialSystemSettingsState(), [{type: 'request-export'}]))).toBe('busy');
	});

	test('完整导出/导入流程 eventLog 不含 sentinel 密码或绝对路径', () => {
		const password = 'SENTINEL-PASSWORD-2f9c';
		const targetPath = '/Users/example/private/target.ccq-backup';
		const bundlePath = '/Users/example/private/source.ccq-backup';

		const state = run(createInitialSystemSettingsState(), [
			{type: 'set-encryption', value: true},
			{type: 'password-input', value: password},
			{type: 'request-export'},
			{type: 'export-prepared', summary: exportSummary()},
			{type: 'export-path-picked', path: targetPath},
			{type: 'failed', kind: 'io', message: '导出包读写失败'},
			{type: 'import-picked', path: bundlePath},
			{type: 'failed', kind: 'password', message: '密码错误或导出包已损坏'}
		]);

		const log = JSON.stringify(state.eventLog);
		expect(log.includes(password)).toBe(false);
		expect(log.includes(targetPath)).toBe(false);
		expect(log.includes(bundlePath)).toBe(false);
		expect(page(state).importModal?.kind).toBe('password');
	});
});
