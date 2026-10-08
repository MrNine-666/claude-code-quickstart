import {mkdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {describe, expect, test} from 'bun:test';

import {readCcqSystemSettings, writeCcqSystemSettings} from '../../src/core/system-settings.js';
import {ccqSystemSettingsPath} from '../../src/core/paths.js';
import {createTempHome} from '../helpers/temp-home.js';

// CCQ 自身系统设置 owner：缺失默认 false、损坏 fail closed 不覆盖、未知字段保留、权限保守。
// 全部使用临时 CCQ_HOME，绝不触碰真实 HOME。

function writeSettings(home: string, content: string): string {
	const path = join(home, '.ccq', 'system-settings.json');
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
	return path;
}

describe('CCQ 系统设置读写', () => {
	test('缺失文件默认 autoUpdate=false，不创建文件', () => {
		const home = createTempHome('ccq-system-settings-missing-');
		try {
			const read = readCcqSystemSettings();
			expect(read.status).toBe('missing');
			expect(read.value.autoUpdate).toBe(false);
			expect(read.value.backupEncryption).toBe(false);
			expect(read.value.backupPassword).toBe('');
			expect(() => statSync(ccqSystemSettingsPath())).toThrow();
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('保存 true/false 后可读回，保留未知字段且权限为 0600', () => {
		const home = createTempHome('ccq-system-settings-save-');
		try {
			writeSettings(home.path, JSON.stringify({autoUpdate: false, customFlag: 'keep-me', nested: {a: 1}}));
			expect(writeCcqSystemSettings({autoUpdate: true}).ok).toBe(true);
			const raw = JSON.parse(readFileSync(ccqSystemSettingsPath(), 'utf8')) as Record<string, unknown>;
			expect(raw.autoUpdate).toBe(true);
			expect(raw.customFlag, '未知字段必须保留').toBe('keep-me');
			expect(raw.nested).toEqual({a: 1});
			expect(readCcqSystemSettings().value.autoUpdate).toBe(true);
			if (process.platform !== 'win32') {
				expect(statSync(ccqSystemSettingsPath()).mode & 0o777).toBe(0o600);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('缺少 autoUpdate 字段视为 false；保存其他字段时补写布尔值', () => {
		const home = createTempHome('ccq-system-settings-default-');
		try {
			writeSettings(home.path, JSON.stringify({other: true}));
			expect(readCcqSystemSettings().status).toBe('valid');
			expect(readCcqSystemSettings().value.autoUpdate).toBe(false);
			expect(writeCcqSystemSettings({autoUpdate: false}).ok).toBe(true);
			const raw = JSON.parse(readFileSync(ccqSystemSettingsPath(), 'utf8')) as Record<string, unknown>;
			expect(raw.autoUpdate).toBe(false);
			expect(raw.other).toBe(true);
			expect(raw.backupEncryption).toBe(false);
			expect(raw.backupPassword).toBe('');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('加密偏好与密码写入本机 JSON，自动更新的部分写入保留它们', () => {
		const home = createTempHome('ccq-system-settings-backup-');
		try {
			expect(writeCcqSystemSettings({backupEncryption: true}).ok).toBe(true);
			expect(writeCcqSystemSettings({backupPassword: 'local-secret'}).ok).toBe(true);
			expect(writeCcqSystemSettings({autoUpdate: true}).ok).toBe(true);
			expect(readCcqSystemSettings().value).toEqual({autoUpdate: true, backupEncryption: true, backupPassword: 'local-secret'});
			const raw = JSON.parse(readFileSync(ccqSystemSettingsPath(), 'utf8')) as Record<string, unknown>;
			expect(raw.backupPassword).toBe('local-secret');
			if (process.platform !== 'win32') expect(statSync(ccqSystemSettingsPath()).mode & 0o777).toBe(0o600);
			expect(writeCcqSystemSettings({backupPassword: ''}).ok).toBe(true);
			expect(readCcqSystemSettings().value.backupPassword).toBe('');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('损坏 JSON 与非法类型 fail closed：不静默覆盖，也不自动下载', () => {
		const home = createTempHome('ccq-system-settings-invalid-');
		try {
			const broken = writeSettings(home.path, '{not json');
			const read = readCcqSystemSettings();
			expect(read.status).toBe('invalid');
			expect(read.value.autoUpdate, '损坏设置不得开启自动下载').toBe(false);

			const write = writeCcqSystemSettings({autoUpdate: true});
			expect(write.ok).toBe(false);
			expect(readFileSync(broken, 'utf8'), '损坏文件必须保持原字节').toBe('{not json');

			writeSettings(home.path, JSON.stringify({autoUpdate: 'yes'}));
			expect(readCcqSystemSettings().status).toBe('invalid');
			expect(writeCcqSystemSettings({autoUpdate: true}).ok).toBe(false);
			expect(JSON.parse(readFileSync(ccqSystemSettingsPath(), 'utf8')).autoUpdate).toBe('yes');
			for (const invalid of [{backupEncryption: 'yes'}, {backupPassword: 123}]) {
				const raw = JSON.stringify(invalid);
				writeSettings(home.path, raw);
				expect(readCcqSystemSettings().status).toBe('invalid');
				expect(writeCcqSystemSettings({backupPassword: 'new-secret'}).ok).toBe(false);
				expect(readFileSync(ccqSystemSettingsPath(), 'utf8')).toBe(raw);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
