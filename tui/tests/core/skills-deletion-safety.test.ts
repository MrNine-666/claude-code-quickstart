import {describe, expect, test} from 'bun:test';
import {join} from 'node:path';
import {supportedSkillsRoots, verifySkillDeletionTarget} from '../../src/core/skills-installed.js';

// 载体迁移（P3b）：原 scripts/verify-skills-deletion-safety.mjs 的纯词法判定分支
// （C-3 路径穿越 / C-4 不安全 Skill 名称，共 2 条静态断言）迁入。
//
// 判据：`verifySkillDeletionTarget` 先跑 `verifySkillDeletionPath` 的纯词法校验，
// 名称不安全时在任何 `lstat` 之前返回，故这两条断言在去掉真实临时目录后仍成立。
// C-1/C-2/C-5..C-12 的 `directory` / `symlink` / broken symlink / 逃逸 / 所有权歧义
// 判定依赖真实 fs 语义（含 win32 无符号链接权限时的 SKIP 分支），全部保留在 verify。

// 词法层判定不触碰磁盘，这里用不存在的 home 即可；断言成立性与路径是否存在无关。
const homeDir = join('/fake-home', 'ccq-del-lexical');
const roots = supportedSkillsRoots(homeDir, homeDir);

describe('Skills 删除目标词法层校验（core/skills-installed.ts）', () => {
	// ── C-3 路径穿越：词法层拒绝 ──────────────────────────────────────────────
	test('C-3 路径穿越：词法层拒绝', async () => {
		const verdict = await verifySkillDeletionTarget(join(homeDir, '.claude', 'skills', '..', '..', 'etc'), '..', roots);
		expect(verdict.ok, '路径穿越必须在词法层拒绝，不得进入 lstat').toBe(false);
	});

	// ── C-4 不安全 Skill 名称：拒绝 ───────────────────────────────────────────
	test('C-4 不安全 Skill 名称：拒绝', async () => {
		const verdict = await verifySkillDeletionTarget(join(homeDir, '.claude', 'skills', 'a'), 'a/b', roots);
		expect(verdict.ok, '不安全 Skill 名称必须在词法层拒绝，不得进入 lstat').toBe(false);
	});
});
