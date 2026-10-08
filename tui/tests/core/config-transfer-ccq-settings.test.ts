import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';
import {applyConfigTransferImport, planConfigTransferExport, planConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {createBundlePayload} from '../../src/core/config-transfer.js';
import {ccqSystemSettingsPath} from '../../src/core/paths.js';
import {createTempHome} from '../helpers/temp-home.js';

const selection = {categories: [{tool: 'ccq' as const, category: 'system-settings'}], includeCredentials: true};

function put(content: string): void {
	const path = ccqSystemSettingsPath();
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content);
}

async function payload(autoUpdate: unknown) {
	const created = createBundlePayload({
		sections: [{tool: 'ccq', category: 'system-settings', data: {autoUpdate}}],
		containsCredentials: false,
		version: 'test',
		platform: 'test'
	});
	if (!created.ok) throw new Error(created.error);
	return created.data;
}

describe('CCQ 系统设置分类', () => {
	test('缺失偏好默认 false，单选分类不包含密码、profile、缓存与未知字段', async () => {
		const home = createTempHome('ccq-transfer-own-settings-');
		try {
			const planned = await planConfigTransferExport(selection);
			expect(planned.ok).toBe(true);
			if (!planned.ok) return;
			expect(planned.data.sections).toEqual([{tool: 'ccq', category: 'system-settings', data: {autoUpdate: false}}]);
			expect(planned.data.summaries[0]?.itemCount).toBe(1);
			expect(planned.data.containsCredentials).toBe(false);
			expect(() => statSync(ccqSystemSettingsPath())).toThrow();
			put(
				JSON.stringify({
					autoUpdate: true,
					backupEncryption: true,
					backupPassword: 'password-sentinel',
					localOnly: 'secret-sentinel',
					proxy: 'do-not-export'
				})
			);
			const selected = await planConfigTransferExport(selection);
			expect(selected.ok).toBe(true);
			if (selected.ok) {
				expect(selected.data.sections[0]?.data).toEqual({autoUpdate: true});
				expect(JSON.stringify(selected.data)).not.toContain('password-sentinel');
				expect(JSON.stringify(selected.data)).not.toContain('secret-sentinel');
				expect(JSON.stringify(selected.data)).not.toContain('do-not-export');
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('预览零写盘；合并覆盖偏好但保留目标未知字段与受限权限', async () => {
		const home = createTempHome('ccq-transfer-import-settings-');
		try {
			put(JSON.stringify({autoUpdate: false, backupEncryption: true, backupPassword: 'local-password', localOnly: {theme: 'user'}}));
			const before = readFileSync(ccqSystemSettingsPath());
			const incoming = await payload(true);
			const preview = await planConfigTransferImport(incoming);
			expect(preview.ok).toBe(true);
			if (!preview.ok) return;
			expect(preview.data.items[0]?.counts.replaced).toBe(1);
			expect(readFileSync(ccqSystemSettingsPath())).toEqual(before);
			const applied = await applyConfigTransferImport(incoming, preview.data);
			expect(applied.ok).toBe(true);
			if (applied.ok) expect(applied.data.completed).toEqual(selection.categories);
			expect(JSON.parse(readFileSync(ccqSystemSettingsPath(), 'utf8'))).toEqual({
				autoUpdate: true,
				backupEncryption: true,
				backupPassword: 'local-password',
				localOnly: {theme: 'user'}
			});
			if (process.platform !== 'win32') expect(statSync(ccqSystemSettingsPath()).mode & 0o777).toBe(0o600);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('损坏源不导出；损坏目标及非法包在预览时阻断且原字节不变', async () => {
		const home = createTempHome('ccq-transfer-invalid-settings-');
		try {
			put('{broken');
			const before = readFileSync(ccqSystemSettingsPath());
			expect((await planConfigTransferExport(selection)).ok).toBe(false);
			const incoming = await payload(true);
			const preview = await planConfigTransferImport(incoming);
			expect(preview.ok).toBe(true);
			if (preview.ok) expect(preview.data.items[0]?.status).toBe('blocked');
			expect(readFileSync(ccqSystemSettingsPath())).toEqual(before);
			put(JSON.stringify({autoUpdate: false}));
			for (const invalid of [null, 'yes', 1, {nested: true}]) {
				const malformed = await payload(invalid);
				const blocked = await planConfigTransferImport(malformed);
				expect(blocked.ok).toBe(true);
				if (blocked.ok) expect(blocked.data.items[0]?.status).toBe('blocked');
			}
			expect(JSON.parse(readFileSync(ccqSystemSettingsPath(), 'utf8'))).toEqual({autoUpdate: false});
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
