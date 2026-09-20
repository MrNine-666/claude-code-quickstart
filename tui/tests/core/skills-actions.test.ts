import {describe, expect, test} from 'bun:test';
import {installMultipleSkills, installSkill, uninstallSkills, updateSkills} from '../../src/core/skills-actions.js';
import {getInstalledSkills, listRepoSkills, searchSkillIdentity, skillsAgentOf, type SearchSkillResult} from '../../src/core/skills.js';
import {
	installResultToTargets,
	installSearchResultsToTargets,
	planSkillInstallBatches,
	toggleClaudeInstall,
	uninstallSkillAllAgents
} from '../../src/services/skills-service.js';
import type {SkillsInstallTarget} from '../../src/state/skills-view-state.js';

// 载体迁移（P3a）：原 scripts/verify-skills-view.mjs 的 action / service 段（7.9 / 8.1-8.5 /
// 17-19.4 / 扁平跨来源批量安装，共 72 条静态断言）迁入。
// owner 模块：core/skills-actions.ts + services/skills-service.ts。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

describe('Skills action 与 service（core/skills-actions.ts + services/skills-service.ts）', () => {
	// ── 7.9 action 进度通过 callback 上报，不直接 console ─────────────────────────
	test('7.9 action 进度经 callback 上报，installMultipleSkills 单次多 --skill，空名单不 spawn', async () => {
		const originalLog = console.log;
		const originalError = console.error;
		let consoleHits = 0;
		console.log = () => {
			consoleHits++;
		};
		console.error = () => {
			consoleHits++;
		};

		try {
			const okExec = async () => ({code: 0, stdout: 'done', stderr: ''});
			const failExec = async () => ({code: 1, stdout: '', stderr: 'ETIMEDOUT'});

			// install：成功路径
			const installEvents: {level: string; message: string; instruction?: string}[] = [];
			const installRes = await installSkill({source: 'org/skill', displayName: 'skill'}, event => installEvents.push(event), okExec);
			expect(installRes.success).toBe(true);
			expect(installEvents.some(event => event.level === 'success')).toBe(true);

			// install：指定子 skill 时必须传 --skill，避免误装整个 repo
			const installArgs: string[][] = [];
			const installWithSkill = await installSkill(
				{source: 'org/repo', displayName: 'org/repo@child', skillName: 'child'},
				undefined,
				async (_cmd, args) => {
					installArgs.push([...args]);
					return {code: 0, stdout: 'done', stderr: ''};
				}
			);
			expect(installWithSkill.success).toBe(true);
			const firstInstallArgs = required(installArgs[0], 'installArgs[0]');
			expect(firstInstallArgs.includes('--skill'), '指定子 skill 安装必须带 --skill').toBe(true);
			expect(firstInstallArgs[firstInstallArgs.indexOf('--skill') + 1], '--skill 后应跟选中的子 skill 名').toBe('child');

			// installMultipleSkills：单次多 --skill 批量安装（需求③）
			const captured: string[][] = [];
			const multiExec = async (_cmd: string, args: readonly string[]) => {
				captured.push([...args]);
				return {code: 0, stdout: 'done', stderr: ''};
			};
			const multiEvents: {level: string; message: string; instruction?: string}[] = [];
			const multiRes = await installMultipleSkills(
				{source: 'org/repo', skillNames: ['a', 'b', 'c'], displayName: 'org/repo'},
				event => multiEvents.push(event),
				multiExec
			);
			expect(multiRes.success).toBe(true);
			expect(captured.length, '批量安装应单次调用').toBe(1);
			const firstCaptured = required(captured[0], 'captured[0]');
			const skillArgs = firstCaptured.filter((value, index, arr) => arr[index - 1] === '--skill');
			expect(skillArgs.length, '三个 --skill 一次传入').toBe(3);
			expect(multiEvents.find(event => event.instruction)?.instruction, 'Skills progress 必须上报实际批量安装命令').toBe(
				'npx --yes skills@latest add org/repo --yes --agent claude-code -g --skill a --skill b --skill c'
			);
			expect(multiEvents.some(event => event.level === 'success')).toBe(true);
			// 空名单直接失败不 spawn
			let emptyCalled = false;
			const emptyMulti = await installMultipleSkills({source: 'org/repo', skillNames: []}, undefined, async () => {
				emptyCalled = true;
				return {code: 0, stdout: '', stderr: ''};
			});
			expect(emptyMulti.success).toBe(false);
			expect(emptyCalled, '空名单不得 spawn').toBe(false);

			// update：失败路径
			const updateEvents: {level: string; message: string; instruction?: string}[] = [];
			const updateRes = await updateSkills([], event => updateEvents.push(event), failExec);
			expect(updateRes.success).toBe(false);
			expect((updateRes.error ?? '').includes('网络')).toBe(true);
			expect(updateEvents.find(event => event.instruction)?.instruction, 'Skills update progress 必须上报实际命令').toBe(
				'npx --yes skills@latest update -g -y'
			);
			expect(updateEvents.some(event => event.level === 'danger')).toBe(true);

			// uninstall：成功路径
			const uninstallEvents: {level: string; message: string; instruction?: string}[] = [];
			const uninstallRes = await uninstallSkills(['skill-a'], event => uninstallEvents.push(event), okExec);
			expect(uninstallRes.success).toBe(true);
			expect(uninstallEvents.find(event => event.instruction)?.instruction, 'Skills uninstall progress 必须上报实际命令').toBe(
				'npx --yes skills@latest remove skill-a -g --agent claude-code --yes'
			);
			expect(uninstallEvents.length > 0).toBe(true);

			// 空名单 uninstall 直接失败
			const emptyRes = await uninstallSkills([], () => {}, okExec);
			expect(emptyRes.success).toBe(false);

			expect(consoleHits, 'action service 不得直接写 console').toBe(0);
		} finally {
			console.log = originalLog;
			console.error = originalError;
		}
	});

	// ── Task 8.1-8.5：agentContext 参数化 + service 映射 + 命令参数捕获 ──────────────
	test('8.1-8.5 Skills 核心 action：list/install/uninstall 显式 agent，update 全局无 agent', async () => {
		// 8.1/8.2 映射不变量
		expect(skillsAgentOf('cc')).toBe('claude-code');
		expect(skillsAgentOf('cx')).toBe('codex');

		// getInstalledSkills：cc/cx 各自注入对应 --agent
		const listArgs: string[][] = [];
		await getInstalledSkills('cc', async (_cmd, args) => {
			listArgs.push([...args]);
			return {code: 0, stdout: '[]', stderr: ''};
		});
		await getInstalledSkills('cx', async (_cmd, args) => {
			listArgs.push([...args]);
			return {code: 0, stdout: '[]', stderr: ''};
		});
		const ccListArgs = required(listArgs[0], 'listArgs[0]');
		expect(ccListArgs.includes('--agent'), 'list 必须带 --agent').toBe(true);
		expect(ccListArgs[ccListArgs.indexOf('--agent') + 1], 'cc list --agent=claude-code').toBe('claude-code');
		const cxListArgs = required(listArgs[1], 'listArgs[1]');
		expect(cxListArgs[cxListArgs.indexOf('--agent') + 1], 'cx list --agent=codex').toBe('codex');

		// listRepoSkills：cx → --agent codex
		const repoArgs: string[][] = [];
		await listRepoSkills('org/repo', 'cx', async (_cmd, args) => {
			repoArgs.push([...args]);
			return {code: 0, stdout: '◇  Available Skills\n│\n│    x\n', stderr: ''};
		});
		const firstRepoArgs = required(repoArgs[0], 'repoArgs[0]');
		expect(firstRepoArgs[firstRepoArgs.indexOf('--agent') + 1], 'cx listRepoSkills --agent=codex').toBe('codex');

		// install / installMultipleSkills / uninstall：cx → --agent codex；update 为全局单次且无 --agent
		const installArgs: string[][] = [];
		await installSkill({source: 'org/repo', displayName: 'org/repo@x', skillName: 'x'}, undefined, 'cx', async (_cmd, args) => {
			installArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		const cxInstallArgs = required(installArgs[0], 'installArgs[0]');
		expect(cxInstallArgs[cxInstallArgs.indexOf('--agent') + 1], 'cx install --agent=codex').toBe('codex');

		const multiArgs: string[][] = [];
		await installMultipleSkills({source: 'org/repo', skillNames: ['a']}, undefined, 'cx', async (_cmd, args) => {
			multiArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		const cxMultiArgs = required(multiArgs[0], 'multiArgs[0]');
		expect(cxMultiArgs[cxMultiArgs.indexOf('--agent') + 1], 'cx installMultiple --agent=codex').toBe('codex');

		const uninstallArgs: string[][] = [];
		await uninstallSkills(['skill-a'], undefined, 'cx', async (_cmd, args) => {
			uninstallArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		const cxUninstallArgs = required(uninstallArgs[0], 'uninstallArgs[0]');
		expect(cxUninstallArgs[cxUninstallArgs.indexOf('--agent') + 1], 'cx uninstall --agent=codex').toBe('codex');

		const updateArgs: string[][] = [];
		await updateSkills([], undefined, async (_cmd, args) => {
			updateArgs.push([...args]);
			return {code: 0, stdout: 'all skills up to date', stderr: ''};
		});
		expect(updateArgs.length, 'update 只执行一次').toBe(1);
		expect(required(updateArgs[0], 'updateArgs[0]').includes('--agent'), 'update 不得传 --agent').toBe(false);
	});

	// ── Section 17/19.4：双侧共享 service（多目标安装 / 全量删省略 --agent / 单侧 --agent claude-code） ──
	test('17/19.4 双侧共享 service：多目标安装 per-side、单侧撤销 --agent claude-code、全量删省略 --agent', async () => {
		// installResultToTargets：含 cc → 一次调用同传 [claude-code, codex] 双 --agent 触发 symlink（非逐侧多次）。
		const agentsOf = (args: readonly string[]): string[] =>
			args.reduce<string[]>((acc, a, i) => (a === '--agent' ? [...acc, args[i + 1] ?? ''] : acc), []);
		const agentOf = (args: readonly string[]): string | undefined => args[args.indexOf('--agent') + 1];
		const bothArgs: string[][] = [];
		const bothSides = await installResultToTargets(
			{name: 'org/repo@x', source: 'org/repo', description: ''},
			['cc', 'cx'],
			undefined,
			async (_cmd, args) => {
				bothArgs.push([...args]);
				return {code: 0, stdout: '', stderr: ''};
			}
		);
		expect(bothArgs.length, '含 cc 单次原子调用（非逐侧）').toBe(1);
		expect(agentsOf(required(bothArgs[0], 'bothArgs[0]')).sort(), '单次调用同传双 --agent 触发 symlink').toEqual([
			'claude-code',
			'codex'
		]);
		expect(
			bothSides.every(s => s.result.success),
			'结果映射回两 target 皆成功'
		).toBe(true);

		// 单侧安装（仅 cc）：含 cc 补 cx，仍一次双 agent 调用。
		const ccOnlyArgs: string[][] = [];
		await installResultToTargets({name: 'org/repo@x', source: 'org/repo', description: ''}, ['cc'], undefined, async (_cmd, args) => {
			ccOnlyArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		expect(ccOnlyArgs.length, '仅选 cc 也只调一次').toBe(1);
		expect(agentsOf(required(ccOnlyArgs[0], 'ccOnlyArgs[0]')).sort(), '含 cc 补 cx，一次双 --agent').toEqual(['claude-code', 'codex']);

		// 仅 Pi 也必须补 Codex canonical，省略 --copy 让 Pi 目录成为 canonical 的软链接。
		const piOnlyArgs: string[][] = [];
		const piOnlyOptions: ({env?: NodeJS.ProcessEnv} | undefined)[] = [];
		await installResultToTargets(
			{name: 'org/repo@x', source: 'org/repo', description: ''},
			['pi'],
			undefined,
			async (_cmd, args, options) => {
				piOnlyArgs.push([...args]);
				piOnlyOptions.push(options);
				return {code: 0, stdout: '', stderr: ''};
			}
		);
		expect(piOnlyArgs.length, '仅 Pi 只调一次').toBe(1);
		const firstPiArgs = required(piOnlyArgs[0], 'piOnlyArgs[0]');
		expect(agentsOf(firstPiArgs).sort(), '仅 Pi 必须补 Codex canonical').toEqual(['codex', 'pi']);
		expect(firstPiArgs.includes('--copy'), 'Pi 必须使用 symlink 模式而非 copy').toBe(false);
		expect(piOnlyOptions[0]?.env?.CODEX_HOME ?? '', 'Pi symlink 安装必须把 CODEX_HOME 定向到 canonical .agents').toMatch(/\.agents$/);

		// C/X/Pi 一次安装仍只调用一个 source batch，三个 agent 共享同一 canonical。
		const allTargetArgs: string[][] = [];
		await installSearchResultsToTargets(
			[{name: 'org/repo@x', source: 'org/repo', description: ''}],
			['cc', 'cx', 'pi'],
			undefined,
			async (_cmd, args) => {
				allTargetArgs.push([...args]);
				return {code: 0, stdout: '', stderr: ''};
			}
		);
		expect(allTargetArgs.length, 'C/X/Pi 安装必须只调用一次').toBe(1);
		const firstAllTargetArgs = required(allTargetArgs[0], 'allTargetArgs[0]');
		expect(agentsOf(firstAllTargetArgs).sort(), 'C/X/Pi 必须共享一次 canonical 安装').toEqual(['claude-code', 'codex', 'pi']);
		expect(firstAllTargetArgs.includes('--copy'), 'C/X/Pi 共享安装不得使用 copy').toBe(false);

		// 仅 cx：单 Agent + --copy，并用 scoped CODEX_HOME 物化到 canonical .agents。
		const cxOnlyArgs: string[][] = [];
		const cxOnlyOptions: ({env?: NodeJS.ProcessEnv} | undefined)[] = [];
		await installResultToTargets(
			{name: 'org/repo@x', source: 'org/repo', description: ''},
			['cx'],
			undefined,
			async (_cmd, args, options) => {
				cxOnlyArgs.push([...args]);
				cxOnlyOptions.push(options);
				return {code: 0, stdout: '', stderr: ''};
			}
		);
		expect(cxOnlyArgs.length, '仅 cx 只调一次').toBe(1);
		const firstCxOnlyArgs = required(cxOnlyArgs[0], 'cxOnlyArgs[0]');
		expect(agentsOf(firstCxOnlyArgs), '仅 cx 单 --agent codex').toEqual(['codex']);
		expect(firstCxOnlyArgs.includes('--copy'), '仅 Codex 必须显式物化实体').toBe(true);
		expect(cxOnlyOptions[0]?.env?.CODEX_HOME ?? '', '仅 Codex 必须把 CODEX_HOME 定向到 canonical .agents').toMatch(/\.agents$/);
		expect(cxOnlyOptions[0]?.env?.CLAUDE_CONFIG_DIR ?? '', 'Skills 子进程必须显式固定 CLAUDE_CONFIG_DIR').toMatch(/\.claude$/);

		// 单次原子调用失败 → 各 side 皆标失败（per-side 失败隔离退化）。
		const mixedSides = await installResultToTargets(
			{name: 'org/repo@x', source: 'org/repo', description: ''},
			['cc', 'cx'],
			undefined,
			async () => ({code: 1, stdout: '', stderr: 'boom'})
		);
		expect(
			mixedSides.every(s => !s.result.success),
			'单次调用失败则各 side 皆失败'
		).toBe(true);

		// toggleClaudeInstall(true) → 一次双 --agent（建 symlink）；(false) → remove --agent claude-code（单侧撤销）。
		const addArgs: string[][] = [];
		const installedRow = {
			name: 'x',
			path: '',
			scope: 'global',
			source: 'org/repo',
			ref: 'main',
			skillName: 'x',
			sharedInstalled: true,
			claudeInjected: false,
			codexAvailable: true,
			agents: [],
			otherAgents: []
		};
		await toggleClaudeInstall(installedRow, true, undefined, async (_cmd, args) => {
			addArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		const firstAddArgs = required(addArgs[0], 'addArgs[0]');
		expect(firstAddArgs.includes('add'), 'toggleClaudeInstall(true) 走 add').toBe(true);
		expect(firstAddArgs.includes('org/repo#main'), '重注入使用 lock source + ref').toBe(true);
		expect(firstAddArgs[firstAddArgs.indexOf('--skill') + 1], '重注入使用 lock skillName').toBe('x');
		expect(agentsOf(firstAddArgs).sort(), 'install 建 symlink 传双 --agent').toEqual(['claude-code', 'codex']);
		const missingSource = await toggleClaudeInstall({...installedRow, source: undefined}, true);
		expect(missingSource.success, 'lock 缺 source 时拒绝把裸 name 当 source').toBe(false);
		expect(missingSource.error ?? '', 'lock 缺 source 时给出可操作提示').toMatch(/重新搜索安装/);

		const removeArgs: string[][] = [];
		await toggleClaudeInstall(installedRow, false, undefined, async (_cmd, args) => {
			removeArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		const firstRemoveArgs = required(removeArgs[0], 'removeArgs[0]');
		expect(firstRemoveArgs.includes('remove'), 'toggleClaudeInstall(false) 走 remove').toBe(true);
		expect(agentOf(firstRemoveArgs), '单侧撤销走 --agent claude-code').toBe('claude-code');

		// uninstallSkillAllAgents：单条 skills remove（省略 --agent，CLI 默认全 agent + 清本体；非挨个 agent）。
		// CLI 1.5.16 的 remove 不接受 --agent '*'（报 Invalid agents: * 并 exit 1），故全量删靠省略 --agent。
		const delArgs: string[][] = [];
		await uninstallSkillAllAgents('org/repo@x', undefined, async (_cmd, args) => {
			delArgs.push([...args]);
			return {code: 0, stdout: '', stderr: ''};
		});
		expect(delArgs.length, '全量删只调一次（非挨个 agent）').toBe(1);
		const firstDelArgs = required(delArgs[0], 'delArgs[0]');
		expect(firstDelArgs.includes('remove'), '全量删走 remove').toBe(true);
		expect(firstDelArgs.includes('--agent'), "全量删省略 --agent（不再传 '*'，避免 Invalid agents）").toBe(false);
	});

	// ── 扁平跨来源批量安装：共享身份 + source 批次规划/顺序执行 ────────────────
	test('扁平跨来源批量安装按 source 合并、顺序执行、失败隔离并防御同名冲突', async () => {
		const sourceAOne: SearchSkillResult = {name: 'org/a@one', source: 'org/a', description: ''};
		const sourceATwo: SearchSkillResult = {name: 'org/a@two', source: 'org/a', description: ''};
		const sourceBThree: SearchSkillResult = {name: 'org/b@three', source: 'org/b', description: ''};

		expect(searchSkillIdentity(sourceAOne), '搜索结果身份应由 source + 子 Skill 名共同决定').toEqual({
			key: JSON.stringify(['org/a', 'one']),
			source: 'org/a',
			skillName: 'one'
		});
		expect(searchSkillIdentity({name: 'standalone', source: '', description: ''}), '无法派生子 Skill 身份时应禁选').toBe(undefined);

		const plan = planSkillInstallBatches([sourceAOne, sourceATwo, sourceBThree, sourceATwo]);
		expect(plan, 'planner 应按首次出现顺序合并同 source，并去重同 source 子 Skill').toEqual([
			{source: 'org/a', skillNames: ['one', 'two']},
			{source: 'org/b', skillNames: ['three']}
		]);

		const calls: string[][] = [];
		let activeCalls = 0;
		let maxActiveCalls = 0;
		const execution = await installSearchResultsToTargets(
			[sourceAOne, sourceATwo, sourceBThree],
			['cc', 'cx'],
			undefined,
			async (_cmd, args) => {
				activeCalls++;
				maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
				calls.push([...args]);
				await Promise.resolve();
				activeCalls--;
				return args.includes('org/a') ? {code: 1, stdout: '', stderr: 'source a failed'} : {code: 0, stdout: 'done', stderr: ''};
			}
		);
		expect(maxActiveCalls, '不同 source 必须顺序执行').toBe(1);
		expect(calls.length, '一个 source 失败后仍应继续后续 source').toBe(2);
		expect(
			required(calls[0], 'calls[0]').filter(value => value === '--skill').length,
			'同 source 多 Skill 应合并为一次多 --skill 调用'
		).toBe(2);
		expect(
			execution.batches.map(batch => batch.result.success),
			'批次结果应保留每个 source 的独立结果'
		).toEqual([false, true]);

		let conflictSpawned = false;
		await expect(
			installSearchResultsToTargets(
				[sourceAOne, {name: 'org/b@one', source: 'org/b', description: ''}],
				['cx'],
				undefined,
				async () => {
					conflictSpawned = true;
					return {code: 0, stdout: '', stderr: ''};
				}
			),
			'不同 source 的同名 Skill 应在 spawn 前被拒绝'
		).rejects.toThrow(/同名/);
		expect(conflictSpawned, '同名冲突不得启动任何命令').toBe(false);

		let projectTargetSpawned = false;
		await expect(
			installSearchResultsToTargets([sourceAOne], ['pi-project'] as unknown as SkillsInstallTarget[], undefined, async () => {
				projectTargetSpawned = true;
				return {code: 0, stdout: '', stderr: ''};
			}),
			'Skills TUI 批量安装不得接受项目 Pi target'
		).rejects.toThrow(/未选择安装目标/);
		expect(projectTargetSpawned, '项目 Pi target 不得启动任何命令').toBe(false);
	});
});
