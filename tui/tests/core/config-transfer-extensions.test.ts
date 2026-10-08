import {existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, test} from 'bun:test';

import {importExtensionsSection, parseExtensionsSection, snapshotExtensionsSection} from '../../src/core/config-transfer-extensions.js';
import {createTempHome} from '../helpers/temp-home.js';

// Phase 2 Part B：Pi 全局 Extensions 实际内容导入导出。全部使用临时 CCQ_HOME。

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, content, 'utf8');
}

function readText(path: string): string {
	return readFileSync(path, 'utf8');
}

function fileEntry(path: string, content: string): Record<string, unknown> {
	return {kind: 'file', root: 'pi-agent', path, contentBase64: Buffer.from(content, 'utf8').toString('base64'), mode: 0o644};
}

describe('Pi Extensions 导入导出', () => {
	test('实际内容 roundtrip；本机额外文件保留；models-store 不进入快照', () => {
		const home = createTempHome('ccq-transfer-ext-');
		const projectDir = join(home.path, 'project');
		const originalCwd = process.cwd();
		try {
			const extensionsDir = join(home.path, '.pi', 'agent', 'extensions');
			writeFile(join(extensionsDir, 'mine.ts'), 'export default 1;\n');
			writeFile(join(extensionsDir, 'nested', 'helper.ts'), 'export const h = 2;\n');
			writeFile(join(home.path, '.pi', 'agent', 'models-store.json'), '{"secret":"STORE-CACHE"}');
			writeFile(join(projectDir, '.pi', 'extensions', 'project.ts'), 'project\n');

			const snapshot = snapshotExtensionsSection();
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.entries.map(entry => entry.path).sort()).toEqual(['mine.ts', 'nested/helper.ts']);
			expect(snapshot.data.entries.every(entry => entry.root === 'pi-agent')).toBe(true);
			expect(JSON.stringify(snapshot.data)).not.toContain('STORE-CACHE');
			expect(JSON.stringify(snapshot.data)).not.toContain('models-store');

			writeFile(join(extensionsDir, 'local-only.ts'), 'keep\n');
			process.chdir(projectDir);
			const imported = importExtensionsSection({
				entries: [fileEntry('mine.ts', 'export default 2;\n'), fileEntry('new.ts', 'new\n')]
			});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(imported.data.added).toEqual(['new.ts']);
			expect(imported.data.replaced).toEqual(['mine.ts']);
			expect(readText(join(extensionsDir, 'mine.ts'))).toBe('export default 2;\n');
			expect(readText(join(extensionsDir, 'nested', 'helper.ts'))).toBe('export const h = 2;\n');
			expect(readText(join(extensionsDir, 'local-only.ts')), '包外本机文件必须保留').toBe('keep\n');
			expect(readText(join(home.path, '.pi', 'agent', 'models-store.json'))).toBe('{"secret":"STORE-CACHE"}');
			expect(readText(join(projectDir, '.pi', 'extensions', 'project.ts')), '项目级 .pi/extensions 不得被触碰').toBe('project\n');
		} finally {
			process.chdir(originalCwd);
			home.restore();
			home.cleanup();
		}
	});

	test('二进制内容按原始字节往返，不被 utf8 往返损坏', () => {
		const home = createTempHome('ccq-transfer-ext-binary-');
		try {
			const extensionsDir = join(home.path, '.pi', 'agent', 'extensions');
			const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x7f, 0x0a]);
			mkdirSync(extensionsDir, {recursive: true});
			writeFileSync(join(extensionsDir, 'asset.bin'), bytes);

			const snapshot = snapshotExtensionsSection();
			expect(snapshot.ok).toBe(true);
			if (!snapshot.ok) return;
			expect(snapshot.data.entries).toHaveLength(1);

			// 先删掉本机文件，再导入快照：写入必须逐字节相等，且 postflight 认作 unchanged。
			rmSync(join(extensionsDir, 'asset.bin'));
			const imported = importExtensionsSection({entries: snapshot.data.entries});
			expect(imported.ok).toBe(true);
			if (!imported.ok) return;
			expect(readFileSync(join(extensionsDir, 'asset.bin')).equals(bytes), '二进制扩展资源必须逐字节恢复').toBe(true);

			const postflight = importExtensionsSection({entries: snapshot.data.entries}, {dryRun: true});
			expect(postflight.ok).toBe(true);
			if (!postflight.ok) return;
			expect(postflight.data.unchanged, 'postflight 必须确认字节一致').toEqual(['asset.bin']);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('dryRun 零写盘；parse 拒绝越界路径与错误 root', () => {
		const home = createTempHome('ccq-transfer-ext-parse-');
		try {
			const extensionsDir = join(home.path, '.pi', 'agent', 'extensions');
			writeFile(join(extensionsDir, 'mine.ts'), 'old\n');
			const before = readText(join(extensionsDir, 'mine.ts'));

			const preview = importExtensionsSection(
				{entries: [fileEntry('mine.ts', 'new\n'), fileEntry('added.ts', 'x\n')]},
				{dryRun: true}
			);
			expect(preview.ok).toBe(true);
			if (!preview.ok) return;
			expect(preview.data.replaced).toEqual(['mine.ts']);
			expect(preview.data.added).toEqual(['added.ts']);
			expect(readText(join(extensionsDir, 'mine.ts'))).toBe(before);
			expect(existsSync(join(extensionsDir, 'added.ts'))).toBe(false);

			expect(parseExtensionsSection({entries: [fileEntry('../escape.ts', 'x')]}).ok).toBe(false);
			expect(parseExtensionsSection({entries: [{...fileEntry('a.ts', 'x'), root: 'claude'}]}).ok).toBe(false);
			expect(parseExtensionsSection({entries: [fileEntry('/abs.ts', 'x')]}).ok).toBe(false);
			expect(parseExtensionsSection({entries: []}).ok).toBe(true);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('深层相对显式入口随文件往返；本机入口与未知设置保留，绝对/project/本地 package 不迁移', () => {
		const home = createTempHome('ccq-transfer-ext-explicit-');
		try {
			const source = join(home.path, 'source');
			const target = join(home.path, 'target');
			process.env.CCQ_HOME = source;
			writeFile(join(source, '.pi', 'agent', 'extensions', 'custom', 'src', 'main.ts'), 'export default () => {}');
			writeFile(
				join(source, '.pi', 'agent', 'settings.json'),
				JSON.stringify({
					extensions: [
						'extensions/custom/src/main.ts',
						'/outside.ts',
						'../project/.pi/extensions/foo.ts',
						'npm:package',
						'extensions/missing.ts'
					],
					packages: ['./package']
				})
			);
			const exported = snapshotExtensionsSection();
			expect(exported.ok).toBe(true);
			if (!exported.ok) return;
			expect(exported.data.explicitEntries).toEqual(['extensions/custom/src/main.ts']);
			expect(exported.warnings.length).toBeGreaterThan(0);
			process.env.CCQ_HOME = target;
			writeFile(
				join(target, '.pi', 'agent', 'settings.json'),
				JSON.stringify({extensions: ['extensions/local.ts', '-extensions/disabled.ts'], packages: ['local'], theme: 'light'})
			);
			const before = readText(join(target, '.pi', 'agent', 'settings.json'));
			const preview = importExtensionsSection(exported.data, {dryRun: true});
			expect(preview.ok).toBe(true);
			expect(readText(join(target, '.pi', 'agent', 'settings.json'))).toBe(before);
			const result = importExtensionsSection(exported.data);
			expect(result.ok).toBe(true);
			const settings = JSON.parse(readText(join(target, '.pi', 'agent', 'settings.json')));
			expect(settings.extensions).toEqual(['extensions/local.ts', '-extensions/disabled.ts', 'extensions/custom/src/main.ts']);
			expect(settings.packages).toEqual(['local']);
			expect(settings.theme).toBe('light');
			expect(readText(join(target, '.pi', 'agent', 'extensions', 'custom', 'src', 'main.ts'))).toBe('export default () => {}');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('如提供 Pi 安装目录，以原生加载器验证深层入口可加载（离线 oracle）', async () => {
		const nativeDir = process.env.PI_CODING_AGENT_PACKAGE_DIR;
		if (!nativeDir) return;
		const home = createTempHome('ccq-transfer-ext-oracle-');
		try {
			const source = join(home.path, 'source');
			const target = join(home.path, 'target');
			process.env.CCQ_HOME = source;
			writeFile(join(source, '.pi', 'agent', 'extensions', 'custom', 'src', 'main.ts'), 'export default function () {}');
			writeFile(join(source, '.pi', 'agent', 'settings.json'), JSON.stringify({extensions: ['extensions/custom/src/main.ts']}));
			const exported = snapshotExtensionsSection();
			expect(exported.ok).toBe(true);
			if (!exported.ok) return;
			process.env.CCQ_HOME = target;
			expect(importExtensionsSection(exported.data).ok).toBe(true);
			const dir = join(target, '.pi', 'agent');
			const settings = JSON.parse(readText(join(dir, 'settings.json'))) as {extensions: string[]};
			const {discoverAndLoadExtensions} = await import(pathToFileURL(join(nativeDir, 'dist/core/extensions/loader.js')).href);
			const loaded = await discoverAndLoadExtensions(
				settings.extensions.map(path => join(dir, path)),
				target,
				dir
			);
			expect(loaded.errors).toEqual([]);
			expect(loaded.extensions).toHaveLength(1);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('本机明确禁用的深层入口不被导入包重新启用', () => {
		const home = createTempHome('ccq-transfer-ext-disabled-');
		try {
			const root = join(home.path, '.pi', 'agent');
			writeFile(join(root, 'settings.json'), JSON.stringify({extensions: ['-extensions/custom/deep.ts']}));
			const result = importExtensionsSection({
				entries: [fileEntry('custom/deep.ts', 'x')],
				explicitEntries: ['extensions/custom/deep.ts']
			});
			expect(result.ok).toBe(true);
			expect(JSON.parse(readText(join(root, 'settings.json'))).extensions).toEqual(['-extensions/custom/deep.ts']);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('目标 settings.json 损坏时 Extensions 预览阻断、字节与文件集不变', () => {
		const home = createTempHome('ccq-transfer-ext-invalid-settings-');
		try {
			const root = join(home.path, '.pi', 'agent');
			writeFile(join(root, 'settings.json'), '{broken');
			const section = {entries: [fileEntry('custom/deep.ts', 'x')], explicitEntries: ['extensions/custom/deep.ts']};
			expect(importExtensionsSection(section, {dryRun: true}).ok).toBe(false);
			expect(readText(join(root, 'settings.json'))).toBe('{broken');
			expect(existsSync(join(root, 'extensions', 'custom', 'deep.ts'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('排除已知认证/会话文件：明文源码仍可能携带硬编码密钥', () => {
		const home = createTempHome('ccq-transfer-ext-sensitive-');
		try {
			const root = join(home.path, '.pi', 'agent', 'extensions', 'custom');
			for (const name of ['.env', '.env.local', 'auth.json', 'session.json', 'tokens.json'])
				writeFile(join(root, name), 'OAUTH-SECRET');
			writeFile(join(root, 'main.ts'), 'const key = "HARDCODED-SECRET";');
			const result = snapshotExtensionsSection();
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.entries.map(entry => entry.path)).toEqual(['custom/main.ts']);
			expect(JSON.stringify(result.data)).not.toContain('OAUTH-SECRET');
			expect(
				Buffer.from(result.data.entries[0]?.kind === 'file' ? result.data.entries[0].contentBase64 : '', 'base64').toString()
			).toContain('HARDCODED-SECRET');
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('受管扩展根本身被重定向到外部时预览也阻断', () => {
		const home = createTempHome('ccq-transfer-ext-root-link-');
		try {
			const root = join(home.path, '.pi', 'agent', 'extensions');
			const external = join(home.path, 'external');
			mkdirSync(dirname(root), {recursive: true});
			mkdirSync(external);
			symlinkSync(external, root, process.platform === 'win32' ? 'junction' : 'dir');
			expect(importExtensionsSection({entries: [fileEntry('new.ts', 'x')]}, {dryRun: true}).ok).toBe(false);
			expect(snapshotExtensionsSection().ok).toBe(false);
			expect(existsSync(join(external, 'new.ts'))).toBe(false);
		} finally {
			home.restore();
			home.cleanup();
		}
	});

	test('已有父目录 symlink 跳出受管 root 时 dryRun/执行均阻断；内部相对 symlink 正常', () => {
		const home = createTempHome('ccq-transfer-ext-symlink-');
		try {
			const root = join(home.path, '.pi', 'agent', 'extensions');
			const outside = join(home.path, 'outside');
			writeFile(join(outside, 'existing.ts'), 'ORIGINAL');
			mkdirSync(root, {recursive: true});
			symlinkSync(outside, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
			for (const dryRun of [true, false]) {
				const result = importExtensionsSection({entries: [fileEntry('alias/existing.ts', 'CHANGED')]}, {dryRun});
				expect(result.ok).toBe(false);
				expect(readText(join(outside, 'existing.ts'))).toBe('ORIGINAL');
			}
			mkdirSync(join(root, 'inside'), {recursive: true});
			symlinkSync('inside', join(root, 'safe'), process.platform === 'win32' ? 'junction' : 'dir');
			expect(importExtensionsSection({entries: [fileEntry('safe/mine.ts', 'SAFE')]}).ok).toBe(true);
			expect(readText(join(root, 'inside', 'mine.ts'))).toBe('SAFE');
		} finally {
			home.restore();
			home.cleanup();
		}
	});
});
