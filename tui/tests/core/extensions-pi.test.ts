import {describe, expect, test} from 'bun:test';
import type {execCommand} from '../../src/core/exec.js';
import type {PiExtensionManifest} from '../../src/core/extensions.js';
import {
	fixedPiMcpAdapterPackage,
	installPiMcpAdapter,
	installPiPackage,
	listPiPackages,
	packageFromManifest,
	piResourceLabel,
	removePiPackage,
	resourceTypesFromPiManifest,
	searchPiPackageCatalog,
	searchPiPackageCatalogPage,
	updatePiPackage
} from '../../src/core/extensions.js';
import {createExtensionsService} from '../../src/services/extensions-service.js';

// P5d 迁移自 scripts/verify-extensions-pi.mjs（45 条静态断言，整体迁移，脚本删除）。
// 判据：全部经注入的 exec / request 缝复现，无真实子进程、无 fs、无渲染。
// 原脚本的单 PASS 段按逻辑块拆为 6 个 describe。

type ExecResult = {readonly code: number; readonly stdout: string; readonly stderr: string};
type ExecFn = typeof execCommand;
const execOf = (fn: (command: string, args: readonly string[]) => Promise<ExecResult>): ExecFn => fn as unknown as ExecFn;

const manifest: PiExtensionManifest = {
	name: '@scope/demo',
	version: '1.2.3',
	description: 'demo package',
	author: {name: 'Earendil Works'},
	repository: {url: 'https://github.com/earendil-works/demo'},
	pi: {extensions: ['./index.ts'], skills: ['./skills'], prompts: ['./prompts']}
};

describe('Pi Extensions 清单投影', () => {
	test('packageFromManifest / piResourceLabel / resourceTypesFromPiManifest', () => {
		const packageInfo = packageFromManifest(manifest, {catalogListed: true});
		expect(packageInfo).toBeTruthy();
		expect(packageInfo!.resourceTypes).toEqual(['extension', 'skill', 'prompt']);
		expect(packageInfo!.type).toBe('extension');
		expect(packageInfo!.version).toBe('1.2.3');
		expect(packageInfo!.piMaintained).toBe(true);
		expect(packageInfo!.installCommand).toBe('pi install npm:@scope/demo');
		expect(piResourceLabel(packageInfo!.resourceTypes)).toBe('extension、skill、prompt');
		expect(resourceTypesFromPiManifest({name: 'skills-only', pi: {skills: ['x']}})).toEqual(['skill']);
		expect(packageFromManifest({name: 'not-a-pi-package', pi: {}})).toBeNull();
	});

	test('fixedPiMcpAdapterPackage 固定 adapter 身份', () => {
		const adapter = fixedPiMcpAdapterPackage(true);
		expect(adapter.name).toBe('pi-mcp-adapter');
		expect(adapter.installed).toBe(true);
		expect(adapter.installCommand).toBe('pi install npm:pi-mcp-adapter');
	});
});

describe('listPiPackages 目录解析', () => {
	test('JSON 与 human 列表格式均解析，空列表返回空数组', async () => {
		const list = await listPiPackages(
			execOf(async () => ({
				code: 0,
				stdout: JSON.stringify({packages: [{name: 'npm:@scope/demo'}, {source: 'npm:pi-mcp-adapter@latest'}]}),
				stderr: ''
			}))
		);
		expect(list).toEqual(['@scope/demo', 'pi-mcp-adapter']);

		const humanList = await listPiPackages(
			execOf(async (_command, args) => {
				expect(args).toEqual(['list', '--no-approve']);
				return {
					code: 0,
					stdout: 'User packages:\n  npm:@scope/demo@1.2.3\n    C:\\Users\\test\\.pi\\agent\\npm\\node_modules\\demo\nProject packages:\n  npm:local-only@1.0.0\n',
					stderr: ''
				};
			})
		);
		expect(humanList).toEqual(['@scope/demo@1.2.3', 'local-only@1.0.0']);

		const emptyList = await listPiPackages(execOf(async () => ({code: 0, stdout: 'No packages installed.\n', stderr: ''})));
		expect(emptyList).toEqual([]);
	});
});

describe('createExtensionsService 已安装投影', () => {
	test('已安装 npm 扩展补齐官方月下载量', async () => {
		const installedService = createExtensionsService({
			exec: execOf(async (command, args) => {
				if (command === 'pi') return {code: 0, stdout: 'User packages:\n  npm:@scope/demo@1.2.3\n', stderr: ''};
				expect(args).toEqual(['view', '@scope/demo@latest', '--json']);
				return {code: 0, stdout: JSON.stringify(manifest), stderr: ''};
			}),
			request: async url => {
				expect(url).toMatch(/api\.npmjs\.org\/downloads\/point\/last-month\/%40scope%2Fdemo/);
				return {ok: true, status: 200, json: async () => ({downloads: 123456})};
			}
		});
		const installedProjection = await installedService.loadInstalled();
		expect(installedProjection[0]?.source).toBe('npm:@scope/demo@1.2.3');
		expect(installedProjection[0]?.monthlyDownloads, '已安装 npm 扩展必须补齐官方月下载量').toBe(123456);
	});

	test('manifest 暂时不可读时仍应补齐 npm 月下载量', async () => {
		const manifestFallbackService = createExtensionsService({
			exec: execOf(async (command, args) => {
				if (command === 'pi') return {code: 0, stdout: 'User packages:\n  npm:pi-mcp-adapter@2.32.1\n', stderr: ''};
				expect(args).toEqual(['view', 'pi-mcp-adapter@latest', '--json']);
				return {code: 1, stdout: '', stderr: 'simulated npm cache failure'};
			}),
			request: async url => {
				expect(url).toMatch(/api\.npmjs\.org\/downloads\/point\/last-month\/pi-mcp-adapter/);
				return {ok: true, status: 200, json: async () => ({downloads: 906832})};
			}
		});
		const manifestFallbackProjection = await manifestFallbackService.loadInstalled();
		expect(manifestFallbackProjection[0]?.name).toBe('pi-mcp-adapter');
		expect(manifestFallbackProjection[0]?.monthlyDownloads, 'manifest 暂时不可读时仍应补齐 npm 月下载量').toBe(906832);
	});
});

describe('Pi 扩展目录检索', () => {
	test('只有包含真实 pi.extensions 的 package 可安装', async () => {
		const catalogCalls: readonly string[][] = [];
		const catalog = await searchPiPackageCatalog(
			'mcp',
			execOf(async (_command, args) => {
				(catalogCalls as string[][]).push([...args]);
				if (args[0] === 'search') {
					return {
						code: 0,
						stdout: JSON.stringify([
							{name: '@scope/demo', keywords: ['pi-package'], description: 'search hit'},
							{name: 'no-extension', keywords: ['pi-package']},
							{name: 'not-listed', keywords: ['other']}
						]),
						stderr: ''
					};
				}
				if (args[1] === '@scope/demo@latest') return {code: 0, stdout: JSON.stringify(manifest), stderr: ''};
				return {code: 0, stdout: JSON.stringify({name: 'no-extension', pi: {skills: ['./skills']}}), stderr: ''};
			})
		);
		expect(catalog.length, '只有包含真实 pi.extensions 的 package 可安装').toBe(1);
		expect(catalog[0]!.name).toBe('@scope/demo');
		expect(catalogCalls[0]!.slice(-2)).toEqual(['mcp', 'keywords:pi-package']);
	});

	test('registry 分页 from/size 与页字段', async () => {
		const registryCalls: string[] = [];
		const pagedCatalog = await searchPiPackageCatalogPage('tools', 2, {
			exec: execOf(async (command, args) => {
				expect(command).toBe('npm');
				expect(args).toEqual(['view', '@scope/page-demo@latest', '--json']);
				return {code: 0, stdout: JSON.stringify({...manifest, name: '@scope/page-demo'}), stderr: ''};
			}),
			request: async url => {
				registryCalls.push(url);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						objects: [{package: {name: '@scope/page-demo', keywords: ['pi-package'], version: '1.0.0'}}],
						total: 61
					})
				};
			}
		});
		const registryUrl = new URL(registryCalls[0]!);
		expect(registryUrl.searchParams.get('from')).toBe('40');
		expect(registryUrl.searchParams.get('size')).toBe('20');
		expect(pagedCatalog.page).toBe(2);
		expect(pagedCatalog.total).toBe(61);
		expect(pagedCatalog.hasPrevious).toBe(true);
		expect(pagedCatalog.hasNext).toBe(true);
		expect(pagedCatalog.items[0]?.name).toBe('@scope/page-demo');
	});
});

describe('Pi 包生命周期（install / update / remove / adapter）', () => {
	const lifecycleExec = (calls: {command: string; args: string[]}[]): ExecFn =>
		execOf(async (command, args) => {
			calls.push({command, args: [...args]});
			if (command === 'pi' && args[0] === 'list') {
				return {code: 0, stdout: 'User packages:\n  npm:@scope/demo@1.2.3\n', stderr: ''};
			}
			return {code: 0, stdout: 'ok', stderr: ''};
		});

	test('install 走官方 install 并回读列表；未装 Pi CLI 时 guard', async () => {
		const lifecycleCalls: {command: string; args: string[]}[] = [];
		const installed = await installPiPackage('@scope/demo', {
			exec: lifecycleExec(lifecycleCalls),
			piInstalled: async () => true
		});
		expect(installed.ok).toBe(true);
		expect(lifecycleCalls.map(call => call.args)).toEqual([
			['install', 'npm:@scope/demo'],
			['list', '--no-approve']
		]);

		const guarded = await installPiPackage('@scope/demo', {
			exec: lifecycleExec([]),
			piInstalled: async () => false
		});
		expect(guarded.ok).toBe(false);
		expect(guarded.ok === false && guarded.error).toMatch(/先安装 Pi Agent CLI/);
	});

	test('update 走官方 update --extension', async () => {
		const updateCalls: {command: string; args: string[]}[] = [];
		await updatePiPackage('npm:pi-mcp-adapter', {
			piInstalled: async () => true,
			exec: execOf(async (command, args) => {
				updateCalls.push({command, args: [...args]});
				if (args[0] === 'list') return {code: 0, stdout: JSON.stringify(['pi-mcp-adapter']), stderr: ''};
				return {code: 0, stdout: 'ok', stderr: ''};
			})
		});
		expect(updateCalls[0]!.args).toEqual(['update', '--extension', 'npm:pi-mcp-adapter']);
	});

	test('remove 保留完整 package source 并用同一 source 对账', async () => {
		const removeCalls: {command: string; args: string[]}[] = [];
		await removePiPackage('npm:pi-subagents', {
			piInstalled: async () => true,
			exec: execOf(async (command, args) => {
				removeCalls.push({command, args: [...args]});
				if (args[0] === 'remove') {
					expect(args, 'Pi 卸载必须保留完整 package source').toEqual(['remove', 'npm:pi-subagents']);
					return {code: 0, stdout: 'ok', stderr: ''};
				}
				if (args[0] === 'list') return {code: 0, stdout: 'No packages installed.\n', stderr: ''};
				return {code: 0, stdout: '', stderr: ''};
			})
		});
		expect(
			removeCalls.map(call => call.args),
			'Pi 卸载成功后必须用同一 source 做状态对账'
		).toEqual([
			['remove', 'npm:pi-subagents'],
			['list', '--no-approve']
		]);
	});

	test('installPiMcpAdapter 安装固定 adapter', async () => {
		const adapterCalls: {command: string; args: string[]}[] = [];
		const adapterResult = await installPiMcpAdapter({
			piInstalled: async () => true,
			exec: execOf(async (command, args) => {
				adapterCalls.push({command, args: [...args]});
				if (args[0] === 'list') return {code: 0, stdout: JSON.stringify(['pi-mcp-adapter']), stderr: ''};
				return {code: 0, stdout: 'ok', stderr: ''};
			})
		});
		expect(adapterResult.ok).toBe(true);
		expect(adapterCalls[0]!.args).toEqual(['install', 'npm:pi-mcp-adapter']);
	});
});
