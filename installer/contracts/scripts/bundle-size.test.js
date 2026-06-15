#!/usr/bin/env node
/**
 * Bundle 大小断言测试（任务 6.9）
 *
 * 架构适配：当前采用 base64 内嵌（非 esbuild 单文件打包），
 * 故断言对象为「四个 manage JS 源文件总和 <150KB」。
 *
 * 硬约束来源：HC-JS-MODULE-LOADING（design.md D2）
 *
 * 运行：node bundle-size.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = path.join(__dirname);

// 受管 JS 文件清单（与 ManageCore.ps1 $script:ManageScriptNames 一致）
const MANAGED_SCRIPTS = [
  'manage.js',
  'provider-manager.js',
  'skills-manager.js',
  'update-manager.js'
];

// MCP 管理器（独立部署，单独计入）
const MCP_SCRIPT = 'mcp-manager.js';

// 硬上限（design.md D2：HC-JS-MODULE-LOADING）
const MAX_BUNDLE_KB = 150;

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

function getFileKB(fileName) {
  const filePath = path.join(SCRIPTS_DIR, fileName);
  if (!fs.existsSync(filePath)) return -1;
  return Math.round((fs.statSync(filePath).size / 1024) * 10) / 10;
}

// ============================================================================
// 测试用例
// ============================================================================

console.log(`\n━━━ Bundle 大小检查（上限 ${MAX_BUNDLE_KB}KB）━━━\n`);

test('四个 manage JS 源文件全部存在', () => {
  for (const f of MANAGED_SCRIPTS) {
    const p = path.join(SCRIPTS_DIR, f);
    assert(fs.existsSync(p), `缺失文件: ${f}`);
  }
});

test('四个 manage JS 源文件总和 < 150KB', () => {
  let total = 0;
  const details = [];
  for (const f of MANAGED_SCRIPTS) {
    const kb = getFileKB(f);
    total += kb;
    details.push(`${f}=${kb}KB`);
  }
  console.log(`  明细: ${details.join(', ')}`);
  console.log(`  总和: ${total.toFixed(1)}KB / ${MAX_BUNDLE_KB}KB 上限`);
  assert(total < MAX_BUNDLE_KB, `总和 ${total}KB 超过 ${MAX_BUNDLE_KB}KB 上限`);
});

test('单个 JS 文件不超过 60KB（单模块膨胀预警）', () => {
  for (const f of MANAGED_SCRIPTS) {
    const kb = getFileKB(f);
    assert(kb < 60, `${f} = ${kb}KB，单模块过大（接近膨胀阈值）`);
  }
});

test('mcp-manager.js 独立计入且 < 60KB', () => {
  const kb = getFileKB(MCP_SCRIPT);
  assert(kb > 0, `mcp-manager.js 必须存在`);
  assert(kb < 60, `mcp-manager.js = ${kb}KB，单文件过大`);
  console.log(`  mcp-manager.js = ${kb}KB（独立部署，不计入 manage 集合）`);
});

test('base64 内嵌后预估大小可接受（×1.37 膨胀）', () => {
  let total = 0;
  for (const f of MANAGED_SCRIPTS) total += getFileKB(f);
  const base64Estimate = total * 1.37;
  console.log(`  base64 预估: ${base64Estimate.toFixed(1)}KB（注入 manage.ps1/manage.sh）`);
  // base64 膨胀后单 artifact 可能超 150KB，这是 wrapper 体积，不违反 JS 加载约束
  assert(base64Estimate < 250, `base64 内嵌后 ${base64Estimate}KB 过大，需考虑拆分`);
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
