import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {readInstalledPiPackageManifest} from '../../src/core/pi-package-source.js';
import {createExtensionsService} from '../../src/services/extensions-service.js';
import type {execCommand} from '../../src/core/exec.js';
import {piExtensionUpdateStatus} from '../../src/core/extensions.js';

let home: string;
let previousHome: string | undefined;
beforeEach(() => {
	previousHome = process.env.CCQ_HOME;
	home = mkdtempSync(join(tmpdir(), 'ccq-extension-version-'));
	process.env.CCQ_HOME = home;
});
afterEach(() => {
	if (previousHome === undefined) delete process.env.CCQ_HOME;
	else process.env.CCQ_HOME = previousHome;
	rmSync(home, {recursive: true, force: true});
});
function manifest(dir: string, version: unknown = '1.2.3', name = '@test/extension') {
	const path = join(dir, 'package.json');
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify({name, version, pi: {extensions: ['./extension.ts']}}));
}
function commands(source: string, calls: string[]): typeof execCommand {
	return async (command, args) => {
		calls.push(`${command} ${args.join(' ')}`);
		if (command === 'pi') return {code: 0, stdout: JSON.stringify([source]), stderr: ''};
		return {
			code: 0,
			stdout: JSON.stringify({
				name: '@test/extension',
				version: '9.0.0',
				author: 'Registry Author',
				time: {'9.0.0': '2026-10-01T00:00:00.000Z'},
				pi: {extensions: ['./extension.ts']}
			}),
			stderr: ''
		};
	};
}

describe('installed extension versions', () => {
	test('reads scoped npm local version, not pinned source or registry latest', async () => {
		manifest(join(home, '.pi/agent/npm/node_modules/@test/extension'));
		const calls: string[] = [];
		const items = await createExtensionsService({exec: commands('npm:@test/extension@^1.0.0', calls)}).loadInstalled();
		expect(items[0]?.installedVersion).toBe('1.2.3');
		expect(items[0]?.version).toBe('9.0.0');
		expect(items[0]?.publishedAt).toBe('2026-10-01T00:00:00.000Z');
		expect(items[0]?.author).toBe('Registry Author');
		expect(piExtensionUpdateStatus(items[0]!)).toBe('available');
		expect(calls).toEqual(['pi list --no-approve', 'npm view @test/extension@latest --json']);
	});
	test('missing local manifest never reports registry latest as installed', async () => {
		const items = await createExtensionsService({exec: commands('npm:@test/extension', [])}).loadInstalled();
		expect(items[0]?.version).toBe('9.0.0');
		expect(items[0]?.installedVersion).toBe('');
	});
	test('invalid local version stays unknown even when latest metadata exists', async () => {
		manifest(join(home, '.pi/agent/npm/node_modules/@test/extension'), 'latest');
		const calls: string[] = [];
		const items = await createExtensionsService({exec: commands('npm:@test/extension', calls)}).loadInstalled();
		expect(items[0]?.installedVersion).toBe('');
		expect(piExtensionUpdateStatus(items[0]!)).toBe('unknown');
		expect(calls).toHaveLength(2);
	});
	test('reads Git and relative/local manifests', async () => {
		manifest(join(home, '.pi/agent/git/github.com/test/extension'), '2.3.4');
		manifest(join(home, '.pi/agent/local-extension'), '3.4.5');
		manifest(join(home, 'local-extension'), '4.5.6');
		expect(readInstalledPiPackageManifest('git:github.com/test/extension@main')?.version).toBe('2.3.4');
		expect(readInstalledPiPackageManifest('./local-extension')?.version).toBe('3.4.5');
		expect(readInstalledPiPackageManifest('file:./local-extension')?.version).toBe('3.4.5');
		expect(readInstalledPiPackageManifest('~/local-extension')?.version).toBe('4.5.6');
		const items = await createExtensionsService({exec: commands('git:github.com/test/extension@main', [])}).loadInstalled();
		expect(items[0]?.installedVersion).toBe('2.3.4');
	});
	test('offline registry preserves current version but cannot prove up-to-date', async () => {
		manifest(join(home, '.pi/agent/npm/node_modules/@test/extension'));
		const exec: typeof execCommand = async command =>
			command === 'pi'
				? {code: 0, stdout: JSON.stringify(['npm:@test/extension']), stderr: ''}
				: {code: 1, stdout: '', stderr: 'offline fixture'};
		const items = await createExtensionsService({exec}).loadInstalled();
		expect(items[0]?.installedVersion).toBe('1.2.3');
		expect(items[0]?.version).toBe('');
		expect(piExtensionUpdateStatus(items[0]!)).toBe('unknown');
	});
	test('download statistics still enrich local metadata', async () => {
		manifest(join(home, '.pi/agent/npm/node_modules/@test/extension'));
		const urls: string[] = [];
		const items = await createExtensionsService({
			exec: commands('npm:@test/extension', []),
			request: async url => {
				urls.push(url);
				return {ok: true, status: 200, json: async () => ({downloads: 41000})};
			}
		}).loadInstalled();
		expect(items[0]?.monthlyDownloads).toBe(41000);
		expect(urls).toHaveLength(1);
	});
	test('corrupt or mismatched manifests fail closed', () => {
		const dir = join(home, '.pi/agent/npm/node_modules/@test/extension');
		manifest(dir, '1.2.3', 'wrong-package');
		expect(readInstalledPiPackageManifest('npm:@test/extension')).toBeNull();
		writeFileSync(join(dir, 'package.json'), '{bad json');
		expect(readInstalledPiPackageManifest('npm:@test/extension')).toBeNull();
		expect(readInstalledPiPackageManifest('npm:../../outside')).toBeNull();
	});
});
