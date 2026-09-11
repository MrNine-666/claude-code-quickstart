import assert from 'node:assert/strict';
import {createExtensionsService} from '../src/services/extensions-service.ts';
import {
	fixedPiMcpAdapterPackage,
	installPiMcpAdapter,
	installPiPackage,
	listPiPackages,
	updatePiPackage,
	packageFromManifest,
	piResourceLabel,
	resourceTypesFromPiManifest,
	searchPiPackageCatalogPage,
	searchPiPackageCatalog
} from '../src/core/extensions.ts';

const manifest = {
	name: '@scope/demo',
	version: '1.2.3',
	description: 'demo package',
	author: {name: 'Earendil Works'},
	repository: {url: 'https://github.com/earendil-works/demo'},
	pi: {extensions: ['./index.ts'], skills: ['./skills'], prompts: ['./prompts']}
};
const packageInfo = packageFromManifest(manifest, {catalogListed: true});
assert.ok(packageInfo);
assert.deepEqual(packageInfo.resourceTypes, ['extension', 'skill', 'prompt']);
assert.equal(packageInfo.type, 'extension');
assert.equal(packageInfo.version, '1.2.3');
assert.equal(packageInfo.piMaintained, true);
assert.equal(packageInfo.installCommand, 'pi install npm:@scope/demo');
assert.equal(piResourceLabel(packageInfo.resourceTypes), 'extension、skill、prompt');
assert.deepEqual(resourceTypesFromPiManifest({name: 'skills-only', pi: {skills: ['x']}}), ['skill']);
assert.equal(packageFromManifest({name: 'not-a-pi-package', pi: {}}), null);

const adapter = fixedPiMcpAdapterPackage(true);
assert.equal(adapter.name, 'pi-mcp-adapter');
assert.equal(adapter.installed, true);
assert.equal(adapter.installCommand, 'pi install npm:pi-mcp-adapter');

const list = await listPiPackages(async () => ({
	code: 0,
	stdout: JSON.stringify({packages: [{name: 'npm:@scope/demo'}, {source: 'npm:pi-mcp-adapter@latest'}]}),
	stderr: ''
}));
assert.deepEqual(list, ['@scope/demo', 'pi-mcp-adapter']);

const humanList = await listPiPackages(async (_command, args) => {
	assert.deepEqual(args, ['list', '--no-approve']);
	return {
		code: 0,
		stdout: 'User packages:\n  npm:@scope/demo@1.2.3\n    C:\\Users\\test\\.pi\\agent\\npm\\node_modules\\demo\nProject packages:\n  npm:local-only@1.0.0\n',
		stderr: ''
	};
});
assert.deepEqual(humanList, ['@scope/demo@1.2.3', 'local-only@1.0.0']);

const emptyList = await listPiPackages(async () => ({code: 0, stdout: 'No packages installed.\n', stderr: ''}));
assert.deepEqual(emptyList, []);

const installedService = createExtensionsService({
	exec: async (command, args) => {
		if (command === 'pi') return {code: 0, stdout: 'User packages:\n  npm:@scope/demo@1.2.3\n', stderr: ''};
		assert.deepEqual(args, ['view', '@scope/demo@latest', '--json']);
		return {code: 0, stdout: JSON.stringify(manifest), stderr: ''};
	},
	request: async url => {
		assert.match(url, /api\.npmjs\.org\/downloads\/point\/last-month\/%40scope%2Fdemo/);
		return {ok: true, status: 200, json: async () => ({downloads: 123456})};
	}
});
const installedProjection = await installedService.loadInstalled();
assert.equal(installedProjection[0]?.source, 'npm:@scope/demo@1.2.3');
assert.equal(installedProjection[0]?.monthlyDownloads, 123456, '已安装 npm 扩展必须补齐官方月下载量');

const manifestFallbackService = createExtensionsService({
	exec: async (command, args) => {
		if (command === 'pi') return {code: 0, stdout: 'User packages:\n  npm:pi-mcp-adapter@2.32.1\n', stderr: ''};
		assert.deepEqual(args, ['view', 'pi-mcp-adapter@latest', '--json']);
		return {code: 1, stdout: '', stderr: 'simulated npm cache failure'};
	},
	request: async url => {
		assert.match(url, /api\.npmjs\.org\/downloads\/point\/last-month\/pi-mcp-adapter/);
		return {ok: true, status: 200, json: async () => ({downloads: 906832})};
	}
});
const manifestFallbackProjection = await manifestFallbackService.loadInstalled();
assert.equal(manifestFallbackProjection[0]?.name, 'pi-mcp-adapter');
assert.equal(manifestFallbackProjection[0]?.monthlyDownloads, 906832, 'manifest 暂时不可读时仍应补齐 npm 月下载量');

const catalogCalls = [];
const catalog = await searchPiPackageCatalog('mcp', async (_command, args) => {
	catalogCalls.push(args);
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
});
assert.equal(catalog.length, 1, '只有包含真实 pi.extensions 的 package 可安装');
assert.equal(catalog[0].name, '@scope/demo');
assert.deepEqual(catalogCalls[0].slice(-2), ['mcp', 'keywords:pi-package']);

const registryCalls = [];
const pagedCatalog = await searchPiPackageCatalogPage('tools', 2, {
	exec: async (command, args) => {
		assert.equal(command, 'npm');
		assert.deepEqual(args, ['view', '@scope/page-demo@latest', '--json']);
		return {code: 0, stdout: JSON.stringify({...manifest, name: '@scope/page-demo'}), stderr: ''};
	},
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
const registryUrl = new URL(registryCalls[0]);
assert.equal(registryUrl.searchParams.get('from'), '40');
assert.equal(registryUrl.searchParams.get('size'), '20');
assert.equal(pagedCatalog.page, 2);
assert.equal(pagedCatalog.total, 61);
assert.equal(pagedCatalog.hasPrevious, true);
assert.equal(pagedCatalog.hasNext, true);
assert.equal(pagedCatalog.items[0]?.name, '@scope/page-demo');

const lifecycleCalls = [];
const lifecycleExec = async (command, args) => {
	lifecycleCalls.push({command, args: [...args]});
	if (command === 'pi' && args[0] === 'list') {
		return {code: 0, stdout: 'User packages:\n  npm:@scope/demo@1.2.3\n', stderr: ''};
	}
	return {code: 0, stdout: 'ok', stderr: ''};
};
const installed = await installPiPackage('@scope/demo', {exec: lifecycleExec, piInstalled: async () => true});
assert.equal(installed.ok, true);
assert.deepEqual(
	lifecycleCalls.map(call => call.args),
	[
		['install', 'npm:@scope/demo'],
		['list', '--no-approve']
	]
);

const guarded = await installPiPackage('@scope/demo', {exec: lifecycleExec, piInstalled: async () => false});
assert.equal(guarded.ok, false);
assert.match(guarded.error, /先安装 Pi Agent CLI/);

const updateCalls = [];
await updatePiPackage('npm:pi-mcp-adapter', {
	piInstalled: async () => true,
	exec: async (command, args) => {
		updateCalls.push({command, args: [...args]});
		if (args[0] === 'list') return {code: 0, stdout: JSON.stringify(['pi-mcp-adapter']), stderr: ''};
		return {code: 0, stdout: 'ok', stderr: ''};
	}
});
assert.deepEqual(updateCalls[0].args, ['update', '--extension', 'npm:pi-mcp-adapter']);

const adapterCalls = [];
const adapterResult = await installPiMcpAdapter({
	piInstalled: async () => true,
	exec: async (command, args) => {
		adapterCalls.push({command, args: [...args]});
		if (args[0] === 'list') return {code: 0, stdout: JSON.stringify(['pi-mcp-adapter']), stderr: ''};
		return {code: 0, stdout: 'ok', stderr: ''};
	}
});
assert.equal(adapterResult.ok, true);
assert.deepEqual(adapterCalls[0].args, ['install', 'npm:pi-mcp-adapter']);

console.log('[PASS] Pi Extensions：目录筛选、团队维护标识、固定 MCP adapter、CLI guard 与生命周期对账门禁全部通过');
