import {describe, expect, test} from 'bun:test';
import {mkdirSync, readFileSync, existsSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {snapshotExtensionsSection, parseExtensionsSection} from '../../src/core/config-transfer-extensions.js';
import {applyConfigTransferImport, planConfigTransferImport} from '../../src/core/config-transfer-plan.js';
import {createBundlePayload} from '../../src/core/config-transfer.js';
import {parsePiPackageSource, inspectPiPackageInstallation} from '../../src/core/pi-package-source.js';
import {createTempHome} from '../helpers/temp-home.js';
import {installPiPackage, type ExtensionCommandDeps} from '../../src/core/extensions.js';
import {OperationAbortedError} from '../../src/core/exec.js';
import {createConfigTransferService} from '../../src/services/config-transfer-service.js';
import {writeConfigBundle, CONFIG_BUNDLE_FORMAT, CONFIG_BUNDLE_VERSION} from '../../src/core/config-transfer.js';

const write = (path: string, value: unknown) => {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, JSON.stringify(value));
};
const declarations = [
	'npm:@demo/tools@1.2.3',
	{
		source: 'git:github.com/demo/tools@v1',
		autoload: false,
		extensions: ['+src/main.ts', '!src/old.ts'],
		skills: [],
		prompts: ['prompts/*.md'],
		themes: []
	}
];
const payloadOf = (packages: unknown, files = false) => {
	const created = createBundlePayload({
		version: 'test',
		platform: 'test',
		containsCredentials: false,
		sections: [
			{
				tool: 'pi',
				category: 'extensions',
				data: {
					entries: files
						? [
								{
									root: 'pi-agent',
									kind: 'file',
									path: 'test.ts',
									contentBase64: Buffer.from('new').toString('base64'),
									mode: 0o644
								}
							]
						: [],
					...(packages === undefined ? {} : {packages})
				}
			}
		]
	});
	if (!created.ok) throw new Error(created.error);
	return created.data;
};
function fake(installed: Set<string>, calls: string[], fail?: string, controller?: AbortController): ExtensionCommandDeps {
	return {
		piInstalled: async () => true,
		packageInstalled: source => installed.has(source),
		exec: async (_cmd, args, options) => {
			if (args[0] === 'install') {
				calls.push(args[1]!);
				expect(options?.timeout).toBe(120000);
				expect(options?.env?.PI_CODING_AGENT_DIR).toContain('.pi');
				if (args[1] === fail) {
					if (controller) controller.abort();
					return {code: 1, stdout: '', stderr: 'SECRET-NETWORK'};
				}
				installed.add(args[1]!);
			}
			return {code: 0, stdout: JSON.stringify([...installed]), stderr: ''};
		}
	};
}

describe('Pi package transfer isolated', () => {
	test('snapshot retains string/object filters and excludes local sources without values', () => {
		const h = createTempHome('ccq-pkg-snapshot-');
		try {
			write(join(h.path, '.pi/agent/settings.json'), {
				packages: [...declarations, '/PRIVATE/path', './PRIVATE/path', 'file:/PRIVATE/path']
			});
			const r = snapshotExtensionsSection();
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.data.packages).toEqual(declarations);
			expect(r.warnings.length).toBeGreaterThanOrEqual(3);
			expect(JSON.stringify(r)).not.toContain('PRIVATE');
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	for (const source of [
		'--local',
		'npm:--prefix',
		'npm:a@file:/tmp/a',
		'npm:a\0',
		'npm:a\n',
		'git:https://user:secret@host.com/org/repo',
		'https://host.com/org/repo?token=secret',
		'git:host.com/org/../repo',
		'git:host.com/org/repo@--upload-pack',
		'git:host.com/org/repo%00',
		'ftp://host.com/org/repo',
		'npm:a%TOKEN%',
		'npm:a&whoami'
	]) {
		test(`reject unsafe source ${JSON.stringify(source)}`, () => {
			expect(parsePiPackageSource(source).ok).toBe(false);
			expect(parseExtensionsSection({entries: [], packages: [source]}).ok).toBe(false);
		});
	}
	test('duplicate identity with conflicting ref/filter rejected; exact duplicate deduped', () => {
		expect(parseExtensionsSection({entries: [], packages: ['npm:a@1', 'npm:a@2']}).ok).toBe(false);
		const r = parseExtensionsSection({entries: [], packages: [declarations[0], declarations[0]]});
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.data.packages).toEqual([declarations[0]!]);
	});
	test('read-only install proof requires npm version/Git ref, not declaration alone', () => {
		const h = createTempHome('ccq-pkg-fact-');
		try {
			write(join(h.path, '.pi/agent/settings.json'), {packages: ['npm:a@1.2.3']});
			expect(inspectPiPackageInstallation('npm:a@1.2.3')).toBe(false);
			write(join(h.path, '.pi/agent/npm/node_modules/a/package.json'), {name: 'a', version: '1.2.3'});
			expect(inspectPiPackageInstallation('npm:a@1.2.3')).toBe(true);
			expect(inspectPiPackageInstallation('npm:a@2.0.0')).toBe(false);
			const git = join(h.path, '.pi/agent/git/github.com/demo/tools/.git');
			mkdirSync(join(git, 'refs/tags'), {recursive: true});
			writeFileSync(join(git, 'HEAD'), '1111111111111111111111111111111111111111\n');
			writeFileSync(join(git, 'refs/tags/v1'), '1111111111111111111111111111111111111111\n');
			expect(inspectPiPackageInstallation('git:github.com/demo/tools@v1')).toBe(true);
			expect(inspectPiPackageInstallation('git:github.com/demo/tools@v2')).toBe(false);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('preview zero spawn/write; confirmation installs npm/Git and merges filters/files/unknown/local', async () => {
		const h = createTempHome('ccq-pkg-roundtrip-');
		try {
			const path = join(h.path, '.pi/agent/settings.json');
			const local = {packages: ['./local', 'npm:outside'], unknown: {keep: true}};
			write(path, local);
			const before = readFileSync(path, 'utf8');
			const installed = new Set<string>();
			const calls: string[] = [];
			const deps = fake(installed, calls);
			const p = payloadOf(declarations, true);
			const plan = await planConfigTransferImport(p, {piPackages: deps});
			expect(plan.ok).toBe(true);
			if (!plan.ok) return;
			expect(calls).toEqual([]);
			expect(readFileSync(path, 'utf8')).toBe(before);
			expect(existsSync(join(h.path, '.pi/agent/extensions/test.ts'))).toBe(false);
			expect(JSON.stringify(plan)).toContain('第三方');
			expect(JSON.stringify(plan)).toContain('npm:@demo/tools@1.2.3');
			const r = await applyConfigTransferImport(p, plan.data, [], {piPackages: deps});
			expect(r.ok).toBe(true);
			if (!r.ok) return;
			expect(r.data.status).toBe('complete');
			expect(calls).toEqual(declarations.map(x => (typeof x === 'string' ? x : x!.source)));
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({...local, packages: [...local.packages, ...declarations]});
			expect(readFileSync(join(h.path, '.pi/agent/extensions/test.ts'), 'utf8')).toBe('new');
			const next = await planConfigTransferImport(p, {piPackages: deps});
			if (!next.ok) throw Error(next.error);
			await applyConfigTransferImport(p, next.data, [], {piPackages: deps});
			expect(calls).toHaveLength(2);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('legacy package missing packages and skipped Extensions perform no installs or clearing', async () => {
		const h = createTempHome('ccq-pkg-legacy-');
		try {
			const path = join(h.path, '.pi/agent/settings.json');
			write(path, {packages: ['./local']});
			const calls: string[] = [];
			const deps = fake(new Set(), calls);
			for (const pkgs of [undefined, declarations]) {
				const p = payloadOf(pkgs);
				const plan = await planConfigTransferImport(p, {piPackages: deps});
				if (!plan.ok) throw Error(plan.error);
				await applyConfigTransferImport(p, plan.data, pkgs ? [{tool: 'pi', category: 'extensions', action: 'skip'}] : [], {
					piPackages: deps
				});
			}
			expect(calls).toEqual([]);
			expect(JSON.parse(readFileSync(path, 'utf8')).packages).toEqual(['./local']);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	for (const cancel of [false, true])
		test(`failure/cancel reports external partial and restores only files ${cancel}`, async () => {
			const h = createTempHome('ccq-pkg-partial-');
			try {
				const path = join(h.path, '.pi/agent/settings.json');
				write(path, {packages: ['npm:existing', './local'], unknown: true});
				const before = readFileSync(path, 'utf8');
				const calls: string[] = [];
				const controller = new AbortController();
				const deps = fake(new Set(['npm:existing']), calls, 'npm:b', cancel ? controller : undefined);
				const p = payloadOf(['npm:a', 'npm:b', 'npm:c'], true);
				const plan = await planConfigTransferImport(p, {piPackages: deps});
				if (!plan.ok) throw Error(plan.error);
				const r = await applyConfigTransferImport(p, plan.data, [], {piPackages: deps, signal: controller.signal});
				expect(r.ok).toBe(true);
				if (!r.ok) return;
				expect(r.data.status).toBe('partial');
				expect(r.data.packages?.completed).toEqual(['npm:a']);
				expect(r.data.packages?.failed.map(x => x.source)).toEqual(['npm:b']);
				expect(r.data.packages?.notExecuted).toEqual(['npm:c']);
				expect(r.data.failed[0]?.restored).toBe(true);
				expect(readFileSync(path, 'utf8')).toBe(before);
				expect(calls).toEqual(['npm:a', 'npm:b']);
				expect(JSON.stringify(r)).not.toContain('SECRET-NETWORK');
				expect(JSON.stringify(r)).toContain('副作用');
			} finally {
				h.restore();
				h.cleanup();
			}
		});
	test('non-zero install preserves verified landing facts while stopping and restoring files', async () => {
		const h = createTempHome('ccq-pkg-nonzero-landed-');
		try {
			const path = join(h.path, '.pi/agent/settings.json');
			write(path, {packages: ['./local'], unknown: true});
			const before = readFileSync(path, 'utf8');
			const installed = new Set<string>();
			const calls: string[] = [];
			const deps: ExtensionCommandDeps = {
				piInstalled: async () => true,
				packageInstalled: source => installed.has(source),
				exec: async (_command, args) => {
					const source = args[1];
					if (!source) throw new Error('Missing install source');
					calls.push(source);
					installed.add(source);
					write(path, {packages: [source]});
					return {code: 1, stdout: '', stderr: 'SECRET-INSTALL-FAILURE'};
				}
			};
			const payload = payloadOf(['npm:a@1.2.3', 'npm:later']);
			const plan = await planConfigTransferImport(payload, {piPackages: deps});
			if (!plan.ok) throw Error(plan.error);
			const result = await applyConfigTransferImport(payload, plan.data, [], {piPackages: deps});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.status).toBe('partial');
			expect(result.data.packages?.completed).toEqual(['npm:a@1.2.3']);
			expect(result.data.packages?.failed[0]?.kind).toBe('install');
			expect(result.data.packages?.notExecuted).toEqual(['npm:later']);
			expect(result.data.packages?.externalSideEffects).toBe(true);
			expect(result.data.failed[0]?.restored).toBe(true);
			expect(readFileSync(path, 'utf8')).toBe(before);
			expect(calls).toEqual(['npm:a@1.2.3']);
			expect(JSON.stringify(result)).not.toContain('SECRET-INSTALL-FAILURE');
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('cancel reaches executor and postflight; verified landing fact survives abort', async () => {
		const h = createTempHome('ccq-pkg-abort-');
		try {
			const installed = new Set<string>();
			const controller = new AbortController();
			let sawSignal = false;
			const deps: ExtensionCommandDeps = {
				piInstalled: async () => true,
				packageInstalled: s => installed.has(s),
				exec: async (_cmd, args, options) => {
					expect(options?.signal).toBe(controller.signal);
					sawSignal = true;
					if (args[0] === 'install') {
						installed.add(args[1]!);
						return {code: 0, stdout: '', stderr: ''};
					}
					controller.abort();
					throw new OperationAbortedError();
				}
			};
			const p = payloadOf(['git:github.com/demo/tools@v1', 'npm:later']);
			const plan = await planConfigTransferImport(p, {piPackages: deps});
			if (!plan.ok) throw Error(plan.error);
			const r = await applyConfigTransferImport(p, plan.data, [], {piPackages: deps, signal: controller.signal});
			expect(sawSignal).toBe(true);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.data.cancelled).toBe(true);
				expect(r.data.status).toBe('partial');
				expect(r.data.packages?.completed).toEqual(['git:github.com/demo/tools@v1']);
				expect(r.data.packages?.failed[0]?.kind).toBe('cancelled');
				expect(r.data.packages?.notExecuted).toEqual(['npm:later']);
			}
			let began = false;
			const abort = new AbortController();
			const pending = installPiPackage('npm:a', {
				piInstalled: async () => true,
				signal: abort.signal,
				exec: async (_c, _a, o) =>
					new Promise((_resolve, reject) => {
						began = true;
						o?.signal?.addEventListener('abort', () => reject(new OperationAbortedError()), {once: true});
					})
			});
			await Promise.resolve();
			expect(began).toBe(true);
			abort.abort();
			expect((await pending).ok).toBe(false);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('successful packages plus file failure restore native settings side effects, preserve preexisting storage', async () => {
		const h = createTempHome('ccq-pkg-file-fail-');
		try {
			const path = join(h.path, '.pi/agent/settings.json');
			const original = {
				packages: [{source: 'npm:a', custom: 'keep', themes: ['old']}, './local', 'npm:outside'],
				other: {keep: true}
			};
			write(path, original);
			const before = readFileSync(path, 'utf8');
			const installed = new Set<string>(['npm:a', 'npm:outside']);
			const calls: string[] = [];
			const deps = fake(installed, calls);
			const exec = deps.exec!;
			const combined = {
				...deps,
				exec: async (cmd: string, args: readonly string[], options?: Parameters<typeof exec>[2]) => {
					const r = await exec(cmd, args, options);
					if (args[0] === 'install') {
						write(path, {
							...original,
							packages: [{source: args[1], custom: 'keep', themes: ['old']}, './local', 'npm:outside']
						});
						mkdirSync(join(h.path, '.pi/agent/extensions/test.ts'), {recursive: true});
					}
					return r;
				}
			};
			const p = payloadOf([{source: 'npm:a', themes: []}], true);
			const plan = await planConfigTransferImport(p, {piPackages: combined});
			if (!plan.ok) throw Error(plan.error);
			const r = await applyConfigTransferImport(p, plan.data, [], {piPackages: combined});
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.data.status).toBe('partial');
				expect(r.data.packages?.completed).toEqual(['npm:a']);
				expect(r.data.failed[0]?.restored).toBe(true);
			}
			expect(readFileSync(path, 'utf8')).toBe(before);
			expect(installed.has('npm:outside')).toBe(true);
			expect(calls).toEqual(['npm:a']);
			expect(existsSync(join(h.path, '.pi/agent/extensions/test.ts'))).toBe(false);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('object unknown local fields preserved and semantic key order is unchanged', async () => {
		const h = createTempHome('ccq-pkg-unknown-');
		try {
			const path = join(h.path, '.pi/agent/settings.json');
			write(path, {packages: [{themes: [], source: 'npm:a', custom: 'keep'}, './local']});
			const calls: string[] = [];
			const deps = fake(new Set(['npm:a']), calls);
			const p = payloadOf([{source: 'npm:a', themes: []}]);
			const plan = await planConfigTransferImport(p, {piPackages: deps});
			if (!plan.ok) throw Error(plan.error);
			expect(plan.data.items[0]?.status).toBe('unchanged');
			await applyConfigTransferImport(p, plan.data, [], {piPackages: deps});
			expect(calls).toEqual([]);
			expect(JSON.parse(readFileSync(path, 'utf8')).packages[0].custom).toBe('keep');
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('Settings-only service confirm does not install packages and package service uses injected owner', async () => {
		const h = createTempHome('ccq-pkg-service-');
		try {
			const calls: string[] = [];
			const deps = fake(new Set(), calls);
			const service = createConfigTransferService({importOptions: {piPackages: deps}});
			const bundle = join(h.path, 'bundle.ccq-backup');
			for (const p of [
				payloadOf(declarations),
				{
					...payloadOf(undefined),
					sections: [
						{tool: 'pi' as const, category: 'settings', data: {text: JSON.stringify({theme: 'dark', packages: declarations})}}
					]
				}
			]) {
				expect(
					writeConfigBundle(bundle, {format: CONFIG_BUNDLE_FORMAT, version: CONFIG_BUNDLE_VERSION, encryption: null, payload: p})
						.ok
				).toBe(true);
				const loaded = await service.loadImport({bundlePath: bundle, password: ''});
				expect(loaded.ok).toBe(true);
				const before = calls.length;
				const r = await service.applyImport([]);
				expect(r.ok).toBe(true);
				if (p.sections[0]?.category === 'settings') expect(calls).toHaveLength(before);
			}
			expect(calls).toHaveLength(2);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('missing CLI does not claim preexisting storage as completed installation', async () => {
		const h = createTempHome('ccq-pkg-cli-preexisting-');
		try {
			write(join(h.path, '.pi/agent/settings.json'), {packages: [{source: 'npm:a', themes: ['old']}]});
			const deps: ExtensionCommandDeps = {
				piInstalled: async () => false,
				packageInstalled: () => true,
				exec: async () => {
					throw new Error('Must not spawn');
				}
			};
			const payload = payloadOf([{source: 'npm:a', themes: []}]);
			const plan = await planConfigTransferImport(payload, {piPackages: deps});
			if (!plan.ok) throw Error(plan.error);
			const result = await applyConfigTransferImport(payload, plan.data, [], {piPackages: deps});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.data.status).toBe('failed');
			expect(result.data.packages?.completed).toEqual([]);
			expect(result.data.packages?.externalSideEffects).toBe(false);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('failed install cannot count unchanged preexisting storage as newly completed', async () => {
		const h = createTempHome('ccq-pkg-old-storage-failure-');
		try {
			const path = join(h.path, '.pi/agent/settings.json');
			write(path, {packages: [{source: 'npm:a', themes: ['old']}]});
			const before = readFileSync(path, 'utf8');
			const deps: ExtensionCommandDeps = {
				piInstalled: async () => true,
				packageInstalled: () => true,
				exec: async () => ({code: 1, stdout: '', stderr: 'SECRET-FAILURE'})
			};
			const payload = payloadOf([{source: 'npm:a', themes: []}, 'npm:later']);
			const plan = await planConfigTransferImport(payload, {piPackages: deps});
			if (!plan.ok) throw Error(plan.error);
			const result = await applyConfigTransferImport(payload, plan.data, [], {piPackages: deps});
			if (!result.ok) throw Error(result.error);
			expect(result.data.status).toBe('failed');
			expect(result.data.packages?.completed).toEqual([]);
			expect(result.data.packages?.failed[0]?.source).toBe('npm:a');
			expect(result.data.packages?.notExecuted).toEqual(['npm:later']);
			expect(result.data.packages?.externalSideEffects).toBe(true);
			expect(result.data.failed[0]?.restored).toBe(true);
			expect(readFileSync(path, 'utf8')).toBe(before);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('malformed npm manifest version is not installation proof', () => {
		const h = createTempHome('ccq-pkg-invalid-version-');
		try {
			const path = join(h.path, '.pi/agent/npm/node_modules/a/package.json');
			for (const version of ['1.2.3oops', '1.2.3.4', '01.2.3', '1.2.3-01']) {
				write(path, {name: 'a', version});
				expect(inspectPiPackageInstallation('npm:a')).toBe(false);
				expect(inspectPiPackageInstallation('npm:a@latest')).toBe(false);
			}
			write(path, {name: 'a', version: '1.2.3-beta.1+build'});
			expect(inspectPiPackageInstallation('npm:a@1.2.3-beta.1')).toBe(true);
		} finally {
			h.restore();
			h.cleanup();
		}
	});
	test('missing CLI and successful exit with absent storage do not claim installed', async () => {
		const h = createTempHome('ccq-pkg-failure-');
		try {
			for (const cli of [false, true]) {
				let installs = 0;
				const deps: ExtensionCommandDeps = {
					piInstalled: async () => cli,
					packageInstalled: () => false,
					exec: async () => {
						installs++;
						return {code: 0, stdout: 'npm:a', stderr: ''};
					}
				};
				const p = payloadOf(['npm:a']);
				const plan = await planConfigTransferImport(p, {piPackages: deps});
				if (!plan.ok) throw Error(plan.error);
				const r = await applyConfigTransferImport(p, plan.data, [], {piPackages: deps});
				expect(r.ok).toBe(true);
				if (r.ok) {
					expect(r.data.status).not.toBe('complete');
					expect(r.data.packages?.completed).toEqual([]);
				}
				expect(installs).toBe(cli ? 1 : 0);
			}
		} finally {
			h.restore();
			h.cleanup();
		}
	});
});
