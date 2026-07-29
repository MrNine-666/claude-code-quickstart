import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile, symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
	verifySkillDeletionTarget,
	buildSkillsOwnershipIndex,
	groupInstalledSkillItems,
	supportedSkillsRoots
} from '../src/core/skills-installed.ts';
import {removeSkillTarget} from '../src/core/skills-storage.ts';

// 删除目标文件系统层安全矩阵（task 07-28-skills-multi-source-topology / design §8.3 / Checkpoint C）：
//   1) 实体目录放行 directory，调用方只对该精确目录递归删；
//   2) 符号链接放行 symlink，只 unlink 链接本身，realpath 验证目标仍是受支持根下同名投影；
//   3) 链接逃逸 / 断链 / 非目录 / 穿越一律拒绝，永不跟随链接目标；
//   4) 所有权歧义（同一 (root,name) 被多个 Item 声明）拒绝定向删除。
// 目录符号链接在 win32 普通用户常被拒（EPERM），此时显式 SKIP 相关用例，不冒充通过；
// symlink 判定逻辑待非 win32 或开发者模式环境由官方 CLI smoke 补验证。

// verifySkillDeletionTarget 的 symlink 分支对 supportedRoots 与 target 都做 realpath 规范化，
// 故 win32 8.3 短名、macOS /tmp→/private/tmp、挂载点符号链等 realpath/词法不一致场景下，
// 合法 canonical 投影删除不会被误判逃逸（task 07-28-skills-multi-source-topology C6 修复）。
// 这里 home 仍对齐到 realpath 长名保持与历史 fixture 一致；短名 home 现已同样可正确验证。
const home = await realpath(await mkdtemp(join(tmpdir(), 'ccq-del-')));
const roots = supportedSkillsRoots(home);
for (const dir of [join(home, '.claude', 'skills'), join(home, '.agents', 'skills'), join(home, '.codex', 'skills')]) {
	await mkdir(dir, {recursive: true});
}

// 平台能否创建目录符号链接；win32 普通用户常被拒，此时跳过 symlink 矩阵。
async function tryDirSymlink(target, link) {
	try {
		await symlink(target, link);
		return true;
	} catch (error) {
		const code = error?.code;
		if (code === 'EPERM' || code === 'ENOSYS' || code === 'EEXIST' || code === 'EBUSY') {
			return false;
		}

		throw error;
	}
}

let symlinkSupported = true;

try {
	// ── C-1 实体目录：directory 判定 + root 分类 ──────────────────────────────
	{
		const dir = join(home, '.claude', 'skills', 'pdf');
		await mkdir(dir);
		const verdict = await verifySkillDeletionTarget(dir, 'pdf', roots);
		assert.equal(verdict.ok, true);
		assert.equal(verdict.target.kind, 'directory');
		assert.equal(verdict.target.root, 'claude');
		assert.equal(verdict.target.path, dir);
		console.log('[PASS] C-1 实体目录：directory 判定 + root 分类');
	}

	// ── C-2 非目录普通文件：拒绝 ──────────────────────────────────────────────
	{
		const file = join(home, '.agents', 'skills', 'file');
		await writeFile(file, 'x');
		const verdict = await verifySkillDeletionTarget(file, 'file', roots);
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /不是目录/);
		console.log('[PASS] C-2 非目录文件：拒绝删除');
	}

	// ── C-3 路径穿越：词法层拒绝 ──────────────────────────────────────────────
	{
		const verdict = await verifySkillDeletionTarget(join(home, '.claude', 'skills', '..', '..', 'etc'), '..', roots);
		assert.equal(verdict.ok, false);
		console.log('[PASS] C-3 路径穿越：词法层拒绝');
	}

	// ── C-4 不安全 Skill 名称：拒绝 ───────────────────────────────────────────
	{
		const verdict = await verifySkillDeletionTarget(join(home, '.claude', 'skills', 'a'), 'a/b', roots);
		assert.equal(verdict.ok, false);
		console.log('[PASS] C-4 不安全 Skill 名称：拒绝');
	}

	// ── C-5 不存在路径：拒绝并带诊断 ──────────────────────────────────────────
	{
		const verdict = await verifySkillDeletionTarget(join(home, '.codex', 'skills', 'missing'), 'missing', roots);
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /不存在/);
		console.log('[PASS] C-5 不存在路径：拒绝并诊断');
	}

	// ── C-6 所有权歧义：拒绝定向删除 ──────────────────────────────────────────
	{
		const dup = join(home, '.claude', 'skills', 'dup');
		await mkdir(dup);
		// 两个不同来源的 known Item 声明同一 (claude, dup) 物理目标 → ambiguous。
		const items = groupInstalledSkillItems([
			{name: 'dup', path: dup, scope: 'global', agents: ['Claude Code'], source: 'o/a'},
			{name: 'dup', path: dup, scope: 'global', agents: ['Claude Code'], source: 'o/b'}
		]);
		const index = buildSkillsOwnershipIndex(items);
		assert.equal(items.length, 2, '同名异源必须拆成两个 Item');
		const verdict = await verifySkillDeletionTarget(dup, 'dup', roots, index);
		assert.equal(verdict.ok, false);
		assert.match(verdict.reason, /多个来源|歧义/);
		console.log('[PASS] C-6 所有权歧义：拒绝定向删除');
	}

	// ── C-7 所有权无歧义：放行 ────────────────────────────────────────────────
	{
		const solo = join(home, '.agents', 'skills', 'solo');
		await mkdir(solo);
		const items = groupInstalledSkillItems([
			{name: 'solo', path: solo, scope: 'global', agents: ['Codex'], source: 'o/a'}
		]);
		const index = buildSkillsOwnershipIndex(items);
		const verdict = await verifySkillDeletionTarget(solo, 'solo', roots, index);
		assert.equal(verdict.ok, true);
		console.log('[PASS] C-7 所有权无歧义：放行');
	}

	// ── C-8 shared symlink：symlink 判定 + 目标解析（平台支持时） ─────────────
	{
		const canonical = join(home, '.agents', 'skills', 'shared');
		await mkdir(canonical);
		const link = join(home, '.claude', 'skills', 'shared');
		const created = await tryDirSymlink(canonical, link);
		if (!created) {
			symlinkSupported = false;
			console.log('[SKIP] C-8 shared symlink：当前平台无目录符号链接权限，跳过');
		} else {
			const verdict = await verifySkillDeletionTarget(link, 'shared', roots);
			assert.equal(verdict.ok, true);
			assert.equal(verdict.target.kind, 'symlink');
			assert.equal(verdict.target.symlinkTarget, canonical);
			console.log('[PASS] C-8 shared symlink：symlink 判定 + 目标解析');
		}
	}

	// ── C-9 symlink 逃逸：拒绝跟随（平台支持时） ─────────────────────────────
	if (symlinkSupported) {
		const outside = await mkdtemp(join(tmpdir(), 'ccq-esc-'));
		try {
			const link = join(home, '.claude', 'skills', 'esc');
			const created = await tryDirSymlink(outside, link);
			if (!created) {
				console.log('[SKIP] C-9 symlink 逃逸：符号链接创建失败，跳过');
			} else {
				const verdict = await verifySkillDeletionTarget(link, 'esc', roots);
				assert.equal(verdict.ok, false);
				assert.match(verdict.reason, /受支持 Skills 根|拒绝跟随/);
				console.log('[PASS] C-9 symlink 逃逸：拒绝跟随删除');
			}
		} finally {
			await rm(outside, {recursive: true, force: true});
		}
	}

	// ── C-10 broken symlink：拒绝（平台支持时） ──────────────────────────────
	if (symlinkSupported) {
		const link = join(home, '.claude', 'skills', 'ghost');
		const created = await tryDirSymlink(join(home, '.agents', 'skills', 'never-existed'), link);
		if (!created) {
			console.log('[SKIP] C-10 broken symlink：符号链接创建失败，跳过');
		} else {
			const verdict = await verifySkillDeletionTarget(link, 'ghost', roots);
			assert.equal(verdict.ok, false);
			assert.match(verdict.reason, /断开|不存在/);
			console.log('[PASS] C-10 broken symlink：拒绝删除');
		}
	}

	if (!symlinkSupported) {
		console.log('[WARN] 当前平台不支持目录符号链接，C-8/C-9/C-10 已跳过；symlink 判定逻辑待非 win32 或开发者模式环境验证');
	}

	// ── C-11 removeSkillTarget：精确目录被删除 ────────────────────────────────
	{
		const dir = join(home, '.codex', 'skills', 'removeme');
		await mkdir(join(dir, 'sub'), {recursive: true});
		await writeFile(join(dir, 'SKILL.md'), '---\nname: removeme\n---\n');
		const verdict = await verifySkillDeletionTarget(dir, 'removeme', roots);
		assert.equal(verdict.ok, true);
		await removeSkillTarget(verdict.target);
		const after = await verifySkillDeletionTarget(dir, 'removeme', roots);
		assert.equal(after.ok, false, '删除后目标必须不存在');
		assert.match(after.reason, /不存在/);
		console.log('[PASS] C-11 removeSkillTarget directory：精确目录被删除');
	}

	// ── C-12 removeSkillTarget symlink：只删链接，canonical 保留 ──────────────
	if (symlinkSupported) {
		const canonical = join(home, '.agents', 'skills', 'keepcanon');
		await mkdir(canonical);
		await writeFile(join(canonical, 'SKILL.md'), '---\nname: keepcanon\n---\n');
		const link = join(home, '.claude', 'skills', 'keepcanon');
		await symlink(canonical, link);
		const verdict = await verifySkillDeletionTarget(link, 'keepcanon', roots);
		assert.equal(verdict.ok, true);
		assert.equal(verdict.target.kind, 'symlink');
		await removeSkillTarget(verdict.target);
		const linkAfter = await verifySkillDeletionTarget(link, 'keepcanon', roots);
		assert.equal(linkAfter.ok, false, '符号链接必须被移除');
		const canonAfter = await verifySkillDeletionTarget(canonical, 'keepcanon', roots);
		assert.equal(canonAfter.ok, true, 'canonical 本体必须保留，未被跟随删除');
		console.log('[PASS] C-12 removeSkillTarget symlink：只删链接，canonical 保留');
	} else {
		console.log('[SKIP] C-12 removeSkillTarget symlink：无符号链接权限，跳过');
	}

	console.log('[PASS] Skills 删除安全验证门禁全部通过');
} finally {
	await rm(home, {recursive: true, force: true});
}
