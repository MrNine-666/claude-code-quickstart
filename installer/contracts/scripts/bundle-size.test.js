#!/usr/bin/env node
/**
 * Bundle 大小断言测试（P10 任务 10.4.2 / 10.1.6）
 *
 * 架构：P10 方案 3 —— esbuild 单文件 bundle（取代旧 base64 多文件内嵌）。
 * 断言对象为「dist/manage.js 单文件 bundle < 150KB」，取代旧「4 源文件总和」。
 *
 * dist/ 被 gitignore：测试前若 esbuild 可用则即时构建保证最新；
 * 不可用且无产物则 SKIP（CI 在 npm ci + npm run build:manage 后必有产物）。
 *
 * 硬约束来源：HC-JS-MODULE-LOADING（design.md D2）
 * 运行：node bundle-size.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DIST_BUNDLE = path.join(REPO_ROOT, 'dist', 'manage.js');
const ESBUILD_CONFIG = path.join(SCRIPTS_DIR, 'esbuild.config.js');
const ESBUILD_MODULE = path.join(REPO_ROOT, 'node_modules', 'esbuild');

// 单模块膨胀预警的源文件清单（纯源码健康检查，与部署集合无关）
const SOURCE_MODULES = [
  'manage.js',
  'provider-manager.js',
  'skills-manager.js',
  'update-manager.js',
  'mcp-manager.js'
];

// 硬上限（design.md D2：HC-JS-MODULE-LOADING）
const MAX_BUNDLE_KB = 150;
// 单源模块膨胀阈值：provider-manager.js 含完整 TUI Dashboard + CRUD 交互
// （任务 11.1 Phase 1b 接入）约 75KB，故阈值上调至 90KB（保留预警意义，超限仍报警）
const MAX_SINGLE_MODULE_KB = 90;

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

function getFileKB(filePath) {
  if (!fs.existsSync(filePath)) return -1;
  return Math.round((fs.statSync(filePath).size / 1024) * 10) / 10;
}

// 构建兜底：esbuild 可用则即时重建（保证测最新 bundle），否则回退已有产物
function ensureBundle() {
  if (fs.existsSync(ESBUILD_MODULE) && fs.existsSync(ESBUILD_CONFIG)) {
    const r = spawnSync('node', [ESBUILD_CONFIG], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(DIST_BUNDLE)) {
      return { ok: true, fresh: true };
    }
  }
  if (fs.existsSync(DIST_BUNDLE)) {
    return { ok: true, fresh: false };
  }
  return { ok: false, reason: 'esbuild 未安装且无 dist/manage.js（CI: npm ci + npm run build:manage 后可用）' };
}

// ============================================================================
// 测试用例
// ============================================================================

console.log(`\n━━━ Bundle 大小检查（上限 ${MAX_BUNDLE_KB}KB，P10 单文件 bundle）━━━\n`);

const bundle = ensureBundle();

test('dist/manage.js 单文件 bundle 可用（esbuild 构建产物）', () => {
  if (!bundle.ok) {
    console.log(`  [SKIP] ${bundle.reason}`);
    return;
  }
  assert(fs.existsSync(DIST_BUNDLE), 'dist/manage.js 必须存在');
  console.log(`  来源: ${bundle.fresh ? '本次 esbuild 即时构建' : '已有产物'}`);
});

test(`dist/manage.js bundle < ${MAX_BUNDLE_KB}KB`, () => {
  if (!bundle.ok) {
    console.log('  [SKIP] bundle 不可用，跳过大小断言');
    return;
  }
  const kb = getFileKB(DIST_BUNDLE);
  console.log(`  bundle 大小: ${kb}KB / ${MAX_BUNDLE_KB}KB 上限`);
  assert(kb > 0, 'bundle 大小读取失败');
  assert(kb < MAX_BUNDLE_KB, `bundle ${kb}KB 超过 ${MAX_BUNDLE_KB}KB 上限`);
});

test('五个 manage JS 源文件全部存在', () => {
  for (const f of SOURCE_MODULES) {
    assert(fs.existsSync(path.join(SCRIPTS_DIR, f)), `缺失源文件: ${f}`);
  }
});

test(`单个源模块不超过 ${MAX_SINGLE_MODULE_KB}KB（单模块膨胀预警）`, () => {
  const details = [];
  for (const f of SOURCE_MODULES) {
    const kb = getFileKB(path.join(SCRIPTS_DIR, f));
    details.push(`${f}=${kb}KB`);
    assert(kb < MAX_SINGLE_MODULE_KB, `${f}=${kb}KB，单模块过大（接近膨胀阈值）`);
  }
  console.log(`  明细: ${details.join(', ')}`);
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
