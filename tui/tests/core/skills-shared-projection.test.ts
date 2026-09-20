import {describe, expect, test} from 'bun:test';
import {
	detectInstalledSkillItems,
	itemAvailableOn,
	otherAgentsOf,
	SKILL_AGENT_DISPLAY_TO_CONTEXT,
	storageRootsOf,
	type SkillsCliListRecord
} from '../../src/core/skills-installed.js';

// 载体迁移（P3b）：原 scripts/verify-skills-shared-projection.mjs 的纯投影派生段
// （原第 1/2/3/5 段，共 22 条静态断言）迁入；依赖真实落盘的检测干扰段（原第 4 段，
// 8 条）保留在 verify（磁盘 lock / `.claude` 干扰内容不得改变检测投影）。
//
// 判据：这四段的输入全部来自注入 exec 的 JSON 字符串或字面量，去掉真实临时目录后
// 断言仍成立，故属 core 判定 / service 映射层。
//   1) 检测只跑一次 list，且不带 --agent；
//   2) Agent 可用侧只由 `agents` 派生，存储位置只由 `path` 派生；
//   3) 未知 displayName 保留为 otherAgents，不影响三侧判定；
//   5) 检测失败整体传播，不回退文件系统扫描。

function required<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`缺少 ${label}`);
	return value;
}

const listRecord = (over: Partial<SkillsCliListRecord> = {}): SkillsCliListRecord => ({
	name: 'pdf',
	path: '/home/u/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	source: 'owner/repo',
	...over
});

const stdoutExec = (stdout: string) => async () => ({code: 0, stdout, stderr: ''});

describe('Skills 已安装检测投影（core/skills-installed.ts）', () => {
	// ── 1) 检测只跑一次 list，且不带 --agent ────────────────────────────────────
	test('1 已安装检测只执行一次不带 --agent 的 list', async () => {
		const calls: {command: string; args: readonly string[]}[] = [];
		const items = await detectInstalledSkillItems(async (command, args) => {
			calls.push({command, args});
			return {code: 0, stdout: JSON.stringify([listRecord()]), stderr: ''};
		});

		expect(calls.length, '一次检测只允许一次 CLI 调用').toBe(1);
		const firstCall = required(calls[0], 'calls[0]');
		expect(firstCall.command).toBe('npx');
		expect(firstCall.args.includes('--agent'), '检测必须是不带 --agent 的全量扫').toBe(false);
		expect(firstCall.args.includes('--json'), '必须请求 JSON').toBe(true);
		expect(firstCall.args.includes('-g'), '必须是全局 scope').toBe(true);
		expect(items.length).toBe(1);
	});

	// ── 2) Agent 侧只由 agents 派生；storage 位置只由 path 派生 ──────────────────
	test('2 Agent 侧只由 agents 派生，存储位置只由 path 派生', async () => {
		const [codexOnly] = await detectInstalledSkillItems(stdoutExec(JSON.stringify([listRecord({agents: ['Codex']})])));
		const codexItem = required(codexOnly, 'codexOnly');
		expect(itemAvailableOn(codexItem, 'cx'), 'agents 含 Codex → Codex 侧可用').toBe(true);
		expect(itemAvailableOn(codexItem, 'cc'), 'agents 不含 Claude Code → Claude 侧不可用').toBe(false);
		expect(storageRootsOf(codexItem), '存储根只由 JSON path 分类').toEqual(['agents']);

		const [claudeOnly] = await detectInstalledSkillItems(
			stdoutExec(JSON.stringify([listRecord({agents: ['Claude Code'], path: '/home/u/.claude/skills/pdf'})]))
		);
		const claudeItem = required(claudeOnly, 'claudeOnly');
		expect(itemAvailableOn(claudeItem, 'cc')).toBe(true);
		expect(itemAvailableOn(claudeItem, 'cx'), '不得因 canonical 目录存在就推导 Codex 可用').toBe(false);
		expect(storageRootsOf(claudeItem)).toEqual(['claude']);

		const [shared] = await detectInstalledSkillItems(
			stdoutExec(
				JSON.stringify([listRecord({agents: ['Codex']}), listRecord({agents: ['Claude Code'], path: '/home/u/.claude/skills/pdf'})])
			)
		);
		const sharedItem = required(shared, 'shared');
		expect([...sharedItem.agents].sort(), '同源多记录合并 agents 并集').toEqual(['Claude Code', 'Codex']);
		expect([...storageRootsOf(sharedItem)].sort(), '两条投影都保留').toEqual(['agents', 'claude']);
	});

	// ── 3) 未知 displayName 保留为 otherAgents，不影响双侧判定 ───────────────────
	test('3 未知 displayName 保留为 otherAgents', async () => {
		const [item] = await detectInstalledSkillItems(stdoutExec(JSON.stringify([listRecord({agents: ['Cline', 'Cursor', 'Codex']})])));
		const unknownAgentItem = required(item, 'item');
		expect(itemAvailableOn(unknownAgentItem, 'cx'), 'Codex 仍被识别').toBe(true);
		expect(itemAvailableOn(unknownAgentItem, 'cc'), 'Cline/Cursor 不影响 Claude 侧').toBe(false);
		expect([...otherAgentsOf(unknownAgentItem)].sort(), '其它 Agent 保留供确认文案展示').toEqual(['Cline', 'Cursor']);

		expect(SKILL_AGENT_DISPLAY_TO_CONTEXT['Claude Code']).toBe('cc');
		expect(SKILL_AGENT_DISPLAY_TO_CONTEXT.Codex).toBe('cx');
		expect(SKILL_AGENT_DISPLAY_TO_CONTEXT.Cline).toBe(undefined);
	});

	// ── 5) 失败整体传播，不回退文件系统扫描 ─────────────────────────────────────
	test('5 检测失败整体传播，不回退文件系统扫描', async () => {
		const failures = [
			['非零退出', {code: 7, stdout: '', stderr: 'boom'}],
			['空输出', {code: 0, stdout: '', stderr: ''}],
			['无效 JSON', {code: 0, stdout: 'not-json', stderr: ''}],
			['顶层非数组', {code: 0, stdout: '{}', stderr: ''}],
			['坏记录', {code: 0, stdout: JSON.stringify([{name: 5}]), stderr: ''}]
		] as const;
		for (const [label, result] of failures) {
			await expect(
				detectInstalledSkillItems(async () => result),
				`${label} 必须整体失败`
			).rejects.toThrow(/Skills 列表检测失败/);
		}

		expect(await detectInstalledSkillItems(stdoutExec('[]')), '合法 [] 才是真正的空安装列表').toEqual([]);
	});
});
