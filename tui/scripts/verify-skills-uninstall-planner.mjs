import assert from 'node:assert/strict';
import {access, mkdtemp, mkdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {groupInstalledSkillItems} from '../src/core/skills-installed.ts';
import {uninstallSkillInstance, uninstallSkillInstances} from '../src/services/skills-service.ts';
import {createInitialSkillsViewState, reduceSkillsViewState} from '../src/state/skills-view-state.ts';
import {runConfirmedUninstallAction} from '../src/views/skills/skills-view-actions.ts';

// uninstall planner（task 07-28-skills-multi-source-topology / design §8.3 / Checkpoint C3）：
//   1) isolated（无同名异源）→ 官方 remove，不触碰文件系统；
//   2) 异源同名 → 定向删除当前来源投影，保留异源 Item；
//   3) 目标不存在 → failed，不静默成功；
//   4) 所有权歧义 → 拒绝删除，保留目标。

const home = await realpath(await mkdtemp(join(tmpdir(), 'ccq-uninst-')));
for (const dir of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills'), join(home, '.codex', 'skills')]) {
	await mkdir(dir, {recursive: true});
}

function makeExec() {
	const calls = [];
	const exec = async (command, args) => {
		calls.push({command, args});
		return {code: 0, stdout: '', stderr: ''};
	};
	return {exec, calls};
}

function taskCancellation() {
	let controller;
	return {
		start() {
			controller = new AbortController();
			return controller.signal;
		},
		cancel() {
			controller?.abort();
			return Boolean(controller);
		},
		finish() {
			controller = undefined;
		}
	};
}

function terminalDispatch(invoke) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('等待 uninstall reconciliation 超时')), 2000);
		invoke(action => {
			if (action.type === 'uninstall-reconciled' || action.type === 'action-failed') {
				clearTimeout(timer);
				resolve(action);
			}
		});
	});
}

function uninstallConfirmState(installed) {
	const loaded = reduceSkillsViewState(createInitialSkillsViewState(), {type: 'installed-loaded', installed});
	return reduceSkillsViewState(loaded, {type: 'request-uninstall'});
}

try {
	// ── U-1 isolated：官方 remove 被调用，不直接删文件 ────────────────────────
	{
		const items = groupInstalledSkillItems([
			{name: 'pdf', path: join(home, '.agents', 'skills', 'pdf'), scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstance(items[0], items, undefined, exec, {homeDir: home});
		assert.equal(calls.length, 1, 'isolated 必须走官方 remove 一次');
		assert.equal(calls[0].args.includes('remove'), true);
		assert.equal(out.outcome, 'complete');
		assert.equal(out.mutated, true);
		console.log('[PASS] U-1 isolated：官方 remove，complete');
	}

	// ── U-2 异源同名：定向删除当前来源，保留异源 ──────────────────────────────
	{
		const dirA = join(home, '.agents', 'skills', 'conf');
		const dirB = join(home, '.codex', 'skills', 'conf');
		await mkdir(dirA);
		await mkdir(dirB);
		const items = groupInstalledSkillItems([
			{name: 'conf', path: dirA, scope: 'global', agents: ['Codex'], source: 'o/a'},
			{name: 'conf', path: dirB, scope: 'global', agents: ['Codex'], source: 'o/b'}
		]);
		assert.equal(items.length, 2, '异源同名必须拆成两个 Item');
		const {exec, calls} = makeExec();
		const target = items.find(item => item.provenance.kind === 'known' && item.provenance.installSource === 'o/a');
		const out = await uninstallSkillInstance(target, items, undefined, exec, {homeDir: home});
		assert.equal(calls.length, 0, '异源同名不得走官方 remove');
		assert.equal(out.outcome, 'complete');
		await assert.rejects(() => access(dirA), undefined, '目标来源投影必须被删除');
		await access(dirB);
		console.log('[PASS] U-2 异源同名：定向删除当前来源，保留异源');
	}

	// ── U-3 目标不存在：failed，不静默成功 ─────────────────────────────────────
	{
		const items = groupInstalledSkillItems([
			{name: 'ghost-a', path: join(home, '.agents', 'skills', 'ghost-a'), scope: 'global', agents: ['Codex'], source: 'o/a'},
			{name: 'ghost-a', path: join(home, '.codex', 'skills', 'ghost-a'), scope: 'global', agents: ['Codex'], source: 'o/b'}
		]);
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstance(items[0], items, undefined, exec, {homeDir: home});
		assert.equal(calls.length, 0);
		assert.equal(out.outcome, 'failed', '目标不存在应 failed');
		assert.match(out.error, /不存在/);
		console.log('[PASS] U-3 目标不存在：failed 不静默成功');
	}

	// ── U-4 所有权歧义：拒绝删除，保留目标 ─────────────────────────────────────
	{
		const dup = join(home, '.claude', 'skills', 'dup');
		await mkdir(dup);
		const items = groupInstalledSkillItems([
			{name: 'dup', path: dup, scope: 'global', agents: ['Claude Code'], source: 'o/a'},
			{name: 'dup', path: dup, scope: 'global', agents: ['Claude Code'], source: 'o/b'}
		]);
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstance(items[0], items, undefined, exec, {homeDir: home});
		assert.equal(out.outcome, 'failed');
		assert.equal(calls.length, 0, '歧义不得 spawn 官方命令');
		assert.match(out.error, /多个来源|歧义/);
		await access(dup);
		console.log('[PASS] U-4 所有权歧义：拒绝删除，保留目标');
	}

	// ── U-5 isolated 官方 remove 失败 → failed 透传诊断 ────────────────────────
	{
		const items = groupInstalledSkillItems([
			{name: 'fail', path: join(home, '.agents', 'skills', 'fail'), scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		const exec = async () => ({code: 1, stdout: '', stderr: 'boom'});
		const out = await uninstallSkillInstance(items[0], items, undefined, exec, {homeDir: home});
		assert.equal(out.outcome, 'failed');
		assert.equal(out.mutated, true, '官方命令已启动时必须复检，不能假定失败前毫无修改');
		console.log('[PASS] U-5 官方 remove 失败：failed 透传且要求复检');
	}

	// ── U-6 Shared 的 Agent badge 可证明 Claude 投影时必须一并删除 ─────────────
	{
		const canonical = join(home, '.agents', 'skills', 'shared-derived');
		const claude = join(home, '.claude', 'skills', 'shared-derived');
		const codexOther = join(home, '.codex', 'skills', 'shared-derived');
		await mkdir(canonical);
		await mkdir(claude);
		await mkdir(codexOther);
		const items = groupInstalledSkillItems([
			{
				name: 'shared-derived',
				path: canonical,
				scope: 'global',
				agents: ['Codex', 'Claude Code'],
				source: 'o/a'
			},
			{
				name: 'shared-derived',
				path: codexOther,
				scope: 'global',
				agents: ['Codex'],
				source: 'o/b'
			}
		]);
		const target = items.find(item => item.provenance.kind === 'known' && item.provenance.installSource === 'o/a');
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstance(target, items, undefined, exec, {homeDir: home});
		assert.equal(calls.length, 0, '异源同名不得走官方 remove');
		assert.equal(out.outcome, 'complete');
		await assert.rejects(() => access(canonical), undefined, 'canonical 本体必须删除');
		await assert.rejects(() => access(claude), undefined, 'agents 可证明的 Claude 投影必须删除');
		await access(codexOther);
		console.log('[PASS] U-6 Shared：删除 JSON 本体与 agents 可证明的 Claude 投影');
	}

	// ── U-7 所有目标必须先完成预检，禁止先删安全项再发现歧义 ────────────────
	{
		const canonical = join(home, '.agents', 'skills', 'atomic-preflight');
		const claude = join(home, '.claude', 'skills', 'atomic-preflight');
		await mkdir(canonical);
		await mkdir(claude);
		const items = groupInstalledSkillItems([
			{
				name: 'atomic-preflight',
				path: canonical,
				scope: 'global',
				agents: ['Codex', 'Claude Code'],
				source: 'o/a'
			},
			{
				name: 'atomic-preflight',
				path: claude,
				scope: 'global',
				agents: ['Claude Code'],
				source: 'o/b'
			}
		]);
		const target = items.find(item => item.provenance.kind === 'known' && item.provenance.installSource === 'o/a');
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstance(target, items, undefined, exec, {homeDir: home});
		assert.equal(calls.length, 0);
		assert.equal(out.outcome, 'failed');
		assert.equal(out.mutated, false, '预检失败前不得产生任何删除');
		assert.match(out.error, /多个来源|其它来源|歧义/);
		await access(canonical);
		await access(claude);
		console.log('[PASS] U-7 全量预检：任一歧义都在 mutation 前整体拒绝');
	}

	// ── U-8 mutation 后即使 partial 也必须完整复检并采用真实列表 ─────────────
	{
		const missing = join(home, '.agents', 'skills', 'batch-same');
		const present = join(home, '.codex', 'skills', 'batch-same');
		await mkdir(present);
		const items = groupInstalledSkillItems([
			{name: 'batch-same', path: missing, scope: 'global', agents: ['Codex'], source: 'o/a'},
			{name: 'batch-same', path: present, scope: 'global', agents: ['Codex'], source: 'o/b'}
		]);
		const {exec, calls} = makeExec();
		const out = await uninstallSkillInstances(items, items, undefined, exec, {homeDir: home});
		assert.equal(out.items.length, 2, '首项失败不得阻断后续安全 Item');
		assert.deepEqual(out.items.map(entry => entry.result.outcome), ['failed', 'complete']);
		assert.equal(out.outcome, 'partial');
		assert.equal(out.mutated, true);
		assert.match(out.error ?? '', /batch-same/);
		assert.equal(calls.length, 0, '后一项必须仍用原始 allItems 证明存在同名异源，不得放宽成官方 name remove');
		await assert.rejects(() => access(present), undefined, '后续安全 Item 应继续定向删除');
		console.log('[PASS] U-8 batch：失败继续、原始 allItems 隔离、partial 聚合');
	}

	// ── U-9 mutation 后即使 partial 也必须完整复检并采用真实列表 ──
	{
		const installed = groupInstalledSkillItems([
			{name: 'partial-view', path: join(home, '.agents', 'skills', 'partial-view'), scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		const refreshed = groupInstalledSkillItems([
			{name: 'other', path: join(home, '.agents', 'skills', 'other'), scope: 'global', agents: ['Codex'], source: 'o/b'}
		]);
		let refreshCalls = 0;
		const cache = {
			async refreshAndWait() {
				refreshCalls++;
				return {status: 'success', result: refreshed};
			},
			refresh() {}
		};
		const action = await terminalDispatch(dispatch => runConfirmedUninstallAction(
			uninstallConfirmState(installed),
			{async uninstallInstances() {
				return {
					outcome: 'partial',
					mutated: true,
					error: '原实例残留',
					items: [{item: installed[0], result: {outcome: 'partial', mutated: true, error: '原实例残留'}}]
				};
			}},
			dispatch,
			cache,
			taskCancellation()
		));
		assert.equal(refreshCalls, 1, 'partial mutation 必须完整复检一次');
		assert.equal(action.type, 'uninstall-reconciled');
		assert.equal(action.installed, refreshed);
		assert.equal(action.error, '原实例残留');
		console.log('[PASS] U-9 partial mutation：完整复检并保留真实诊断');
	}

	// ── U-9 未 mutation 的安全预检失败不刷新，直接保留原列表 ──────────────────
	{
		const installed = groupInstalledSkillItems([
			{name: 'blocked-view', path: join(home, '.agents', 'skills', 'blocked-view'), scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		let refreshCalls = 0;
		const cache = {
			async refreshAndWait() {
				refreshCalls++;
				return {status: 'success', result: installed};
			},
			refresh() {}
		};
		const action = await terminalDispatch(dispatch => runConfirmedUninstallAction(
			uninstallConfirmState(installed),
			{async uninstallInstances() {
				return {
					outcome: 'failed',
					mutated: false,
					error: '路径歧义',
					items: [{item: installed[0], result: {outcome: 'failed', mutated: false, error: '路径歧义'}}]
				};
			}},
			dispatch,
			cache,
			taskCancellation()
		));
		assert.equal(refreshCalls, 0);
		assert.equal(action.type, 'action-failed');
		assert.equal(action.error, '路径歧义');
		console.log('[PASS] U-10 未 mutation 的预检失败：不刷新且保留诊断');
	}

	console.log('[PASS] Skills uninstall planner 门禁全部通过');
} finally {
	await rm(home, {recursive: true, force: true});
}
