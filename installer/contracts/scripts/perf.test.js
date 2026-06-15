#!/usr/bin/env node
/**
 * 性能基线测试（任务 6.8）
 *
 * 目标（design.md 7.3）：Manage 菜单打开时间 <2s
 *
 * 测量范围（菜单打开时间的核心组成）：
 * 1. manage.js 模块冷加载时间（子进程隔离，避免缓存）
 * 2. ensureTmpCacheDir 初始化时间
 * 3. 完整初始化链：require + ensureTmpCacheDir
 *
 * 说明：wrapper curl 下载耗时不在此测（网络相关，CI 测量）。
 * 运行：node perf.test.js
 */

'use strict';

const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const MANAGE_JS = path.join(SCRIPTS_DIR, 'manage.js');
const PERF_BUDGET_MS = 2000; // design.md 7.3 目标

let testCount = 0, passCount = 0, failCount = 0;
function test(name, fn) {
  testCount++;
  try { fn(); passCount++; console.log(`✓ ${name}`); }
  catch (err) { failCount++; console.error(`✗ ${name}\n  ${err.message}`); }
}
function suite(name, fn) { console.log(`\n━━━ ${name} ━━━`); fn(); }

// 子进程测量冷加载时间（毫秒）
function measureColdLoad(scriptExpr, samples = 5) {
  const probe = `const t0=process.hrtime.bigint(); ${scriptExpr}; const t1=process.hrtime.bigint(); console.log(Number(t1-t0)/1e6);`;
  const times = [];
  for (let i = 0; i < samples; i++) {
    const out = execSync(`node -e "${probe.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
    times.push(Number(out.trim()));
  }
  times.sort((a, b) => a - b);
  return {
    min: times[0],
    median: times[Math.floor(times.length / 2)],
    max: times[times.length - 1],
    avg: times.reduce((s, t) => s + t, 0) / times.length
  };
}

// ============================================================================
// 1. manage.js 模块冷加载
// ============================================================================

suite('manage.js 模块冷加载', () => {
  const req = `require(${JSON.stringify(MANAGE_JS)})`;
  const stats = measureColdLoad(req, 5);

  test(`模块冷加载 < 500ms（实测中位数 ${stats.median.toFixed(1)}ms）`, () => {
    console.log(`  采样: min=${stats.min.toFixed(1)} med=${stats.median.toFixed(1)} max=${stats.max.toFixed(1)} avg=${stats.avg.toFixed(1)} ms`);
    assert(stats.median < 500, `冷加载 ${stats.median}ms 超过 500ms 预算`);
  });
});

// ============================================================================
// 2. 完整初始化链（require + ensureTmpCacheDir）
// ============================================================================

suite('完整初始化链', () => {
  const init = `const m=require(${JSON.stringify(MANAGE_JS)}); m.ensureTmpCacheDir()`;
  const stats = measureColdLoad(init, 5);

  test(`完整初始化 < 600ms（实测中位数 ${stats.median.toFixed(1)}ms）`, () => {
    console.log(`  采样: min=${stats.min.toFixed(1)} med=${stats.median.toFixed(1)} max=${stats.max.toFixed(1)} avg=${stats.avg.toFixed(1)} ms`);
    assert(stats.median < 600, `初始化 ${stats.median}ms 超过 600ms 预算`);
  });
});

// ============================================================================
// 3. 端到端预算（菜单打开 = 冷加载 + 初始化 + 渲染）
// ============================================================================

suite('端到端预算', () => {
  const init = `const m=require(${JSON.stringify(MANAGE_JS)}); m.ensureTmpCacheDir()`;
  const stats = measureColdLoad(init, 5);

  test(`Manage 菜单打开预算 < ${PERF_BUDGET_MS}ms（JS 侧 ${stats.median.toFixed(1)}ms + wrapper 下载预留 1400ms）`, () => {
    const jsSideMs = stats.median;
    const wrapperBudgetMs = PERF_BUDGET_MS - jsSideMs;
    console.log(`  JS 侧初始化: ${jsSideMs.toFixed(1)}ms`);
    console.log(`  wrapper 下载预算: ${wrapperBudgetMs.toFixed(0)}ms（剩余）`);
    assert(jsSideMs < PERF_BUDGET_MS, `JS 侧 ${jsSideMs}ms 已超总预算 ${PERF_BUDGET_MS}ms`);
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);

