#!/usr/bin/env node
/**
 * skills-manager.js 核心不变量单元测试
 *
 * 测试范围：
 * 1. 纯函数（去重、ANSI 清理、输出解析）
 * 2. Catalogue 层（条目规范化、加载、忽略过滤）
 * 3. 错误分类（friendly error）
 *
 * 运行：node skills-manager.test.js
 */

'use strict';

const assert = require('assert');
const sm = require('./skills-manager.js');

// ============================================================================
// 测试框架（零依赖迷你版）
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  try {
    fn();
    passCount++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failCount++;
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
  }
}

function suite(name, fn) {
  console.log(`\n━━━ ${name} ━━━`);
  fn();
}

// ============================================================================
// 1. 纯函数测试
// ============================================================================

suite('纯函数层', () => {
  test('uniqueSkillNames 去重并保留顺序', () => {
    const input = ['skill-a', 'skill-b', 'skill-A', 'skill-b', 'skill-c'];
    const result = sm.uniqueSkillNames(input);
    assert.deepStrictEqual(result, ['skill-a', 'skill-b', 'skill-c']);
  });

  test('uniqueSkillNames 过滤空字符串', () => {
    const input = ['skill-a', '', '  ', 'skill-b', null, undefined];
    const result = sm.uniqueSkillNames(input);
    assert.deepStrictEqual(result, ['skill-a', 'skill-b']);
  });

  test('removeAnsiSequences 清除 ANSI 转义序列', () => {
    const input = '\x1b[92mSuccess\x1b[0m';
    const result = sm.removeAnsiSequences(input);
    assert.strictEqual(result, 'Success');
  });

  test('parseSkillsListOutput 解析表格输出', () => {
    const input = `
│ skill-one
│ skill-two
│ invalid@name
│ skill-three
    `;
    const result = sm.parseSkillsListOutput(input);
    assert.deepStrictEqual(result, ['skill-one', 'skill-two', 'skill-three']);
  });

  test('parseSkillsListOutput 过滤非表格行', () => {
    const input = `
Header line
│ valid-skill
Footer line
│ another-skill
    `;
    const result = sm.parseSkillsListOutput(input);
    assert.deepStrictEqual(result, ['valid-skill', 'another-skill']);
  });
});

// ============================================================================
// 2. Catalogue 层测试
// ============================================================================

suite('Catalogue 层', () => {
  test('normalizeEntry 填充默认值', () => {
    const result = sm.normalizeEntry({ Id: 'test', Name: '测试' });
    assert.strictEqual(result.Id, 'test');
    assert.strictEqual(result.Name, '测试');
    assert.strictEqual(result.Source, '');
    assert.strictEqual(result.SkipDiscovery, false);
    assert.strictEqual(result.Default, false);
    assert.strictEqual(result.Order, 9999);
  });

  test('normalizeEntry 保留布尔与数字', () => {
    const result = sm.normalizeEntry({
      Id: 'ppt', SkipDiscovery: true, Default: true, Order: 120
    });
    assert.strictEqual(result.SkipDiscovery, true);
    assert.strictEqual(result.Default, true);
    assert.strictEqual(result.Order, 120);
  });

  test('loadSkillsCatalogue 返回有效结构', () => {
    const { catalogue, ignoredNames } = sm.loadSkillsCatalogue();
    assert(Array.isArray(catalogue), 'catalogue 必须是数组');
    assert(catalogue.length > 0, 'catalogue 不能为空');
    assert(Array.isArray(ignoredNames), 'ignoredNames 必须是数组');
  });

  test('loadSkillsCatalogue 按 Order 升序排序', () => {
    const { catalogue } = sm.loadSkillsCatalogue();
    for (let i = 1; i < catalogue.length; i++) {
      assert(catalogue[i].Order >= catalogue[i - 1].Order, 'Order 必须升序');
    }
  });

  test('loadSkillsCatalogue 包含 find-skills 默认条目', () => {
    const { catalogue } = sm.loadSkillsCatalogue();
    const findSkills = catalogue.find(e => e.Id === 'find-skills');
    assert(findSkills, '必须包含 find-skills');
    assert.strictEqual(findSkills.Default, true);
  });

  test('ignoredNames 包含 CCG 管理技能', () => {
    const { ignoredNames } = sm.loadSkillsCatalogue();
    assert(ignoredNames.includes('ccg-skills'), '必须忽略 ccg-skills');
    assert(ignoredNames.includes('collaborating-with-codex'));
    assert(ignoredNames.includes('collaborating-with-gemini'));
  });

  test('isSkillIgnored 大小写不敏感匹配', () => {
    const ignored = ['ccg-skills', 'collaborating-with-codex'];
    assert.strictEqual(sm.isSkillIgnored('ccg-skills', ignored), true);
    assert.strictEqual(sm.isSkillIgnored('CCG-Skills', ignored), true);
    assert.strictEqual(sm.isSkillIgnored('other-skill', ignored), false);
  });
});

// ============================================================================
// 3. 错误分类测试
// ============================================================================

suite('错误分类层', () => {
  test('getFriendlyError 识别网络错误', () => {
    const result = sm.getFriendlyError(1, 'fetch failed: ETIMEDOUT', '安装');
    assert(result.includes('网络'), '网络错误应提示网络');
  });

  test('getFriendlyError 识别权限错误', () => {
    const result = sm.getFriendlyError(1, 'EACCES: permission denied symlink', '安装');
    assert(result.includes('copy 模式'), '权限错误应提示 copy 模式');
  });

  test('getFriendlyError 识别 404 错误', () => {
    const result = sm.getFriendlyError(1, 'Error: 404 not found', '安装');
    assert(result.includes('catalogue'), '404 错误应提示检查 catalogue');
  });

  test('getFriendlyError 默认错误含 exit code', () => {
    const result = sm.getFriendlyError(42, 'unknown failure', '更新');
    assert(result.includes('42'), '默认错误应含 exit code');
    assert(result.includes('更新'), '默认错误应含操作名');
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);


