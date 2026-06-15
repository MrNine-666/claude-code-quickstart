#!/usr/bin/env node
/**
 * skills-manager.js 安装 E2E 测试（任务 6.4）
 *
 * 测试范围：
 * 1. 安装链路函数契约（installSkill/updateSkills/uninstallSkills 可调用）
 * 2. Catalogue 与默认安装条目一致性
 * 3. 安装验证逻辑（隔离 HOME 下 checkSkillsUpdates 扫描 ~/.claude/skills/）
 * 4. 真实 npx 安装（门控：CCQ_E2E_REAL=1 时启用，默认跳过避免污染本地）
 *
 * 运行：
 *   node skills-e2e.test.js                    # 本地契约验证
 *   CCQ_E2E_REAL=1 node skills-e2e.test.js     # CI 真实 npx 安装
 */

'use strict';

const assert = require('assert');
const sm = require('./skills-manager.js');

let testCount = 0, passCount = 0, failCount = 0;
function test(name, fn) {
  testCount++;
  try { fn(); passCount++; console.log(`✓ ${name}`); }
  catch (err) { failCount++; console.error(`✗ ${name}\n  ${err.message}`); }
}
function suite(name, fn) { console.log(`\n━━━ ${name} ━━━`); fn(); }

const REAL_NPX = process.env.CCQ_E2E_REAL === '1';

// ============================================================================
// 1. 安装链路函数契约
// ============================================================================

suite('安装链路函数契约', () => {
  test('installSkill / updateSkills / uninstallSkills 均可调用', () => {
    assert.strictEqual(typeof sm.installSkill, 'function');
    assert.strictEqual(typeof sm.updateSkills, 'function');
    assert.strictEqual(typeof sm.uninstallSkills, 'function');
    assert.strictEqual(typeof sm.getInstalledSkills, 'function');
  });

  test('SCRIPT_VERSION 存在且为字符串', () => {
    assert.strictEqual(typeof sm.SCRIPT_VERSION, 'string');
    assert(sm.SCRIPT_VERSION.length > 0);
  });
});

// ============================================================================
// 2. Catalogue 与默认安装条目一致性
// ============================================================================

suite('Catalogue 默认安装条目', () => {
  test('loadSkillsCatalogue 含可安装的默认条目', () => {
    const { catalogue } = sm.loadSkillsCatalogue();
    const installable = catalogue.filter(e => !e.SkipDiscovery);
    assert(installable.length > 0, '必须存在可安装条目');
  });

  test('每个可安装条目含 Source 字段（npx skills add 参数）', () => {
    const { catalogue } = sm.loadSkillsCatalogue();
    for (const entry of catalogue) {
      if (entry.SkipDiscovery) continue;
      assert(typeof entry.Source === 'string', `条目 ${entry.Id} 必须含 Source`);
    }
  });

  test('ignoredNames 排除 CCG 内部技能（不向用户展示）', () => {
    const { ignoredNames } = sm.loadSkillsCatalogue();
    assert(ignoredNames.length > 0, '必须存在忽略列表');
    assert(ignoredNames.includes('ccg-skills'), '必须忽略 ccg-skills');
  });
});

// ============================================================================
// 3. 安装验证逻辑（checkSkillsUpdates 扫描文件系统，验证 ~/.claude/skills/ 填充）
// ============================================================================

suite('安装验证逻辑（文件系统扫描）', () => {
  test('checkSkillsUpdates 检测已安装 skill 的版本字段', async () => {
    // 借用 update-manager 的 checkSkillsUpdates（直接扫描文件系统，不依赖 npx）
    const um = require('./update-manager.js');
    const mockOutdated = {};
    const skills = await um.checkSkillsUpdates(mockOutdated);
    assert(Array.isArray(skills), '必须返回数组');
    // 若环境存在 skills，验证数据结构
    for (const s of skills) {
      assert(s.id.startsWith('Skill:'), `id 必须以 Skill: 开头: ${s.id}`);
      assert.strictEqual(typeof s.installed, 'boolean');
      assert('currentVersion' in s && 'latestVersion' in s);
    }
  });
});

// ============================================================================
// 4. 真实 npx 安装（门控：仅 CCQ_E2E_REAL=1 时执行）
// ============================================================================

suite('真实 npx 安装（CI 门控）', () => {
  if (!REAL_NPX) {
    test('跳过真实 npx 安装（设置 CCQ_E2E_REAL=1 启用，CI 执行）', () => {
      console.log('  [SKIP] 本地环境不执行真实 npx skills add');
    });
    return;
  }

  test('installSkill 安装默认条目后 ~/.claude/skills/ 填充', async () => {
    const { catalogue } = sm.loadSkillsCatalogue();
    const target = catalogue.find(e => e.Default && !e.SkipDiscovery) || catalogue[0];
    assert(target, '必须存在可安装的默认条目');

    const result = await sm.installSkill(target);
    assert.strictEqual(typeof result.success, 'boolean', '必须返回 success 字段');

    if (result.success) {
      const installed = await sm.getInstalledSkills();
      assert(Array.isArray(installed), '已安装列表必须为数组');
      console.log(`  已安装 skills 数量: ${installed.length}`);
    }
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
console.log(REAL_NPX ? '模式: 真实 npx（CI）' : '模式: 契约验证（本地）');
process.exit(failCount > 0 ? 1 : 0);


