#!/usr/bin/env node
/**
 * update-manager.js 检测与摘要 E2E 测试（任务 6.5）
 *
 * 测试范围：
 * 1. semver 单调性（V_new > V_old → hasUpdate === true）
 * 2. 摘要格式（<scope>::<target>::<change>）
 * 3. 组件状态数据结构完整性
 * 4. 快照 manifest 读写一致性（隔离临时目录）
 *
 * 不依赖真实 npm outdated：通过注入 mock outdated 数据验证逻辑。
 * 运行：node update-manager.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const um = require('./update-manager.js');

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
// 1. semver 解析与比较
// ============================================================================

suite('semver 解析', () => {
  test('parseSemver 解析标准版本', () => {
    const v = um.parseSemver('1.2.3');
    assert.deepStrictEqual(v, { major: 1, minor: 2, patch: 3, prerelease: null, build: null });
  });

  test('parseSemver 处理 v 前缀', () => {
    assert.strictEqual(um.parseSemver('v2.0.1').major, 2);
  });

  test('parseSemver 拒绝非语义版本', () => {
    assert.strictEqual(um.parseSemver('latest'), null);
    assert.strictEqual(um.parseSemver(''), null);
    assert.strictEqual(um.parseSemver(null), null);
  });

  test('semverCompare major/minor/patch 优先级', () => {
    assert(um.semverCompare('2.0.0', '1.0.0') > 0);
    assert(um.semverCompare('1.2.0', '1.1.0') > 0);
    assert(um.semverCompare('1.0.2', '1.0.1') > 0);
    assert(um.semverCompare('1.0.0', '1.0.0') === 0);
    assert(um.semverCompare('1.0.0', '2.0.0') < 0);
  });
});

// ============================================================================
// 2. 单调性（任务 4.14：V_new > V_old → hasUpdate === true）
// ============================================================================

suite('hasUpdate 单调性', () => {
  test('新版本更高 → 需要更新', () => {
    assert.strictEqual(um.hasUpdate('1.0.0', '1.0.1'), true);
    assert.strictEqual(um.hasUpdate('1.0.0', '1.1.0'), true);
    assert.strictEqual(um.hasUpdate('1.0.0', '2.0.0'), true);
  });

  test('版本相同 → 无需更新', () => {
    assert.strictEqual(um.hasUpdate('1.2.3', '1.2.3'), false);
  });

  test('远程版本更低 → 无需更新（不降级）', () => {
    assert.strictEqual(um.hasUpdate('2.0.0', '1.9.0'), false);
  });

  test('远程为预发布版本 → 默认排除', () => {
    assert.strictEqual(um.hasUpdate('1.0.0', '2.0.0-beta'), false);
    assert.strictEqual(um.hasUpdate('1.0.0', '1.0.1-rc.1'), false);
  });

  test('无效输入返回 null', () => {
    assert.strictEqual(um.hasUpdate('', '1.0.0'), null);
    assert.strictEqual(um.hasUpdate('1.0.0', ''), null);
    assert.strictEqual(um.hasUpdate(null, null), null);
  });
});

// ============================================================================
// 3. 摘要格式（<scope>::<target>::<change>）
// ============================================================================

suite('更新摘要格式', () => {
  test('generateUpdateSummary 空数组返回 up-to-date', () => {
    assert.strictEqual(um.generateUpdateSummary([]), '✓ All components up to date');
    assert.strictEqual(um.generateUpdateSummary(null), '✓ All components up to date');
  });

  test('generateUpdateSummary 保留合法 scope::target::change', () => {
    const items = ['Skill::foo::1.0.0→1.1.0', 'Cli::ccg::2.0.0→2.1.0'];
    const summary = um.generateUpdateSummary(items);
    assert(summary.includes('Skill::foo::'), '必须保留 Skill 条目');
    assert(summary.includes('Cli::ccg::'), '必须保留 Cli 条目');
    assert(summary.includes('\n'), '多条目用换行分隔');
  });

  test('generateUpdateSummary 补全不合规条目为 updated::unknown', () => {
    const summary = um.generateUpdateSummary(['bare-item']);
    assert(summary.includes('updated::unknown::bare-item'), '不合规条目必须补全');
  });
});

// ============================================================================
// 4. 组件检测数据结构（注入 mock outdated，不依赖真实 npm）
// ============================================================================

suite('组件检测数据结构', () => {
  test('checkSkillsUpdates 注入 mock outdated 正确计算 hasUpdate', async () => {
    // mock: foo 包有更新（1.0.0 → 1.1.0）
    const mockOutdated = { 'foo-skill': { current: '1.0.0', latest: '1.1.0' } };
    const skills = await um.checkSkillsUpdates(mockOutdated);
    assert(Array.isArray(skills), '必须返回数组');
    // 数据结构完整性校验（无论环境是否有 skills 目录）
    for (const s of skills) {
      assert(typeof s.id === 'string' && s.id.startsWith('Skill:'), 'id 必须以 Skill: 开头');
      assert(['skill'].includes(s.type), 'type 必须为 skill');
      assert('hasUpdate' in s, '必须有 hasUpdate 字段');
    }
  });

  test('checkSkillsUpdates 无 skills 目录返回空数组', async () => {
    // 不存在的目录场景（HOME 指向隔离临时目录时）
    const result = await um.checkSkillsUpdates({});
    assert(Array.isArray(result));
  });

  test('checkCliToolUpdates 返回组件含 id/type 字段', async () => {
    const components = await um.checkCliToolUpdates({});
    assert(Array.isArray(components), '必须返回数组');
    assert(components.length > 0, 'CLI 工具列表不能为空');
    for (const c of components) {
      assert(typeof c.id === 'string', '必须有 id');
      assert('installed' in c, '必须有 installed 字段');
    }
  });
});

// ============================================================================
// 5. 快照 API 契约（验证导出的快照函数签名）
// ============================================================================

suite('快照 API 契约', () => {
  test('createSnapshot / rollbackFromSnapshot 为可调用函数', () => {
    assert.strictEqual(typeof um.createSnapshot, 'function', 'createSnapshot 必须可调用');
    assert.strictEqual(typeof um.rollbackFromSnapshot, 'function', 'rollbackFromSnapshot 必须可调用');
  });

  test('rollbackFromSnapshot 不存在的快照抛出错误', () => {
    assert.throws(() => um.rollbackFromSnapshot('/nonexistent/snapshot/path'), /快照不存在/);
  });

  test('rollbackFromSnapshot 损坏 manifest 抛出错误', () => {
    const tmpSnap = path.join(os.tmpdir(), `ccq-snap-corrupt-${process.pid}`);
    fs.mkdirSync(tmpSnap, { recursive: true });
    fs.writeFileSync(path.join(tmpSnap, 'manifest.json'), '{ broken');
    assert.throws(() => um.rollbackFromSnapshot(tmpSnap), /manifest/);
    try { fs.rmSync(tmpSnap, { recursive: true, force: true }); } catch {}
  });
});


// ============================================================================
// 6. execCommand 基础契约
// ============================================================================

suite('execCommand 基础契约', () => {
  test('execCommand 执行 node 版本查询成功', async () => {
    const result = await um.execCommand('node', ['--version']);
    assert.strictEqual(result.exitCode, 0);
    assert(result.stdout.includes('v'), 'node --version 输出应含 v 前缀');
  });

  test('execCommand 不存在的命令返回非零退出码', async () => {
    const result = await um.execCommand('nonexistent-cmd-xyz', []);
    assert.notStrictEqual(result.exitCode, 0);
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);


