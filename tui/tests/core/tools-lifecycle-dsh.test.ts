import {describe, expect, test} from 'bun:test';
import {
	DSH_INSTALL_ARGS,
	DSH_PACKAGE_NAME,
	DSH_TOOL_ID,
	DSH_UNINSTALL_ARGS,
	installDsh,
	uninstallDsh,
	updateDsh,
	type DshLifecycleProjection
} from '../../src/core/dsh-lifecycle.js';
import {applyUpdates} from '../../src/core/update.js';

// P4b 迁移自 scripts/verify-dsh-lifecycle.mjs（47 条静态断言：operations 46 + helper guard 1）。
// 判据（R1）：这些断言经注入 exec / detect 缝复现「精确 npm argv、ownership gate、
// mutation 失败与 postflight 失败收敛」——去掉真实 fs / 真实子进程后成立。
//
// 保留在 verify-dsh-lifecycle.mjs（46 条）：
// - detectDshLifecycle 的真实 shim/manifest/PATH 矩阵（managed/version-mismatch/broken/
//   not-installed/external/path-conflict/npm-unavailable）——kind 由真实 `lstat`/`readFile` 决定；
// - `~/.dsh` snapshot allowlist 与卸载用户数据保留的真实文件字节；
// - update.ts 源码文本断言（本批不涉及源码正则分类，保持原样）。
//
// 载体说明：npm-path 的 Windows Path/PATH 纯段已合并到 `tests/core/tools-npm-path.test.ts`
// （与 verify-tools-install 共用模块，避免重复载体）。

function lifecycle(state: DshLifecycleProjection['state'], overrides: Partial<DshLifecycleProjection> = {}): DshLifecycleProjection {
	const repairRequired = state === 'broken' || state === 'version-mismatch';
	return {
		owner: DSH_TOOL_ID,
		state,
		packageName: DSH_PACKAGE_NAME,
		packageVersion: '',
		commandVersion: '',
		packagePresent: false,
		commandPresent: false,
		canInstall: state === 'not-installed',
		canUpdate: state === 'managed' || repairRequired,
		canUninstall: state === 'managed' || repairRequired,
		repairRequired,
		diagnostic: `fixture: ${state}`,
		...overrides
	};
}

function sequenceDetector(values: readonly DshLifecycleProjection[]) {
	let index = 0;
	return async (): Promise<DshLifecycleProjection> => values[Math.min(index++, values.length - 1)] as DshLifecycleProjection;
}

type ExecCall = {command: string; args: string[]};

function operationExec(prefix: string, calls: ExecCall[], mutationCode = 0) {
	return async (command: string, args: readonly string[]) => {
		calls.push({command, args: [...args]});
		if (command === 'npm' && args[0] === 'prefix' && args[1] === '-g') {
			return {code: 0, stdout: `${prefix}\n`, stderr: ''};
		}
		if (command === 'npm' && (args[0] === 'install' || args[0] === 'uninstall')) {
			return {code: mutationCode, stdout: '', stderr: mutationCode === 0 ? '' : 'fixture mutation failure'};
		}
		return {code: 0, stdout: '', stderr: ''};
	};
}

function mutationCalls(calls: readonly ExecCall[], verb: string): ExecCall[] {
	return calls.filter(call => call.command === 'npm' && call.args[0] === verb);
}

async function withFixtureProcessEnvAsync<T>(env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
	const descriptor = Object.getOwnPropertyDescriptor(process, 'env');
	expect(descriptor, 'process.env descriptor exists').toBeDefined();
	if (!descriptor) throw new Error('process.env descriptor 缺失');
	Object.defineProperty(process, 'env', {...descriptor, value: env});
	try {
		return await run();
	} finally {
		Object.defineProperty(process, 'env', descriptor);
	}
}

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

const PREFIX = '/tmp/ccq-dsh-operations';

describe('DSH 操作：Windows Path-only postflight', () => {
	test('Path 大小写保留，不引入冲突的 PATH key', async () => {
		const managed = lifecycle('managed', {
			packageVersion: '1.2.3',
			commandVersion: '1.2.3',
			packagePresent: true,
			commandPresent: true
		});
		const detections: {env?: NodeJS.ProcessEnv}[] = [];
		const result = await withFixtureProcessEnvAsync({Path: 'C:\\process-path'}, async () =>
			updateDsh(undefined, {
				platform: 'win32',
				env: {Path: 'C:\\existing'},
				exec: async (command: string, args: readonly string[]) => {
					if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: 'C:\\npm-global\n', stderr: ''};
					return {code: 0, stdout: '', stderr: ''};
				},
				detect: async deps => {
					detections.push(deps ?? {});
					return managed;
				}
			})
		);
		expect(result.success, 'Windows Path-only postflight remains operable').toBe(true);
		expect(detections.length, 'Windows update performs preflight and postflight detection').toBe(2);
		expect(detections[1]?.env, 'Windows postflight preserves Path casing while prefixing npm bin').toEqual({
			Path: 'C:\\npm-global;C:\\existing'
		});
		expect(
			Object.hasOwn(detections[1]?.env ?? {}, 'PATH'),
			'Windows Path-only postflight does not introduce a conflicting PATH key'
		).toBe(false);
	});
});

describe('DSH 操作 npm argv 与 postflight lifecycle', () => {
	test('install/update 用 DSH_INSTALL_ARGS，uninstall 用 DSH_UNINSTALL_ARGS 并返回 postflight 状态', async () => {
		await withSavedPathAsync(async () => {
			const managed = lifecycle('managed', {
				packageVersion: '1.2.3',
				commandVersion: '1.2.3',
				packagePresent: true,
				commandPresent: true
			});
			const notInstalled = lifecycle('not-installed');
			const external = lifecycle('external', {commandPresent: true});

			const installCalls: ExecCall[] = [];
			const installResult = await installDsh(undefined, {
				exec: operationExec(PREFIX, installCalls),
				detect: sequenceDetector([notInstalled, managed])
			});
			expect(installResult.success, 'not-installed 安装成功').toBe(true);
			expect(
				mutationCalls(installCalls, 'install').map(call => call.args),
				'安装使用精确 npm argv'
			).toEqual([[...DSH_INSTALL_ARGS]]);
			expect(installResult.lifecycle?.state, '安装成功返回 postflight lifecycle').toBe('managed');

			const updateCalls: ExecCall[] = [];
			const updateResult = await updateDsh(undefined, {
				exec: operationExec(PREFIX, updateCalls),
				detect: sequenceDetector([managed, managed])
			});
			expect(updateResult.success, 'managed 更新成功').toBe(true);
			expect(
				mutationCalls(updateCalls, 'install').map(call => call.args),
				'更新使用精确 npm argv'
			).toEqual([[...DSH_INSTALL_ARGS]]);
			expect(updateResult.lifecycle?.state, '更新成功返回 postflight lifecycle').toBe('managed');

			const uninstallCalls: ExecCall[] = [];
			const uninstallResult = await uninstallDsh(undefined, {
				exec: operationExec(PREFIX, uninstallCalls),
				detect: sequenceDetector([managed, external])
			});
			expect(uninstallResult.success, '包移除且外部命令仍存在时卸载成功').toBe(true);
			expect(
				mutationCalls(uninstallCalls, 'uninstall').map(call => call.args),
				'卸载使用精确 npm argv'
			).toEqual([[...DSH_UNINSTALL_ARGS]]);
			expect(uninstallResult.lifecycle?.state, '卸载返回外部 dsh postflight 状态').toBe('external');
			expect(uninstallResult.warning, '卸载后外部 dsh 以 warning 暴露').toBe(external.diagnostic);
		});
	});

	test('external ownership gate 阻止 npm 写命令', async () => {
		const external = lifecycle('external', {commandPresent: true});
		const blockedCalls: ExecCall[] = [];
		const blocked = await installDsh(undefined, {
			exec: operationExec(PREFIX, blockedCalls),
			detect: async () => external
		});
		expect(blocked.success, 'external install 被阻止').toBe(false);
		expect(mutationCalls(blockedCalls, 'install').length, 'external install 不执行 npm 写命令').toBe(0);
	});
});

describe('DSH mutation / postflight 失败收敛', () => {
	test('postflight 非 managed 必须失败并保留最终 lifecycle', async () => {
		await withSavedPathAsync(async () => {
			const notInstalled = lifecycle('not-installed');
			const failedPostflight = lifecycle('broken', {
				packageVersion: '1.2.3',
				packagePresent: true,
				commandPresent: true,
				repairRequired: true
			});
			const calls: ExecCall[] = [];
			const failed = await installDsh(undefined, {
				exec: operationExec(PREFIX, calls),
				detect: sequenceDetector([notInstalled, failedPostflight])
			});
			expect(failed.success, 'postflight 非 managed 必须失败').toBe(false);
			expect(failed.lifecycle?.state, 'postflight 失败保留最终 lifecycle').toBe('broken');
			expect(failed.error, 'postflight 失败有明确诊断').toMatch(/postflight/);
		});
	});

	test('mutation throw / 非零退出码保留诊断且 postflight 成功时收敛为 managed', async () => {
		await withSavedPathAsync(async () => {
			const managed = lifecycle('managed', {
				packageVersion: '1.2.3',
				commandVersion: '1.2.3',
				packagePresent: true,
				commandPresent: true
			});

			const thrownCalls: ExecCall[] = [];
			const thrown = await updateDsh(undefined, {
				exec: async (command: string, args: readonly string[]) => {
					thrownCalls.push({command, args: [...args]});
					if (command === 'npm' && args[0] === 'install') throw new Error('fixture mutation throw');
					if (command === 'npm' && args[0] === 'prefix') return {code: 0, stdout: `${PREFIX}\n`, stderr: ''};
					return {code: 0, stdout: '', stderr: ''};
				},
				detect: sequenceDetector([managed, managed])
			});
			expect(thrown.success, 'mutation throw 必须返回失败').toBe(false);
			expect(thrown.lifecycle?.state, 'mutation throw 后 postflight 成功时保留最终 managed lifecycle').toBe('managed');
			expect(thrown.error, 'mutation throw 诊断被保留').toMatch(/fixture mutation throw/);
			expect(mutationCalls(thrownCalls, 'install').length, 'mutation throw 仍只尝试一次 npm install').toBe(1);

			const nonzeroCalls: ExecCall[] = [];
			const nonzero = await updateDsh(undefined, {
				exec: operationExec(PREFIX, nonzeroCalls, 23),
				detect: sequenceDetector([managed, managed])
			});
			expect(nonzero.success, 'mutation 非零退出码必须返回失败').toBe(false);
			expect(nonzero.lifecycle?.state, 'mutation 非零后 postflight 成功时保留最终 managed lifecycle').toBe('managed');
			expect(nonzero.error, 'mutation 非零退出码诊断被保留').toMatch(/exit 23/);
		});
	});

	test('postflight detector 抛错 → verification-unknown，且不覆盖 mutation 诊断', async () => {
		await withSavedPathAsync(async () => {
			const managed = lifecycle('managed', {
				packageVersion: '1.2.3',
				commandVersion: '1.2.3',
				packagePresent: true,
				commandPresent: true
			});

			let detectCount = 0;
			const verificationUnknown = await updateDsh(undefined, {
				exec: operationExec(PREFIX, []),
				detect: async () => {
					detectCount += 1;
					if (detectCount === 1) return managed;
					throw new Error('fixture postflight detector failure');
				}
			});
			expect(verificationUnknown.success, 'postflight detector throw 必须返回失败').toBe(false);
			expect(verificationUnknown.state, 'postflight detector throw 使用不可验证最终状态').toBe('verification-unknown');
			expect(verificationUnknown.lifecycle?.state, 'postflight detector throw 不得复用 mutation 前 lifecycle').toBe(
				'verification-unknown'
			);
			expect(verificationUnknown.lifecycle?.canInstall, 'verification-unknown 禁止 install').toBe(false);
			expect(verificationUnknown.lifecycle?.canUpdate, 'verification-unknown 禁止 update').toBe(false);
			expect(verificationUnknown.lifecycle?.canUninstall, 'verification-unknown 禁止 uninstall').toBe(false);
			expect(verificationUnknown.error, 'postflight detector 诊断被保留').toMatch(/postflight.*fixture postflight detector failure/);

			let combinedCount = 0;
			const combined = await updateDsh(undefined, {
				exec: operationExec(PREFIX, [], 41),
				detect: async () => {
					combinedCount += 1;
					if (combinedCount === 1) return managed;
					throw new Error('fixture combined postflight failure');
				}
			});
			expect(combined.lifecycle?.state, 'mutation 与 postflight 双失败仍使用不可验证最终状态').toBe('verification-unknown');
			expect(combined.error, 'mutation 失败诊断不可被 postflight 错误覆盖').toMatch(/exit 41/);
			expect(combined.error, 'postflight 检测失败诊断不可覆盖 mutation 错误').toMatch(/fixture combined postflight failure/);
		});
	});
});

describe('DSH applyUpdates 门禁失败隔离', () => {
	test('批量 DSH 门禁失败被隔离，单项失败不创建 snapshot', async () => {
		await withSavedPathAsync(async () => {
			const external = lifecycle('external', {commandPresent: true});
			const mixedDsh = lifecycle('path-conflict', {packagePresent: true, commandPresent: true});

			const mixedCalls: ExecCall[] = [];
			let mixedSnapshotCreated = false;
			const mixedResult = await applyUpdates(
				[
					{
						id: DSH_TOOL_ID,
						name: 'DeepSeek Harness',
						type: 'npm',
						package: DSH_PACKAGE_NAME,
						installed: true,
						currentVersion: '1.2.3',
						latestVersion: '1.2.4',
						hasUpdate: true
					},
					{
						id: 'OpenSpec',
						name: 'OpenSpec CLI',
						type: 'npm',
						package: '@fission-ai/openspec',
						installed: true,
						currentVersion: '1.0.0',
						latestVersion: '1.1.0',
						hasUpdate: true
					}
				] as never,
				undefined,
				{
					exec: operationExec(PREFIX, mixedCalls),
					createSnapshotFn: () => {
						mixedSnapshotCreated = true;
						return '/tmp/ccq-dsh-mixed-snapshot';
					},
					dshDetect: async () => mixedDsh
				}
			);
			expect(mixedSnapshotCreated, '混合批次仍为其他组件创建 snapshot').toBe(true);
			expect(
				mixedResult.updatedItems.some(item => item.startsWith(`failed::${DSH_TOOL_ID}::`)),
				'批量 DSH 门禁失败被隔离'
			).toBe(true);
			expect(
				mixedResult.updatedItems.some(item => item.startsWith('updated::OpenSpec::')),
				'批量 DSH 门禁失败不阻断其他组件'
			).toBe(true);
			expect(
				mutationCalls(mixedCalls, 'install').some(call => call.args.includes(DSH_PACKAGE_NAME)),
				'批量 DSH 被阻止时不执行 npm install'
			).toBe(false);

			const singleCalls: ExecCall[] = [];
			let singleSnapshotCreated = false;
			const singleResult = await applyUpdates(
				[
					{
						id: DSH_TOOL_ID,
						name: 'DeepSeek Harness',
						type: 'npm',
						package: DSH_PACKAGE_NAME,
						installed: true,
						currentVersion: '1.2.3',
						latestVersion: '1.2.4',
						hasUpdate: true
					}
				] as never,
				undefined,
				{
					exec: operationExec(PREFIX, singleCalls),
					createSnapshotFn: () => {
						singleSnapshotCreated = true;
						return '/tmp/ccq-dsh-single-blocked-snapshot';
					},
					dshDetect: async () => external
				}
			);
			expect(singleResult.dshLifecycle?.state, '单项 DSH 门禁失败保留最终 lifecycle').toBe('external');
			expect(
				singleResult.updatedItems.some(item => item.startsWith(`failed::${DSH_TOOL_ID}::`)),
				'单项 DSH 门禁返回失败结果'
			).toBe(true);
			expect(singleSnapshotCreated, '单项 DSH 门禁失败不创建 snapshot').toBe(false);
			expect(mutationCalls(singleCalls, 'install').length, '单项 DSH 门禁失败不执行 npm install').toBe(0);
		});
	});
});

describe('DSH 预发布提示', () => {
	test('预发布版本仍允许安装并返回风险提示', async () => {
		await withSavedPathAsync(async () => {
			const notInstalled = lifecycle('not-installed');
			const prerelease = lifecycle('managed', {
				packageVersion: '2.0.0-beta.1',
				commandVersion: '2.0.0-beta.1',
				packagePresent: true,
				commandPresent: true,
				prereleaseWarning: '当前为预发布版本，可能存在 breaking changes。'
			});
			const result = await installDsh(undefined, {
				exec: operationExec(PREFIX, []),
				detect: sequenceDetector([notInstalled, prerelease])
			});
			expect(result.success, '预发布版本仍允许安装').toBe(true);
			expect(result.warning, '预发布安装返回风险提示').toMatch(/预发布版本/);
		});
	});
});
