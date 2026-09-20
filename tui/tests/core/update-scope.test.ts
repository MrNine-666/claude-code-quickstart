import {expect, test} from 'bun:test';
import type {ProgressEvent} from '../../src/core/exec.js';
import {applyUpdates, type UpdateComponent} from '../../src/core/update.js';

// P5a 迁移自 scripts/verify-update-scope.mjs 的纯段（1 条静态断言）。
//
// 该脚本其余 18 条断言全部依赖真实临时 HOME 下的检测事实（mock `claude --version` / npm 缓存 /
// `~/.claude/.ccg/config.toml` 字节），`checkComponentUpdates()` 无注入缝，按 R1 留在 verify；
// 另 3 条 `snapshot 失败不执行更新命令` 已由 P4b tests/core/tools-manage.test.ts 的
// `applyUpdates snapshot-before-write` 用例覆盖（R9 登记，不重复迁移）。

test('工具更新 progress 上报实际执行命令', async () => {
	const execCalls: {cmd: string; args: readonly string[]}[] = [];
	const exec = async (cmd: string, args: readonly string[]) => {
		execCalls.push({cmd, args});
		return {code: 0, stdout: '', stderr: ''};
	};
	const npmComp: UpdateComponent = {
		id: 'ClaudeCode',
		name: 'ClaudeCode',
		type: 'npm',
		package: '@anthropic-ai/claude-code',
		installed: true,
		currentVersion: '1.0.0',
		latestVersion: '1.1.0',
		hasUpdate: true
	};
	const updateEvents: ProgressEvent[] = [];
	await applyUpdates([npmComp], event => updateEvents.push(event), {
		createSnapshotFn: () => 'snapshot.json',
		exec
	});
	expect(updateEvents.find(event => event.instruction)?.instruction, '工具更新 progress 必须上报实际 npm 命令').toBe(
		'npm install -g @anthropic-ai/claude-code@1.1.0'
	);
});
