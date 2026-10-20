import {expect, test} from 'bun:test';
import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {transferOk} from '../../src/core/config-transfer.js';
import type {ConfigTransferApplyOutcome, ConfigTransferImportPlanItem} from '../../src/core/config-transfer-plan.js';
import type {ConfigTransferService} from '../../src/services/config-transfer-service.js';
import {SystemSettingsView} from '../../src/views/system-settings/SystemSettingsView.js';

const item = (tool: 'cc' | 'pi', category: string, status: 'add' | 'blocked', reason: string | null = null) =>
	({
		tool,
		category,
		status,
		defaultAction: status === 'blocked' ? 'skip' : 'merge',
		counts: {added: 1, replaced: 0, unchanged: 0, blocked: status === 'blocked' ? 1 : 0},
		identities: {added: [], replaced: [], unchanged: [], skipped: []},
		warnings: [],
		reason
	}) as ConfigTransferImportPlanItem;

const outcome: ConfigTransferApplyOutcome = {
	status: 'partial',
	completed: [{tool: 'cc', category: 'settings'}],
	skipped: [{tool: 'pi', category: 'providers'}],
	notExecuted: [],
	failed: [],
	blocked: [{tool: 'pi', category: 'providers', reason: '本机 Pi models.json 的 providers 不是对象'}],
	warnings: ['供应商 demo 未包含 API Key']
};

const service = {
	pickExportPath: async () => ({kind: 'cancelled'}),
	pickImportPath: async () => ({kind: 'selected', path: 'C:/backup/demo.ccq-backup'}),
	inventory: async () => transferOk([]),
	prepareExport: async () => transferOk({categories: [], containsCredentials: false, warnings: []}),
	writeExport: async () => transferOk({}),
	loadImport: async () =>
		transferOk({
			containsCredentials: false,
			items: [item('cc', 'settings', 'add'), item('pi', 'providers', 'blocked', 'x')],
			warnings: []
		}),
	applyImport: async () => transferOk(outcome)
} as unknown as ConfigTransferService;

test('导入完成后用结果弹窗展示明细，Enter 关闭', async () => {
	const modes: string[] = [];
	const setup = await testRender(
		<SystemSettingsView
			active
			service={service}
			settingsStore={{
				load: () => ({status: 'missing', value: {autoUpdate: false, backupEncryption: false, backupPassword: ''}}) as never,
				save: () => ({ok: true}) as never
			}}
			autoUpdate={false}
			autoUpdateError={null}
			onSubModeChange={mode => modes.push(mode)}
			onExitToNav={() => {}}
		/>,
		{width: 90, height: 30}
	);
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await act(async () => await setup.renderOnce());
	};
	try {
		await settle();
		await act(async () => setup.mockInput.pressKey('i', {ctrl: true}));
		await settle();
		expect(setup.captureCharFrame()).toContain('导入 · demo.ccq-backup');
		await act(async () => setup.mockInput.pressEnter());
		await settle();

		const frame = setup.captureCharFrame();
		expect(modes.at(-1)).toBe('import-result');
		expect(frame).toContain('导入部分完成');
		expect(frame).toContain('已导入 1 · 跳过 0 · 未导入 1 · 失败 0 · 未执行 0 个分类');
		expect(frame).toContain('本机 Pi models.json 的 providers 不是对象');
		expect(frame).toContain('Enter 关闭');

		await act(async () => setup.mockInput.pressEnter());
		await settle();
		expect(setup.captureCharFrame()).not.toContain('导入部分完成');
		expect(modes.at(-1)).not.toBe('import-result');
	} finally {
		act(() => setup.renderer.destroy());
	}
});
