import {describe, expect, test} from 'bun:test';
import {installMultipleTools, TOOL_DEFINITIONS} from '../../src/core/tools-install.js';
import type {ManagedComponent} from '../../src/core/tools-manage.js';
import {createInitialToolsViewState, type ToolsViewAction} from '../../src/state/tools-view-state.js';
import {runPrimaryAction} from '../../src/views/tools/tools-view-actions.js';
import type {ToolsViewServices} from '../../src/views/tools/tools-view-types.js';

// P4b 迁移自 scripts/verify-tools-view.mjs（13 条静态断言，纯进程内）。
// 判据（R1）：installMultipleTools 失败隔离、registry 完整性、Pi 上下文 Enter 安装透传、
// 安装结果 version 字段——去掉真实 fs 后全部成立。
//
// R9 去重（本批前置）：
// - codeGraphInstallCommands('cc'/'cx') 已由 P1 `tests/core/tools-lifecycle.test.ts` 覆盖，
//   保留在 verify-tools-view.mjs；
// - TOOL_DEFINITIONS（tools-install）与 COMPONENT_DEFINITIONS（tools-manage）是**两个独立导出**，
//   tools-context.test.ts 只断言后者；P4c 将 TOOL_DEFINITIONS 顺序断言迁入本文件「registry 完整性」。
// 保留在 verify 的是真实 fs 段：readMcpSnapshot / restoreMcpSnapshot 的 `.claude.json` 字节。

const idleTick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('批量安装失败隔离 (P-6)', () => {
	test('第 N 个工具失败时第 N+1 个仍执行，失败项不中断后续', async () => {
		const order = ['OpenSpec', 'CodexCli', 'Ccline'] as const;
		const calls: string[] = [];
		const installOne = async (id: (typeof order)[number]) => {
			calls.push(id);
			if (id === 'CodexCli') return {id, success: false, error: 'mock 失败'};
			return {id, success: true};
		};

		const outcomes = await installMultipleTools([...order], undefined, installOne as never);
		expect(calls.length, '失败隔离：全部工具均被调用（含失败项之后的）').toBe(order.length);
		expect(calls, '失败隔离：按顺序执行，失败项不中断后续').toEqual([...order]);
		const failed = outcomes.filter(item => !item.success);
		expect(failed.length, '仅 CodexCli 失败').toBe(1);
		expect(failed[0]?.id, '失败项为 CodexCli').toBe('CodexCli');
		const succeeded = outcomes.filter(item => item.success);
		expect(succeeded.length, '其余 2 项成功').toBe(2);
	});
});

describe('registry 完整性', () => {
	test('12 项均有检测命令与安装 kind', () => {
		for (const tool of TOOL_DEFINITIONS) {
			expect(Boolean(tool.command && tool.versionArgs.length > 0), `${tool.id} 有检测命令`).toBe(true);
			expect(Boolean(tool.kind), `${tool.id} 有安装 kind`).toBe(true);
		}
	});

	// P4c 迁移自 scripts/verify-tools-view.mjs（原「registry 完整性」段的顺序断言）。
	test('12 项 registry 顺序固定（含 Pi CLI / Pi Web）', () => {
		expect(
			TOOL_DEFINITIONS.map(tool => tool.id),
			'12 项 registry 齐备且顺序固定（含 Pi CLI / Pi Web）'
		).toEqual([
			'ClaudeCode',
			'Ccline',
			'PiCli',
			'PiWeb',
			'CcgWorkflow',
			'OpenSpec',
			'Trellis',
			'CodeGraph',
			'GitNexus',
			'CodexCli',
			'AntigravityCli',
			'DeepSeekHarness'
		]);
	});
});

describe('Pi Agent 上下文透传到 Enter 安装路径', () => {
	test('Pi Enter 安装当前 PiCli 项并透传 Pi Agent context，成功后局部 patch 卡片', async () => {
		const piDefinition = TOOL_DEFINITIONS.find(item => item.id === 'PiCli');
		expect(piDefinition, 'PiCli registry 定义存在').toBeDefined();
		if (!piDefinition) throw new Error('PiCli 定义缺失');

		const piComponent = {
			...piDefinition,
			installed: false,
			currentVersion: '',
			latestVersion: '',
			hasUpdate: null
		} as ManagedComponent;
		const installCalls: unknown[][] = [];
		const actions: ToolsViewAction[] = [];
		const services = {
			async installComponent(...args: unknown[]) {
				installCalls.push(args);
				return {id: 'PiCli', success: true, version: '0.1.0'};
			}
		} as unknown as ToolsViewServices;
		const taskCancellation = {
			start: () => new AbortController().signal,
			finish: () => {}
		};

		runPrimaryAction(
			{...createInitialToolsViewState(), components: [piComponent], loaded: true},
			services,
			action => actions.push(action),
			{refresh: () => {}} as never,
			taskCancellation as never,
			'pi'
		);
		await idleTick();

		expect(installCalls[0]?.[0], 'Pi Enter 应安装当前 PiCli 项').toBe('PiCli');
		expect(installCalls[0]?.[2], 'Pi Enter 安装必须透传 Pi Agent context').toBe('pi');
		expect(actions[0]?.type, 'Pi Enter 应进入安装中状态').toBe('item-start');
		expect(actions.at(-1)?.type, 'Pi 安装成功后应局部更新卡片').toBe('item-patched');
	});
});

describe('安装结果保留版本号用于卡片局部更新', () => {
	test('安装成功结果保留 version 字段，供 UI patch 使用', async () => {
		const outcomes = await installMultipleTools(['CodexCli'], undefined, (async (id: string) => ({
			id,
			success: true,
			version: '0.142.5'
		})) as never);
		expect(outcomes[0]?.version, '安装成功结果应保留 version 字段，供 UI patch 使用').toBe('0.142.5');
	});
});

// 保留在 verify-tools-view.mjs 的未迁移段：
// - codeGraphInstallCommands('cc'/'cx')（已由 P1 覆盖）
// - CcgWorkflow mcpServers 快照保护 / 无 mcpServers 快照为 null（真实 `.claude.json` 落盘字节）
