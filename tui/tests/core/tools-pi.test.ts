import {describe, expect, test} from 'bun:test';
import {detectTool, installTool, TOOL_DEFINITIONS} from '../../src/core/tools-install.js';
import {uninstallComponent} from '../../src/core/tools-manage.js';
import {applyUpdates, checkCliToolUpdates} from '../../src/core/update.js';
import {createInitialToolsViewState, resolveToolsPrimaryAction, updatableComponents} from '../../src/state/tools-view-state.js';

// P4b 迁移自 scripts/verify-tools-pi.mjs（23 条静态断言，纯进程内，注入 exec 缝）。
// 判据（R1）：Node preflight、Pi CLI ignore-scripts、Pi Web --help 探针、update/uninstall argv
// 对账——全部经注入 exec 复现，去掉真实 fs / 子进程后成立。
//
// 保留在 verify-tools-pi.mjs（5 条）：Pi Web 卸载不得删除 Pi 用户 settings 的**真实文件字节**；
// 以及 COMPONENT_META/TOOL_GROUP_META 的 4 条（已由 P4a/P4b tools-manage.test.ts 覆盖，不重复迁移）。

const NODE = 'node';

async function withSavedPathAsync<T>(run: () => Promise<T>): Promise<T> {
	const originalPath = process.env.PATH;
	const originalPathCase = process.env.Path;
	try {
		return await run();
	} finally {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		if (originalPathCase === undefined) delete process.env.Path;
		else process.env.Path = originalPathCase;
	}
}

const installedExec = async (command: string, args: readonly string[]) => {
	if (command === NODE) return {code: 0, stdout: 'v22.19.0\n', stderr: ''};
	if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
	if (command === 'npm' && args[0] === 'install') return {code: 0, stdout: 'installed\n', stderr: ''};
	if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.1.0\n', stderr: ''};
	if (command === 'pi-web' && args[0] === '--help') {
		return {code: 0, stdout: 'Usage: pi-web [options]\n  -H, --hostname <host> (default: 127.0.0.1)\n', stderr: ''};
	}
	if (command === 'pi-web' && args[0] === '--version') return {code: 1, stdout: '', stderr: 'Unknown option --version'};
	return {code: 1, stdout: '', stderr: 'not found'};
};

describe('Pi Web 检测探针与主操作', () => {
	test('Pi Web 用 --help 无副作用探针且不报版本，检测链路投影为可更新', async () => {
		await withSavedPathAsync(async () => {
			const piInstall = await installTool('PiCli', undefined, 'pi', {exec: installedExec});
			expect(piInstall.success).toBe(true);
			const piWebInstall = await installTool('PiWeb', undefined, 'pi', {exec: installedExec});
			expect(piWebInstall.success).toBe(true);

			const piWebDefinition = TOOL_DEFINITIONS.find(item => item.id === 'PiWeb');
			expect(piWebDefinition, 'PiWeb registry 定义存在').toBeDefined();
			if (!piWebDefinition) throw new Error('PiWeb 定义缺失');
			expect(piWebDefinition.versionArgs, 'Pi Web 使用 --help 作为无副作用检测探针').toEqual(['--help']);
			expect(piWebDefinition.reportsVersion, 'Pi Web help 输出不得被当作版本来源').toBe(false);
			const piWebDetected = await detectTool(piWebDefinition, installedExec);
			expect(piWebDetected.installed, 'Pi Web 支持 --help 时必须判定为已安装').toBe(true);
		});
	});

	test('checkCliToolUpdates 投影 installed/currentVersion/hasUpdate 并复用普通更新主操作', async () => {
		const detected = await checkCliToolUpdates({}, false, {
			exec: installedExec,
			latestByPackage: {'@agegr/pi-web': '0.9.0'}
		});
		const piWebComponent = detected.find(component => component.id === 'PiWeb');
		expect(piWebComponent?.installed, '工具管理检测链路必须把可执行的 Pi Web 显示为已安装').toBe(true);
		expect(piWebComponent?.currentVersion, 'Pi Web help 输出不得被误当作版本号').toBe('');
		expect(piWebComponent?.hasUpdate, 'Pi Web 无法比较版本时应按待更新组件投影').toBe(true);
		expect(resolveToolsPrimaryAction(piWebComponent as never), 'Pi Web Enter 应复用普通更新主操作').toBe('update');
		expect(
			updatableComponents({...createInitialToolsViewState(), components: [piWebComponent as never]}).map(component => component.id),
			'Pi Web A 更新全部应复用普通可更新组件筛选'
		).toEqual(['PiWeb']);
	});
});

describe('Pi Node preflight', () => {
	test('Node 版本不足时安装失败且不得执行 npm install', async () => {
		const lowNodeCalls: {command: string; args: string[]}[] = [];
		const lowNodeExec = async (command: string, args: readonly string[]) => {
			lowNodeCalls.push({command, args: [...args]});
			if (command === NODE) return {code: 0, stdout: 'v22.18.9\n', stderr: ''};
			return {code: 0, stdout: '', stderr: ''};
		};
		const lowNode = await installTool('PiCli', undefined, 'pi', {exec: lowNodeExec});
		expect(lowNode.success).toBe(false);
		expect(lowNode.error).toMatch(/要求 Node\.js >= 22\.19\.0/);
		expect(
			lowNodeCalls.some(call => call.command === 'npm' && call.args[0] === 'install'),
			'Node 版本不足时不得执行 npm install'
		).toBe(false);
	});
});

describe('Pi 安装 npm argv', () => {
	test('Pi CLI 安装带 --ignore-scripts，Pi Web 安装不带', async () => {
		await withSavedPathAsync(async () => {
			const cliCalls: {command: string; args: string[]}[] = [];
			const cliExec = async (command: string, args: readonly string[]) => {
				cliCalls.push({command, args: [...args]});
				return installedExec(command, args);
			};
			const cliResult = await installTool('PiCli', undefined, 'pi', {exec: cliExec});
			expect(cliResult.success).toBe(true);
			const cliInstall = cliCalls.find(call => call.command === 'npm' && call.args[0] === 'install');
			expect(cliInstall?.args).toEqual(['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent']);

			const webCalls: {command: string; args: string[]}[] = [];
			const webExec = async (command: string, args: readonly string[]) => {
				webCalls.push({command, args: [...args]});
				return installedExec(command, args);
			};
			const webResult = await installTool('PiWeb', undefined, 'pi', {exec: webExec});
			expect(webResult.success).toBe(true);
			const webInstall = webCalls.find(call => call.command === 'npm' && call.args[0] === 'install');
			expect(webInstall?.args).toEqual(['install', '-g', '@agegr/pi-web']);
		});
	});
});

describe('Pi 更新与卸载 argv 对账', () => {
	test('Pi 更新先做 Node preflight、npm 装目标版本，完成后 pi --version 对账', async () => {
		const updateCalls: {command: string; args: string[]}[] = [];
		const updateExec = async (command: string, args: readonly string[]) => {
			updateCalls.push({command, args: [...args]});
			if (command === NODE) return {code: 0, stdout: 'v22.19.0\n', stderr: ''};
			if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
			if (command === 'npm' && args[0] === 'install') return {code: 0, stdout: '', stderr: ''};
			if (command === 'pi' && args[0] === '--version') return {code: 0, stdout: '0.2.0\n', stderr: ''};
			if (command === 'pi-web' && args[0] === '--version') return {code: 0, stdout: '0.2.0\n', stderr: ''};
			return {code: 1, stdout: '', stderr: 'not found'};
		};

		await withSavedPathAsync(async () => {
			await applyUpdates(
				[
					{
						id: 'PiCli',
						name: 'Pi Agent CLI',
						type: 'npm',
						package: '@earendil-works/pi-coding-agent',
						installed: true,
						currentVersion: '0.1.0',
						latestVersion: '0.2.0',
						hasUpdate: true
					}
				],
				undefined,
				{exec: updateExec, createSnapshotFn: () => '/tmp/ccq-pi-update-snapshot'}
			);
		});

		const updateInstall = updateCalls.find(call => call.command === 'npm' && call.args[0] === 'install');
		expect(updateInstall?.args).toEqual(['install', '-g', '--ignore-scripts', '@earendil-works/pi-coding-agent@0.2.0']);
		expect(
			updateCalls.findIndex(call => call.command === NODE) < updateCalls.indexOf(updateInstall as never),
			'Pi 更新先做 Node preflight'
		).toBe(true);
		expect(
			updateCalls.some(call => call.command === 'pi' && call.args[0] === '--version'),
			'Pi 更新完成后做命令对账'
		).toBe(true);
	});

	test('Pi Web 卸载 npm uninstall -g @agegr/pi-web 并做命令对账', async () => {
		const removeCalls: {command: string; args: string[]}[] = [];
		const removeExec = async (command: string, args: readonly string[]) => {
			removeCalls.push({command, args: [...args]});
			if (command === 'npm' && args[0] === 'uninstall') return {code: 0, stdout: '', stderr: ''};
			if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: '/tmp/ccq-pi-prefix\n', stderr: ''};
			if (command === 'pi-web' && args[0] === '--help') return {code: 1, stdout: '', stderr: 'not found'};
			return {code: 1, stdout: '', stderr: 'not found'};
		};

		const removed = await withSavedPathAsync(() =>
			uninstallComponent('PiWeb', undefined, {
				exec: removeExec,
				createSnapshotFn: () => '/tmp/ccq-pi-remove-snapshot'
			})
		);
		expect(removed.success).toBe(true);
		expect(removeCalls.find(call => call.command === 'npm' && call.args[0] === 'uninstall')?.args).toEqual([
			'uninstall',
			'-g',
			'@agegr/pi-web'
		]);
	});
});
