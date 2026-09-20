import {describe, expect, test} from 'bun:test';
import {join} from 'node:path';
import type {ExecOptions} from '../../src/core/exec.js';
import {runSkillsAdd, runSkillsRemove, type SkillsExecFn} from '../../src/core/skills-actions.js';
import {groupInstalledSkillItems, type InstalledSkillItem, type SkillsCliListRecord} from '../../src/core/skills-installed.js';
import type {SkillTopology} from '../../src/core/skills-storage.js';
import {targetTopologyOfDraft, transitionSkillTopology} from '../../src/services/skills-adoption.js';
import {installSearchResultsToTargets} from '../../src/services/skills-service.js';

// 载体迁移（P3b）：原 scripts/verify-skills-adoption.mjs 的纯段（共 20 条静态断言）迁入；
// 依赖真实临时目录落盘 / 符号链接语义 / official add 物化的段（共 119 条）保留在 verify。
//
// 判据（逐段实测）：迁走段去掉真实临时目录后断言仍成立 ——
//   1) Skills action 的 argv / env 映射（exec 注入桩，storageOptions 不参与）；
//   2) `targetTopologyOfDraft` 纯函数（字面量输入）；
//   3) C/X/B 三种 no-op 的 Item 派生决策（`current === target && !needsManagedMigration`
//      在 preflight 前短路，不 spawn、不标记 mutation）；同段的「未创建恢复快照」是
//      真实 fs 事实，保留在 verify；
//   4) Claude-only 第三方占用阻断（`otherAgentsOf(item)` 派生，preflight 前短路）；
//   5) 同源覆盖在 add 前被拒绝（`prepareReplacements` 的 source 等价守卫，
//      同名 Item 已存在时 `validateInstallCandidates` 不做 fs 探测）。
// 其余段（Claude-only → shared 收编、`.codex`/Pi global 收编、Windows copy partial、
// 六向转换与 exit/fact 对账、storage kind 分类、同名来源替换的定向清理与 orphan 阻断）
// 全部依赖真实 fs 语义，保留在 verify。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

function agentsFromArgs(args: readonly string[]): string[] {
	return args.filter((_, index) => args[index - 1] === '--agent');
}

// 纯段不读磁盘：home 只用于拼装 Item projection 路径与子进程 env 字符串。
const fakeHome = join('/fake-home', 'ccq-skills-adoption');

function itemFor(
	homeDir: string,
	name: string,
	topology: SkillTopology | 'pi-only',
	{
		source = 'o/repo',
		extraAgents = [],
		location = 'agents'
	}: {source?: string; extraAgents?: readonly string[]; location?: 'agents' | 'codex'} = {}
): InstalledSkillItem {
	const claudeRecord = (): SkillsCliListRecord => ({
		name,
		path: join(homeDir, '.claude', 'skills', name),
		scope: 'global',
		agents: ['Claude Code', ...extraAgents],
		source
	});
	const canonicalRecord = (): SkillsCliListRecord => ({
		name,
		path: join(homeDir, '.agents', 'skills', name),
		scope: 'global',
		agents: ['Codex', ...extraAgents],
		source
	});
	const codexRecord = (): SkillsCliListRecord => ({
		name,
		path: join(homeDir, '.codex', 'skills', name),
		scope: 'global',
		agents: ['Codex', ...extraAgents],
		source
	});
	const piGlobalRecord = (): SkillsCliListRecord => ({
		name,
		path: join(homeDir, '.pi', 'agent', 'skills', name),
		scope: 'global',
		agents: ['Pi', ...extraAgents],
		source
	});

	let records: SkillsCliListRecord[];
	if (topology === 'claude-only') {
		records = [claudeRecord()];
	} else if (topology === 'codex-only') {
		records = location === 'codex' ? [codexRecord()] : [canonicalRecord()];
	} else if (topology === 'pi-only') {
		records = [piGlobalRecord()];
	} else {
		records = [canonicalRecord(), claudeRecord()];
	}

	return required(groupInstalledSkillItems(records)[0], 'itemFor');
}

describe('Skills 迁移事务纯段（core/skills-actions.ts + services/skills-adoption.ts）', () => {
	// ── Skills action：copy / 有序 agents / 重复 remove agent / scoped env ────
	test('Skills action：copy / 有序 agents / 重复 remove agent / scoped env', async () => {
		const homeDir = join(fakeHome, 'action');
		const calls: {command: string; args: string[]; options?: ExecOptions}[] = [];
		const exec: SkillsExecFn = async (command, args, options) => {
			calls.push({command, args: [...args], options});
			return {code: 0, stdout: 'ok', stderr: ''};
		};

		const originalCodexHome = process.env.CODEX_HOME;
		const env = {...process.env, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: join(homeDir, '.claude')};
		await runSkillsAdd({source: '/tmp/source', skillNames: ['demo'], agents: ['cc'], copy: true, env}, undefined, exec);
		await runSkillsAdd({source: '/tmp/source', skillNames: ['demo'], agents: ['cx', 'cc'], env}, undefined, exec);
		await runSkillsRemove({skillNames: ['demo'], agents: ['cc', 'cx'], env}, undefined, exec);

		expect(required(calls[0], 'calls[0]').args.includes('--copy'), '单侧物化必须显式 --copy').toBe(true);
		expect(
			calls.every(call => call.args.includes('skills@latest')),
			'所有 mutation 必须使用官方 skills@latest'
		).toBe(true);
		expect(required(calls[1], 'calls[1]').args.includes('--copy'), '双侧投影不得使用 --copy').toBe(false);
		expect(agentsFromArgs(required(calls[1], 'calls[1]').args)).toEqual(['codex', 'claude-code']);
		expect(agentsFromArgs(required(calls[2], 'calls[2]').args), 'remove 必须支持重复 --agent').toEqual(['claude-code', 'codex']);
		expect(calls.every(call => call.options?.env?.CLAUDE_CONFIG_DIR === join(homeDir, '.claude'))).toBe(true);
		expect(process.env.CODEX_HOME, '子进程 env 不得污染父进程').toBe(originalCodexHome);
	});

	// ── install draft → 目标拓扑（纯函数） ─────────────────────────────────────
	test('Skills topology 纯函数：install draft → 目标拓扑', () => {
		expect(targetTopologyOfDraft({cc: true, cx: false})).toBe('claude-only');
		expect(targetTopologyOfDraft({cc: false, cx: true})).toBe('codex-only');
		expect(targetTopologyOfDraft({cc: true, cx: true})).toBe('shared');
		expect(targetTopologyOfDraft({cc: false, cx: false})).toBe('empty');
	});

	// ── C/X/B 三种 no-op：目标与当前一致时不产生任何 mutation（Item 输入） ────
	test('C/X/B 三种 no-op：目标与当前一致时不产生任何 mutation', async () => {
		for (const topology of ['claude-only', 'codex-only', 'shared'] as const) {
			const homeDir = join(fakeHome, `noop-${topology}`);
			const calls: string[] = [];
			const result = await transitionSkillTopology(
				itemFor(homeDir, `noop-${topology}`, topology),
				topology,
				undefined,
				async () => {
					calls.push('spawn');
					return {code: 0, stdout: '', stderr: ''};
				},
				{homeDir, tempDir: join(homeDir, 'temp')}
			);
			expect(result.success, `${topology} 同拓扑必须 no-op 成功`).toBe(true);
			expect(result.mutated, `${topology} no-op 不得标记 mutation`).toBe(false);
			expect(calls.length, `${topology} no-op 不得 spawn 任何命令`).toBe(0);
		}
	});

	// ── Claude-only 第三方占用阻断（Item 输入） ────────────────────────────────
	test('Claude-only 第三方占用阻断（Item 输入）', async () => {
		const homeDir = join(fakeHome, 'blocked');
		const calls: string[] = [];
		const blocked = await transitionSkillTopology(
			itemFor(homeDir, 'third-party', 'codex-only', {extraAgents: ['Cursor']}),
			'claude-only',
			undefined,
			async () => {
				calls.push('spawn');
				return {code: 0, stdout: '', stderr: ''};
			},
			{homeDir, tempDir: join(homeDir, 'temp')}
		);
		expect(blocked.success).toBe(false);
		expect(blocked.mutated).toBe(false);
		expect(blocked.error ?? '').toMatch(/Cursor|其它 Agent/);
		expect(calls.length).toBe(0);
	});

	// ── 同源覆盖：在 add 前拒绝 ────────────────────────────────────────────────
	test('同名来源替换：同源覆盖在 add 前被拒绝', async () => {
		const homeDir = join(fakeHome, 'same-source');
		const sameInstalled = groupInstalledSkillItems([
			{name: 'dup', path: join(homeDir, '.agents', 'skills', 'dup'), scope: 'global', agents: ['Codex'], source: 'same/repo'}
		]);
		let sameSpawned = false;
		const sameResult = await installSearchResultsToTargets(
			[{name: 'same/repo@dup', source: 'same/repo', description: ''}],
			['cx'],
			undefined,
			async () => {
				sameSpawned = true;
				return {code: 0, stdout: '', stderr: ''};
			},
			{installed: sameInstalled, storage: {homeDir, tempDir: join(homeDir, 'temp')}}
		);
		expect(sameSpawned, '同源覆盖应在 add 前拒绝').toBe(false);
		expect(sameResult.batches[0]?.result.success, '同源覆盖 batch 必须失败').toBe(false);
	});
});
