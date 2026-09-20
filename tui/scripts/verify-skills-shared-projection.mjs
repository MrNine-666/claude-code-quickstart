import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {itemAvailableOn, storageRootsOf} from '../src/core/skills-installed.ts';
import {createSkillsDetectionRunner, runSkillsDetection} from '../src/services/view-detection.ts';

// Skills 已安装检测投影门禁（task 07-28-skills-multi-source-topology R1/R2）。
// 本门禁替换旧的「list 后物理 inspection 修正 Agent badge」契约：
//   1) 检测事实只来自一次 `skills list -g --json`；
//   2) 不读 `.agents/.skill-lock.json`，不扫 `.claude`/`.agents`/`.codex` 目录；
//   3) Agent 可用侧只由 `agents` 派生，存储位置只由 `path` 派生；
//   4) 非 Claude Code / Codex / Pi 的 displayName 保留为 otherAgents，不影响三侧判定；
//   5) Skills 视图投影完全排除当前项目 `.pi/skills`，不把 project scope 泄漏到 UI。
//
// 载体迁移（P3b）：纯投影派生段（原 1/2/3/5 段，共 22 条静态断言）已迁入
// `tests/core/skills-shared-projection.test.ts`（检测只跑一次 list 且不带 --agent、
// agents/path 派生、未知 displayName 保留、失败整体传播）。本脚本只保留依赖真实落盘的
// 段：磁盘上的 lock 与 canonical 目录都不得改变检测投影。

const listRecord = (over = {}) => ({
	name: 'pdf',
	path: '/home/u/.agents/skills/pdf',
	scope: 'global',
	agents: ['Codex'],
	source: 'owner/repo',
	...over
});

// ── 4) 检测不读 lock、不扫目录：磁盘上的干扰内容不得改变结果 ─────────────────
{
	const root = await mkdtemp(join(tmpdir(), 'ccq-skills-detection-'));
	const homeDir = join(root, 'home');
	const originalCcqHome = process.env.CCQ_HOME;
	try {
		process.env.CCQ_HOME = homeDir;

		// 磁盘上放置 lock 与 canonical 目录：都不得影响检测结果。
		const agentsDir = join(homeDir, '.agents');
		await mkdir(join(agentsDir, 'skills', 'ghost'), {recursive: true});
		await writeFile(
			join(agentsDir, '.skill-lock.json'),
			JSON.stringify({version: 3, skills: {pdf: {source: 'lock/should-not-be-used', ref: 'v9'}}}),
			'utf8'
		);
		await mkdir(join(homeDir, '.claude', 'skills', 'pdf'), {recursive: true});

		let state;
		const listCalls = [];
		const runner = createSkillsDetectionRunner(next => {
			state = next;
		});
		await runSkillsDetection(runner, async (command, args) => {
			listCalls.push({command, args});
			return {
				code: 0,
				stdout: JSON.stringify([
					listRecord({agents: ['Codex']}),
					listRecord({name: 'project-only', path: '/workspace/project/.pi/skills/project-only', agents: ['Pi'], source: 'owner/project'})
				]),
				stderr: ''
			};
		});

		assert.equal(listCalls.length, 1, '检测不得为文件系统分类追加第二次命令');
		assert.deepEqual(listCalls[0], {command: 'npx', args: ['--yes', 'skills', 'list', '-g', '--json']}, '视图检测只请求全局 Skills 列表');
		assert.equal(state?.status, 'success');
		const items = state?.result ?? [];
		assert.equal(items.length, 1, '项目 `.pi/skills` Skill 不得出现在列表里');
		assert.equal(items[0].name, 'pdf');
		assert.equal(
			items[0].provenance.source,
			'owner/repo',
			'来源只来自 CLI 记录，lock 中的来源不得覆盖'
		);
		assert.equal(itemAvailableOn(items[0], 'cc'), false, '磁盘上的 .claude 目录不得改变 Agent 侧');
		assert.deepEqual(storageRootsOf(items[0]), ['agents']);

		console.log('[PASS] 4 检测不读 lock、不扫目录，磁盘干扰不改变结果');
	} finally {
		if (originalCcqHome === undefined) delete process.env.CCQ_HOME;
		else process.env.CCQ_HOME = originalCcqHome;
		await rm(root, {recursive: true, force: true});
	}
}

console.log('[PASS] Skills 已安装检测投影门禁全部通过');
