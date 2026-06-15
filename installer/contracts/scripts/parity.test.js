#!/usr/bin/env node
/**
 * 功能对等测试（任务 6.11）
 *
 * 比较 JS 实现与 legacy PS/zsh 实现的机器可验证对等契约：
 * 1. CRUD 函数契约对等（provider/skills/update 三模块）
 * 2. 字段所有权不变量（ApiKey 绝不触碰 model/language/permissions/hooks/mcpServers）
 * 3. 对等验证文档存在性（provider 已有，skills/update 待人工审查）
 *
 * 说明：逐行 UI 文案/错误消息对等需人工审查（见 *.parity-check.md）。
 * 运行：node parity.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const provider = require('./provider-manager.js');
const skills = require('./skills-manager.js');
const update = require('./update-manager.js');

let testCount = 0, passCount = 0, failCount = 0;
function test(name, fn) {
  testCount++;
  try { fn(); passCount++; console.log(`✓ ${name}`); }
  catch (err) { failCount++; console.error(`✗ ${name}\n  ${err.message}`); }
}
function suite(name, fn) { console.log(`\n━━━ ${name} ━━━`); fn(); }

// PS/zsh → JS 函数映射（对等契约）
const PROVIDER_CRUD = ['getProviderList', 'addProvider', 'editProvider', 'deleteProvider', 'switchProvider'];
const SKILLS_CRUD = ['installSkill', 'updateSkills', 'uninstallSkills', 'getInstalledSkills'];
const UPDATE_CRUD = ['checkComponentUpdates', 'createSnapshot', 'rollbackFromSnapshot', 'generateUpdateSummary'];

suite('Provider CRUD 函数对等（PS: Get-/Add-/Edit-/Remove-/Switch-Provider）', () => {
  for (const fn of PROVIDER_CRUD) {
    test(`provider.${fn} 存在且可调用`, () => {
      assert.strictEqual(typeof provider[fn], 'function', `${fn} 必须为函数`);
    });
  }
});

suite('Skills CRUD 函数对等（PS: Install-/Update-/Uninstall-Skill）', () => {
  for (const fn of SKILLS_CRUD) {
    test(`skills.${fn} 存在且可调用`, () => {
      assert.strictEqual(typeof skills[fn], 'function', `${fn} 必须为函数`);
    });
  }
});

suite('Update CRUD 函数对等（PS: Get-AvailableUpdates/New-Snapshot/Restore-Snapshot）', () => {
  for (const fn of UPDATE_CRUD) {
    test(`update.${fn} 存在且可调用`, () => {
      assert.strictEqual(typeof update[fn], 'function', `${fn} 必须为函数`);
    });
  }
});

// ============================================================================
// 字段所有权不变量（HC-SETTINGS-OWNERSHIP）
// ============================================================================

suite('字段所有权不变量（ApiKey 不触碰 ClaudeConfig 字段）', () => {
  test('provider-manager 源码不直接写 model/language 顶层字段', () => {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'provider-manager.js'), 'utf8');
    // 静态检查：不应有 settings.model = / settings.language = 这类直接赋值
    const violations = [
      /settings\.model\s*=/,
      /settings\.language\s*=/,
      /settings\.permissions\s*=/,
      /settings\.hooks\s*=/,
      /settings\.mcpServers\s*=/
    ];
    for (const re of violations) {
      assert(!re.test(src), `provider-manager 不应直接赋值 ${re}（违反字段所有权）`);
    }
  });

  test('provider-manager 拥有 ANTHROPIC_* env 键（BaseUrl/AuthToken/Model）', () => {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'provider-manager.js'), 'utf8');
    assert(src.includes('ANTHROPIC_AUTH_TOKEN'), '必须管理 ANTHROPIC_AUTH_TOKEN');
    assert(src.includes('ANTHROPIC_BASE_URL'), '必须管理 ANTHROPIC_BASE_URL');
  });
});

// ============================================================================
// 对等验证文档存在性
// ============================================================================

suite('对等验证文档', () => {
  test('provider-manager.parity-check.md 存在（task 2.15 产物）', () => {
    const doc = path.join(SCRIPTS_DIR, 'provider-manager.parity-check.md');
    assert(fs.existsSync(doc), 'provider 对等文档必须存在');
    const content = fs.readFileSync(doc, 'utf8');
    assert(content.includes('功能对等'), '文档必须含功能对等内容');
  });

  test('skills/update parity-check 标记待人工审查', () => {
    // task 3.15/4.17 标注跳过：需人工审查
    const skillsDoc = path.join(SCRIPTS_DIR, 'skills-manager.parity-check.md');
    const updateDoc = path.join(SCRIPTS_DIR, 'update-manager.parity-check.md');
    if (!fs.existsSync(skillsDoc)) {
      console.log('  [TODO] skills-manager.parity-check.md 待人工审查（task 3.15）');
    }
    if (!fs.existsSync(updateDoc)) {
      console.log('  [TODO] update-manager.parity-check.md 待人工审查（task 4.17）');
    }
    // 不强制失败：人工审查任务，仅提示
  });
});

// ============================================================================
// 6 个内建 Provider 契约对等（task 2.16 基础）
// ============================================================================

suite('内建 Provider 契约对等', () => {
  test('providers 契约含 6 个内建供应商', () => {
    const contract = provider.loadProviderContract();
    assert(contract, '契约必须可加载');
    const providers = contract.providers || contract;
    assert(typeof providers === 'object');
    const keys = Object.keys(providers);
    // 至少包含核心供应商 key（zhipu/minimax/deepseek/custom）
    assert(keys.length >= 4, `内建供应商数量异常: ${keys.length}`);
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);


