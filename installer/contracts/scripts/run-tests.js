#!/usr/bin/env node
/**
 * 回归测试聚合入口（任务 6.10）
 *
 * 发现并运行 installer/contracts/scripts/ 下所有 *.test.js，汇总结果。
 * 双平台（Windows/macOS）语义一致：纯 Node.js，零依赖。
 *
 * 运行：
 *   node installer/contracts/scripts/run-tests.js            # 运行全部
 *   node installer/contracts/scripts/run-tests.js --unit     # 仅单元测试
 *   node installer/contracts/scripts/run-tests.js --e2e      # 仅 E2E/集成测试
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = __dirname;

// 测试分类（--unit / --e2e 过滤用）
const UNIT_TESTS = [
  'provider-manager.test.js',
  'skills-manager.test.js'
];

const INTEGRATION_TESTS = [
  'profile-lock.test.js',
  'bundle-size.test.js',
  'update-manager.test.js',
  'skills-e2e.test.js',
  'deploy.test.js',
  'perf.test.js'
];

// ============================================================================
// 参数解析
// ============================================================================

const args = process.argv.slice(2);
let targetTests;

if (args.includes('--unit')) {
  targetTests = UNIT_TESTS;
} else if (args.includes('--e2e') || args.includes('--integration')) {
  targetTests = INTEGRATION_TESTS;
} else {
  // 默认：运行全部 *.test.js（自动发现）
  targetTests = fs.readdirSync(SCRIPTS_DIR)
    .filter(f => f.endsWith('.test.js') && f !== 'run-tests.js')
    .sort();
}

// ============================================================================
// 逐个运行测试
// ============================================================================

console.log('╔═══════════════════════════════════════════════════════════╗');
console.log('║        Claude Code Quickstart - Manage JS 测试聚合        ║');
console.log('╚═══════════════════════════════════════════════════════════╝');
console.log(`\n测试套件: ${targetTests.length} 个\n`);

const results = [];
let totalPass = 0, totalFail = 0;

for (const testFile of targetTests) {
  const testPath = path.join(SCRIPTS_DIR, testFile);
  if (!fs.existsSync(testPath)) {
    console.log(`⚠ [SKIP] ${testFile}（文件不存在）`);
    continue;
  }

  // 隔离运行（每个测试独立进程，避免状态污染）
  const proc = spawnSync('node', [testPath], {
    encoding: 'utf8',
    timeout: 120000,
    env: process.env
  });

  const passed = proc.status === 0;
  const output = (proc.stdout || '') + (proc.stderr || '');

  // 从输出解析通过/失败计数（兼容多种汇总格式）
  const pipeMatch = output.match(/总计:\s*(\d+)\s*\|\s*通过:\s*(\d+)\s*\|\s*失败:\s*(\d+)/);
  const passMatch = !pipeMatch && output.match(/通过:\s*(\d+)\s*✓?/);
  const failMatch = !pipeMatch && output.match(/失败:\s*(\d+)\s*✗?/);

  let counts;
  if (pipeMatch) {
    counts = { total: +pipeMatch[1], pass: +pipeMatch[2], fail: +pipeMatch[3] };
  } else if (passMatch) {
    const pass = +passMatch[1];
    const fail = failMatch ? +failMatch[1] : 0;
    counts = { total: pass + fail, pass, fail };
  } else {
    counts = { total: 0, pass: 0, fail: passed ? 0 : 1 };
  }

  totalPass += counts.pass;
  totalFail += counts.fail;

  const status = passed ? '✓ [PASS]' : '✗ [FAIL]';
  console.log(`${status} ${testFile}  (${counts.pass}/${counts.total})`);

  if (!passed && process.env.CCQ_TEST_VERBOSE) {
    console.log(output);
  }

  results.push({ file: testFile, passed, counts });
}

// ============================================================================
// 汇总
// ============================================================================

console.log('\n┌───────────────────────────────────────────────────────────┐');
console.log('│                        汇总结果                          │');
console.log('└───────────────────────────────────────────────────────────┘');

for (const r of results) {
  const status = r.passed ? '✓' : '✗';
  console.log(`  ${status} ${r.file.padEnd(32)} ${r.counts.pass}/${r.counts.total}`);
}

const allPassed = totalFail === 0 && results.every(r => r.passed);
console.log(`\n套件: ${results.filter(r => r.passed).length}/${results.length} 通过`);
console.log(`断言: ${totalPass}/${totalPass + totalFail} 通过`);

if (allPassed) {
  console.log('\n🎉 全部测试通过');
} else {
  console.log(`\n❌ ${totalFail} 个断言失败，详见各套件输出（CCQ_TEST_VERBOSE=1 查看详情）`);
}

process.exit(allPassed ? 0 : 1);

