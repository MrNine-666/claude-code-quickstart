import {resolve} from 'node:path';
import {expect, test} from 'bun:test';
import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {transferOk} from '../../src/core/config-transfer.js';
import {type ManualPathKind, resolveManualBundlePath} from '../../src/core/native-file-dialog.js';
import type {ConfigTransferService} from '../../src/services/config-transfer-service.js';
import {SystemSettingsView} from '../../src/views/system-settings/SystemSettingsView.js';

const HOME = resolve('/home/demo');
const files: Record<string, ManualPathKind> = {[HOME]: 'directory', [resolve(HOME, 'pkg.ccq-backup')]: 'file'};

function createService() {
	const calls = {writeExport: [] as string[], loadImport: [] as string[]};
	const service = {
		pickExportPath: async () => ({kind: 'unavailable', reason: '当前平台不支持系统文件对话框'}),
		pickImportPath: async () => ({kind: 'unavailable', reason: '当前平台不支持系统文件对话框'}),
		resolveManualPath: (kind: 'import' | 'export', raw: string) =>
			resolveManualBundlePath(kind, raw, {home: HOME, stat: path => files[path] ?? 'missing'}),
		inventory: async () => transferOk([]),
		prepareExport: async () => transferOk({categories: [], containsCredentials: false, warnings: []}),
		writeExport: async (request: {targetPath: string}) => {
			calls.writeExport.push(request.targetPath);
			return transferOk({bundlePath: request.targetPath});
		},
		loadImport: async (request: {bundlePath: string}) => {
			calls.loadImport.push(request.bundlePath);
			return transferOk({containsCredentials: false, items: [], warnings: []});
		},
		applyImport: async () => transferOk({})
	} as unknown as ConfigTransferService;
	return {service, calls};
}

async function renderView(service: ConfigTransferService) {
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
			onExitToNav={() => {}}
		/>,
		{width: 90, height: 30}
	);
	const settle = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await act(async () => await setup.renderOnce());
	};
	// 裸 ESC 会被终端解析器缓冲并与下一个按键合并，必须等一小段超时让它单独成事件。
	const pressEscapeKey = async (): Promise<void> => {
		await act(async () => {
			setup.mockInput.pressEscape();
			await new Promise(done => setTimeout(done, 20));
		});
		await settle();
	};
	return {setup, settle, pressEscapeKey};
}

test('导出：对话框 unavailable 时进入手动路径，Esc 回到明细弹窗，提交默认路径后写入', async () => {
	const {service, calls} = createService();
	const {setup, settle, pressEscapeKey} = await renderView(service);
	try {
		await settle();
		await act(async () => setup.mockInput.pressKey('o', {ctrl: true}));
		await settle();
		await act(async () => setup.mockInput.pressEnter());
		await settle();
		expect(setup.captureCharFrame()).toContain('导出到路径');
		expect(setup.captureCharFrame()).toContain('~/ccq-config-');

		await pressEscapeKey();
		expect(setup.captureCharFrame()).not.toContain('导出到路径');
		expect(setup.captureCharFrame()).toContain('导出配置');
		expect(calls.writeExport).toEqual([]);

		await act(async () => setup.mockInput.pressEnter());
		await settle();
		await act(async () => setup.mockInput.pressEnter());
		await settle();
		expect(calls.writeExport).toHaveLength(1);
		expect(calls.writeExport[0]).toMatch(/ccq-config-\d{8}-\d{6}\.ccq-backup$/);
		expect(calls.writeExport[0]?.startsWith(HOME)).toBe(true);
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test('导入：对话框 unavailable 时手动输入，校验失败留在弹窗，修正后复用 import-picked', async () => {
	const {service, calls} = createService();
	const {setup, settle} = await renderView(service);
	try {
		await settle();
		await act(async () => setup.mockInput.pressKey('i', {ctrl: true}));
		await settle();
		expect(setup.captureCharFrame()).toContain('从路径导入');

		await act(async () => setup.mockInput.typeText('~/pkg'));
		await settle();
		await act(async () => setup.mockInput.pressEnter());
		await settle();
		expect(setup.captureCharFrame()).toContain('文件不存在');
		expect(calls.loadImport).toEqual([]);

		await act(async () => setup.mockInput.typeText('.ccq-backup'));
		await settle();
		expect(setup.captureCharFrame()).not.toContain('文件不存在');
		await act(async () => setup.mockInput.pressEnter());
		await settle();
		expect(calls.loadImport).toEqual([resolve(HOME, 'pkg.ccq-backup')]);
		expect(setup.captureCharFrame()).not.toContain('从路径导入');
	} finally {
		act(() => setup.renderer.destroy());
	}
});

test('导入：手动路径 Esc 静默回到页面，不读取任何包', async () => {
	const {service, calls} = createService();
	const {setup, settle, pressEscapeKey} = await renderView(service);
	try {
		await settle();
		await act(async () => setup.mockInput.pressKey('i', {ctrl: true}));
		await settle();
		await pressEscapeKey();
		expect(setup.captureCharFrame()).not.toContain('从路径导入');
		expect(calls.loadImport).toEqual([]);
	} finally {
		act(() => setup.renderer.destroy());
	}
});
