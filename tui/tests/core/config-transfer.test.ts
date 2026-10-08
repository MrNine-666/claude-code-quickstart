import {existsSync, readFileSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, test} from 'bun:test';

import {
	type BundlePayload,
	type BundleSection,
	CONFIG_BUNDLE_FORMAT,
	CONFIG_BUNDLE_MAX_BYTES,
	CONFIG_BUNDLE_MAX_TREE_ENTRIES,
	CONFIG_BUNDLE_PASSWORD_ERROR,
	CONFIG_BUNDLE_VERSION,
	type EncryptedBundleEnvelope,
	TRANSFER_CATEGORY_REGISTRY,
	TRANSFER_EXECUTION_ORDER,
	createBundlePayload,
	createPortableTreeValidationState,
	decryptBundlePayload,
	encryptBundlePayload,
	ensureBundleExtension,
	parseBundleEnvelope,
	parseBundlePayload,
	parseConfigBundleText,
	parsePortableTreeEntries,
	parsePortableTreeEntry,
	readConfigBundle,
	writeConfigBundle
} from '../../src/core/config-transfer.js';
import {createTempHome} from '../helpers/temp-home.js';

const SENTINEL = 'SENTINEL-SECRET-c0ffee';

function payloadOf(sections: readonly BundleSection[], containsCredentials = false): BundlePayload {
	const created = createBundlePayload({
		sections,
		containsCredentials,
		version: '0.0.0-test',
		platform: 'test'
	});
	if (!created.ok) {
		throw new Error(`测试 payload 非法：${created.error}`);
	}

	return created.data;
}

function fileEntry(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {kind: 'file', root: 'claude', path, contentBase64: 'aGVsbG8=', mode: 0o644, ...overrides};
}

function tamperMiddle(value: string): string {
	const index = Math.floor(value.length / 2);
	const current = value[index] ?? 'A';
	return value.slice(0, index) + (current === 'A' ? 'B' : 'A') + value.slice(index + 1);
}

describe('config-transfer 导出目标归一化', () => {
	test('缺少 .ccq-backup 后缀时补齐，已有后缀（含大小写）保持原样', () => {
		expect(ensureBundleExtension('C:/out/ccq-config-20260101')).toBe('C:/out/ccq-config-20260101.ccq-backup');
		expect(ensureBundleExtension(' /tmp/out.CCQ-BACKUP ')).toBe('/tmp/out.CCQ-BACKUP');
		expect(ensureBundleExtension('/tmp/out.ccq-backup')).toBe('/tmp/out.ccq-backup');
	});
});

describe('config-transfer 包格式与加密', () => {
	test('明文包可原子写入并按 SECRET_FILE_MODE 回读', () => {
		const home = createTempHome('ccq-transfer-plain-');
		try {
			const payload = payloadOf([{tool: 'cc', category: 'settings', data: {env: {THEME: 'dark'}}}]);
			const file = join(home.path, 'bundle.ccq-backup');
			const written = writeConfigBundle(file, {
				format: CONFIG_BUNDLE_FORMAT,
				version: CONFIG_BUNDLE_VERSION,
				encryption: null,
				payload
			});
			expect(written.ok).toBe(true);

			const loaded = readConfigBundle(file);
			expect(loaded.ok).toBe(true);
			if (!loaded.ok) return;

			expect(loaded.data.encryption).toBeNull();
			expect(loaded.data.payload).toEqual(payload);
			if (process.platform !== 'win32') {
				expect(statSync(file).mode & 0o777, '明文包也必须使用保守权限').toBe(0o600);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('加密包可往返解密，且原始字节不含 sentinel 明文', async () => {
		const home = createTempHome('ccq-transfer-encrypted-');
		try {
			const payload = payloadOf([{tool: 'pi', category: 'providers', data: {apiKey: SENTINEL}}], true);
			const encrypted = await encryptBundlePayload(payload, 'correct horse battery');
			expect(encrypted.ok).toBe(true);
			if (!encrypted.ok) return;

			const file = join(home.path, 'bundle.ccq-backup');
			expect(writeConfigBundle(file, encrypted.data).ok).toBe(true);
			const raw = readFileSync(file, 'utf8');
			expect(raw.includes(SENTINEL), '密文中不得出现 sentinel 明文').toBe(false);
			expect(JSON.stringify(encrypted.data).includes(SENTINEL)).toBe(false);

			const loaded = readConfigBundle(file);
			expect(loaded.ok).toBe(true);
			if (!loaded.ok) return;

			const decrypted = await decryptBundlePayload(loaded.data, 'correct horse battery');
			expect(decrypted.ok).toBe(true);
			if (decrypted.ok) {
				expect(decrypted.data).toEqual(payload);
			}
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('错误密码、篡改密文与损坏密文共用同一可见文案', async () => {
		const payload = payloadOf([{tool: 'ccq', category: 'mcp-library', data: {servers: {}}}], true);
		const encrypted = await encryptBundlePayload(payload, 'right-password');
		expect(encrypted.ok).toBe(true);
		if (!encrypted.ok) return;

		const wrong = await decryptBundlePayload(encrypted.data, 'wrong-password');
		expect(wrong).toEqual({ok: false, kind: 'password', error: CONFIG_BUNDLE_PASSWORD_ERROR});

		const tampered: EncryptedBundleEnvelope = {...encrypted.data, payload: tamperMiddle(encrypted.data.payload)};
		expect(await decryptBundlePayload(tampered, 'right-password')).toEqual({
			ok: false,
			kind: 'password',
			error: CONFIG_BUNDLE_PASSWORD_ERROR
		});

		const corrupt: EncryptedBundleEnvelope = {...encrypted.data, payload: '!!!not-base64!!!'};
		expect(await decryptBundlePayload(corrupt, 'right-password')).toEqual({
			ok: false,
			kind: 'password',
			error: CONFIG_BUNDLE_PASSWORD_ERROR
		});

		const missing = await decryptBundlePayload(encrypted.data);
		expect(missing).toEqual({ok: false, kind: 'password', error: '此导出包已加密，需要输入密码'});
	});

	test('未知版本、未知分类和重复分类拒绝；含凭据明文包允许显式导出', () => {
		const payload = payloadOf([{tool: 'cc', category: 'settings', data: {}}]);

		expect(parseBundleEnvelope({format: CONFIG_BUNDLE_FORMAT, version: 2, encryption: null, payload})).toEqual({
			ok: false,
			kind: 'validation',
			error: '不支持的导出包版本：2'
		});

		expect(parseBundleEnvelope({format: 'other-bundle', version: 1, encryption: null, payload}).ok).toBe(false);

		const base = {
			createdAt: '2026-01-01T00:00:00.000Z',
			createdBy: {name: 'ccq', version: 'v', platform: 'test'},
			containsCredentials: false
		};
		expect(parseBundlePayload({...base, sections: [{tool: 'zz', category: 'settings', data: {}}]})).toEqual({
			ok: false,
			kind: 'validation',
			error: '导出包包含未知的工具或配置分类'
		});
		expect(parseBundlePayload({...base, sections: [{tool: 'cc', category: 'cache', data: {}}]})).toEqual({
			ok: false,
			kind: 'validation',
			error: '导出包包含未知的工具或配置分类'
		});
		expect(
			parseBundlePayload({
				...base,
				sections: [
					{tool: 'cc', category: 'settings', data: {}},
					{tool: 'cc', category: 'settings', data: {}}
				]
			})
		).toEqual({ok: false, kind: 'validation', error: '导出包包含重复的配置分类'});

		const withCredentials = payloadOf([{tool: 'cc', category: 'settings', data: {}}], true);
		expect(
			parseBundleEnvelope({format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload: withCredentials})
				.ok
		).toBe(true);

		const home = createTempHome('ccq-transfer-reject-');
		try {
			const file = join(home.path, 'bundle.ccq-backup');
			expect(
				writeConfigBundle(file, {
					format: CONFIG_BUNDLE_FORMAT,
					version: CONFIG_BUNDLE_VERSION,
					encryption: null,
					payload: withCredentials
				})
			).toEqual({ok: true, data: undefined, warnings: []});
			expect(readConfigBundle(file).ok).toBe(true);
			if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
		} finally {
			home.restore();
			home.cleanup();
		}

		expect(parseBundleEnvelope({format: CONFIG_BUNDLE_FORMAT, version: '1', encryption: null, payload}).ok).toBe(false);
	});

	test('超过 64 MiB 的包在解析前被拒绝', () => {
		const oversized = 'x'.repeat(CONFIG_BUNDLE_MAX_BYTES + 1);
		expect(parseConfigBundleText(oversized)).toEqual({ok: false, kind: 'validation', error: '导出包超过 64 MiB 上限'});
		expect(parseConfigBundleText('{"format":"ccq-config-bundle"}').ok).toBe(false);
	});

	test('执行顺序覆盖注册分类且无重复', () => {
		const registry = TRANSFER_CATEGORY_REGISTRY.map(definition => `${definition.tool}/${definition.category}`);
		const order = TRANSFER_EXECUTION_ORDER.map(identity => `${identity.tool}/${identity.category}`);
		expect(order.length, '执行顺序不得重复').toBe(new Set(order).size);
		expect([...order].sort()).toEqual([...registry].sort());
		expect(order[0]).toBe('ccq/mcp-library');
	});
});

describe('config-transfer portable tree', () => {
	test('接受安全路径并拒绝绝对路径、盘符、NUL、..、空段与越界', () => {
		for (const path of ['a', 'a/b.txt', 'rules/CLAUDE.md']) {
			expect(parsePortableTreeEntry(fileEntry(path)).ok, `应接受安全路径 ${path}`).toBe(true);
		}

		for (const path of [
			'',
			'/abs/file',
			'C:/windows/file',
			'C:\\windows\\file',
			'a\\b',
			'a\u0000b',
			'a/../b',
			'..',
			'../x',
			'a//b',
			'a/',
			'./a'
		]) {
			expect(parsePortableTreeEntry(fileEntry(path)).ok, `应拒绝不安全路径 ${JSON.stringify(path)}`).toBe(false);
		}

		expect(parsePortableTreeEntry(fileEntry('a.txt', {root: 'other'})).ok).toBe(false);
		expect(parsePortableTreeEntry(fileEntry('a.txt', {mode: 0o777})).ok).toBe(false);
		expect(parsePortableTreeEntry(fileEntry('a.txt', {contentBase64: '!!!'})).ok).toBe(false);
		expect(parsePortableTreeEntry({kind: 'directory', root: 'claude', path: 'a'}).ok).toBe(false);
	});

	test('符号链接 target 必须留在同一导出 root 内', () => {
		expect(parsePortableTreeEntry({kind: 'symlink', root: 'claude', path: 'skills/a/link', target: '../b/file'}).ok).toBe(true);

		for (const target of ['', '/etc/passwd', 'C:/x', 'a\u0000b', 'a\\b', './a', '../..', '../../../outside']) {
			const entry = {kind: 'symlink', root: 'claude', path: 'skills/a/link', target};
			expect(parsePortableTreeEntry(entry).ok, `应拒绝符号链接目标 ${JSON.stringify(target)}`).toBe(false);
		}
	});

	test('重复路径按 root+path 在整个 bundle 范围拒绝', () => {
		const state = createPortableTreeValidationState();
		expect(parsePortableTreeEntries([fileEntry('a.txt')], state).ok).toBe(true);
		expect(parsePortableTreeEntries([fileEntry('a.txt')], state)).toEqual({
			ok: false,
			kind: 'validation',
			error: '文件树存在重复路径'
		});
		expect(parsePortableTreeEntries([fileEntry('a.txt', {root: 'agents'})], state).ok, '不同 root 的同名路径不冲突').toBe(true);
		expect(parsePortableTreeEntries([fileEntry('b.txt'), fileEntry('b.txt')]).ok).toBe(false);
	});

	test('文件树条目超过 10,000 上限时拒绝', () => {
		const entries = Array.from({length: CONFIG_BUNDLE_MAX_TREE_ENTRIES + 1}, (_, index) => fileEntry(`rules/${index}.md`));
		expect(parsePortableTreeEntries(entries)).toEqual({
			ok: false,
			kind: 'validation',
			error: `文件树条目超过 ${CONFIG_BUNDLE_MAX_TREE_ENTRIES} 上限`
		});
	});

	test('非数组输入与非法 base64 内容被拒绝', () => {
		expect(parsePortableTreeEntries({}).ok).toBe(false);
		expect(parsePortableTreeEntries([fileEntry('a.txt', {contentBase64: 'aGVsbG8'})]).ok).toBe(false);
	});
});
