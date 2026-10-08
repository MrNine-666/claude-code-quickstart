import {existsSync, mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {importSettingsSection, snapshotSettingsSection} from '../../src/core/config-transfer-sections.js';
import {
	type BundleEnvelope,
	CONFIG_BUNDLE_FORMAT,
	CONFIG_BUNDLE_VERSION,
	createBundlePayload,
	decryptBundlePayload,
	encryptBundlePayload,
	readConfigBundle,
	type TransferResult,
	writeConfigBundle
} from '../../src/core/config-transfer.js';
import {piSettingsPath} from '../../src/core/paths.js';
import {readPiConfigText, savePiConfigText} from '../../src/core/pi-config.js';
import {createConfigTransferService} from '../../src/services/config-transfer-service.js';
import {createTempHome} from '../helpers/temp-home.js';

const categories = [{tool: 'pi' as const, category: 'settings'}];
const password = 'isolated-test-password';
const sourceVersion = 'SOURCE-CHANGELOG-SENTINEL';
const localVersion = 'LOCAL-CHANGELOG-SENTINEL';

function dataOf<T>(result: TransferResult<T>): T {
	if (!result.ok) throw new Error(result.error);
	return result.data;
}

function putSettings(text: string): void {
	const path = piSettingsPath();
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, text);
}

function settings(): Record<string, unknown> {
	return JSON.parse(readFileSync(piSettingsPath(), 'utf8')) as Record<string, unknown>;
}

async function writeOldBundle(path: string, encrypt: boolean, text: string): Promise<void> {
	const payload = dataOf(
		createBundlePayload({
			sections: [{tool: 'pi', category: 'settings', data: {text}}],
			containsCredentials: false,
			version: 'test',
			platform: 'test'
		})
	);
	const envelope: BundleEnvelope = encrypt
		? dataOf(await encryptBundlePayload(payload, password))
		: {format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload};
	dataOf(writeConfigBundle(path, envelope));
}

describe('Pi settings 迁移排除 lastChangelogVersion', () => {
	for (const encrypt of [false, true]) {
		const mode = encrypt ? '加密' : '明文';
		test(`${mode}导出解码后无运行时版本，源字节不变且其他设置可往返`, async () => {
			const home = createTempHome('ccq-pi-settings-export-');
			try {
				putSettings(
					JSON.stringify({lastChangelogVersion: sourceVersion, deviceId: 'source-device', theme: 'light', custom: {remote: 1}})
				);
				const before = readFileSync(piSettingsPath());
				const beforeStat = statSync(piSettingsPath());
				const service = createConfigTransferService();
				dataOf(await service.prepareExport({categories}));
				const bundlePath = join(home.path, 'new.ccq-backup');
				dataOf(await service.writeExport({categories, targetPath: bundlePath, encrypt, password}));
				const envelope = dataOf(readConfigBundle(bundlePath));
				expect(envelope.encryption !== null).toBe(encrypt);
				const payload = dataOf(await decryptBundlePayload(envelope, password));
				const section = payload.sections[0]?.data as {text: string};
				expect(JSON.parse(section.text)).toEqual({theme: 'light', custom: {remote: 1}});
				expect(JSON.stringify(payload)).not.toContain(sourceVersion);
				expect(readFileSync(piSettingsPath())).toEqual(before);
				expect(statSync(piSettingsPath()).mtimeMs).toBe(beforeStat.mtimeMs);

				putSettings(
					JSON.stringify({lastChangelogVersion: localVersion, theme: 'dark', custom: {local: 2}, packages: ['npm:local-only']})
				);
				const localBytes = readFileSync(piSettingsPath());
				dataOf(await service.loadImport({bundlePath, password}));
				expect(readFileSync(piSettingsPath())).toEqual(localBytes);
				expect(dataOf(await service.applyImport([])).status).toBe('complete');
				expect(settings()).toEqual({
					lastChangelogVersion: localVersion,
					theme: 'light',
					custom: {local: 2, remote: 1},
					packages: ['npm:local-only']
				});
			} finally {
				home.restore();
				home.cleanup();
			}
		});

		for (const target of ['existing-version', 'existing-no-version', 'missing'] as const) {
			test(`${mode}旧 v1 包导入：${target} 保留本机版本或缺失事实`, async () => {
				const home = createTempHome('ccq-pi-settings-old-bundle-');
				try {
					const initial =
						target === 'existing-version' ? {lastChangelogVersion: localVersion, localOnly: true} : {localOnly: true};
					if (target !== 'missing') putSettings(JSON.stringify(initial));
					const before = target === 'missing' ? null : readFileSync(piSettingsPath());
					const beforeStat = target === 'missing' ? null : statSync(piSettingsPath());
					const bundlePath = join(home.path, 'old.ccq-backup');
					await writeOldBundle(
						bundlePath,
						encrypt,
						JSON.stringify({lastChangelogVersion: sourceVersion, theme: 'light', custom: {remote: 1}})
					);
					const service = createConfigTransferService();
					const preview = dataOf(await service.loadImport({bundlePath, password}));
					expect(preview.items[0]?.status).not.toBe('blocked');
					if (before !== null && beforeStat !== null) {
						expect(readFileSync(piSettingsPath())).toEqual(before);
						expect(statSync(piSettingsPath()).mtimeMs).toBe(beforeStat.mtimeMs);
					} else {
						expect(existsSync(piSettingsPath())).toBe(false);
					}
					expect(dataOf(await service.applyImport([])).status).toBe('complete');
					expect(settings()).toEqual({...(target === 'missing' ? {} : initial), theme: 'light', custom: {remote: 1}});
					if (process.platform !== 'win32') expect(statSync(piSettingsPath()).mode & 0o777).toBe(0o600);
				} finally {
					home.restore();
					home.cleanup();
				}
			});
		}
	}

	for (const target of ['existing', 'missing'] as const) {
		test(`dryRun ${target}：忽略旧版本，其他字段计数正常，零写盘`, () => {
			const home = createTempHome('ccq-pi-settings-dry-run-');
			try {
				if (target === 'existing') putSettings(JSON.stringify({lastChangelogVersion: localVersion, theme: 'dark'}));
				const before = target === 'existing' ? readFileSync(piSettingsPath()) : null;
				const beforeStat = target === 'existing' ? statSync(piSettingsPath()) : null;
				const versionOnly = {text: JSON.stringify({lastChangelogVersion: sourceVersion})};
				expect(dataOf(importSettingsSection('pi', versionOnly, {dryRun: true})).unchanged).toEqual(['settings']);
				const withTheme = {text: JSON.stringify({lastChangelogVersion: sourceVersion, theme: 'light'})};
				const report = dataOf(importSettingsSection('pi', withTheme, {dryRun: true}));
				expect(target === 'existing' ? report.replaced : report.added).toEqual(['settings']);
				// A version-only real import must not rewrite an existing file or create a missing one.
				expect(dataOf(importSettingsSection('pi', versionOnly)).unchanged).toEqual(['settings']);
				if (before !== null && beforeStat !== null) {
					expect(readFileSync(piSettingsPath())).toEqual(before);
					expect(statSync(piSettingsPath()).mtimeMs).toBe(beforeStat.mtimeMs);
				} else {
					expect(existsSync(piSettingsPath())).toBe(false);
				}
			} finally {
				home.restore();
				home.cleanup();
			}
		});
	}

	for (const invalid of ['{broken', '[]']) {
		test(`损坏本机 ${invalid}：dryRun/apply 阻断，旧包预览阻断且字节不变`, async () => {
			const home = createTempHome('ccq-pi-settings-corrupt-');
			try {
				putSettings(invalid);
				const before = readFileSync(piSettingsPath());
				const beforeStat = statSync(piSettingsPath());
				const incoming = {text: JSON.stringify({lastChangelogVersion: sourceVersion, theme: 'light'})};
				for (const dryRun of [true, false]) {
					const result = importSettingsSection('pi', incoming, {dryRun});
					expect(result.ok).toBe(false);
					if (!result.ok) expect(result.kind).toBe('conflict');
				}
				const bundlePath = join(home.path, 'old.ccq-backup');
				await writeOldBundle(bundlePath, false, incoming.text);
				const service = createConfigTransferService();
				const preview = dataOf(await service.loadImport({bundlePath, password}));
				expect(preview.items[0]?.status).toBe('blocked');
				const outcome = dataOf(await service.applyImport([{tool: 'pi', category: 'settings', action: 'merge'}]));
				expect(outcome.completed).toEqual([]);
				expect(readFileSync(piSettingsPath())).toEqual(before);
				expect(statSync(piSettingsPath()).mtimeMs).toBe(beforeStat.mtimeMs);
			} finally {
				home.restore();
				home.cleanup();
			}
		});
	}

	test('版本过滤仅属迁移：Config 编辑仍允许该字段，缺失源不创建设置', () => {
		const home = createTempHome('ccq-pi-settings-editor-');
		try {
			expect(dataOf(snapshotSettingsSection('pi')).text).toBe('');
			expect(existsSync(piSettingsPath())).toBe(false);
			const saved = savePiConfigText(JSON.stringify({lastChangelogVersion: localVersion, theme: 'dark'}));
			expect(saved.ok).toBe(true);
			expect(JSON.parse(readPiConfigText()).lastChangelogVersion).toBe(localVersion);
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
